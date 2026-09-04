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

      const closing = this.runtime.close().then(() => 'closed' as const);
      const outcome = await Promise.race([closing, bounded]);
      if (outcome === 'timeout') {
        this.logger.warn(
          `the runtime did not finish closing within ${this.timeoutMs}ms; exiting anyway`,
        );
        /**
         * A failure that arrives AFTER the timeout has already won the race.
         *
         * `Promise.race` subscribes to both promises, so a late rejection is
         * already *handled* — there is no `unhandledRejection` here, and adding a
         * blanket `.then(ok, ok)` to make sure would also swallow the ordinary
         * failure the `catch` below reports. What was actually missing is that a
         * late failure went nowhere at all: the only line written said "did not
         * finish in time", and the reason it never finished — a pool wedged
         * against an unresponsive database, a socket that refused to close — was
         * dropped. It is the one thing that would explain the timeout.
         */
        void closing.catch((late: unknown) => {
          this.logger.warn(
            'the runtime failed to close after the shutdown timeout had already passed',
            late instanceof Error ? late.stack : String(late),
          );
        });
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
