import type {
  OpenSessionInput,
  ReadSessionResult,
  RotateSessionInput,
  RotateSessionResult,
  SessionGeneration,
  SessionPort,
} from '@stuwith/domain';
import {
  assertValidHash,
  assertValidDate,
  assertValidOpenInput,
  assertValidRotateInput,
  classifyForRead,
} from '../pg/session-adapter';

interface MutableGeneration {
  id: string;
  sessionId: string;
  userId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  refreshExpiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

function snapshot(row: MutableGeneration): SessionGeneration {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    issuedAt: new Date(row.issuedAt.getTime()),
    expiresAt: new Date(row.expiresAt.getTime()),
    refreshExpiresAt: new Date(row.refreshExpiresAt.getTime()),
    rotatedAt: row.rotatedAt === null ? null : new Date(row.rotatedAt.getTime()),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt.getTime()),
  };
}

/**
 * TD-5 — the in-memory `SessionPort`, so the contract suite runs twice.
 *
 * The classification and validation logic is imported from the Postgres adapter,
 * not duplicated: "a rotated generation is not readable" and "a spent refresh
 * token revokes the chain" have to mean the same thing in both, or the pass that
 * runs without Docker becomes a test of a different system.
 *
 * The UNIQUE constraints on the two hash columns are mirrored explicitly below.
 * Postgres would reject a duplicate hash; a Map would silently overwrite the
 * earlier row and hand an attacker a way to displace someone else's session.
 */
export class InMemorySessionAdapter implements SessionPort {
  private readonly rows: MutableGeneration[] = [];
  private counter = 0;

  async open(input: OpenSessionInput): Promise<SessionGeneration> {
    assertValidOpenInput(input);
    this.assertHashesAreFree(input.accessTokenHash, input.refreshTokenHash);

    const row: MutableGeneration = {
      id: this.nextId(),
      sessionId: this.nextId(),
      userId: input.userId,
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      issuedAt: new Date(input.issuedAt.getTime()),
      expiresAt: new Date(input.expiresAt.getTime()),
      refreshExpiresAt: new Date(input.refreshExpiresAt.getTime()),
      rotatedAt: null,
      revokedAt: null,
    };
    this.rows.push(row);
    return snapshot(row);
  }

  async readByAccessTokenHash(accessTokenHash: string, now: Date): Promise<ReadSessionResult> {
    assertValidHash(accessTokenHash, 'accessTokenHash');
    assertValidDate(now, 'now');

    const row = this.rows.find((candidate) => candidate.accessTokenHash === accessTokenHash);
    if (row === undefined) {
      return { ok: false, reason: 'SessionNotFound' };
    }
    return classifyForRead(snapshot(row), now);
  }

  async rotate(input: RotateSessionInput): Promise<RotateSessionResult> {
    assertValidRotateInput(input);

    const row = this.rows.find(
      (candidate) => candidate.refreshTokenHash === input.presentedRefreshTokenHash,
    );
    if (row === undefined) {
      return { ok: false, reason: 'SessionNotFound' };
    }
    if (row.revokedAt !== null) {
      return { ok: false, reason: 'SessionRevoked' };
    }
    if (row.rotatedAt !== null) {
      // Spent token: treat as theft and end the chain, exactly as Postgres does.
      await this.revokeChain(row.sessionId, input.issuedAt);
      return { ok: false, reason: 'RefreshTokenReused', revokedSessionId: row.sessionId };
    }
    if (row.refreshExpiresAt.getTime() <= input.issuedAt.getTime()) {
      return { ok: false, reason: 'SessionExpired' };
    }

    this.assertHashesAreFree(input.accessTokenHash, input.refreshTokenHash);
    row.rotatedAt = new Date(input.issuedAt.getTime());

    const next: MutableGeneration = {
      id: this.nextId(),
      sessionId: row.sessionId,
      userId: row.userId,
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      issuedAt: new Date(input.issuedAt.getTime()),
      expiresAt: new Date(input.expiresAt.getTime()),
      refreshExpiresAt: new Date(input.refreshExpiresAt.getTime()),
      rotatedAt: null,
      revokedAt: null,
    };
    this.rows.push(next);
    return { ok: true, session: snapshot(next) };
  }

  async revokeChain(sessionId: string, now: Date): Promise<void> {
    assertValidHash(sessionId, 'sessionId');
    assertValidDate(now, 'now');

    for (const row of this.rows) {
      if (row.sessionId === sessionId && row.revokedAt === null) {
        row.revokedAt = new Date(now.getTime());
      }
    }
  }

  async revokeChainByRefreshTokenHash(
    refreshTokenHash: string,
    now: Date,
  ): Promise<string | null> {
    assertValidHash(refreshTokenHash, 'refreshTokenHash');
    assertValidDate(now, 'now');

    const row = this.rows.find((candidate) => candidate.refreshTokenHash === refreshTokenHash);
    if (row === undefined) {
      return null;
    }
    await this.revokeChain(row.sessionId, now);
    return row.sessionId;
  }

  async listChain(sessionId: string): Promise<readonly SessionGeneration[]> {
    assertValidHash(sessionId, 'sessionId');
    return this.rows.filter((row) => row.sessionId === sessionId).map(snapshot);
  }

  clear(): void {
    this.rows.length = 0;
    this.counter = 0;
  }

  private assertHashesAreFree(accessTokenHash: string, refreshTokenHash: string): void {
    for (const row of this.rows) {
      if (row.accessTokenHash === accessTokenHash || row.refreshTokenHash === refreshTokenHash) {
        // Mirrors `sessions_access_token_hash_key` / `sessions_refresh_token_hash_key`.
        // A Map would overwrite instead, which is a way to displace someone else's
        // live session.
        throw new Error('duplicate session token hash');
      }
    }
  }

  private nextId(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `019200f1-0000-7000-8000-${suffix}`;
  }
}
