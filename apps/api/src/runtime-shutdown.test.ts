import { describe, expect, it } from 'vitest';
import type { AuthRuntime } from './auth/auth.runtime';
import { RuntimeShutdown } from './runtime-shutdown';

/**
 * `createProductionRuntime` has returned a `close()` since Story 1.2 and nothing
 * ever called it. That was survivable while the only thing it held was a `pg`
 * pool — the process exited anyway — and stopped being survivable when the Valkey
 * client arrived with a reconnect strategy, because an open retrying client keeps
 * the event loop alive and the process looks like it is ignoring SIGTERM.
 *
 * A real signal cannot be delivered on Windows, so what is checked here is the
 * wiring: the hook exists, it calls `close()`, and it cannot itself become the
 * reason a shutdown does not finish.
 */
function runtimeWith(close?: () => Promise<void>): AuthRuntime {
  return { close } as unknown as AuthRuntime;
}

describe('RuntimeShutdown', () => {
  it('closes the runtime when the process is asked to stop', async () => {
    let closed = 0;
    const shutdown = new RuntimeShutdown(
      runtimeWith(async () => {
        closed += 1;
      }),
    );

    await shutdown.onApplicationShutdown();

    expect(closed).toBe(1);
  });

  it('does nothing for a runtime that owns no sockets', async () => {
    // The flow-test harness supplies in-memory adapters and no `close`.
    await expect(new RuntimeShutdown(runtimeWith()).onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('never lets a stubborn socket stop the shutdown', async () => {
    // Refusing to shut down because something would not close is the one thing a
    // shutdown handler must not do.
    const shutdown = new RuntimeShutdown(
      runtimeWith(async () => {
        throw new Error('the pool would not drain');
      }),
    );

    await expect(shutdown.onApplicationShutdown()).resolves.toBeUndefined();
  });

  /**
   * The failure this hook was added to fix, arriving through the hook itself.
   *
   * `pool.end()` waits for in-flight queries, and a query wedged against an
   * unresponsive database never returns — so an unbounded await here means SIGTERM
   * arrives, nothing happens, and the supervisor kills the process anyway. Leaking
   * a socket out of a process that is about to exit costs nothing; hanging costs a
   * rolling deploy.
   */
  it('gives up on a close that never finishes, rather than hanging for ever', async () => {
    const shutdown = new RuntimeShutdown(
      runtimeWith(() => new Promise<void>(() => {})),
      25,
    );

    const startedAt = Date.now();
    await expect(shutdown.onApplicationShutdown()).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('still waits for a close that finishes inside the bound', async () => {
    let closed = false;
    const shutdown = new RuntimeShutdown(
      runtimeWith(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              closed = true;
              resolve();
            }, 5),
          ),
      ),
      2_000,
    );

    await shutdown.onApplicationShutdown();

    expect(closed, 'the timeout must not cut short a close that was going to work').toBe(true);
  });
});
