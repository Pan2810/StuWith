import path from 'node:path';
import {
  DEFAULT_USER_PLAN,
  MAX_PARTICIPANTS_CEILING,
  ROOM_STATUSES,
  ROOM_TOPICS,
  ROOM_VISIBILITIES,
  USER_PLANS,
} from '@stuwith/contracts';
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
 * Story 2.1's migration, checked in the two ways that answer different questions.
 *
 * The first block reads the SQL the migration EMITS, against a fake `pgm`, and
 * compares its CHECK lists with the contract's enums — the same technique
 * `identity-schema.test.ts` uses, and for the same reason: a migration runs as
 * plain JavaScript before anything is built, so it cannot import the contract and
 * the link has to be a test. Without it the drift is silent and one-directional —
 * adding a seventh topic to `packages/contracts` makes every typecheck pass and
 * every room with that topic fail at INSERT time, in production, on a path no test
 * would have exercised.
 *
 * The second block is **the boundary probe this story declared** (`## Probe ranh
 * giới`, boundary 2). AD-8 splits write ownership between two Postgres ROLES, and
 * every other suite in this repository connects as the migration role or as
 * `stuwith_api` — so nothing anywhere runs a statement under `stuwith_realtime`
 * against `rooms`. An assertion on the text of the migration would not do: a
 * `REVOKE` can be present and a `GRANT` above it can win, `has_table_privilege`
 * reports the catalogue rather than what happens, and both would stay green with
 * the rule broken. The probe opens a connection AS the realtime role on a real
 * PG18 and expects `42501` from a real `INSERT` and a real `UPDATE`.
 *
 * ## The file name is load-bearing
 *
 * CI gate 4 is `vitest run --project db migration` (`package.json`), which filters
 * by FILE NAME. A suite called `rooms-schema.test.ts` would run under
 * `pnpm test:contract` and be invisible to the migrations gate — green, and not
 * where the story says it is. The word `migration` in this name is what puts it in
 * gate 4.
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  'migrations',
  '1788480200000_rooms-and-plans.js',
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

/**
 * The quoted values inside `... IN ('a', 'b')`, for the named constraint.
 *
 * Copied from `identity-schema.test.ts` rather than imported: that file does not
 * export it, and a `.test.ts` importing another `.test.ts` would run the other
 * suite's top-level container start as a side effect. `deferred-work.md` carries an
 * open item about exactly this class of duplication.
 */
function checkValues(statement: string, constraint: string): string[] {
  const index = statement.indexOf(constraint);
  expect(index, `constraint ${constraint} is missing`).toBeGreaterThan(-1);
  const tail = statement.slice(index);
  const match = /IN \(([^)]*)\)/.exec(tail);
  if (match === null) {
    throw new Error(`constraint ${constraint} has no IN (...) list`);
  }
  return [...(match[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}

beforeEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

afterEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

describe('the rooms schema and packages/contracts agree', () => {
  it('emits statements at all, so every comparison below is over something', () => {
    // A migration that threw, or that stopped calling `pgm.sql`, would make every
    // `statementContaining` fail loudly — but a migration that emitted ONE
    // statement would let a `find` miss silently. This is the guard the other
    // sweeps in this repository put in front of themselves.
    expect(statements().length).toBeGreaterThanOrEqual(8);
  });

  it('accepts exactly the six topics the contract declares', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS rooms');
    expect(checkValues(statement, 'rooms_topic_check').sort()).toEqual([...ROOM_TOPICS].sort());
  });

  it('accepts exactly the two visibilities the contract declares', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS rooms');
    expect(checkValues(statement, 'rooms_visibility_check').sort()).toEqual(
      [...ROOM_VISIBILITIES].sort(),
    );
  });

  it('accepts exactly the three statuses, INCLUDING the one nothing writes yet', () => {
    // `closing` is Story 4.8's and is written by nobody today. It is declared now
    // so that the first implementation of the close protocol has a state to move
    // to — otherwise it reaches for a DELETE, because the schema offers it nothing
    // else, and widening a CHECK later is a migration on a populated table.
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS rooms');
    const statuses = checkValues(statement, 'rooms_status_check');
    expect(statuses.sort()).toEqual([...ROOM_STATUSES].sort());
    expect(statuses).toContain('closing');
  });

  it('accepts exactly the three plans the contract declares', () => {
    expect(checkValues(statementContaining('users_plan_check'), 'users_plan_check').sort()).toEqual(
      [...USER_PLANS].sort(),
    );
  });

  it('defaults the plan to the one the contract calls the default', () => {
    // Three places have to agree and none can import from the other two: this
    // column's DEFAULT, the in-memory identity adapter, and any fixture. The
    // contract's constant is the one name; this is the half a test has to hold.
    expect(statementContaining('ADD COLUMN plan')).toContain(`DEFAULT '${DEFAULT_USER_PLAN}'`);
  });

  it('caps max_participants at the technical ceiling the contract publishes', () => {
    expect(statementContaining('CREATE TABLE IF NOT EXISTS rooms')).toContain(
      `BETWEEN 1 AND ${String(MAX_PARTICIPANTS_CEILING)}`,
    );
  });
});

