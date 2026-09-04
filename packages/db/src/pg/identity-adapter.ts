import type { GlobalUserRole } from '@stuwith/contracts';
import { isCalendarDate } from '@stuwith/contracts';
import type {
  IdentityPort,
  ProviderIdentity,
  RecordDateOfBirthResult,
  ResolvedIdentity,
  User,
} from '@stuwith/domain';
import { IdentityInputError, normalizeProviderUserId } from '@stuwith/domain';
import type { Pool, PoolClient } from 'pg';

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  role: string;
  date_of_birth: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * What the conditional declaration statement returns: one row, always.
 *
 * Every user column is nullable here and nowhere else, because the `LEFT JOIN`
 * against a CTE that matched nothing fills them with `NULL`. `user_exists` is the
 * existence check computed in the same statement, which is what tells
 * `AlreadyRecorded` from `UserNotFound` without a second round trip.
 */
type ConditionalUpdateRow = { readonly user_exists: boolean } & {
  readonly [K in keyof UserRow]: UserRow[K] | null;
};

/** Everything on `users` that comes back as itself. `date_of_birth` does not — see below. */
const PLAIN_USER_COLUMNS = [
  'id',
  'display_name',
  'email',
  'avatar_url',
  'role',
  'created_at',
  'updated_at',
] as const;

/**
 * The select list, optionally qualified by a table alias.
 *
 * A function rather than the string constant this used to be, because the join in
 * `findByIdentity` needs `u.`-prefixed columns and used to build them by splitting
 * the constant on `', '`. That works only while every entry is a bare column name,
 * and the entry below is a function call — `u.to_char(date_of_birth, ...)` is not
 * SQL. Composing the list here instead makes the prefix a parameter rather than a
 * string operation that quietly stops being valid.
 *
 * ## Why `date_of_birth` comes back as TEXT
 *
 * `pg` parses a `date` column into a JavaScript `Date` at LOCAL midnight, so the
 * same row read on a machine in UTC+7 and one in UTC-5 yields two different days
 * once anybody asks for the UTC calendar day — which is precisely what the age
 * rule does. Postgres formats it instead, in the one spelling `parseDateOfBirth`
 * accepts, and no client-side time zone is ever involved. `to_char(NULL, ...)` is
 * `NULL`, so "not declared yet" survives the conversion unchanged.
 */
function selectUserColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return [
    ...PLAIN_USER_COLUMNS.map((column) => `${prefix}${column}`),
    `to_char(${prefix}date_of_birth, 'YYYY-MM-DD') AS date_of_birth`,
  ].join(', ');
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    role: row.role as GlobalUserRole,
    dateOfBirth: row.date_of_birth,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * AD-1 keeps `pg` out of the domain; this is where it is allowed to live.
 *
 * ## The concurrency shape, and why it is not read-then-write
 *
 * Two callbacks for the same brand-new identity arrive together often enough to
 * matter (a double-tapped consent screen does it). `SELECT ... ; if none INSERT`
 * has both requests take the same branch and create two users, and no architecture
 * rule catches it — it only shows up as duplicate accounts in production.
 *
 * So the decisive statement is a single conditional write:
 *
 *   INSERT INTO user_identities ... ON CONFLICT (provider, provider_user_id) DO NOTHING
 *
 * Zero rows back means somebody else won, and the winner is then read back. The
 * UNIQUE constraint is the arbiter, not application logic.
 *
 * The user row is inserted first, inside the same transaction, and the whole
 * transaction is ROLLED BACK when the identity insert loses. Rollback rather than
 * cleanup is deliberate: no role holds DELETE (AD-12's posture applies to every
 * table here), so "insert a user then delete it if we lost" is not an option the
 * database would even permit — and rollback leaves no orphan `users` row behind,
 * which is what "exactly one user is created" actually requires.
 *
 * Note what is NOT caught: driver and server errors propagate untouched. A
 * deadlock or a revoked GRANT is a fault, and a fault must never be laundered into
 * a normal-looking result.
 */
export class PgIdentityAdapter implements IdentityPort {
  constructor(private readonly pool: Pool) {}

