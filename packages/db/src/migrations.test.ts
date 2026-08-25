import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

    it('DENIES writes on a NEW table by default — the posture `users` will rely on', async () => {
      await withClient(pg.connectionString, async (client) => {
        await client.query(`CREATE TABLE IF NOT EXISTS ad8_probe (id int primary key)`);
      });

      const privileges = await withClient(pg.connectionString, (client) =>
        client.query<{ role: string; can_select: boolean; can_update: boolean; can_insert: boolean }>(
          `SELECT r.rolname AS role,
                  has_table_privilege(r.rolname, 'ad8_probe', 'SELECT') AS can_select,
                  has_table_privilege(r.rolname, 'ad8_probe', 'UPDATE') AS can_update,
                  has_table_privilege(r.rolname, 'ad8_probe', 'INSERT') AS can_insert
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

    it('rejects an unauthorised write at the database, not in application code', async () => {
      await withClient(pg.connectionString, async (client) => {
        await client.query(`CREATE TABLE IF NOT EXISTS ad8_probe (id int primary key)`);
        await client.query(`INSERT INTO ad8_probe (id) VALUES (1) ON CONFLICT DO NOTHING`);
      });

      const realtimeUrl = pg.connectionStringFor(
        'stuwith_realtime',
        TEST_ROLE_PASSWORDS.DB_ROLE_REALTIME_PASSWORD,
      );

      await expect(
        withClient(realtimeUrl, (client) => client.query(`UPDATE ad8_probe SET id = 2`)),
      ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
    });
  });
});
