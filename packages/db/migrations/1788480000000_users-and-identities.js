/* eslint-disable */
/**
 * Story 1.2 — `users`, `user_identities`, `sessions`, `audit_events`.
 *
 * Forward-only, no `down` (spine, "Migration"): a rollback path is a second,
 * untested code path that only ever runs during an incident.
 *
 * ## What is enforced here rather than in application code
 *
 * - **AD-8, one writer per entity.** `stuwith_api` gets INSERT/UPDATE on the three
 *   identity tables; `stuwith_realtime` gets nothing but the SELECT it inherits.
 *   The roles migration set the default posture to DENY, so forgetting a GRANT
 *   fails closed — but a grant to the WRONG role would not, which is why the
 *   grants below are explicit and asserted by `migrations.test.ts`.
 * - **AD-12, append-only audit.** Both roles get INSERT on `audit_events` and
 *   NOTHING else. UPDATE and DELETE are revoked explicitly rather than merely
 *   never granted: the REVOKE is a statement a reviewer can find, and it survives
 *   someone later adding a blanket `GRANT ALL` above it.
 * - **No duplicate accounts.** `UNIQUE (provider, provider_user_id)` is what
 *   decides the winner when two callbacks for the same new identity race. An `if`
 *   in the service layer cannot do this, because both requests take the same
 *   branch at the same time.
 *
 * ## Scope
 *
 * `date_of_birth` is NOT here. It belongs to Story 1.4, and adding the column
 * early would put a PII field in the schema before the flow that populates it and
 * the redaction that protects it exist.
 */

exports.shorthands = undefined;

/**
 * Kept in step with `packages/contracts/src/auth.ts` by
 * `packages/db/src/identity-schema.test.ts`, which fails if either list drifts.
 * A migration cannot import the TypeScript contracts package (it runs as plain
 * JS, before any build), so the link is a test rather than an import.
 */
const AUTH_PROVIDERS = ['google', 'facebook', 'apple', 'microsoft'];

/**
 * The five roles a `users` row may carry. `host` is deliberately absent: it is a
 * permission held per room (Epic 2), and a global `host` would mean "host of every
 * room" the moment anyone wrote the guard.
 */
const GLOBAL_USER_ROLES = ['guest', 'user', 'org_admin', 'moderator', 'system_admin'];

const AUDIT_ACTIONS = [
  'auth.signed_in',
  'auth.sign_in_failed',
  'room_token.issued',
  'balance.changed',
  'report.submitted',
  'moderation.applied',
];

const SERVICE_NAMES = ['api', 'realtime-gateway'];

