/* eslint-disable */
/**
 * AD-8, enforcement half: "ownership written in prose is advice; ownership
 * enforced with GRANT is an invariant."
 *
 * Two login roles, one per process. The default posture is DENY: PUBLIC loses the
 * schema, every future table is granted SELECT only, and any write on a future
 * table has to be granted explicitly by the story that introduces the table.
 * That is what stops `stuwith_realtime` from ever UPDATE-ing `users`.
 */

const { randomBytes } = require('node:crypto');

exports.shorthands = undefined;

const ROLES = /** @type {const} */ ([
  { name: 'stuwith_api', passwordVar: 'DB_ROLE_API_PASSWORD' },
  { name: 'stuwith_realtime', passwordVar: 'DB_ROLE_REALTIME_PASSWORD' },
]);

const BACKSLASH = String.fromCharCode(92);

/**
 * Standard-conforming single-quote escaping, for a literal that will sit at the
 * TOP LEVEL of a statement — never inside a dollar-quoted body.
 *
 * That distinction is the whole point. A password containing `$do$` used to end
 * the surrounding `DO $do$ ... $do$` block early and turn the remainder of the
 * password into executable SQL running as the migration role. Doubling quotes
 * does nothing about that, because the dollar-quote delimiter is not a quote.
 * The structural fix is below: `ALTER ROLE ... PASSWORD` is issued as its own
 * statement, so no dollar-quoted context exists for a password to escape from.
 *
 * The password never reaches a log line and never gets a default value (AD-14).
 */
function quoteLiteral(value, variableName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `[migration] missing required environment variable: ${variableName}. ` +
        'Role passwords have no default value — see .env.example.',
    );
  }
  if (value.includes(BACKSLASH)) {
    throw new Error(
      `[migration] ${variableName} must not contain a backslash; it cannot be escaped safely here.`,
    );
  }
  // A newline or NUL in a credential is never intentional, and both make the
  // surrounding statement unreadable in any log or error that does echo it.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      `[migration] ${variableName} must not contain control characters.`,
    );
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A dollar-quote tag no attacker-supplied text can predict, for the blocks that
 * legitimately need one. Nothing interpolated into these blocks is user-supplied
 * today — but "no caller-controlled text ends up in here" is an invariant a
 * future edit can break silently, and a random tag costs nothing to keep.
 */
function dollarTag() {
  return `$stuwith_${randomBytes(8).toString('hex')}$`;
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  for (const role of ROLES) {
    const password = quoteLiteral(process.env[role.passwordVar], role.passwordVar);
    const tag = dollarTag();

    // Step 1 — create the role WITHOUT a password. No secret enters the
    // dollar-quoted body, so nothing in the body can be escaped out of.
    pgm.sql(`
      DO ${tag}
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.name}') THEN
          CREATE ROLE ${role.name} LOGIN;
        END IF;
      END
      ${tag};
    `);

    // Step 2 — set the password in a top-level statement, where standard
    // single-quote doubling is the complete and correct escaping rule.
    pgm.sql(`ALTER ROLE ${role.name} WITH LOGIN PASSWORD ${password}`);
  }

  const both = ROLES.map((r) => r.name).join(', ');

  // Deny by default.
  pgm.sql(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${both}`);

  const connectTag = dollarTag();
  pgm.sql(`
    DO ${connectTag}
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${both}', current_database());
    END
    ${connectTag};
  `);
  pgm.sql(`GRANT USAGE ON SCHEMA public TO ${both}`);

  // Neither process may create objects in `public`. This is not tidiness: the
  // default-privilege rules below are attached to the roles that CREATE objects,
  // so "only migrations create tables here" has to be an enforced invariant
  // rather than an assumption. If an app role could create a table, that table
  // would carry nobody's default grants and the ownership model would have a
  // hole exactly where a new feature put it.
  pgm.sql(`REVOKE CREATE ON SCHEMA public FROM ${both}`);

  // Read is shared; write is not. Every existing table is readable, nothing is
  // writable unless the line below names it.
  pgm.sql(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${both}`);
  pgm.sql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${both}`);

  // Tables created by LATER migrations inherit SELECT only. A story that adds
  // `users` must explicitly grant INSERT/UPDATE to stuwith_api and must NOT grant
  // them to stuwith_realtime — and if it forgets to think about it, the safe thing
  // happens rather than the convenient thing.
  //
  // `FOR ROLE` is explicit rather than implied. Default privileges are recorded
  // per creating role; the bare form silently means "FOR ROLE current_user", so a
  // migration later run by a different role would create tables that inherit
  // nothing and quietly become unreadable to both processes. Naming the role makes
  // that coupling visible, and the REVOKE CREATE above makes the set of possible
  // creators exactly this one.
  //
  // SEQUENCES matter as much as TABLES: a `bigint GENERATED ... AS IDENTITY` or a
  // `serial` column owns a sequence, and INSERT on the table fails with
  // "permission denied for sequence" unless USAGE is granted. Granting it by
  // default is safe — a sequence holds no data, and INSERT on the table is still
  // denied until a story grants it explicitly.
  const defaultsTag = dollarTag();
  pgm.sql(`
    DO ${defaultsTag}
    DECLARE
      creator text := current_user;
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO ${both}',
        creator
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${both}',
        creator
      );
    END
    ${defaultsTag};
  `);

  // The one shared-write table in Story 1.1. DELETE is never granted to anyone:
  // it is the same posture `audit_events` will need in Story 1.7 (AD-12).
  pgm.sql(`GRANT INSERT, UPDATE ON TABLE service_heartbeats TO ${both}`);

  pgm.sql(`
    COMMENT ON ROLE stuwith_api IS
      'Write owner of users/rooms/plans/room_reservations (AD-8). Must never hold INSERT or UPDATE on coin_ledger or user_balances.'
  `);
  pgm.sql(`
    COMMENT ON ROLE stuwith_realtime IS
      'Write owner of coin_ledger/user_balances/private_sessions/room_participants (AD-8). Must never hold UPDATE on users, rooms or plans.'
  `);
};
