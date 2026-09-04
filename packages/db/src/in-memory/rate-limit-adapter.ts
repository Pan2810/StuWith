import type { ClockPort, RateLimitDecision, RateLimitPort } from '@stuwith/domain';
import {
  assertValidLimit,
  assertValidRateLimitKey,
  assertValidWindowSeconds,
  retryAfterSecondsFrom,
} from '@stuwith/domain';

interface Entry {
  count: number;
  /** Absolute epoch milliseconds at which this key stops existing. */
  expiresAtMs: number;
}

/**
 * The in-memory half of the two-pass contract suite (TD-5).
 *
 * It lives in `packages/db` rather than in the domain for the same reason the
 * in-memory heartbeat adapter does: an in-memory store is still an adapter, and
 * AD-1 says the domain imports no adapter at all.
 *
 * The clock is INJECTED, and that is the point of the file rather than a detail.
 * Half the matrix is about time — a countdown that really decreases, a window that
 * really expires, a brute-force lock that outlives an ordinary one — and testing
 * any of it against the wall clock means either a flaky suite or a suite that
 * sleeps for fifteen minutes. With `FixedClock` the same assertions are exact and
 * instant, and the Valkey pass then proves the real store agrees.
 */
export class InMemoryRateLimitAdapter implements RateLimitPort {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: ClockPort) {}

  /**
   * ONE map for counters and locks, deliberately, because Valkey has one keyspace.
   *
   * Two maps would be tidier and would be a lie: in Valkey a counter and a lock are
   * both a string with an expiry, so `INCR` against a lock value returns 2 and
   * `SET … NX` against a counter is a no-op that leaves the counter's TTL. An
   * adapter that kept them apart would disagree with the real store on exactly
   * those calls — and production keeps the two key spaces separate
   * (`bruteForceCounterKey` vs `bruteForceLockKey`), so the divergence would never
   * show up anywhere but in a future feature that reused a key. The contract suite
   * now makes both of those calls against both adapters.
   */

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    assertValidRateLimitKey(key);
    assertValidLimit(limit);
    assertValidWindowSeconds(windowSeconds);

    const nowMs = this.clock.now().getTime();
    const existing = this.live(key, nowMs);

    // A fixed window: the first hit sets the expiry and later hits inside it do
    // NOT push it out. A window renewed on every attempt can never run out for
    // somebody who keeps hammering, so the countdown would never reach zero.
    const entry: Entry = existing ?? { count: 0, expiresAtMs: nowMs + windowSeconds * 1_000 };
    entry.count += 1;
    this.entries.set(key, entry);

    if (entry.count > limit) {
      return {
        ok: false,
        reason: 'RateLimited',
        retryAfterSeconds: retryAfterSecondsFrom(entry.expiresAtMs - nowMs),
      };
    }
    return { ok: true, count: entry.count, remaining: limit - entry.count };
  }

  async remainingSeconds(key: string): Promise<number | null> {
    assertValidRateLimitKey(key);

    const nowMs = this.clock.now().getTime();
    const entry = this.live(key, nowMs);
    return entry === null ? null : retryAfterSecondsFrom(entry.expiresAtMs - nowMs);
  }

  async lock(key: string, seconds: number): Promise<number> {
    assertValidRateLimitKey(key);
    assertValidWindowSeconds(seconds);

    const nowMs = this.clock.now().getTime();
    const existing = this.live(key, nowMs);
    if (existing !== null) {
      // Never shorten, and never restart. Re-locking on every later failure would
      // make the number the person is watching jump back up, and a lock that
      // cannot run out is a ban rather than a cool-down.
      return retryAfterSecondsFrom(existing.expiresAtMs - nowMs);
    }

    const expiresAtMs = nowMs + seconds * 1_000;
    this.entries.set(key, { count: 1, expiresAtMs });
    return retryAfterSecondsFrom(expiresAtMs - nowMs);
  }

  async clear(key: string): Promise<void> {
    assertValidRateLimitKey(key);
    this.entries.delete(key);
  }

  /** Expiry is lazy, exactly as it is in Valkey: a dead key simply is not there. */
  private live(key: string, nowMs: number): Entry | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  reset(): void {
    this.entries.clear();
  }
}