  async findOrCreateByIdentity(identity: ProviderIdentity, now: Date): Promise<ResolvedIdentity> {
    assertValidIdentity(identity, now);
    const providerUserId = normalizeProviderUserId(identity.providerUserId);

    // Attempt 1: try to become the creator.
    const created = await this.tryCreate(identity, providerUserId, now);
    if (created !== null) {
      return { user: created, created: true };
    }

    // Attempt 2: someone else created it. Under READ COMMITTED our INSERT blocked
    // on their uncommitted unique key and resumed once they committed, so the row
    // is visible by the time we get here.
    const existing = await this.findByIdentity(identity.provider, providerUserId);
    if (existing !== null) {
      return { user: existing, created: false };
    }

    // The conflicting writer rolled back between our conflict and our read — rare,
    // but real. One more attempt at creating; a second miss is a genuine fault and
    // is reported as one rather than silently returning a wrong answer.
    const retried = await this.tryCreate(identity, providerUserId, now);
    if (retried !== null) {
      return { user: retried, created: true };
    }
    const afterRetry = await this.findByIdentity(identity.provider, providerUserId);
    if (afterRetry !== null) {
      return { user: afterRetry, created: false };
    }
    throw new Error(
      'identity insert conflicted but no identity row is visible; the store is not behaving transactionally',
    );
  }

