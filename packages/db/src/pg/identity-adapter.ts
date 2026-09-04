import type { GlobalUserRole } from '@stuwith/contracts';
import type { IdentityPort, ProviderIdentity, ResolvedIdentity, User } from '@stuwith/domain';
import { IdentityInputError, normalizeProviderUserId } from '@stuwith/domain';
import type { Pool, PoolClient } from 'pg';

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  role: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT_USER_COLUMNS =
  'id, display_name, email, avatar_url, role, created_at, updated_at';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    role: row.role as GlobalUserRole,
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
      `SELECT ${SELECT_USER_COLUMNS} FROM users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUser(row);
  }

  private async findByIdentity(provider: string, providerUserId: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT ${SELECT_USER_COLUMNS.split(', ')
        .map((column) => `u.${column}`)
        .join(', ')}
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
        `INSERT INTO users (display_name, email, avatar_url, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING ${SELECT_USER_COLUMNS}`,
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
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IdentityInputError('now must be a valid Date');
  }
  // Throws for an empty, non-string or over-long subject.
  normalizeProviderUserId(identity.providerUserId);
}

export function assertValidUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new IdentityInputError('userId must be a non-empty string');
  }
}
