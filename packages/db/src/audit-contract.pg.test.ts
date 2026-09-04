import type { AuditEventInput, AuditPort } from '@stuwith/domain';
import type { Pool } from 'pg';
import { PgAuditAdapter } from './pg/audit-adapter';
import { createPool } from './pool';
import { runAuditPortContract } from './test-kit';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #3, pass 2 of 2 for `AuditPort` — the pass that actually executes the
 * INSERT.
 *
 * It connects as `stuwith_api`, not as the owner, so it simultaneously proves the
 * story's `GRANT INSERT ON audit_events` is sufficient for this exact statement.
 * Reading the rows back goes through the OWNER connection: the app role has SELECT,
 * but reading as the writer would let a "wrote it into the wrong column" bug agree
 * with itself.
 */
let started: StartedPostgres | undefined;

interface AuditRow {
  source_service: string;
  action: string;
  actor_user_id: string | null;
  subject_id: string | null;
  request_id: string;
  occurred_at: Date;
  metadata: Record<string, string | number | boolean>;
}

runAuditPortContract({
  label: 'postgres-18 (testcontainers)',
  skip: testcontainersDisabled,
  createHarness: async () => {
    started = await startPostgres();
    await applyMigrations(started.connectionString);

    const pool = createPool(
      started.connectionStringFor('stuwith_api', TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD),
    );
    const adminUrl = started.connectionString;
    const faultingPools: Pool[] = [];

    return {
      port: new PgAuditAdapter(pool),

      // TRUNCATE as the owner. Neither process role holds DELETE or TRUNCATE on
      // this table — that is the whole point of AD-12 — so a reset that worked
      // through the app role would be exercising a privilege that must not exist.
      reset: async () => {
        await withClient(adminUrl, (client) => client.query('TRUNCATE TABLE audit_events'));
      },

      rows: async (): Promise<readonly AuditEventInput[]> => {
        const result = await withClient(adminUrl, (client) =>
          client.query<AuditRow>(
            `SELECT source_service, action, actor_user_id, subject_id,
                    request_id, occurred_at, metadata
               FROM audit_events
              ORDER BY occurred_at, id`,
          ),
        );
        return result.rows.map((row) => ({
          sourceService: row.source_service as AuditEventInput['sourceService'],
          action: row.action as AuditEventInput['action'],
          actorUserId: row.actor_user_id,
          subjectId: row.subject_id,
          requestId: row.request_id,
          occurredAt: row.occurred_at,
          metadata: row.metadata,
        }));
      },

      createFaultingPort: async (): Promise<AuditPort> => {
        const deadPool = createPool('postgres://nobody:nobody@127.0.0.1:1/nowhere', {
          connectionTimeoutMillis: 2_000,
        });
        deadPool.on('error', () => {});
        faultingPools.push(deadPool);
        return new PgAuditAdapter(deadPool);
      },

      teardown: async () => {
        const failures: unknown[] = [];
        const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
          try {
            await fn();
          } catch (error) {
            failures.push(new Error(`${label} failed: ${String(error)}`));
          }
        };

        for (const deadPool of faultingPools) {
          await attempt('faulting pool end', () => deadPool.end());
        }
        await attempt('pool end', () => pool.end());
        await attempt('container stop', async () => {
          await started?.stop();
        });
        started = undefined;

        if (failures.length > 0) {
          throw new AggregateError(failures, 'teardown did not complete cleanly');
        }
      },
    };
  },
});
