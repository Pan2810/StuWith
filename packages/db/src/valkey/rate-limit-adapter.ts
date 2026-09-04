import type { RateLimitDecision, RateLimitPort } from '@stuwith/domain';
import {
  DEFAULT_REPAIR_SECONDS,
  assertValidLimit,
  assertValidRateLimitKey,
  assertValidWindowSeconds,
  retryAfterSecondsFrom,
} from '@stuwith/domain';
import { HIT_COMMAND, LOCK_COMMAND, REMAINING_COMMAND, type ValkeyClient } from './client';

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


/**
 * The reply from a script was not the shape this adapter expects.
 *
 * A distinct class, and not a plain `Error` mentioning Valkey, because of what
 * `apps/api` does with the difference. `isStoreFault` there decides whether a
 * failure earns the fail-open, and it used to match the WORD "valkey" anywhere in
 * a message — so this error, which means the script or this file is wrong while
 * Valkey is perfectly healthy, was classified as "the store could not answer".
 * The layer then failed open silently and the log pointed the operator at a
 * service that had nothing wrong with it. A bug of ours has to surface as the 500
 * it is, and a named class is what lets the other side tell the two apart without
 * reading prose.
 *
 * It is recognised across the package boundary by `name`, so `apps/api` needs no
 * import of `@stuwith/db` in the module that classifies errors.
 */
export class ValkeyReplyShapeError extends Error {
  override readonly name = 'ValkeyReplyShapeError';
}

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

  async remainingSeconds(key: string, repairSeconds = DEFAULT_REPAIR_SECONDS): Promise<number | null> {
    assertValidRateLimitKey(key);

    // Repairs a key that exists with no expiry, exactly as `hit` and `lock` do.
    // This is the path a LOCK is read through, so a key without an expiry here is
    // a permanent lockout with nothing to release it.
    const ttlMs = readNumber(
      await this.client[REMAINING_COMMAND](key, String(repairSeconds * 1_000)),
    );
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
    throw new ValkeyReplyShapeError('unexpected reply shape from the rate-limit script');
  }
  return [readNumber(reply[0]), readNumber(reply[1])];
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // Digits, not `Number()`. `Number('')` is `0`, which is the exact failure this
  // function's docblock says it prevents: an empty reply would have been read as
  // "count = 0" and switched the limit off for that key without a single failing
  // test. `Number(' ')` and `Number('0x10')` are the same class of accident.
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    return Number(value);
  }
  throw new ValkeyReplyShapeError('expected an integer reply');
}