/** A SQL list literal from a fixed, code-owned array. Never caller-supplied. */
function sqlList(values) {
  return values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ');
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── users ──────────────────────────────────────────────────────────────────
  //
  // `email` is nullable on purpose: Apple lets a user withhold it, and no flow may
  // require it. There is deliberately NO unique index on it either — two providers
  // reporting one address are two people as far as this system is concerned, and a
  // unique index would turn that correct answer into a failed login.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id            uuid        PRIMARY KEY DEFAULT uuidv7(),
      display_name  text        NOT NULL,
      email         text,
      avatar_url    text,
      role          text        NOT NULL DEFAULT 'user',
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> ''),
      CONSTRAINT users_role_check CHECK (role IN (${sqlList(GLOBAL_USER_ROLES)}))
    )
  `);

  pgm.sql(`
    COMMENT ON TABLE users IS
      'People. Write owner: stuwith_api (AD-8). email is nullable (Apple can withhold it) and is NOT unique — email is not an identity key. date_of_birth arrives in Story 1.4.'
  `);

  // ── user_identities ────────────────────────────────────────────────────────
  //
  // The UNIQUE constraint IS the anti-duplicate rule. One user may hold several
  // identities (deliberate account linking is a later epic); one identity belongs
  // to exactly one user.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_identities (
      id                uuid        PRIMARY KEY DEFAULT uuidv7(),
      user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      provider          text        NOT NULL,
      provider_user_id  text        NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_identities_provider_check CHECK (provider IN (${sqlList(AUTH_PROVIDERS)})),
      CONSTRAINT user_identities_subject_not_blank CHECK (btrim(provider_user_id) <> ''),
      CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, provider_user_id)
    )
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS user_identities_user_id_idx ON user_identities (user_id)`);

  pgm.sql(`
    COMMENT ON CONSTRAINT user_identities_provider_subject_key ON user_identities IS
      'The anti-duplicate rule. Two concurrent callbacks for the same new identity both reach INSERT; this constraint picks the winner and the loser reads the row back. Application-level checking cannot do that.'
  `);

  // ── sessions ───────────────────────────────────────────────────────────────
  //
  // One ROW per token generation; `session_id` is the chain and stays constant
  // across rotations, which is what a revocation targets and what Epic 2's
  // WebSocket handshake will hold.
  //
  // Only HASHES are stored. A stolen database dump therefore yields nothing that
  // can be replayed as a cookie. The columns are named `*_hash` so that a future
  // change storing the token itself has to lie in the schema to do it.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
      session_id          uuid        NOT NULL,
      user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      access_token_hash   text        NOT NULL,
      refresh_token_hash  text        NOT NULL,
      issued_at           timestamptz NOT NULL DEFAULT now(),
      expires_at          timestamptz NOT NULL,
      refresh_expires_at  timestamptz NOT NULL,
      rotated_at          timestamptz,
      revoked_at          timestamptz,
      CONSTRAINT sessions_access_token_hash_key  UNIQUE (access_token_hash),
      CONSTRAINT sessions_refresh_token_hash_key UNIQUE (refresh_token_hash)
    )
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS sessions_session_id_idx ON sessions (session_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)`);

  pgm.sql(`
    COMMENT ON TABLE sessions IS
      'One row per token generation. session_id is the chain and survives rotation. Only hashes are stored, so a dump yields nothing replayable. Sessions are revoked by UPDATE, never deleted — no role holds DELETE.'
  `);

  // ── audit_events ───────────────────────────────────────────────────────────
  //
  // No foreign key on actor_user_id, deliberately. An append-only trail must
  // survive the disappearance of the thing it describes; ON DELETE CASCADE here
  // would let deleting a user erase the record that they signed in, which is the
  // one property AD-12 exists to guarantee.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id              uuid        PRIMARY KEY DEFAULT uuidv7(),
      source_service  text        NOT NULL,
      action          text        NOT NULL,
      actor_user_id   uuid,
      subject_id      uuid,
      request_id      text        NOT NULL,
      occurred_at     timestamptz NOT NULL DEFAULT now(),
      metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT audit_events_source_service_check CHECK (source_service IN (${sqlList(SERVICE_NAMES)})),
      CONSTRAINT audit_events_action_check CHECK (action IN (${sqlList(AUDIT_ACTIONS)})),
      CONSTRAINT audit_events_request_id_not_blank CHECK (btrim(request_id) <> '')
    )
  `);

  pgm.sql(
    `CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events (occurred_at DESC)`,
  );
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_user_id, occurred_at DESC)`,
  );

  pgm.sql(`
    COMMENT ON TABLE audit_events IS
      'AD-12 append-only. Both processes INSERT; no role holds UPDATE or DELETE. No FK on actor_user_id: the trail must outlive the row it describes. metadata carries non-PII scalars only.'
  `);

  // ── AD-8 / AD-12 grants ────────────────────────────────────────────────────
  //
  // New tables inherit SELECT only (roles migration). Everything below is the
  // explicit, minimal addition.
  pgm.sql(`GRANT INSERT, UPDATE ON TABLE users            TO stuwith_api`);
  pgm.sql(`GRANT INSERT, UPDATE ON TABLE user_identities  TO stuwith_api`);
  pgm.sql(`GRANT INSERT, UPDATE ON TABLE sessions         TO stuwith_api`);

  // Belt and braces. `stuwith_realtime` inherits SELECT and nothing more, but this
  // states the intent as a statement rather than as an absence, so a later blanket
  // grant above it is visibly overridden here instead of silently winning.
  pgm.sql(
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE users, user_identities, sessions FROM stuwith_realtime`,
  );

  // AD-12: INSERT for both, UPDATE/DELETE for neither. DELETE is never granted to
  // anyone anywhere in this repo, including to stuwith_api.
  pgm.sql(`GRANT INSERT ON TABLE audit_events TO stuwith_api, stuwith_realtime`);
  pgm.sql(
    `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_events FROM stuwith_api, stuwith_realtime`,
  );

  pgm.sql(`
    COMMENT ON ROLE stuwith_api IS
      'Write owner of users/user_identities/sessions/rooms/plans (AD-8). Holds INSERT on audit_events and never UPDATE or DELETE on it (AD-12). Must never hold INSERT or UPDATE on coin_ledger or user_balances.'
  `);
  pgm.sql(`
    COMMENT ON ROLE stuwith_realtime IS
      'Write owner of coin_ledger/user_balances/private_sessions/room_participants (AD-8). Reads users/user_identities/sessions but must never write them. Holds INSERT on audit_events only (AD-12).'
  `);
};
