import type {
  Heartbeat,
  HeartbeatPort,
  RecordHeartbeatResult,
} from '@stuwith/domain';
import { supersedes } from '@stuwith/domain';

/**
 * Lives in packages/db, not in packages/domain: an in-memory store is still an
 * adapter, and AD-1 says the domain imports no adapter at all. It exists so the
 * shared contract suite can run twice (TD-5) — once here, once against real PG18.
 */
export class InMemoryHeartbeatAdapter implements HeartbeatPort {
  private readonly rows = new Map<string, Date>();

  async record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult> {
    const stored = this.rows.get(serviceKey) ?? null;
    if (!supersedes(observedAt, stored)) {
      return { ok: false, reason: 'StaleObservation' };
    }
    this.rows.set(serviceKey, new Date(observedAt.getTime()));
    return { ok: true, heartbeat: { serviceKey, observedAt: new Date(observedAt.getTime()) } };
  }

  async latest(serviceKey: string): Promise<Heartbeat | null> {
    const observedAt = this.rows.get(serviceKey);
    return observedAt === undefined
      ? null
      : { serviceKey, observedAt: new Date(observedAt.getTime()) };
  }

  clear(): void {
    this.rows.clear();
  }
}
