import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  readSeed,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #4 — "migrations run against a copy of the database that already has
 * data", plus the AD-8 half of the story-1.1 acceptance criteria (two roles, write
 * ownership enforced by GRANT rather than by prose).
 *
 * Running migrations on an empty schema proves almost nothing: the schema that
 * matters is the one with rows in it.
 */
const suite = testcontainersDisabled ? describe.skip : describe;

suite('migrations on a database that already has data', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    await applyMigrations(pg.connectionString);
    await withClient(pg.connectionString, (client) => client.query(readSeed()));
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  }, 120_000);

  it('is idempotent — a second `up` on a seeded database is a no-op', async () => {
    await applyMigrations(pg.connectionString);

    const rows = await withClient(pg.connectionString, (client) =>
      client.query<{ service_key: string; observed_at: Date }>(
        'SELECT service_key, observed_at FROM service_heartbeats ORDER BY service_key',
      ),
    );

    // The seeded rows survived. A migration that quietly truncates is the exact
    // failure this gate exists to catch.
    expect(rows.rows.map((r) => r.service_key)).toEqual(['api', 'realtime-gateway']);
  });

  it('runs on PostgreSQL 18 with pgvector available', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ server_version_num: string; extname: string | null }>(
        `SELECT current_setting('server_version_num') AS server_version_num,
                (SELECT extname FROM pg_extension WHERE extname = 'vector') AS extname`,
      ),
    );
    const row = result.rows[0];
    expect(Number(row?.server_version_num)).toBeGreaterThanOrEqual(180000);
    expect(row?.extname).toBe('vector');
  });

  it('assigns a time-sortable uuidv7 primary key without an extension', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM service_heartbeats ORDER BY service_key LIMIT 1`,
      ),
    );
    // Version nibble of a UUIDv7 is '7'.
    expect(result.rows[0]?.id?.charAt(14)).toBe('7');
  });

  describe('AD-8 — two roles, ownership enforced by GRANT', () => {
    /**
     * A throwaway table standing in for the first business table a later story
     * adds. It is created and dropped around EACH example rather than left behind:
     * the value of this fixture is a known seeded state, and a table surviving from
     * one example into the next makes the suite order-dependent — precisely the
     * property this file exists to rule out for migrations.
     *
     * `bigint GENERATED ALWAYS AS IDENTITY` is deliberate. An identity column owns
     * a sequence, and INSERT fails with "permission denied for sequence" unless
     * sequence privileges are granted too. A probe table with a plain `int` key
     * would never have surfaced that gap.
     */
    const PROBE = 'ad8_probe';

    beforeEach(async () => {
      await withClient(pg.connectionString, async (client) => {
        await client.query(`DROP TABLE IF EXISTS ${PROBE}`);
        await client.query(
          `CREATE TABLE ${PROBE} (
             id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
             label text NOT NULL
           )`,
        );
      });
    }, 60_000);

    afterEach(async () => {
      await withClient(pg.connectionString, (client) =>
        client.query(`DROP TABLE IF EXISTS ${PROBE}`),
      );
    }, 60_000);

    it('creates both login roles', async () => {
      const result = await withClient(pg.connectionString, (client) =>
        client.query<{ rolname: string; rolcanlogin: boolean }>(
          `SELECT rolname, rolcanlogin FROM pg_roles
            WHERE rolname IN ('stuwith_api', 'stuwith_realtime') ORDER BY rolname`,
        ),
      );
      expect(result.rows).toEqual([
        { rolname: 'stuwith_api', rolcanlogin: true },
        { rolname: 'stuwith_realtime', rolcanlogin: true },
      ]);
    });

    it('gives neither role DELETE on the shared infrastructure table', async () => {
      const result = await withClient(pg.connectionString, (client) =>
        client.query<{ role: string; can_delete: boolean }>(
          `SELECT r.rolname AS role,
                  has_table_privilege(r.rolname, 'service_heartbeats', 'DELETE') AS can_delete
             FROM pg_roles r
            WHERE r.rolname IN ('stuwith_api', 'stuwith_realtime')`,
        ),
      );
      for (const row of result.rows) {
        expect(row.can_delete, `${row.role} must not hold DELETE`).toBe(false);
      }
    });

    it('lets neither process create objects in `public`', async () => {
      // Default privileges are recorded against the CREATING role, so "only
      // migrations create tables here" has to be an enforced invariant rather than
      // an assumption: a table created by an app role would inherit nobody's
      // grants and would sit outside the ownership model entirely.
      const result = await withClient(pg.connectionString, (client) =>
        client.query<{ role: string; can_create: boolean }>(
          `SELECT r.rolname AS role,
                  has_schema_privilege(r.rolname, 'public', 'CREATE') AS can_create
             FROM pg_roles r
            WHERE r.rolname IN ('stuwith_api', 'stuwith_realtime')`,
        ),
      );
      expect(result.rows.length).toBe(2);
      for (const row of result.rows) {
        expect(row.can_create, `${row.role} must not hold CREATE on schema public`).toBe(false);
      }
    });

    it('records default privileges for TABLES and SEQUENCES, against a named role', async () => {
      // `ALTER DEFAULT PRIVILEGES` without `FOR ROLE` silently means
      // "FOR ROLE current_user", which is invisible until a migration is run by a
      // different role and starts producing tables that inherit nothing.
      // `pg_default_acl` is where that choice is actually recorded, so that is what
      // gets asserted — not the text of the migration.
      const result = await withClient(pg.connectionString, (client) =>
        client.query<{ owner: string; objtype: string }>(
          `SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype::text AS objtype
             FROM pg_default_acl d
             JOIN pg_namespace n ON n.oid = d.defaclnamespace
            WHERE n.nspname = 'public'
            ORDER BY objtype`,
        ),
      );

      // 'r' = relations (tables), 'S' = sequences.
      expect(
        result.rows.map((r) => r.objtype).sort(),
        'default privileges must cover TABLES and SEQUENCES',
      ).toEqual(['S', 'r']);
      for (const row of result.rows) {
        expect(row.owner, 'recorded against the role that runs migrations').toBe('postgres');
      }
    });

    it('DENIES writes on a NEW table by default — the posture `users` will rely on', async () => {
      const privileges = await withClient(pg.connectionString, (client) =>
        client.query<{
          role: string;
          can_select: boolean;
          can_update: boolean;
          can_insert: boolean;
        }>(
          `SELECT r.rolname AS role,
                  has_table_privilege(r.rolname, '${PROBE}', 'SELECT') AS can_select,
                  has_table_privilege(r.rolname, '${PROBE}', 'UPDATE') AS can_update,
                  has_table_privilege(r.rolname, '${PROBE}', 'INSERT') AS can_insert
             FROM pg_roles r
            WHERE r.rolname IN ('stuwith_api', 'stuwith_realtime')`,
        ),
      );

      expect(privileges.rows.length).toBe(2);
      for (const row of privileges.rows) {
        expect(row.can_select, `${row.role} should read a new table`).toBe(true);
        expect(row.can_update, `${row.role} must not write a new table by default`).toBe(false);
        expect(row.can_insert, `${row.role} must not write a new table by default`).toBe(false);
      }
    });

    it('grants sequence usage by default, so a granted INSERT actually works', async () => {
      // Without default privileges on SEQUENCES, the first story to add an
      // identity-keyed table and grant INSERT fails at runtime with "permission
      // denied for sequence" — a failure that only shows up once real data is
      // being written, which is the worst time to discover it.
      await withClient(pg.connectionString, (client) =>
        client.query(`GRANT INSERT ON TABLE ${PROBE} TO stuwith_api`),
      );

      const apiUrl = pg.connectionStringFor(
        'stuwith_api',
        TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD,
      );

      await expect(
        withClient(apiUrl, (client) =>
          client.query(`INSERT INTO ${PROBE} (label) VALUES ('written-by-api')`),
        ),
      ).resolves.toBeTruthy();
    });

    it('rejects an unauthorised write at the database, not in application code', async () => {
      await withClient(pg.connectionString, (client) =>
        client.query(`INSERT INTO ${PROBE} (label) VALUES ('seed')`),
      );

      const realtimeUrl = pg.connectionStringFor(
        'stuwith_realtime',
        TEST_ROLE_PASSWORDS.DB_ROLE_REALTIME_PASSWORD,
      );

      await expect(
        withClient(realtimeUrl, (client) =>
          client.query(`UPDATE ${PROBE} SET label = 'tampered'`),
        ),
      ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
    });
  });
});
