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
      teardown: async () => {
        await pool.end();
        await started?.stop();
        started = undefined;
      },
    };
  },
});
