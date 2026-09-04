import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { AuthRuntime } from './auth/auth.runtime';

/**
 * Closes the sockets the runtime owns when the process is asked to stop.
 *
 * `createProductionRuntime` has returned a `close()` since Story 1.2 and nothing
 * ever called it, which was survivable while the only thing it held was a `pg`
 * pool: the process exited anyway. That stopped being true when the Valkey client
 * arrived with a reconnect strategy — an open, retrying client keeps the event
 * loop alive, so after SIGTERM the process appears to ignore the signal and is
 * eventually killed instead of shutting down. `main.ts` already calls
 * `enableShutdownHooks()`; this is the hook it was calling for.
 *
 * A failure to close is logged and swallowed, and the wait is BOUNDED by
 * {@link SHUTDOWN_TIMEOUT_MS}. Refusing to shut down because a socket would not
 * close is the one thing a shutdown handler must never do — and `pool.end()` waits
 * for in-flight queries, so a query wedged against an unresponsive database would
 * otherwise reproduce the exact failure this hook was added to fix. Leaking a
 * socket on the way out of a process that is about to exit costs nothing; hanging
 * costs a rolling deploy.
 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

@Injectable()
export class RuntimeShutdown implements OnApplicationShutdown {
  private readonly logger = new Logger('RuntimeShutdown');

  constructor(
    private readonly runtime: AuthRuntime,
    private readonly timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.runtime.close === undefined) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
        // Do not let the timer itself be the reason the loop stays alive.
        timer.unref?.();
      });

      const outcome = await Promise.race([this.runtime.close().then(() => 'closed' as const), bounded]);
      if (outcome === 'timeout') {
        this.logger.warn(
          `the runtime did not finish closing within ${this.timeoutMs}ms; exiting anyway`,
        );
      }
    } catch (error) {
      this.logger.error(
        'the runtime did not shut down cleanly; the process is exiting anyway',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
