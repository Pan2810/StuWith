import type { Heartbeat, HeartbeatPort, RecordHeartbeatResult } from '@stuwith/domain';
import { assertValidHeartbeatInput, assertValidServiceKey, supersedes } from '@stuwith/domain';

/**
 * Lives in packages/db, not in packages/domain: an in-memory store is still an
 * adapter, and AD-1 says the domain imports no adapter at all. It exists so the
 * shared contract suite can run twice (TD-5) — once here, once against real PG18.
 */
export class InMemoryHeartbeatAdapter implements HeartbeatPort {
  private readonly rows = new Map<string, Date>();

  async record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult> {
    // Same guard as the Postgres adapter, for the same reason: an in-memory Map
    // will happily store an `Invalid Date` that Postgres would have rejected, and
    // the two adapters must not disagree about what is a legal call.
    assertValidHeartbeatInput(serviceKey, observedAt);

    const stored = this.rows.get(serviceKey) ?? null;
    if (!supersedes(observedAt, stored)) {
      return { ok: false, reason: 'StaleObservation' };
    }
    this.rows.set(serviceKey, new Date(observedAt.getTime()));
    return { ok: true, heartbeat: { serviceKey, observedAt: new Date(observedAt.getTime()) } };
  }

  async latest(serviceKey: string): Promise<Heartbeat | null> {
    assertValidServiceKey(serviceKey);

    const observedAt = this.rows.get(serviceKey);
    return observedAt === undefined
      ? null
      : { serviceKey, observedAt: new Date(observedAt.getTime()) };
  }

  clear(): void {
    this.rows.clear();
  }
}
