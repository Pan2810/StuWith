/* eslint-disable */
/**
 * Story 2.1 — `rooms`, and the `users.plan` a participant cap is derived from.
 *
 * Forward-only, no `down` (spine, "Migration"): a rollback path is a second,
 * untested code path that only ever runs during an incident.
 *
 * ## This migration is the enforcement half of a sentence Story 1.1 already wrote
 *
 * `1788480000000_users-and-identities.js` ends with
 * `COMMENT ON ROLE stuwith_api IS 'Write owner of users/user_identities/sessions/rooms/plans …'`.
 * That claim has been in the database since Story 1.1 and there has been no `rooms`
 * table to hold it up — the prose half of AD-8 shipped seven stories before the
 * GRANT half. This file closes that gap, and `rooms-migration.test.ts` proves it
 * with a real `INSERT` refused `42501` under `stuwith_realtime` rather than with an
 * assertion about the text below.
 *
 * ## `ON DELETE RESTRICT`, and why it is not `CASCADE`
 *
 * `user_identities` and `sessions` both use `CASCADE`, and both are right to: an
 * identity or a session without its person is meaningless. A room is not like
 * that. `CASCADE` here would BE a hard-delete path for rooms — one that lives in
 * the schema rather than in a controller, and that nobody would find by reading the
 * API. Epic 2's constraint is "Không tồn tại đường xoá cứng một phòng", and
 * `tests/gates/no-hard-delete-rooms.test.ts` refuses "an endpoint OR any code
 * path", which a foreign-key action plainly is.
 *
 * What `RESTRICT` costs, stated rather than discovered later: deleting a `users`
 * row that still owns a room fails. That is the intended answer — no role in this
 * repository holds `DELETE` on `users` anyway, so the only caller who could meet it
 * is a DBA at a prompt, and a DBA meeting a loud refusal is better served than a
 * DBA whose one statement silently removed somebody else's study rooms.
 *
 * ## `closing` exists here and is written by nobody
 *
 * The full close protocol is Story 4.8. What this story owes is that the state a
 * graceful shutdown needs EXISTS before the protocol that uses it — otherwise the
 * first implementation reaches for a `DELETE`, because the schema offers it
 * nothing else. A value declared now costs nothing; a CHECK constraint widened
 * later is a migration against a populated table.
 *
 * ## Why the lists are copied instead of imported
 *
 * A migration runs as plain JavaScript through `node-pg-migrate`, before anything
 * is built, so it cannot import `@stuwith/contracts`. The link is a test:
 * `packages/db/src/rooms-migration.test.ts` runs this file against a fake `pgm`,
 * reads the SQL it really emits, and compares every list below with the contract's
 * own enum. Adding a seventh topic to the contract and forgetting this file is a
 * red run rather than a CHECK violation in production.
 */

exports.shorthands = undefined;

/** Kept in step with `USER_PLANS` in `packages/contracts/src/rooms.ts` by a test. */
const USER_PLANS = ['study_buddy', 'study_circle', 'campus'];

/** The plan every existing and every new row starts on. Epic 5 owns changing it. */
const DEFAULT_USER_PLAN = 'study_buddy';

/** Kept in step with `ROOM_TOPICS`. Codes, never labels — the words live in i18n. */
const ROOM_TOPICS = [
  'ngoai_ngu',
  'khoa_hoc_tu_nhien',
  'khoa_hoc_xa_hoi',
  'lap_trinh_cong_nghe',
  'on_thi',
  'khac',
];

/** Kept in step with `ROOM_VISIBILITIES`. */
const ROOM_VISIBILITIES = ['public', 'private'];

/** Kept in step with `ROOM_STATUSES`. `closing` is Story 4.8's, declared now. */
const ROOM_STATUSES = ['open', 'closing', 'closed'];

/** Kept in step with `INITIAL_ROOM_STATUS`. */
const INITIAL_ROOM_STATUS = 'open';

/** Kept in step with `MAX_ROOM_NAME_LENGTH` / `MAX_ROOM_DESCRIPTION_LENGTH`. */
const MAX_ROOM_NAME_LENGTH = 120;
const MAX_ROOM_DESCRIPTION_LENGTH = 2000;

/**
 * Kept in step with `MAX_PARTICIPANTS_CEILING`.
 *
 * It is a ceiling on what the COLUMN will store, not a default anybody gets: the
 * plan table tops out at 45. Story 2.2 counts reservations against this column, so
 * an unbounded value here would be an unbounded room.
 */
const MAX_PARTICIPANTS_CEILING = 100;

