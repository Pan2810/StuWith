import type { Heartbeat, HeartbeatPort, RecordHeartbeatResult } from '@stuwith/domain';
import { assertValidHeartbeatInput, assertValidServiceKey } from '@stuwith/domain';
import type { Pool } from 'pg';

interface HeartbeatRow {
  service_key: string;
  observed_at: Date;
}

/**
 * AD-6 in its Postgres form: one conditional statement, never read-then-write.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE` returns zero rows when the incoming
 * observation is not strictly newer, and that zero-row result IS the refusal
 * branch — the same mechanism `debit()` will use for InsufficientFunds in Epic 3.
 *
 * Note what is deliberately NOT caught: driver and server errors propagate
 * untouched. A deadlock (40P01), a serialization failure (40001) or a revoked
 * GRANT (42501) is a fault, and the port contract says a fault throws. Wrapping
 * them into `{ ok: false, reason: 'StaleObservation' }` would be the single most
 * damaging thing this file could do — every caller would read a broken database
 * as a routine, expected decision. Retrying 40001/40P01 is a policy decision for
 * the caller that owns the transaction, not for the adapter.
 */
export class PgHeartbeatAdapter implements HeartbeatPort {
  constructor(private readonly pool: Pool) {}

  async record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult> {
    // Checked here rather than left to Postgres so that both adapters reject the
    // same inputs with the same error, instead of one throwing a driver error and
    // the other silently storing `Invalid Date`.
    assertValidHeartbeatInput(serviceKey, observedAt);

    const result = await this.pool.query<HeartbeatRow>(
      `INSERT INTO service_heartbeats (service_key, observed_at)
       VALUES ($1, $2)
       ON CONFLICT (service_key) DO UPDATE
         SET observed_at = EXCLUDED.observed_at,
             recorded_at = now()
         WHERE service_heartbeats.observed_at < EXCLUDED.observed_at
       RETURNING service_key, observed_at`,
      [serviceKey, observedAt],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return { ok: false, reason: 'StaleObservation' };
    }
    return { ok: true, heartbeat: { serviceKey: row.service_key, observedAt: row.observed_at } };
  }

  async latest(serviceKey: string): Promise<Heartbeat | null> {
    assertValidServiceKey(serviceKey);

    const result = await this.pool.query<HeartbeatRow>(
      `SELECT service_key, observed_at FROM service_heartbeats WHERE service_key = $1`,
      [serviceKey],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { serviceKey: row.service_key, observedAt: row.observed_at };
  }
}
