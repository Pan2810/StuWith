import type { RateLimitDecision, RateLimitPort } from '@stuwith/domain';
import {
  assertValidLimit,
  assertValidRateLimitKey,
  assertValidWindowSeconds,
  retryAfterSecondsFrom,
} from '@stuwith/domain';
import { HIT_COMMAND, LOCK_COMMAND, type ValkeyClient } from './client';

/**
 * The Valkey implementation of `RateLimitPort`.
 *
 * The two Lua scripts live in `client.ts`, registered with `defineCommand` so they
 * travel as `EVALSHA` rather than as source on every request; their docblocks
 * explain why each is one atomic step and why each repairs a missing expiry.
 *
 * ## What this file deliberately does NOT do
 *
 * There is no `try/catch` anywhere in it. The tempting version wraps every command
 * and returns "allowed" when Valkey is unreachable, and that single decision
 * breaks two things at once: a FAULT becomes a normal answer — the collapse
 * `heartbeat-port.ts` exists to forbid — and the caller loses the ability to tell
 * "this person still has attempts left" apart from "the counter is blind". Nobody
 * would then know the blocking layer had been off for a week.
 *
 * The fail-open decision is real and was made by a human on 2026-09-04. It lives
 * in `apps/api/src/rate-limit/rate-limit.guard.ts`, where there is enough context
 * to write the `error` line that says the layer is not working.
 */
export class ValkeyRateLimitAdapter implements RateLimitPort {
  constructor(private readonly client: ValkeyClient) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    assertValidRateLimitKey(key);
    assertValidLimit(limit);
    assertValidWindowSeconds(windowSeconds);

    const reply = await this.client[HIT_COMMAND](key, String(windowSeconds * 1_000));
    const [count, ttlMs] = readPair(reply);

    if (count > limit) {
      return { ok: false, reason: 'RateLimited', retryAfterSeconds: retryAfterSecondsFrom(ttlMs) };
    }
    return { ok: true, count, remaining: limit - count };
  }

  async remainingSeconds(key: string): Promise<number | null> {
    assertValidRateLimitKey(key);

    const ttlMs = readNumber(await this.client.pttl(key));
    // -2 is "no such key" and -1 is "no expiry". Both mean there is nothing to
    // wait for here: every key this adapter writes is written WITH an expiry, and
    // both scripts repair one that is somehow missing, so -1 can only be somebody
    // else's key sharing the namespace.
    return ttlMs < 0 ? null : retryAfterSecondsFrom(ttlMs);
  }

  async lock(key: string, seconds: number): Promise<number> {
    assertValidRateLimitKey(key);
    assertValidWindowSeconds(seconds);

    const ttlMs = readNumber(await this.client[LOCK_COMMAND](key, String(seconds * 1_000)));
    return retryAfterSecondsFrom(ttlMs);
  }

  async clear(key: string): Promise<void> {
    assertValidRateLimitKey(key);
    await this.client.del(key);
  }
}

/**
 * A Lua reply is `unknown` to the type system and an array of integers at runtime.
 * Reading it defensively is not ceremony: a reply that is not what we expect means
 * the script or the server changed underneath us, and silently treating that as
 * `count = 0` would switch the limit off without a single failing test.
 */
function readPair(reply: unknown): [number, number] {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error('valkey: unexpected reply shape from the rate-limit script');
  }
  return [readNumber(reply[0]), readNumber(reply[1])];
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error('valkey: expected an integer reply');
}
