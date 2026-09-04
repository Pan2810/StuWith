import type { Pool } from 'pg';
import { PgIdentityAdapter } from './pg/identity-adapter';
import { createPool } from './pool';
import { runIdentityPortContract } from './test-kit';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #3, pass 2 of 2 for `IdentityPort`.
 *
 * This is the pass that can catch the failure the in-memory adapter cannot even
 * express: a read-then-write "find or create" looks correct in a single-threaded
 * Map and produces two `users` rows under a real concurrent INSERT. It also proves
 * the GRANTs from the story's migration are exactly sufficient for the writes this
 * adapter performs — it connects as `stuwith_api`, not as the owner.
 */
let started: StartedPostgres | undefined;

runIdentityPortContract({
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
      port: new PgIdentityAdapter(pool),

      // Truncated as the OWNER, not as stuwith_api: neither process role holds
      // DELETE or TRUNCATE, and a reset that worked through the app role would be
      // exercising a privilege the product must never have.
      reset: async () => {
        await withClient(adminUrl, (client) =>
          client.query('TRUNCATE TABLE user_identities, sessions, users CASCADE'),
        );
      },

      countUsers: async () => {
        const result = await withClient(adminUrl, (client) =>
          client.query<{ count: string }>('SELECT count(*)::text AS count FROM users'),
        );
        return Number(result.rows[0]?.count ?? '0');
      },

      createFaultingPort: async () => {
        const deadPool = createPool('postgres://nobody:nobody@127.0.0.1:1/nowhere', {
          connectionTimeoutMillis: 2_000,
        });
        deadPool.on('error', () => {});
        faultingPools.push(deadPool);
        return new PgIdentityAdapter(deadPool);
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
