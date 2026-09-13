/* eslint-disable */
/**
 * Story 2.2 — `room_reservations`, and the `users.banned_at` the admission gate reads.
 *
 * Forward-only, no `down` (spine, "Migration"): a rollback path is a second,
 * untested code path that only ever runs during an incident.
 *
 * ## AD-22, written into the schema
 *
 * "A read-only check is a hint, not a gate." The room cap is enforced by writing a
 * row here in the SAME transaction as the count, with the room's row held
 * `FOR UPDATE`; nothing reads `room_participants` to decide capacity, because that
 * table is written by the gateway from LiveKit's signals and lags by seconds. The
 * table therefore has exactly one writer, `stuwith_api`, and that writer also owns
 * the housekeeping: an expired row is deleted inside the reservation transaction.
 * That is why `DELETE` IS granted here, on this table alone — it is not a
 * hard-delete path for anything a person made, it is the reservation's own lifetime.
 *
 * ## Both foreign keys are `ON DELETE RESTRICT`, and neither may become `CASCADE`
 *
 * `rooms.owner_user_id` is RESTRICT because a cascade would BE a hard-delete path
 * for rooms living in the schema (Story 2.1, AC5 gate). The same argument applies
 * from the other side here: a `CASCADE` on `room_id` would let a room disappear
 * quietly "because its reservations went with it", and a `CASCADE` on `user_id`
 * would make a `users` delete reach into a table about rooms. `deferred-work.md`
 * records the CASCADE trap by name; this file does not fall into it.
 *
 * ## `users.banned_at` is a timestamp, nullable, and NOBODY WRITES IT YET
 *
 * Story 4.7 (moderation) is the first writer — a human decision on 2026-09-12. The
 * column exists now because the token endpoint reads it from this story on, and
 * fails closed on anything that is not `NULL`: the day a ban is written, it takes
 * effect without anybody touching the admission path. A timestamp rather than a
 * boolean because "since when" is the first question of every investigation, and
 * a boolean would need a second column the day 4.7 arrives.
 *
 * `ALTER TABLE ... ADD COLUMN ... NULL` with no default is a catalogue-only change:
 * CI gate #4 runs this against a database that already has rows and measures no
 * rewrite. Every existing person is not banned, which is the truth.
 */

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── users.banned_at ────────────────────────────────────────────────────────
  pgm.sql(`ALTER TABLE users ADD COLUMN banned_at timestamptz NULL`);

  pgm.sql(`
    COMMENT ON COLUMN users.banned_at IS
      'When this person was banned, or NULL for not banned. Read by the room-token admission gate (Story 2.2), which refuses on any non-NULL value. No writer exists until Story 4.7 (moderation); that is deliberate, and the gate fails closed regardless. Write owner: stuwith_api (AD-8).'
  `);

  // ── room_reservations ──────────────────────────────────────────────────────
  //
  // `reserved_at` and `expires_at` are the request's instant and that instant plus
  // the token TTL; both come from the caller's clock, never from `now()`, so a row
  // and the token issued against it name the same millisecond.
  //
  // `UNIQUE (room_id, user_id)`: one person, one seat per room. The adapter renews
  // a live seat rather than inserting a second, and this constraint is what makes
  // that a fact of the schema rather than a habit of the code.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS room_reservations (
      id           uuid        PRIMARY KEY DEFAULT uuidv7(),
      room_id      uuid        NOT NULL REFERENCES rooms (id) ON DELETE RESTRICT,
      user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      reserved_at  timestamptz NOT NULL,
      expires_at   timestamptz NOT NULL,
      CONSTRAINT room_reservations_expires_after_reserved CHECK (expires_at > reserved_at),
      CONSTRAINT room_reservations_one_seat_per_person UNIQUE (room_id, user_id)
    )
  `);

  // The index the reservation transaction lives on: "delete this room's expired
  // seats, then count this room's live ones" is two range scans over exactly this
  // pair. The UNIQUE above already indexes `(room_id, user_id)`, which answers the
  // renewal lookup; this one answers the two time-bounded questions. The RESTRICT
  // on `user_id` gets no index of its own: no role holds DELETE on `users`, so the
  // scan it would speed up is one a DBA runs by hand.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS room_reservations_room_id_expires_at_idx
      ON room_reservations (room_id, expires_at)
  `);

  pgm.sql(`
    COMMENT ON TABLE room_reservations IS
      'Seats held against rooms.max_participants, one row per (room, person), for as long as the room token issued with it lives (AD-22: a read-only capacity check is a hint, not a gate — the row is written in the same transaction as the count, under FOR UPDATE on the room). Write owner: stuwith_api (AD-8), INCLUDING deletion of expired rows, which happens inside the reservation transaction; stuwith_realtime reads and never writes. This is not presence: room_participants is. Both foreign keys are ON DELETE RESTRICT, never CASCADE.'
  `);

  // ── AD-8 grants ────────────────────────────────────────────────────────────
  //
  // DELETE is granted, and this is the one table in the repository where that is
  // the design rather than a hole. `rooms-migration.test.ts` asserts "never DELETE
  // in any GRANT" over Story 2.1's migration only, and this file is the reason that
  // assertion is scoped to a file rather than to the repository: a reservation is a
  // lifetime, not a record, and the process that grants it is the process that
  // reaps it. The probe in `room-reservations-migration.test.ts` runs all three
  // verbs under BOTH roles.
  pgm.sql(`GRANT INSERT, UPDATE, DELETE ON TABLE room_reservations TO stuwith_api`);

  // Stated rather than inherited, for the reason the 2.1 migration gives: a later
  // blanket grant above this line is visibly overridden here instead of silently
  // winning. TRUNCATE is named and granted to nobody.
  pgm.sql(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE room_reservations FROM stuwith_realtime`);

  // ── the two role comments, kept in step with the grants in force ───────────
  pgm.sql(`
    COMMENT ON ROLE stuwith_api IS
      'Write owner of users/user_identities/sessions/rooms/room_reservations (AD-8). Holds INSERT and UPDATE on rooms and never DELETE or TRUNCATE — no role does, and there is no hard-delete path for a room anywhere in this system. Holds INSERT, UPDATE and DELETE on room_reservations: a reservation is a lifetime it both grants and reaps (AD-22). Holds INSERT on audit_events and never UPDATE or DELETE on it (AD-12). Must never hold INSERT or UPDATE on coin_ledger or user_balances.'
  `);
  pgm.sql(`
    COMMENT ON ROLE stuwith_realtime IS
      'Write owner of coin_ledger/user_balances/private_sessions/room_participants (AD-8). Reads users/user_identities/sessions/rooms/room_reservations but must never write them. Holds INSERT on audit_events only (AD-12).'
  `);
};
