import type { Pool } from 'pg';
import { PgHeartbeatAdapter } from './pg/heartbeat-adapter';
import { createPool } from './pool';
import { runHeartbeatPortContract } from './test-kit';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #3, pass 2 of 2. Same suite, real database.
 *
 * This is the pass that catches the failure the spine warns about: an adapter that
 * drops the `WHERE` clause still satisfies every architecture rule on paper, and
 * only a real Postgres round trip shows that it silently accepts a stale write.
 */
let started: StartedPostgres | undefined;

runHeartbeatPortContract({
  label: `postgres-18 (testcontainers)`,
  skip: testcontainersDisabled,
  createHarness: async () => {
    started = await startPostgres();
    await applyMigrations(started.connectionString);

    // Connects as stuwith_api — so the suite also proves the GRANTs from the roles
    // migration are sufficient for the writes this port actually performs.
    const pool = createPool(
      started.connectionStringFor('stuwith_api', TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD),
    );
    const adminUrl = started.connectionString;
    const faultingPools: Pool[] = [];

    return {
      port: new PgHeartbeatAdapter(pool),
      // Truncated as the owner, not as stuwith_api: DELETE is deliberately never
      // granted to either process role, so a test that could delete would be
      // testing a permission the product must not have.
      reset: async () => {
        await withClient(adminUrl, (client) =>
          client.query('TRUNCATE TABLE service_heartbeats'),
        );
      },

      /**
       * A pool pointed at a port nothing is listening on — a genuine connection
       * fault rather than a stub. Proves the adapter lets it propagate instead of
       * converting it into `{ ok: false, reason: 'StaleObservation' }`.
       */
      createFaultingPort: async () => {
        const deadPool = createPool('postgres://nobody:nobody@127.0.0.1:1/nowhere', {
          connectionTimeoutMillis: 2_000,
        });
        // A pg Pool emits 'error' on background connection failures, and an
        // unhandled 'error' event takes the whole worker down.
        deadPool.on('error', () => {});
        faultingPools.push(deadPool);
        return new PgHeartbeatAdapter(deadPool);
      },

      /**
       * Every step runs even if an earlier one rejects. Previously `pool.end()`
       * came first and unguarded, so a pool that failed to drain meant
       * `container.stop()` was never reached and a Postgres container leaked on
       * the CI runner for the rest of the job.
       */
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
