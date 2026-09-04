import { Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiEnv } from '@stuwith/config';
import type { RateLimitDecision, RateLimitPort } from '@stuwith/domain';
import { RateLimitInputError, bruteForceLockKey, rateLimitKey } from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimitHealth } from './rate-limit-health';
import { RATE_LIMIT_ACTION_METADATA } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitedException } from './rate-limited.exception';

/**
 * Every branch of the guard, without an HTTP server.
 *
 * `rate-limit.flow.test.ts` drives the same code through real requests and is the
 * stronger evidence for the rows of the matrix. What it cannot reach cheaply is
 * the branch shape itself: a route with no decorator, an input error that must NOT
 * be laundered into a fail-open, the order the lock and the counters are consulted
 * in. Those are asserted here.
 */

const CONFIG = {
  TRUSTED_PROXY_ADDRESSES: 'none',
  SESSION_COOKIE_SECRET: 'guard-test-secret'.padEnd(48, 'x'),
  RATE_LIMIT_IP_MAX: 5,
  RATE_LIMIT_IP_WINDOW_SECONDS: 60,
  RATE_LIMIT_USER_MAX: 3,
  RATE_LIMIT_USER_WINDOW_SECONDS: 60,
  RATE_LIMIT_BRUTE_FORCE_MAX: 2,
  RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS: 900,
} as unknown as ApiEnv;

const CLIENT = '203.0.113.7';

class RecordingPort implements RateLimitPort {
  readonly hits: string[] = [];
  readonly reads: string[] = [];
  constructor(
    private readonly behaviour: {
      hit?: (key: string) => RateLimitDecision | Error;
      remainingSeconds?: (key: string) => number | null | Error;
    } = {},
  ) {}

  async hit(key: string, limit: number): Promise<RateLimitDecision> {
    this.hits.push(key);
    const answer = this.behaviour.hit?.(key) ?? { ok: true as const, count: 1, remaining: limit - 1 };
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }

  async remainingSeconds(key: string): Promise<number | null> {
    this.reads.push(key);
    const answer = this.behaviour.remainingSeconds?.(key) ?? null;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }

  async lock(): Promise<number> {
    return 1;
  }

  async clear(): Promise<void> {}
}

function contextFor(action: string | undefined, headers: Record<string, string> = {}) {
  const request = {
    headers,
    socket: { remoteAddress: CLIENT },
  } as unknown as FastifyRequest;

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => {
      const handler = () => undefined;
      if (action !== undefined) {
        Reflect.defineMetadata(RATE_LIMIT_ACTION_METADATA, action, handler);
      }
      return handler;
    },
    getClass: () => class Anonymous {},
  } as unknown as ExecutionContext;
}

function guardWith(port: RateLimitPort): { guard: RateLimitGuard; health: RateLimitHealth } {
  const health = new RateLimitHealth();
  return { guard: new RateLimitGuard(new Reflector(), CONFIG, port, health), health };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a route with no decorator', () => {
  it('is allowed without touching the store at all', async () => {
    // The branch `POST /v1/auth/logout` takes. It matters that the store is not
    // consulted: a Valkey outage must not slow down, or log about, a route that
    // was never limited.
    const port = new RecordingPort();
    const { guard } = guardWith(port);

    await expect(guard.canActivate(contextFor(undefined))).resolves.toBe(true);

    expect(port.hits).toEqual([]);
    expect(port.reads).toEqual([]);
  });

  it('ignores metadata that is not a declared action', async () => {
    // A typo in a decorator would otherwise build keys under a name nothing else
    // uses — a limit that exists, counts, and never blocks anything.
    const port = new RecordingPort();
    const { guard } = guardWith(port);

    await expect(guard.canActivate(contextFor('auth_logout'))).resolves.toBe(true);
    expect(port.hits).toEqual([]);
  });
});

describe('the order the store is consulted in', () => {
  it('reads the standing lock BEFORE spending counter budget', async () => {
    const port = new RecordingPort({
      remainingSeconds: () => 42,
    });
    const { guard } = guardWith(port);

    await expect(guard.canActivate(contextFor('auth_start'))).rejects.toBeInstanceOf(
      RateLimitedException,
    );

    // Somebody already locked out should not also lose a counter slot.
    expect(port.reads).toEqual([bruteForceLockKey('ip', CLIENT)]);
    expect(port.hits).toEqual([]);
  });

  it('counts against the address on a browser leg', async () => {
    const port = new RecordingPort();
    const { guard } = guardWith(port);

    await guard.canActivate(contextFor('auth_start'));

    expect(port.hits).toEqual([rateLimitKey('ip', 'auth_start', CLIENT)]);
  });

  it('counts both dimensions on a json leg that presents a credential', async () => {
    const port = new RecordingPort();
    const { guard } = guardWith(port);

    await guard.canActivate(contextFor('auth_refresh', { cookie: 'stuwith_refresh=abc' }));

    expect(port.hits).toHaveLength(2);
    expect(port.hits[0]).toContain(':ip:auth_refresh:');
    expect(port.hits[1]).toContain(':user:auth_refresh:');
  });

  it('refuses when a counter refuses, carrying the store’s own seconds', async () => {
    const port = new RecordingPort({
      hit: () => ({ ok: false as const, reason: 'RateLimited' as const, retryAfterSeconds: 17 }),
    });
    const { guard } = guardWith(port);

    const refusal = await guard.canActivate(contextFor('auth_me')).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RateLimitedException);
    expect((refusal as RateLimitedException).retryAfterSeconds).toBe(17);
    expect((refusal as RateLimitedException).channel).toBe('json');
  });
});

describe('a store fault fails OPEN, and says so once', () => {
  it('allows the request and reports the outage', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const port = new RecordingPort({ hit: () => new Error('Command timed out') });
    const { guard, health } = guardWith(port);

    await expect(guard.canActivate(contextFor('auth_me'))).resolves.toBe(true);

    expect(health.isDegraded()).toBe(true);
  });

  it('clears the degraded state once the store answers again', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    let broken = true;
    const port = new RecordingPort({
      hit: () => (broken ? new Error('Command timed out') : { ok: true, count: 1, remaining: 4 }),
    });
    const { guard, health } = guardWith(port);

    await guard.canActivate(contextFor('auth_me'));
    broken = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await guard.canActivate(contextFor('auth_me'));
    }

    expect(health.isDegraded()).toBe(false);
  });
});

/**
 * The invariant asserted in the guard docblock, the port docblock and `AGENTS.md`,
 * and until now in no test anywhere. Removing the `instanceof` check would report a
 * permanent code defect — a malformed key, a hashing bug — for ever as a Valkey
 * outage, while the layer failed open and never blocked anybody again.
 */
describe('a CODE defect is not laundered into a fail-open', () => {
  it('rethrows RateLimitInputError instead of allowing the request', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const port = new RecordingPort({ hit: () => new RateLimitInputError('key is not usable') });
    const { guard, health } = guardWith(port);

    await expect(guard.canActivate(contextFor('auth_me'))).rejects.toBeInstanceOf(
      RateLimitInputError,
    );

    // And it is NOT reported as an outage: the alarm would point at Valkey while
    // the bug sat in this repository.
    expect(health.isDegraded()).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('rethrows one raised by the lock read too, not only by the counter', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const port = new RecordingPort({
      remainingSeconds: () => new RateLimitInputError('key is not usable'),
    });
    const { guard, health } = guardWith(port);

    await expect(guard.canActivate(contextFor('auth_start'))).rejects.toBeInstanceOf(
      RateLimitInputError,
    );
    expect(health.isDegraded()).toBe(false);
  });
});