describe('the migration cannot lose the properties the story depends on', () => {
  it('makes owner_user_id ON DELETE RESTRICT, and never CASCADE', () => {
    /**
     * The design note, as a rule. `user_identities` and `sessions` use CASCADE and
     * are right to; for `rooms` a cascade IS a hard-delete path for a room, living
     * in the schema rather than in a controller — which is exactly what the AC5
     * gate refuses ("an endpoint or any code path").
     */
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS rooms');
    expect(statement).toContain('REFERENCES users (id) ON DELETE RESTRICT');
    expect(statement).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
  });

  it('grants writes on rooms to stuwith_api only (AD-8)', () => {
    const grants = statements().filter((s) => s.trimStart().startsWith('GRANT'));
    const grant = grants.find((s) => s.includes('ON TABLE rooms'));

    expect(grant, 'no GRANT for rooms').toBeDefined();
    expect(grant).toContain('stuwith_api');
    expect(grant, 'rooms must not be writable by the realtime process').not.toContain(
      'stuwith_realtime',
    );
  });

  it('never grants DELETE or TRUNCATE to anybody, on any table', () => {
    // AD-12's posture, applied to every table in this repository. The word appears
    // in the REVOKE below, which is the opposite statement.
    for (const statement of statements().filter((s) => s.trimStart().startsWith('GRANT'))) {
      expect(statement, 'DELETE is never granted in this repo').not.toContain('DELETE');
      expect(statement, 'TRUNCATE is never granted in this repo').not.toContain('TRUNCATE');
    }
  });

  it('states the revocation rather than relying on the inherited default', () => {
    // The default posture already denies it. Saying it out loud is what makes a
    // later blanket grant above this line visibly overridden instead of silently
    // winning — the same argument the Story 1.2 migration makes for itself.
    const revoke = statements().find((s) => s.trimStart().startsWith('REVOKE'));
    expect(revoke).toContain('ON TABLE rooms');
    expect(revoke).toContain('FROM stuwith_realtime');
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(revoke).toContain(privilege);
    }
  });

  it('brings both role comments into line with the grants that now exist', () => {
    // Story 1.1 wrote "Write owner of … rooms/plans" seven stories before `rooms`
    // existed. A comment that describes privileges nobody holds is the half of AD-8
    // this migration exists to close.
    const comments = statements().filter((s) => s.includes('COMMENT ON ROLE'));
    expect(comments.length).toBe(2);
    expect(comments.join('\n')).toContain('rooms');
  });

  it('says in the schema itself that there is no way to delete a room', () => {
    // The one place a DBA reading `\d+ rooms` will see it. A rule that lives only
    // in a TypeScript docblock is invisible to whoever is holding a psql prompt.
    const comment = statements().find((s) => s.includes('COMMENT ON TABLE rooms'));
    expect(comment).toBeDefined();
    expect(comment).toContain('RESTRICT');
    expect(comment).toContain('never recomputed');
  });
});

/* -------------------------------------------------------------------------- *
 * The boundary probe — a real role, a real statement, a real PostgreSQL 18
 * -------------------------------------------------------------------------- */

const suite = testcontainersDisabled ? describe.skip : describe;

