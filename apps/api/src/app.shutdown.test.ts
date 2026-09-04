import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  InMemoryAuditAdapter,
  InMemoryIdentityAdapter,
  InMemoryRateLimitAdapter,
  InMemorySessionAdapter,
} from '@stuwith/db';
import { FixedClock } from '@stuwith/domain';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { testApiEnv } from './__testing__/api-env';
import type { AuthRuntime } from './auth/auth.runtime';
import { createProviderRegistry } from './auth/providers/registry';

/**
 * The SIGTERM chain, end to end — because it has three links and no test connected
 * them.
 *
 * Deleting the `RuntimeShutdown` provider from `app.module.ts`, deleting
 * `enableShutdownHooks()` from `main.ts`, or reverting `close()` to a sequential
 * pair all passed everything. What they cost in production is a Valkey client with
 * a reconnect strategy keeping the event loop alive: the process appears to ignore
 * SIGTERM and is eventually killed, which turns every rolling deploy into a hard
 * stop.
 *
 * `app.close()` runs the same shutdown hooks the signal does, so this exercises the
 * wiring without needing a signal Windows cannot deliver.
 */
function runtimeThatRecordsClose(closed: { count: number }): AuthRuntime {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const config = testApiEnv();
  return {
    identity: new InMemoryIdentityAdapter(),
    sessions: new InMemorySessionAdapter(),
    audit: new InMemoryAuditAdapter(),
    rateLimit: new InMemoryRateLimitAdapter(clock),
    clock,
    registry: createProviderRegistry(config, fetch),
    close: async () => {
      closed.count += 1;
    },
  };
}

describe('shutting the process down closes what the runtime opened', () => {
  it('calls close() exactly once when the app is closed', async () => {
    const closed = { count: 0 };
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forConfig(testApiEnv(), { authRuntime: runtimeThatRecordsClose(closed) }),
      new FastifyAdapter(),
      { logger: false },
    );
    // The line `main.ts` calls; without it Nest never runs shutdown hooks at all.
    app.enableShutdownHooks();
    await app.init();

    expect(closed.count, 'nothing should close while the app is running').toBe(0);

    await app.close();

    expect(closed.count, 'the runtime must be closed on shutdown').toBe(1);
  }, 60_000);

  it('does not fall over on a runtime that owns nothing to close', async () => {
    // The flow-test harness supplies in-memory adapters and no `close`.
    const runtime = runtimeThatRecordsClose({ count: 0 });
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forConfig(testApiEnv(), {
        authRuntime: { ...runtime, close: undefined },
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.enableShutdownHooks();
    await app.init();

    await expect(app.close()).resolves.toBeUndefined();
  }, 60_000);
});
