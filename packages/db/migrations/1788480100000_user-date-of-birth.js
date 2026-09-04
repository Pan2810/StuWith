/* eslint-disable */
/**
 * Story 1.4 — `users.date_of_birth`.
 *
 * Forward-only, no `down` (spine, "Migration"): a rollback path is a second,
 * untested code path that only ever runs during an incident.
 *
 * ## Nullable, and that is the design rather than a compromise
 *
 * Story 1.2 inserts a `users` row at the moment of first login — before anybody
 * has been asked anything — so `NOT NULL` here would make every first sign-in
 * fail at INSERT time. The absence is therefore what "the profile is not finished
 * yet" MEANS, and it is the only representation of that fact anywhere: there is
 * deliberately no `profile_completed` column beside it. Two columns describing one
 * truth are two columns that can disagree, and no constraint in this schema could
 * keep them in step.
 *
 * ## It takes no lock worth measuring
 *
 * `ADD COLUMN` with no default and no `NOT NULL` is a catalogue-only change in
 * PostgreSQL — the existing heap is untouched and the ACCESS EXCLUSIVE lock is
 * held for the duration of a catalogue write, not of a table rewrite. That is the
 * property CI gate 4 checks by running this against a database that already has
 * rows. A `DEFAULT` or a `NOT NULL` would have changed that answer.
 *
 * ## No new GRANT, on purpose
 *
 * Privileges in PostgreSQL are held per TABLE, not per column, and `stuwith_api`
 * already holds `INSERT, UPDATE` on `users` from the Story 1.2 migration. Adding
 * a column-level grant here would create a second, narrower statement of the same
 * permission and invite the two to drift. `stuwith_realtime` still holds nothing
 * but the inherited `SELECT`, which is correct: AD-8 makes `api` the sole writer
 * of a person's identity, and age is part of that.
 *
 * ## No `IF NOT EXISTS`, on purpose
 *
 * It was there, and it bought nothing this schema does not already have. Migrations
 * are forward-only and `node-pg-migrate` keeps its own ledger in `pgmigrations`, so
 * this file runs exactly once per database whether or not the clause is present.
 * What the clause DOES buy is silence in the one case that matters: if a column
 * called `date_of_birth` already exists with a different type — `text`, or a
 * `timestamptz` from somebody's manual fix — the statement succeeds, the migration
 * is recorded as applied, and every argument below about `date` and `to_char`
 * quietly stops being true. A plain `ADD COLUMN` fails loudly on that database
 * instead, which is the answer a deploy can act on.
 *
 * ## No CHECK constraint, and the reason is not laziness
 *
 * The rules worth enforcing are "not in the future" and "a plausible year", and
 * the first one cannot be a CHECK at all: `current_date` is not IMMUTABLE, and
 * PostgreSQL refuses non-immutable expressions in a table constraint. Enforcing
 * only the half that fits would put a second, weaker copy of the rule in the
 * schema, which is exactly the split this story is trying to avoid — one rule, in
 * `parseDateOfBirth`, read by both processes. What the `date` TYPE already refuses
 * is the class a constraint would mostly have been catching anyway: `2026-02-30`
 * and `1999-13-02` are rejected by the column, not by anybody's code.
 */

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // `date`, not `timestamptz`. A date of birth is a day on a calendar, not an
  // instant, and storing it as an instant is what forces every reader to pick a
  // time zone — the "two readings of one value" class this repository has already
  // paid several review rounds for. The application reads it back as text
  // (`to_char(..., 'YYYY-MM-DD')`) so no driver's local-midnight conversion can
  // shift the day either.
  pgm.sql(`ALTER TABLE users ADD COLUMN date_of_birth date`);

  pgm.sql(`
    COMMENT ON COLUMN users.date_of_birth IS
      'PII. NULL means the first-login declaration has not happened yet — there is no second column for that state. Written exactly once, by UPDATE ... WHERE date_of_birth IS NULL; there is no self-service way to change it. It must never leave apps/api: the API publishes two booleans (profile_completed, is_over_18) and never a date, and it is redacted out of every log line.'
  `);
};
