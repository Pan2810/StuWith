import { describe, expect, it } from 'vitest';
import { FixedClock } from '../ports/clock-port';
import type { HeartbeatPort, RecordHeartbeatResult } from '../ports/heartbeat-port';
import { DEFAULT_LIVENESS_TTL_MS, isHeartbeatStale, supersedes } from './liveness';

/**
 * No setup file, no DB, no network, no timers. If this test ever needs any of
 * those, AD-1 has already been broken somewhere upstream (TD-1).
 *
 * The fake below is declared inline on purpose: packages/domain must not import an
 * adapter, not even a test one — the in-memory adapter lives in packages/db.
 */
class InlineHeartbeatFake implements HeartbeatPort {
  private readonly rows = new Map<string, Date>();

  async record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult> {
    const stored = this.rows.get(serviceKey) ?? null;
    if (!supersedes(observedAt, stored)) {
      return { ok: false, reason: 'StaleObservation' };
    }
    this.rows.set(serviceKey, observedAt);
    return { ok: true, heartbeat: { serviceKey, observedAt } };
  }

  async latest(serviceKey: string) {
    const observedAt = this.rows.get(serviceKey);
    return observedAt === undefined ? null : { serviceKey, observedAt };
  }
}

describe('isHeartbeatStale', () => {
  const clock = new FixedClock(new Date('2026-08-21T00:00:00.000Z'));

  it('treats a missing heartbeat as stale', () => {
    expect(isHeartbeatStale(null, clock)).toBe(true);
  });

  it('accepts a heartbeat exactly at the TTL boundary', () => {
    const observedAt = new Date(clock.now().getTime() - DEFAULT_LIVENESS_TTL_MS);
    expect(isHeartbeatStale({ serviceKey: 'api', observedAt }, clock)).toBe(false);
  });

  it('rejects a heartbeat one millisecond past the TTL', () => {
    const observedAt = new Date(clock.now().getTime() - DEFAULT_LIVENESS_TTL_MS - 1);
    expect(isHeartbeatStale({ serviceKey: 'api', observedAt }, clock)).toBe(true);
  });
});

describe('supersedes', () => {
  it('lets any observation win against no stored row', () => {
    expect(supersedes(new Date(0), null)).toBe(true);
  });

  it('refuses an equal timestamp, so a replayed write is not treated as progress', () => {
    const at = new Date('2026-08-21T00:00:00.000Z');
    expect(supersedes(at, at)).toBe(false);
  });
});

describe('HeartbeatPort refusal branch', () => {
  it('returns StaleObservation instead of throwing', async () => {
    const port = new InlineHeartbeatFake();
    const newer = new Date('2026-08-21T00:00:10.000Z');
    const older = new Date('2026-08-21T00:00:05.000Z');

    expect(await port.record('api', newer)).toEqual({
      ok: true,
      heartbeat: { serviceKey: 'api', observedAt: newer },
    });

    const stale = await port.record('api', older);
    expect(stale).toEqual({ ok: false, reason: 'StaleObservation' });

    // The stored row is untouched by the refused write.
    expect(await port.latest('api')).toEqual({ serviceKey: 'api', observedAt: newer });
  });
});
