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

exports.shorthands = undefined;

const ROLES = /** @type {const} */ ([
  { name: 'stuwith_api', passwordVar: 'DB_ROLE_API_PASSWORD' },
  { name: 'stuwith_realtime', passwordVar: 'DB_ROLE_REALTIME_PASSWORD' },
]);

/**
 * Standard-conforming single-quote escaping. The password never reaches a log line
 * and never gets a default value (AD-14).
 */
const BACKSLASH = String.fromCharCode(92);

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
  return `'${value.replace(/'/g, "''")}'`;
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  for (const role of ROLES) {
    const password = quoteLiteral(process.env[role.passwordVar], role.passwordVar);
    pgm.sql(`
      DO $do$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.name}') THEN
          CREATE ROLE ${role.name} LOGIN PASSWORD ${password};
        ELSE
          ALTER ROLE ${role.name} WITH LOGIN PASSWORD ${password};
        END IF;
      END
      $do$;
    `);
  }

  const both = ROLES.map((r) => r.name).join(', ');

  // Deny by default.
  pgm.sql(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${both}`);

  pgm.sql(`
    DO $do$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${both}', current_database());
    END
    $do$;
  `);
  pgm.sql(`GRANT USAGE ON SCHEMA public TO ${both}`);

  // Read is shared; write is not. Every existing table is readable, nothing is
  // writable unless the line below names it.
  pgm.sql(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${both}`);

  // Tables created by LATER migrations inherit SELECT only. A story that adds
  // `users` must explicitly grant INSERT/UPDATE to stuwith_api and must NOT grant
  // them to stuwith_realtime — and if it forgets to think about it, the safe thing
  // happens rather than the convenient thing.
  pgm.sql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${both}`);

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
