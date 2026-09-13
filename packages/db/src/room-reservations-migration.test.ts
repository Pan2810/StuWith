import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * Story 2.2's migration, checked the two ways Story 2.1's is.
 *
 * The first block reads the SQL the migration EMITS against a fake `pgm` and pins
 * the properties the story depends on: both foreign keys RESTRICT, the UNIQUE and
 * CHECK exist, `banned_at` is nullable with no default, and the grants name one
 * role. The second block is **the GRANT probe the story declared** (AC1): a real
 * `INSERT`, `UPDATE` and `DELETE` under `stuwith_realtime` on a real PG18, each
 * expected to fail `42501` — and the same three under `stuwith_api`, expected to
 * succeed, because a probe that refused everything would satisfy the first half
 * perfectly.
 *
 * ## The file name is load-bearing
 *
 * CI gate 4 is `vitest run --project db migration`, which filters by FILE NAME.
 * The word `migration` in this name is what puts it in gate 4.
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  'migrations',
  '1788480300000_room-reservations.js',
);

interface FakePgm {
  sql(statement: string): void;
}

function statements(): string[] {
  const collected: string[] = [];
  const pgm: FakePgm = { sql: (statement) => void collected.push(statement) };
  const migration = require(MIGRATION) as { up: (pgm: FakePgm) => void };
  migration.up(pgm);
  return collected;
}

function statementContaining(needle: string): string {
  const found = statements().find((statement) => statement.includes(needle));
  if (found === undefined) {
    throw new Error(`no migration statement contains ${needle}`);
  }
  return found;
}

beforeEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

afterEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

describe('the migration cannot lose the properties the story depends on', () => {
  it('emits statements at all, so every comparison below is over something', () => {
    expect(statements().length).toBeGreaterThanOrEqual(8);
  });

  it('adds users.banned_at as a NULLABLE timestamptz with NO default', () => {
    // Nullable and defaultless is the design: `NULL` is the only not-banned state
    // and every existing person is not banned. A `DEFAULT now()` here would ban
    // everybody on migration day.
    const statement = statementContaining('ADD COLUMN banned_at');
    expect(statement).toMatch(/banned_at\s+timestamptz\s+NULL/);
    expect(statement).not.toMatch(/DEFAULT/i);
    expect(statement).not.toMatch(/NOT\s+NULL/i);
  });

  it('makes BOTH foreign keys ON DELETE RESTRICT, and never CASCADE', () => {
    // A cascade on `room_id` would let a room disappear "with its reservations";
    // one on `user_id` would let a `users` delete reach into a table about rooms.
    // `deferred-work.md` records the CASCADE trap by name.
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS room_reservations');
    expect(statement).toContain('REFERENCES rooms (id) ON DELETE RESTRICT');
    expect(statement).toContain('REFERENCES users (id) ON DELETE RESTRICT');
    expect(statement).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
  });

  it('declares one seat per (room, person) and an expiry after the reservation', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS room_reservations');
    expect(statement).toContain('UNIQUE (room_id, user_id)');
    expect(statement).toContain('CHECK (expires_at > reserved_at)');
  });

  it('indexes (room_id, expires_at), the pair the reap and the count scan on', () => {
    const statement = statementContaining('CREATE INDEX IF NOT EXISTS');
    expect(statement).toContain('ON room_reservations (room_id, expires_at)');
  });

  it('grants INSERT, UPDATE and DELETE on room_reservations to stuwith_api, and to nobody else', () => {
    const grants = statements().filter((s) => s.trimStart().startsWith('GRANT'));
    expect(grants).toHaveLength(1);
    const grant = grants[0] ?? '';
    expect(grant).toContain('ON TABLE room_reservations');
    expect(grant).toContain('TO stuwith_api');
    expect(grant).not.toContain('stuwith_realtime');
    // DELETE IS granted, on this table alone: a reservation is a lifetime the
    // writing process both grants and reaps (AD-22). TRUNCATE is not.
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(grant).toContain(privilege);
    }
    expect(grant).not.toContain('TRUNCATE');
  });

  it('grants nothing on rooms — the FOR UPDATE rides on the UPDATE 2.1 already gave', () => {
    // A new grant on `rooms` here would be a second statement of a privilege
    // already held, and an invitation for the two to drift.
    for (const statement of statements()) {
      expect(statement).not.toMatch(/GRANT[^;]*ON\s+TABLE\s+rooms\b/i);
    }
  });

  it('states the revocation from stuwith_realtime, TRUNCATE included', () => {
    const revoke = statements().find((s) => s.trimStart().startsWith('REVOKE'));
    expect(revoke).toContain('ON TABLE room_reservations');
    expect(revoke).toContain('FROM stuwith_realtime');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(revoke).toContain(privilege);
    }
  });

  it('names AD-22 and the RESTRICT posture in the table comment', () => {
    // The one place a DBA reading `\d+ room_reservations` will see why the
    // process that inserts is also the process that deletes.
    const comment = statements().find((s) => s.includes('COMMENT ON TABLE room_reservations'));
    expect(comment).toBeDefined();
    expect(comment).toContain('AD-22');
    expect(comment).toContain('RESTRICT');
    expect(comment).toContain('not presence');
  });

  it('brings both role comments into line with the grants that now exist', () => {
    const comments = statements().filter((s) => s.includes('COMMENT ON ROLE'));
    expect(comments).toHaveLength(2);
    expect(comments.find((s) => s.includes('ROLE stuwith_api'))).toContain('room_reservations');
    expect(comments.find((s) => s.includes('ROLE stuwith_realtime'))).toContain('room_reservations');
  });
});

