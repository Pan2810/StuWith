import type {
  OpenSessionInput,
  ReadSessionResult,
  RotateSessionInput,
  RotateSessionResult,
  SessionGeneration,
  SessionPort,
} from '@stuwith/domain';
import { SessionInputError } from '@stuwith/domain';
import type { Pool, PoolClient } from 'pg';

interface SessionRow {
  id: string;
  session_id: string;
  user_id: string;
  issued_at: Date;
  expires_at: Date;
  refresh_expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS =
  'id, session_id, user_id, issued_at, expires_at, refresh_expires_at, rotated_at, revoked_at';

function toGeneration(row: SessionRow): SessionGeneration {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Postgres form of `SessionPort`.
 *
 * Two things here are load-bearing and easy to lose in a refactor:
 *
 *  1. **Rotation is ONE conditional UPDATE** (`WHERE rotated_at IS NULL AND
 *     revoked_at IS NULL AND refresh_expires_at > now`). Two concurrent refreshes
 *     both run it; exactly one gets a row back. Splitting it into a SELECT and an
 *     UPDATE lets both win, which quietly issues two live chains from one token.
 *  2. **Zero rows back is not automatically "not found".** The loser of that race
 *     has presented an already-rotated token, which is indistinguishable from a
 *     stolen one — so the row is re-read to classify, and an already-rotated token
 *     revokes the whole chain. Collapsing this into `SessionNotFound` would delete
 *     the only theft detection the system has.
 *
 * No statement here deletes anything. Revocation is an UPDATE, which is why the
 * migration grants UPDATE and no role anywhere holds DELETE.
 */
export class PgSessionAdapter implements SessionPort {
  constructor(private readonly pool: Pool) {}

  async open(input: OpenSessionInput): Promise<SessionGeneration> {
    assertValidOpenInput(input);

    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions
         (session_id, user_id, access_token_hash, refresh_token_hash,
          issued_at, expires_at, refresh_expires_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        input.accessTokenHash,
        input.refreshTokenHash,
        input.issuedAt,
        input.expiresAt,
        input.refreshExpiresAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('sessions INSERT ... RETURNING produced no row');
    }
    return toGeneration(row);
  }

  async readByAccessTokenHash(accessTokenHash: string, now: Date): Promise<ReadSessionResult> {
    assertValidHash(accessTokenHash, 'accessTokenHash');
    assertValidDate(now, 'now');

    const result = await this.pool.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE access_token_hash = $1`,
      [accessTokenHash],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { ok: false, reason: 'SessionNotFound' };
    }
    return classifyForRead(toGeneration(row), now);
  }

  async rotate(input: RotateSessionInput): Promise<RotateSessionResult> {
    assertValidRotateInput(input);

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimed = await client.query<SessionRow>(
        `UPDATE sessions
            SET rotated_at = $2
          WHERE refresh_token_hash = $1
            AND rotated_at IS NULL
            AND revoked_at IS NULL
            AND refresh_expires_at > $2
          RETURNING ${COLUMNS}`,
        [input.presentedRefreshTokenHash, input.issuedAt],
      );

      const claimedRow = claimed.rows[0];
      if (claimedRow === undefined) {
        const refusal = await this.refuseRotation(client, input);
        await client.query('COMMIT');
        return refusal;
      }

      const inserted = await client.query<SessionRow>(
        `INSERT INTO sessions
           (session_id, user_id, access_token_hash, refresh_token_hash,
            issued_at, expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [
          claimedRow.session_id,
          claimedRow.user_id,
          input.accessTokenHash,
          input.refreshTokenHash,
          input.issuedAt,
          input.expiresAt,
          input.refreshExpiresAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('sessions INSERT ... RETURNING produced no row');
      }

      await client.query('COMMIT');
      return { ok: true, session: toGeneration(row) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeChain(sessionId: string, now: Date): Promise<void> {
    assertValidHash(sessionId, 'sessionId');
    assertValidDate(now, 'now');

    await this.pool.query(
      `UPDATE sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId, now],
    );
  }

  async revokeChainByRefreshTokenHash(
    refreshTokenHash: string,
    now: Date,
  ): Promise<string | null> {
    assertValidHash(refreshTokenHash, 'refreshTokenHash');
    assertValidDate(now, 'now');

    // One statement, not "find the chain then revoke it": the sub-select and the
    // update run in the same snapshot, so a concurrent rotation cannot slip a new
    // generation in between and leave it live after a logout.
    const result = await this.pool.query<{ session_id: string }>(
      `UPDATE sessions
          SET revoked_at = $2
        WHERE session_id = (SELECT session_id FROM sessions WHERE refresh_token_hash = $1)
          AND revoked_at IS NULL
       RETURNING session_id`,
      [refreshTokenHash, now],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return row.session_id;
    }

    // Zero rows means either "no such token" or "already fully revoked", and a
    // logout must report the second as success rather than as a miss.
    const existing = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM sessions WHERE refresh_token_hash = $1`,
      [refreshTokenHash],
    );
    return existing.rows[0]?.session_id ?? null;
  }

  async listChain(sessionId: string): Promise<readonly SessionGeneration[]> {
    assertValidHash(sessionId, 'sessionId');
    const result = await this.pool.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE session_id = $1 ORDER BY issued_at, id`,
      [sessionId],
    );
    return result.rows.map(toGeneration);
  }

  /**
   * The UPDATE matched nothing. Work out why, and treat a spent refresh token as
   * theft rather than as a stale request.
   */
  private async refuseRotation(
    client: PoolClient,
    input: RotateSessionInput,
  ): Promise<RotateSessionResult> {
    const found = await client.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE refresh_token_hash = $1`,
      [input.presentedRefreshTokenHash],
    );
    const row = found.rows[0];
    if (row === undefined) {
      return { ok: false, reason: 'SessionNotFound' };
    }
    if (row.revoked_at !== null) {
      return { ok: false, reason: 'SessionRevoked' };
    }
    if (row.rotated_at !== null) {
      // Already spent. Either a replay of a stolen token or a client that kept a
      // copy; both are handled the same way, because the system cannot tell them
      // apart and the safe answer is to end the chain.
      await client.query(
        `UPDATE sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`,
        [row.session_id, input.issuedAt],
      );
      return { ok: false, reason: 'RefreshTokenReused', revokedSessionId: row.session_id };
    }
    return { ok: false, reason: 'SessionExpired' };
  }
}

/**
 * Shared by both adapters so a rotated-but-unexpired generation cannot be treated
 * as live by one implementation and dead by the other.
 *
 * Order matters: revoked beats expired beats rotated. A revoked session must read
 * as revoked even after its TTL passes, because that is the answer an incident
 * review needs.
 */
export function classifyForRead(session: SessionGeneration, now: Date): ReadSessionResult {
  if (session.revokedAt !== null) {
    return { ok: false, reason: 'SessionRevoked' };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'SessionExpired' };
  }
  if (session.rotatedAt !== null) {
    // Superseded by a newer generation: the token is spent even though the clock
    // has not caught up with it yet.
    return { ok: false, reason: 'SessionExpired' };
  }
  return { ok: true, session };
}

export function assertValidHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionInputError(`${label} must be a non-empty string`);
  }
  if (value.length > 512) {
    throw new SessionInputError(`${label} must be at most 512 characters`);
  }
}

export function assertValidDate(value: unknown, label: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SessionInputError(`${label} must be a valid Date`);
  }
}

