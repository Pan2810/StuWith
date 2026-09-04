import type { Pool } from 'pg';
import { PgSessionAdapter } from './pg/session-adapter';
import { createPool } from './pool';
import { runSessionPortContract } from './test-kit';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #3, pass 2 of 2 for `SessionPort`.
 *
 * Two properties only a real database can settle: that "exactly one of two
 * concurrent rotations wins" is decided by a conditional UPDATE rather than by
 * JavaScript's single thread, and that the whole port works through the
 * `stuwith_api` GRANTs — including revocation, which is an UPDATE precisely
 * because no role holds DELETE.
 */
let started: StartedPostgres | undefined;

runSessionPortContract({
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
      port: new PgSessionAdapter(pool),

      reset: async () => {
        await withClient(adminUrl, (client) =>
          client.query('TRUNCATE TABLE sessions, user_identities, users CASCADE'),
        );
      },

      // `sessions.user_id` is a real foreign key, so the suite needs a real user.
      createUserId: async () => {
        const result = await withClient(adminUrl, (client) =>
          client.query<{ id: string }>(
            `INSERT INTO users (display_name) VALUES ('session contract user') RETURNING id`,
          ),
        );
        const id = result.rows[0]?.id;
        if (id === undefined) {
          throw new Error('could not create a user for the session contract suite');
        }
        return id;
      },

      createFaultingPort: async () => {
        const deadPool = createPool('postgres://nobody:nobody@127.0.0.1:1/nowhere', {
          connectionTimeoutMillis: 2_000,
        });
        deadPool.on('error', () => {});
        faultingPools.push(deadPool);
        return new PgSessionAdapter(deadPool);
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