suite('Story 2.1 — rooms, ownership enforced by GRANT', () => {
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

  /** A room owned by a fresh user, created through the writing role. */
  const seedRoom = async (): Promise<{ ownerId: string; roomId: string }> =>
    withClient(apiUrl, async (client) => {
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ('Room Owner') RETURNING id`,
      );
      const ownerId = owner.rows[0]?.id ?? '';
      const room = await client.query<{ id: string }>(
        `INSERT INTO rooms (owner_user_id, name, topic, visibility, max_participants)
         VALUES ($1, 'Phong hoc', 'on_thi', 'public', 6) RETURNING id`,
        [ownerId],
      );
      return { ownerId, roomId: room.rows[0]?.id ?? '' };
    });

  it('creates the rooms table', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'rooms'`,
      ),
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(['rooms']);
  });

  it('adds users.plan as a NOT NULL column with the default the contract names', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'plan'`,
      ),
    );
    const row = result.rows[0];
    expect(row?.data_type).toBe('text');
    // NOT NULL, unlike `date_of_birth`: there is no "no plan" state. A nullable
    // column would put a hole in `PLAN_PARTICIPANT_LIMITS[user.plan]` at the exact
    // moment a room's capacity is being decided.
    expect(row?.is_nullable).toBe('NO');
    expect(row?.column_default ?? '').toContain(DEFAULT_USER_PLAN);
  });

  it('gives an existing row the default plan, rather than failing the migration', async () => {
    // The property CI gate 4 exists for: this ran against a database that already
    // had `users` rows in it (`migrations.test.ts` seeds one; the row below is this
    // suite's own). A `NOT NULL` with no default would have failed the ALTER.
    const result = await withClient(apiUrl, async (client) => {
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ('Plan Default') RETURNING id`,
      );
      return client.query<{ plan: string }>(`SELECT plan FROM users WHERE id = $1`, [
        user.rows[0]?.id,
      ]);
    });
    expect(result.rows[0]?.plan).toBe(DEFAULT_USER_PLAN);
  });

  it('lets stuwith_api create a room', async () => {
    const { roomId } = await seedRoom();
    expect(roomId).not.toBe('');
  });

  /**
   * THE PROBE. Boundary 2: `apps/api` and `apps/realtime-gateway` divide write
   * ownership with Postgres roles, and no other test in this repository connects as
   * `stuwith_realtime` to touch `rooms`.
   *
   * Two statements, not one, and not a privilege bit. `has_table_privilege` reports
   * what the catalogue says; a real statement reports what the database does, and
   * the two can differ (a grant to `PUBLIC`, a role membership, a later `GRANT ALL`
   * above the REVOKE). UPDATE is included beside INSERT because Story 4.8 will move
   * `status`, and "the realtime process may not create a room" is a weaker claim
   * than "it may not close one either".
   *
   * The mutation that turns this red is written into the spec: add
   * `GRANT INSERT ON TABLE rooms TO stuwith_realtime` to the migration. It was run,
   * and running it taught something the spec did not say — **where** the line goes
   * decides whether the probe notices:
   *
   *  - placed BEFORE the `REVOKE`, the probe stays GREEN, because the REVOKE two
   *    lines later takes the privilege straight back. That is the "belt and braces"
   *    comment in the migration doing exactly what it claims, measured rather than
   *    asserted — a later blanket grant above that line is visibly overridden
   *    instead of silently winning;
   *  - placed AFTER the `REVOKE`, the probe goes RED on this example, with the
   *    `INSERT` returning `rowCount: 1` instead of `42501`.
   *
   * Worth writing down because the first run looked like a probe that could not see
   * the mutation, and the honest reading is the opposite: the migration has two
   * defences and the mutation had to defeat both.
   */
  it('refuses a real INSERT into rooms from stuwith_realtime, with 42501', async () => {
    const { ownerId } = await seedRoom();

    await expect(
      withClient(realtimeUrl, (client) =>
        client.query(
          `INSERT INTO rooms (owner_user_id, name, topic, visibility, max_participants)
           VALUES ($1, 'Phong lau', 'khac', 'public', 6)`,
          [ownerId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
  });

  it('refuses a real UPDATE of rooms from stuwith_realtime, with 42501', async () => {
    await seedRoom();

    await expect(
      withClient(realtimeUrl, (client) =>
        client.query(`UPDATE rooms SET status = 'closing'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets stuwith_realtime READ rooms, which is the half it is supposed to have', async () => {
    // The positive control. Without it, a probe that refused everything — a role
    // that could not connect, a table that did not exist — would satisfy both
    // examples above perfectly.
    await seedRoom();
    const result = await withClient(realtimeUrl, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text AS count FROM rooms'),
    );
    expect(Number(result.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });

  it('gives NO role DELETE or TRUNCATE on rooms', async () => {
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ role: string; can_delete: boolean; can_truncate: boolean }>(
        `SELECT r.rolname AS role,
                has_table_privilege(r.rolname, 'rooms', 'DELETE')   AS can_delete,
                has_table_privilege(r.rolname, 'rooms', 'TRUNCATE') AS can_truncate
           FROM pg_roles r
          WHERE r.rolname IN ('stuwith_api', 'stuwith_realtime')`,
      ),
    );
    expect(result.rows.length).toBe(2);
    for (const row of result.rows) {
      expect(row.can_delete, `${row.role} must not be able to delete a room`).toBe(false);
      expect(row.can_truncate, `${row.role} must not be able to empty the table`).toBe(false);
    }
  });

  it('refuses a real DELETE of a room from the WRITING role, with 42501', async () => {
    // The privilege bits above say what the catalogue holds; this says what happens.
    // AC5 is "no endpoint and no code path", and the last line of defence is that
    // the statement would not run even if somebody wrote one.
    await seedRoom();
    await expect(
      withClient(apiUrl, (client) => client.query(`DELETE FROM rooms`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  /**
   * `ON DELETE RESTRICT`, proved with a statement rather than with `information_schema`.
   *
   * The acceptance criterion is "a person removed from `users` while they still own
   * a room — the operation is blocked, no room disappears with them". No role holds
   * DELETE on `users`, so the only caller who could ever meet this is somebody at a
   * psql prompt — which is exactly who this test stands in for, connecting as the
   * owner.
   */
  it('blocks deleting a user who still owns a room, and keeps the room', async () => {
    const { ownerId, roomId } = await seedRoom();

    await expect(
      withClient(pg.connectionString, (client) =>
        client.query(`DELETE FROM users WHERE id = $1`, [ownerId]),
      ),
      // `23001` restrict_violation, and specifically NOT `23503`
      // foreign_key_violation — which is a distinction worth pinning rather than a
      // detail. `NO ACTION` (the default) raises 23503 and is deferrable, so a
      // transaction can postpone the check to COMMIT; `RESTRICT` raises 23001 and
      // is checked immediately and cannot be deferred. The SQLSTATE is therefore the
      // one observable that says which referential action is actually in force, and
      // asserting the weaker code would have passed against either.
    ).rejects.toMatchObject({ code: '23001' });

    const after = await withClient(pg.connectionString, (client) =>
      client.query<{ id: string }>(`SELECT id FROM rooms WHERE id = $1`, [roomId]),
    );
    expect(after.rows.map((r) => r.id), 'the room must have survived').toEqual([roomId]);
  });

  it.each([
    ['a topic nobody declared', `'xyz', 'public', 6`],
    ['a visibility nobody declared', `'on_thi', 'secret', 6`],
    ['a cap past the ceiling', `'on_thi', 'public', ${String(MAX_PARTICIPANTS_CEILING + 1)}`],
    ['a cap of zero', `'on_thi', 'public', 0`],
  ])('refuses %s at the database, not only in application code', async (_label, values) => {
    const { ownerId } = await seedRoom();

    await expect(
      withClient(apiUrl, (client) =>
        client.query(
          `INSERT INTO rooms (owner_user_id, name, topic, visibility, max_participants)
           VALUES ($1, 'Phong hoc', ${values})`,
          [ownerId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('refuses a blank name at the database', async () => {
    const { ownerId } = await seedRoom();

    await expect(
      withClient(apiUrl, (client) =>
        client.query(
          `INSERT INTO rooms (owner_user_id, name, topic, visibility, max_participants)
           VALUES ($1, '   ', 'on_thi', 'public', 6)`,
          [ownerId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a plan the contract does not declare', async () => {
    await expect(
      withClient(apiUrl, (client) =>
        client.query(`INSERT INTO users (display_name, plan) VALUES ('bad plan', 'unlimited')`),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('starts every room open, without being told to', async () => {
    // The DEFAULT is the only thing that decides this: the adapter deliberately
    // leaves `status` out of its INSERT so that "which status does a new room
    // start in" lives in one place.
    const { roomId } = await seedRoom();
    const result = await withClient(pg.connectionString, (client) =>
      client.query<{ status: string }>(`SELECT status FROM rooms WHERE id = $1`, [roomId]),
    );
    expect(result.rows[0]?.status).toBe('open');
  });
});