/** A SQL list literal from a fixed, code-owned array. Never caller-supplied. */
function sqlList(values) {
  return values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ');
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── users.plan ─────────────────────────────────────────────────────────────
  //
  // `NOT NULL DEFAULT` on a populated table is still a catalogue-only change in
  // PostgreSQL 11 and later: a non-volatile default is stored in the catalogue and
  // materialised on read, so the heap is untouched and CI gate #4 — which runs
  // this against a database that already has rows — measures no rewrite.
  //
  // `NOT NULL` rather than nullable, and the difference from `date_of_birth` is
  // the whole reason: an absent date of birth MEANS "not declared yet" and the
  // product has a screen for that state. There is no "no plan" state — everybody
  // is on some plan, the free one is a plan, and a nullable column would make
  // `PLAN_PARTICIPANT_LIMITS[user.plan]` a lookup with a hole in it at the exact
  // moment a room's capacity is being decided.
  pgm.sql(`ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT '${DEFAULT_USER_PLAN}'`);

  pgm.sql(`
    ALTER TABLE users
      ADD CONSTRAINT users_plan_check CHECK (plan IN (${sqlList(USER_PLANS)}))
  `);

  pgm.sql(`
    COMMENT ON COLUMN users.plan IS
      'Which plan this person is on. It decides rooms.max_participants ONCE, at creation, and is never read again for a room that already exists. There is no payment flow yet (Epic 5), so every row is on the default. Write owner: stuwith_api (AD-8).'
  `);

  // No new GRANT for the column, on purpose. Privileges in PostgreSQL are held per
  // TABLE, and `stuwith_api` already holds `INSERT, UPDATE` on `users` from the
  // Story 1.2 migration; a column-level grant would be a second, narrower statement
  // of the same permission and an invitation for the two to drift.

  // ── rooms ──────────────────────────────────────────────────────────────────
  //
  // `max_participants` is a stored NUMBER rather than a reference to the owner's
  // plan, and that is the design rather than denormalisation. Reading the plan at
  // join time would make a room's capacity change under the people already in it,
  // on a billing event none of them can see.
  //
  // `description` is `NOT NULL DEFAULT ''` rather than nullable: "no description"
  // and "an empty description" are one fact, and two representations of one fact
  // are two branches every reader has to handle for ever.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS rooms (
      id                uuid        PRIMARY KEY DEFAULT uuidv7(),
      owner_user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      name              text        NOT NULL,
      description       text        NOT NULL DEFAULT '',
      topic             text        NOT NULL,
      visibility        text        NOT NULL,
      max_participants  integer     NOT NULL,
      status            text        NOT NULL DEFAULT '${INITIAL_ROOM_STATUS}',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rooms_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT rooms_name_length CHECK (char_length(name) <= ${MAX_ROOM_NAME_LENGTH}),
      CONSTRAINT rooms_description_length CHECK (char_length(description) <= ${MAX_ROOM_DESCRIPTION_LENGTH}),
      CONSTRAINT rooms_topic_check CHECK (topic IN (${sqlList(ROOM_TOPICS)})),
      CONSTRAINT rooms_visibility_check CHECK (visibility IN (${sqlList(ROOM_VISIBILITIES)})),
      CONSTRAINT rooms_status_check CHECK (status IN (${sqlList(ROOM_STATUSES)})),
      CONSTRAINT rooms_max_participants_range CHECK (max_participants BETWEEN 1 AND ${MAX_PARTICIPANTS_CEILING})
    )
  `);

  // The index the RESTRICT needs. Without it, PostgreSQL has to scan `rooms` to
  // answer "does this user still own one" on every attempted `users` delete — and
  // the referential action is exactly the thing this story leans on.
  pgm.sql(`CREATE INDEX IF NOT EXISTS rooms_owner_user_id_idx ON rooms (owner_user_id)`);

  pgm.sql(`
    COMMENT ON TABLE rooms IS
      'Study rooms. Write owner: stuwith_api (AD-8); stuwith_realtime reads and never writes. max_participants is fixed at creation from the owner plan and is never recomputed. owner_user_id is ON DELETE RESTRICT, not CASCADE: a cascade would be a hard-delete path for rooms living in the schema. There is no DELETE grant for any role and no endpoint that removes a room — closing one is a status change (open -> closing -> closed), and the protocol for it arrives in a later story.'
  `);

  // ── AD-8 grants ────────────────────────────────────────────────────────────
  //
  // New tables inherit SELECT only (roles migration), so forgetting a GRANT fails
  // closed. A grant to the WRONG role would not, which is why this is explicit and
  // why the probe in `rooms-migration.test.ts` runs a real statement under a real
  // role rather than reading this line.
  pgm.sql(`GRANT INSERT, UPDATE ON TABLE rooms TO stuwith_api`);

  // Belt and braces, and the same shape the identity migration uses: `stuwith_realtime`
  // inherits SELECT and nothing more, but stating it as a statement means a later
  // blanket grant above this line is visibly overridden here instead of silently
  // winning. DELETE and TRUNCATE are named in the REVOKE and granted to nobody,
  // anywhere, ever.
  pgm.sql(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE rooms FROM stuwith_realtime`);

  // ── the two role comments, brought back into line with reality ─────────────
  //
  // Story 1.1 wrote "Write owner of … rooms/plans" before either existed. Both
  // comments are re-stated here so that a DBA reading `\du+` sees a description of
  // the grants that are now actually in force rather than of the ones that were
  // promised, and so the `rooms` half of each sentence is anchored to the migration
  // that made it true.
  pgm.sql(`
    COMMENT ON ROLE stuwith_api IS
      'Write owner of users/user_identities/sessions/rooms (AD-8). Holds INSERT and UPDATE on rooms and never DELETE or TRUNCATE — no role does, and there is no hard-delete path for a room anywhere in this system. Holds INSERT on audit_events and never UPDATE or DELETE on it (AD-12). Must never hold INSERT or UPDATE on coin_ledger or user_balances.'
  `);
  pgm.sql(`
    COMMENT ON ROLE stuwith_realtime IS
      'Write owner of coin_ledger/user_balances/private_sessions/room_participants (AD-8). Reads users/user_identities/sessions/rooms but must never write them. Holds INSERT on audit_events only (AD-12).'
  `);
};