  async findUserById(userId: string): Promise<User | null> {
    assertValidUserId(userId);
    const result = await this.pool.query<UserRow>(
      `SELECT ${selectUserColumns()} FROM users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUser(row);
  }

  /**
   * The write-once declaration, decided by ONE statement.
   *
   * `WHERE id = $1 AND date_of_birth IS NULL` is the whole mechanism. Under READ
   * COMMITTED a second concurrent UPDATE blocks on the first one's row lock, and
   * when it resumes it re-evaluates the predicate against the *committed* row —
   * which now has a date of birth — so it matches nothing and reports zero rows.
   * Postgres picks the winner; nothing in this file does.
   *
   * ## Telling the two refusals apart, in the SAME statement
   *
   * Zero rows means one of exactly two things and the caller needs to know which:
   * an already-complete profile is a 409, a vanished one is a 401. That used to be
   * answered by a follow-up `findUserById` on a SECOND connection, outside any
   * transaction, and the docblock here claimed it "introduces no window". Only
   * half of that was true: the WRITE has no window, and the CLASSIFICATION did —
   * anything that removed the row between the two statements turned "your profile
   * already has a date of birth" into "your session points at nothing", a 409
   * reported as a 401.
   *
   * So the existence check rides in the same statement as the update, as a plain
   * `EXISTS`. Every part of one statement is evaluated against one snapshot, which
   * is what makes "did this row exist when we tried to write it" a question with
   * one answer rather than two readings taken a round trip apart. It also drops a
   * connection acquisition from the losing path.
   *
   * The `LEFT JOIN` on a one-row anchor is what keeps the result shape total: the
   * statement returns exactly one row whether or not the UPDATE matched, with the
   * user columns all `NULL` when it did not.
   *
   * `updated_at` moves with the value rather than being left behind: the row did
   * change, and a timestamp that lies about that is worse than no timestamp.
   */
  async recordDateOfBirth(
    userId: string,
    dateOfBirth: string,
    now: Date,
  ): Promise<RecordDateOfBirthResult> {
    assertValidUserId(userId);
    assertValidDateOfBirth(dateOfBirth);
    assertValidNow(now);

    const result = await this.pool.query<ConditionalUpdateRow>(
      `WITH updated AS (
         UPDATE users
            SET date_of_birth = $2::date, updated_at = $3
          WHERE id = $1 AND date_of_birth IS NULL
          RETURNING ${selectUserColumns()}
       )
       SELECT EXISTS (SELECT 1 FROM users WHERE id = $1) AS user_exists, u.*
         FROM (SELECT 1) AS anchor
         LEFT JOIN updated u ON true`,
      [userId, dateOfBirth, now],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // The anchor guarantees a row; losing it means the statement did not run the
      // way this adapter believes, and a fault must not be laundered into a normal
      // outcome (the collapse `heartbeat-port.ts` forbids).
      throw new Error('conditional date_of_birth UPDATE produced no result row');
    }
    if (row.id !== null) {
      // The LEFT JOIN either produced the whole updated row or produced none of
      // it; `id` is `NOT NULL` in the schema, so it is the one column that
      // distinguishes the two cases.
      return { ok: true, user: toUser(row as UserRow) };
    }
    return { ok: false, reason: row.user_exists ? 'AlreadyRecorded' : 'UserNotFound' };
  }

  private async findByIdentity(provider: string, providerUserId: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${selectUserColumns('u')}
         FROM user_identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.provider_user_id = $2`,
      [provider, providerUserId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUser(row);
  }

  /** Returns the created user, or null when the identity already existed. */
  private async tryCreate(
    identity: ProviderIdentity,
    providerUserId: string,
    now: Date,
  ): Promise<User | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query<UserRow>(
        // `date_of_birth` is deliberately not in the column list. A user is
        // created at first login, before anybody has been asked; the absence IS
        // the "profile not finished" state (Story 1.4).
        `INSERT INTO users (display_name, email, avatar_url, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING ${selectUserColumns()}`,
        [
          identity.displayName,
          identity.email,
          identity.avatarUrl,
          'user',
          now,
        ],
      );
      const userRow = inserted.rows[0];
      if (userRow === undefined) {
        throw new Error('users INSERT ... RETURNING produced no row');
      }

      const linked = await client.query<{ user_id: string }>(
        `INSERT INTO user_identities (user_id, provider, provider_user_id, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, provider_user_id) DO NOTHING
         RETURNING user_id`,
        [userRow.id, identity.provider, providerUserId, now],
      );

      if (linked.rows.length === 0) {
        // Lost the race. Rolling back removes the user we just created, so the
        // "exactly one user" property holds without needing a DELETE grant.
        await client.query('ROLLBACK');
        return null;
      }

      await client.query('COMMIT');
      return toUser(userRow);
    } catch (error) {
      // Best-effort rollback; the original fault is what the caller must see.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Both adapters validate identically, for the same reason the heartbeat adapters
 * do: otherwise Postgres raises a driver error where the in-memory store happily
 * accepts the value, and the two are only discovered to disagree in production.
 */
export function assertValidIdentity(identity: ProviderIdentity, now: Date): void {
  if (identity === null || typeof identity !== 'object') {
    throw new IdentityInputError('identity must be an object');
  }
  if (typeof identity.displayName !== 'string' || identity.displayName.trim().length === 0) {
    throw new IdentityInputError('displayName must be a non-empty string');
  }
  if (identity.email !== null && typeof identity.email !== 'string') {
    throw new IdentityInputError('email must be a string or null');
  }
  if (identity.avatarUrl !== null && typeof identity.avatarUrl !== 'string') {
    throw new IdentityInputError('avatarUrl must be a string or null');
  }
  assertValidNow(now);
  // Throws for an empty, non-string or over-long subject.
  normalizeProviderUserId(identity.providerUserId);
}

export function assertValidUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new IdentityInputError('userId must be a non-empty string');
  }
}

export function assertValidNow(now: unknown): asserts now is Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IdentityInputError('now must be a valid Date');
  }
}

/**
 * The SHAPE of a date of birth, and deliberately not its plausibility.
 *
 * `isCalendarDate` comes from `packages/contracts`, so the string an adapter will
 * accept and the string `parseDateOfBirth` will accept cannot drift apart — one
 * rule, read by both processes (AD-13). What an adapter must NOT decide is
 * whether the day is in the future or the year is believable: answering that
 * needs a clock, a port has none, and a second clock in `packages/db` would be a
 * second answer to "what day is it". `apps/api` asks `parseDateOfBirth` with its
 * `ClockPort` before it ever calls this.
 *
 * Both adapters validate through this one function for the same reason
 * `assertValidIdentity` is shared: otherwise Postgres raises a driver error where
 * the in-memory store happily accepts the value, and the two are only discovered
 * to disagree in production.
 */
export function assertValidDateOfBirth(dateOfBirth: unknown): asserts dateOfBirth is string {
  if (!isCalendarDate(dateOfBirth)) {
    throw new IdentityInputError('date_of_birth must be a real calendar day as YYYY-MM-DD');
  }
}