/* -------------------------------------------------------------------------- *
 * The GRANT probe — real roles, real statements, a real PostgreSQL 18
 * -------------------------------------------------------------------------- */

const suite = testcontainersDisabled ? describe.skip : describe;

suite('Story 2.2 — room_reservations, ownership enforced by GRANT', () => {
  let pg: StartedPostgres;
  let apiUrl: string;
  let realtimeUrl: string;

  beforeAll(async () => {
    pg = await startPostgres();
    await applyMigrations(pg.connectionString);
    apiUrl = pg.connectionStringFor('stuwith_api', TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD);
    realtimeUrl = pg.connectionStringFor(
      'stuwith_realtime',
      TEST_ROLE_PASSWORDS.DB_ROLE_REALTIME_PASSWORD,
    );
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  }, 120_000);

  /**
   * The id a seed statement returned, or a failure that NAMES the seed.
   *
   * Not `?? ''`: an empty string handed to the next statement surfaces later as a
   * blind `22P02 invalid input syntax for type uuid` on a line that did nothing
   * wrong, and the probe's real finding — a GRANT that stopped the seed itself —
   * is lost. Same posture as `room-reservation-contract.pg.test.ts`.
   */
  const returnedId = (label: string, rows: ReadonlyArray<{ id: string }>): string => {
    const id = rows[0]?.id;
    if (id === undefined || id.length === 0) {
      throw new Error(`seeding ${label} returned no row — the INSERT ... RETURNING id produced nothing`);
    }
    return id;
  };

  /** A room and a person, through the writing role. */
  const seed = async (): Promise<{ userId: string; roomId: string }> =>
    withClient(apiUrl, async (client) => {
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ('Seat Taker') RETURNING id`,
      );
      const userId = returnedId('the user', user.rows);
      const room = await client.query<{ id: string }>(
        `INSERT INTO rooms (owner_user_id, name, topic, visibility, max_participants)
         VALUES ($1, 'Phong hoc', 'on_thi', 'public', 6) RETURNING id`,
        [userId],
      );
      return { userId, roomId: returnedId('the room', room.rows) };
    });

  /** A reservation, through the writing role, so UPDATE/DELETE probes have a row. */
  const seedReservation = async (): Promise<{ userId: string; roomId: string; id: string }> => {
    const { userId, roomId } = await seed();
    const result = await withClient(apiUrl, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO room_reservations (room_id, user_id, reserved_at, expires_at)
         VALUES ($1, $2, now(), now() + interval '120 seconds') RETURNING id`,
        [roomId, userId],
      ),
    );
    return { userId, roomId, id: returnedId('the reservation', result.rows) };
  };

  it('creates the room_reservations table', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'room_reservations'`,
      ),
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(['room_reservations']);
  });

  it('adds users.banned_at nullable, with NULL as the default, on a table with rows', async () => {
    const column = await withClient(pg.connectionString, (client) =>
      client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'banned_at'`,
      ),
    );
    expect(column.rows[0]?.data_type).toBe('timestamp with time zone');
    expect(column.rows[0]?.is_nullable).toBe('YES');
    expect(column.rows[0]?.column_default).toBeNull();

    // And a row inserted without naming it is not banned.
    const { userId } = await seed();
    const row = await withClient(pg.connectionString, (client) =>
      client.query<{ banned_at: Date | null }>(`SELECT banned_at FROM users WHERE id = $1`, [
        userId,
      ]),
    );
    expect(row.rows[0]?.banned_at).toBeNull();
  });

  /**
   * THE PROBE, AC1. Three verbs under `stuwith_realtime`, each a real statement,
   * each expected `42501`. `has_table_privilege` reports the catalogue; a statement
   * reports what the database does, and the two can differ.
   *
   * The mutation that turns this red is in the spec: add
   * `GRANT INSERT ON TABLE room_reservations TO stuwith_realtime` to the migration
   * AFTER the `REVOKE` (before it, the REVOKE takes it straight back — the belt
   * and braces the 2.1 probe measured).
   */
  it('refuses a real INSERT into room_reservations from stuwith_realtime, with 42501', async () => {
    const { userId, roomId } = await seed();
    await expect(
      withClient(realtimeUrl, (client) =>
        client.query(
          `INSERT INTO room_reservations (room_id, user_id, reserved_at, expires_at)
           VALUES ($1, $2, now(), now() + interval '120 seconds')`,
          [roomId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a real UPDATE of room_reservations from stuwith_realtime, with 42501', async () => {
    const { id } = await seedReservation();
    await expect(
      withClient(realtimeUrl, (client) =>
        client.query(
          `UPDATE room_reservations SET expires_at = now() + interval '1 hour' WHERE id = $1`,
          [id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a real DELETE from room_reservations from stuwith_realtime, with 42501', async () => {
    const { id } = await seedReservation();
    await expect(
      withClient(realtimeUrl, (client) =>
        client.query(`DELETE FROM room_reservations WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets stuwith_api do all three — the positive control for the probe above', async () => {
    const { userId, roomId } = await seed();
    await withClient(apiUrl, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO room_reservations (room_id, user_id, reserved_at, expires_at)
         VALUES ($1, $2, now(), now() + interval '120 seconds') RETURNING id`,
        [roomId, userId],
      );
      const id = inserted.rows[0]?.id;
      expect(id).toBeDefined();

      const updated = await client.query(
        `UPDATE room_reservations SET expires_at = now() + interval '240 seconds' WHERE id = $1`,
        [id],
      );
      expect(updated.rowCount).toBe(1);

      const deleted = await client.query(`DELETE FROM room_reservations WHERE id = $1`, [id]);
      expect(deleted.rowCount).toBe(1);
    });
  });

  it('lets stuwith_api lock a room row FOR UPDATE, which the adapter depends on', async () => {
    // `SELECT ... FOR UPDATE` needs UPDATE on the table. 2.1 granted it; this is
    // what says the reservation transaction can begin at all under the app role.
    const { roomId } = await seed();
    const result = await withClient(apiUrl, async (client) => {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT status FROM rooms WHERE id = $1 FOR UPDATE`, [
        roomId,
      ]);
      await client.query('ROLLBACK');
      return locked;
    });
    expect(result.rowCount).toBe(1);
  });

  it('lets stuwith_realtime READ room_reservations, the half it is supposed to have', async () => {
    await seedReservation();
    const result = await withClient(realtimeUrl, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text AS count FROM room_reservations'),
    );
    expect(Number(result.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });

  it('gives NO role TRUNCATE on room_reservations', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ role: string; can_truncate: boolean }>(
        `SELECT r.rolname AS role,
                has_table_privilege(r.rolname, 'room_reservations', 'TRUNCATE') AS can_truncate
           FROM pg_roles r
          WHERE r.rolname IN ('stuwith_api', 'stuwith_realtime')`,
      ),
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.can_truncate, `${row.role} must not be able to empty the table`).toBe(false);
    }
  });

  it('refuses a second seat for the same person in the same room, with 23505', async () => {
    // The UNIQUE is real, not a comment. The adapter renews rather than inserts,
    // and this is the constraint that makes that a fact of the schema.
    const { userId, roomId } = await seedReservation();
    await expect(
      withClient(apiUrl, (client) =>
        client.query(
          `INSERT INTO room_reservations (room_id, user_id, reserved_at, expires_at)
           VALUES ($1, $2, now(), now() + interval '120 seconds')`,
          [roomId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('refuses a seat that expires before it was reserved, with 23514', async () => {
    const { userId, roomId } = await seed();
    await expect(
      withClient(apiUrl, (client) =>
        client.query(
          `INSERT INTO room_reservations (room_id, user_id, reserved_at, expires_at)
           VALUES ($1, $2, now(), now())`,
          [roomId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('blocks deleting a user who holds a seat, and keeps the seat', async () => {
    // `23001` restrict_violation, not `23503`: RESTRICT is checked immediately and
    // cannot be deferred, and the SQLSTATE is the one observable that says which
    // referential action is in force (the 2.1 probe records the distinction).
    const { userId, id } = await seedReservation();
    await expect(
      withClient(pg.connectionString, (client) =>
        client.query(`DELETE FROM users WHERE id = $1`, [userId]),
      ),
    ).rejects.toMatchObject({ code: '23001' });

    const after = await withClient(pg.connectionString, (client) =>
      client.query<{ id: string }>(`SELECT id FROM room_reservations WHERE id = $1`, [id]),
    );
    expect(after.rows.map((r) => r.id)).toEqual([id]);
  });

  it('blocks deleting a room that has a seat, even for the owner, and keeps both', async () => {
    // Gate AC5 of Story 2.1 stays true from this side too: the one caller who could
    // delete a room (a DBA, as the owner) meets RESTRICT here as well.
    const { roomId, id } = await seedReservation();
    await expect(
      withClient(pg.connectionString, (client) =>
        client.query(`DELETE FROM rooms WHERE id = $1`, [roomId]),
      ),
    ).rejects.toMatchObject({ code: '23001' });

    const after = await withClient(pg.connectionString, (client) =>
      client.query<{ id: string }>(`SELECT id FROM room_reservations WHERE id = $1`, [id]),
    );
    expect(after.rows.map((r) => r.id)).toEqual([id]);
  });
});
