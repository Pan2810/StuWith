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

/**
 * Story 1.2 — the same two rules, now against the tables the story actually adds.
 *
 * The AD-8 block above proves the DEFAULT posture on an anonymous probe table.
 * That is necessary and not sufficient: a migration can be perfectly consistent
 * with the default posture and still hand the wrong role a write, because a GRANT
 * is an explicit statement and defaults have nothing to say about it. These
 * examples check the grants that were actually issued.
 */
suite('Story 1.2 — identity tables, ownership enforced by GRANT', () => {
  let pg2: StartedPostgres;
  let apiUrl: string;
  let realtimeUrl: string;

  beforeAll(async () => {
    pg2 = await startPostgres();
    await applyMigrations(pg2.connectionString);
    apiUrl = pg2.connectionStringFor('stuwith_api', TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD);
    realtimeUrl = pg2.connectionStringFor(
      'stuwith_realtime',
      TEST_ROLE_PASSWORDS.DB_ROLE_REALTIME_PASSWORD,
    );
  }, 300_000);

  afterAll(async () => {
    await pg2?.stop();
  }, 120_000);

  it('creates users, user_identities, sessions and audit_events', async () => {
    const result = await withClient(pg2.connectionString, (client) =>
      client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('users','user_identities','sessions','audit_events')
          ORDER BY table_name`,
      ),
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      'audit_events',
      'sessions',
      'user_identities',
      'users',
    ]);
  });

  /**
   * Story 1.4. This example used to assert the column did NOT exist; it now
   * asserts the three things about it that would each fail silently, against a
   * real PostgreSQL rather than against the SQL text (which
   * `identity-schema.test.ts` covers separately).
   *
   * `is_nullable` is the load-bearing one. Story 1.2 inserts a `users` row at
   * first login, before anybody has been asked anything, so a `NOT NULL` here
   * breaks every first sign-in — and it breaks it at INSERT time, in production,
   * on a code path no schema test would otherwise execute.
   */
  it('adds date_of_birth to users as a NULLABLE date, and to nothing else', async () => {
    const result = await withClient(pg2.connectionString, (client) =>
      client.query<{
        table_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT table_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'date_of_birth'
          ORDER BY table_name`,
      ),
    );

    expect(result.rows).toEqual([
      {
        table_name: 'users',
        // A DAY, not an instant: `timestamptz` would force every reader to pick a
        // time zone before it could say which day somebody was born on.
        data_type: 'date',
        // NULL is the "declaration not made yet" state, and the only one.
        is_nullable: 'YES',
        // No default, which is also what keeps `ADD COLUMN` catalogue-only on a
        // table that already has rows — the property this whole suite exists for.
        column_default: null,
      },
    ]);
  });

  it('adds no second column claiming to say whether the profile is complete', async () => {
    // One source of truth. Two columns describing one fact are two columns that
    // can disagree, and nothing in this schema could keep them in step.
    const result = await withClient(pg2.connectionString, (client) =>
      client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name IN ('profile_completed', 'is_over_18', 'age')`,
      ),
    );
    expect(result.rows).toEqual([]);
  });

  it('lets stuwith_api write date_of_birth without a column grant of its own', async () => {
    // Privileges are per TABLE in PostgreSQL, and `stuwith_api` already holds
    // UPDATE on `users` from the Story 1.2 migration — so the 1.4 migration adds
    // no GRANT at all. This is the example that proves the omission is correct
    // rather than forgotten.
    await expect(
      withClient(apiUrl, async (client) => {
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (display_name) VALUES ('Dob Writer') RETURNING id`,
        );
        const id = user.rows[0]?.id;
        const updated = await client.query(
          `UPDATE users SET date_of_birth = $2::date
            WHERE id = $1 AND date_of_birth IS NULL`,
          [id, '1999-04-02'],
        );
        /**
         * Put back what this example changed.
         *
         * No role in this repository holds `DELETE` (AD-12's posture, applied to
         * every table), so the row itself cannot go — but the COLUMN this suite is
         * about can, and leaving it set meant every later example in the same
         * database ran against a `users` table with a declared row in it that
         * nobody had asked for. That is the shape of a suite whose examples pass in
         * the order they were written and fail in any other.
         */
        await client.query(`UPDATE users SET date_of_birth = NULL WHERE id = $1`, [id]);
        return updated.rowCount;
      }),
    ).resolves.toBe(1);
  });

  it('gives stuwith_realtime no way to write it either', async () => {
    // AD-8: a person's identity, and therefore their age, has exactly one writer.
    const privileges = await withClient(pg2.connectionString, (client) =>
      client.query<{ can_update: boolean }>(
        `SELECT has_table_privilege('stuwith_realtime', 'users', 'UPDATE') AS can_update`,
      ),
    );
    expect(privileges.rows[0]?.can_update).toBe(false);
  });

  it('refuses a date the column cannot represent, at the database', async () => {
    /**
     * The `date` type is the floor under `parseDateOfBirth`: even a caller that
     * bypassed the application rule cannot store the 30th of February.
     *
     * The previous version of this example was `'2026-02-30'::date WHERE false`,
     * and it proved nothing about the column at all. A literal cast is folded
     * before the plan runs, so the throw came from the CAST — which happens whether
     * `date_of_birth` is a `date`, a `text` column, or absent from the schema
     * entirely. It was green in three worlds it claimed to distinguish.
     *
     * So the value arrives as a PARAMETER, on a row that really exists, and the
     * refusal therefore comes from the column accepting the write or not.
     */
    await expect(
      withClient(apiUrl, async (client) => {
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (display_name) VALUES ('Dob Rejecter') RETURNING id`,
        );
        return client.query(`UPDATE users SET date_of_birth = $2 WHERE id = $1`, [
          user.rows[0]?.id,
          '2026-02-30',
        ]);
      }),
    ).rejects.toThrow();

    // And the positive counterpart, on the same shaped statement: a real day IS
    // written. Without it, a column that refused everything — or a statement that
    // matched no row — would satisfy the assertion above perfectly.
    await expect(
      withClient(apiUrl, async (client) => {
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (display_name) VALUES ('Dob Accepter') RETURNING id`,
        );
        const id = user.rows[0]?.id;
        const updated = await client.query(
          `UPDATE users SET date_of_birth = $2 WHERE id = $1 AND date_of_birth IS NULL`,
          [id, '1999-04-02'],
        );
        await client.query(`UPDATE users SET date_of_birth = NULL WHERE id = $1`, [id]);
        return updated.rowCount;
      }),
    ).resolves.toBe(1);
  });

  it('lets stuwith_api write the identity tables', async () => {
    await expect(
      withClient(apiUrl, async (client) => {
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (display_name, email) VALUES ('Api Writer', 'api@example.test') RETURNING id`,
        );
        const id = user.rows[0]?.id;
        await client.query(
          `INSERT INTO user_identities (user_id, provider, provider_user_id)
           VALUES ($1, 'google', 'grant-probe-1')`,
          [id],
        );
        await client.query(`UPDATE users SET display_name = 'Renamed' WHERE id = $1`, [id]);
        return id;
      }),
    ).resolves.toBeTruthy();
  });

  it.each(['users', 'user_identities', 'sessions'])(
    'refuses an INSERT on %s from stuwith_realtime, at the database',
    async (table) => {
      const privileges = await withClient(pg2.connectionString, (client) =>
        client.query<{ can_insert: boolean; can_update: boolean; can_delete: boolean }>(
          `SELECT has_table_privilege('stuwith_realtime', $1, 'INSERT') AS can_insert,
                  has_table_privilege('stuwith_realtime', $1, 'UPDATE') AS can_update,
                  has_table_privilege('stuwith_realtime', $1, 'DELETE') AS can_delete`,
          [table],
        ),
      );
      const row = privileges.rows[0];
      expect(row?.can_insert, `${table} must not be insertable by realtime`).toBe(false);
      expect(row?.can_update, `${table} must not be updatable by realtime`).toBe(false);
      expect(row?.can_delete, `${table} must not be deletable by realtime`).toBe(false);
    },
  );

  it('rejects a realtime UPDATE on users with a real statement, not just a privilege bit', async () => {
    await withClient(pg2.connectionString, (client) =>
      client.query(`INSERT INTO users (display_name) VALUES ('victim') ON CONFLICT DO NOTHING`),
    );

    await expect(
      withClient(realtimeUrl, (client) => client.query(`UPDATE users SET display_name = 'x'`)),
    ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
  });

  it('lets BOTH roles append to audit_events', async () => {
    for (const [service, url] of [
      ['api', apiUrl],
      ['realtime-gateway', realtimeUrl],
    ] as const) {
      await expect(
        withClient(url, (client) =>
          client.query(
            `INSERT INTO audit_events (source_service, action, request_id, metadata)
             VALUES ($1, 'auth.signed_in', 'req-grant-probe', '{}'::jsonb)`,
            [service],
          ),
        ),
      ).resolves.toBeTruthy();
    }
  });

  it.each([
    ['stuwith_api', 'api'],
    ['stuwith_realtime', 'realtime'],
  ])('gives %s neither UPDATE nor DELETE on audit_events (AD-12)', async (role) => {
    const result = await withClient(pg2.connectionString, (client) =>
      client.query<{ can_update: boolean; can_delete: boolean; can_truncate: boolean }>(
        `SELECT has_table_privilege($1, 'audit_events', 'UPDATE')   AS can_update,
                has_table_privilege($1, 'audit_events', 'DELETE')   AS can_delete,
                has_table_privilege($1, 'audit_events', 'TRUNCATE') AS can_truncate`,
        [role],
      ),
    );
    const row = result.rows[0];
    expect(row?.can_update, `${role} must not be able to rewrite history`).toBe(false);
    expect(row?.can_delete, `${role} must not be able to erase history`).toBe(false);
    expect(row?.can_truncate, `${role} must not be able to empty the table`).toBe(false);
  });

  it('rejects a real UPDATE and a real DELETE on audit_events from the writing role', async () => {
    await withClient(apiUrl, (client) =>
      client.query(
        `INSERT INTO audit_events (source_service, action, request_id)
         VALUES ('api', 'auth.sign_in_failed', 'req-immutability-probe')`,
      ),
    );

    await expect(
      withClient(apiUrl, (client) =>
        client.query(`UPDATE audit_events SET action = 'auth.signed_in'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withClient(apiUrl, (client) => client.query(`DELETE FROM audit_events`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a duplicate (provider, provider_user_id) at the database', async () => {
    const userId = await withClient(apiUrl, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ('dup probe') RETURNING id`,
      );
      return result.rows[0]?.id ?? '';
    });

    await withClient(apiUrl, (client) =>
      client.query(
        `INSERT INTO user_identities (user_id, provider, provider_user_id)
         VALUES ($1, 'apple', 'dup-subject')`,
        [userId],
      ),
    );

    await expect(
      withClient(apiUrl, (client) =>
        client.query(
          `INSERT INTO user_identities (user_id, provider, provider_user_id)
           VALUES ($1, 'apple', 'dup-subject')`,
          [userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('rejects a role value the contract does not declare', async () => {
    await expect(
      withClient(apiUrl, (client) =>
        client.query(`INSERT INTO users (display_name, role) VALUES ('bad role', 'host')`),
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation — `host` is per-room
  });
});