export function assertValidOpenInput(input: OpenSessionInput): void {
  assertValidHash(input?.userId, 'userId');
  assertValidHash(input.accessTokenHash, 'accessTokenHash');
  assertValidHash(input.refreshTokenHash, 'refreshTokenHash');
  assertValidDate(input.issuedAt, 'issuedAt');
  assertValidDate(input.expiresAt, 'expiresAt');
  assertValidDate(input.refreshExpiresAt, 'refreshExpiresAt');
  if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new SessionInputError('expiresAt must be after issuedAt');
  }
  if (input.refreshExpiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new SessionInputError('refreshExpiresAt must be after issuedAt');
  }
}

export function assertValidRotateInput(input: RotateSessionInput): void {
  assertValidHash(input?.presentedRefreshTokenHash, 'presentedRefreshTokenHash');
  assertValidHash(input.accessTokenHash, 'accessTokenHash');
  assertValidHash(input.refreshTokenHash, 'refreshTokenHash');
  assertValidDate(input.issuedAt, 'issuedAt');
  assertValidDate(input.expiresAt, 'expiresAt');
  assertValidDate(input.refreshExpiresAt, 'refreshExpiresAt');
  if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new SessionInputError('expiresAt must be after issuedAt');
  }
  if (input.refreshExpiresAt.getTime() <= input.issuedAt.getTime()) {
    throw new SessionInputError('refreshExpiresAt must be after issuedAt');
  }
}
