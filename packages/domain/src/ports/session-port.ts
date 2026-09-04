/**
 * Session lifecycle as a port: open, read, rotate, revoke a chain.
 *
 * ## Why opaque server-side sessions and not a JWT
 *
 * The spine requires the WebSocket boundary to "re-authenticate when a session is
 * revoked". A JWT cannot be revoked before it expires without a server-side deny
 * list — which is a table. Having decided a table is unavoidable, a plain
 * server-side session is strictly simpler: rotation and instant revocation are the
 * same UPDATE, and Epic 2 only has to read one row.
 *
 * ## Why every token crosses this boundary as a HASH
 *
 * Not one method takes a token. They take `...TokenHash`, and the caller does the
 * hashing (hashing needs `node:crypto`, which AD-1 keeps out of the domain
 * entirely). That is not a workaround — it makes "the database stores no usable
 * token" a property of the port's TYPE rather than a promise in a comment. An
 * adapter physically cannot store the plaintext it is never given.
 */

/**
 * Every way a session request can be validly refused. All four are returns, never
 * throws: a caller has to handle them, and none of them is an outage.
 *
 * `RefreshTokenReused` is the one that matters. A refresh token that has already
 * been rotated should not exist anywhere except in an attacker's hands or a stolen
 * backup, so presenting one is treated as theft — the whole chain is revoked, not
 * just that token. A user who genuinely hit a race loses their session, which is
 * the cheap half of the trade.
 */
export type SessionRefusalReason =
  | 'SessionNotFound'
  | 'SessionExpired'
  | 'SessionRevoked'
  | 'RefreshTokenReused';

/**
 * One generation of tokens inside a chain.
 *
 * `sessionId` is the CHAIN id and is stable across every rotation — it is what
 * Epic 2's WebSocket handshake will hold on to, and what revocation targets. `id`
 * is the individual row.
 */
export interface SessionGeneration {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface OpenSessionInput {
  readonly userId: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
}

export interface RotateSessionInput {
  /** Hash of the refresh token the client just presented. */
  readonly presentedRefreshTokenHash: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
}

export type ReadSessionResult =
  | { readonly ok: true; readonly session: SessionGeneration }
  | { readonly ok: false; readonly reason: SessionRefusalReason };

export type RotateSessionResult =
  | { readonly ok: true; readonly session: SessionGeneration }
  | {
      readonly ok: false;
      readonly reason: SessionRefusalReason;
      /**
       * Set when the refusal revoked a chain, so the caller can say so in the
       * audit row without a second query.
       */
      readonly revokedSessionId?: string;
    };

/**
 * A caller handed something that cannot describe a session. A defect in the
 * calling code, so it throws — and both adapters throw the same error.
 */
export class SessionInputError extends Error {
  override readonly name = 'SessionInputError';

  constructor(message: string) {
    super(message);
  }
}

export interface SessionPort {
  /** @throws {SessionInputError} when the input cannot describe a session. */
  open(input: OpenSessionInput): Promise<SessionGeneration>;

  /**
   * The read path for every authenticated request.
   *
   * A generation that has been rotated is NOT usable, even before it expires:
   * once a newer generation exists the old access token is spent, and treating it
   * as live would leave a stolen token working for the rest of its TTL.
   *
   * @throws {SessionInputError} when `accessTokenHash` is not a usable hash.
   */
  readByAccessTokenHash(accessTokenHash: string, now: Date): Promise<ReadSessionResult>;

  /**
   * Rotate: mark the presented generation rotated and issue the next one, keeping
   * `sessionId` unchanged.
   *
   * Must be a single conditional UPDATE (`... WHERE rotated_at IS NULL`) so two
   * concurrent refreshes cannot both win. The loser sees an already-rotated token
   * and MUST return `RefreshTokenReused` after revoking the chain — an adapter
   * that quietly re-issues instead has removed the theft detection.
   *
   * @throws {SessionInputError} when the input cannot describe a rotation.
   */
  rotate(input: RotateSessionInput): Promise<RotateSessionResult>;

  /**
   * Revoke every generation in a chain. Idempotent: revoking twice is not an
   * error, because logout and theft detection can both reach it.
   *
   * @throws {SessionInputError} when `sessionId` is not a usable id.
   */
  revokeChain(sessionId: string, now: Date): Promise<void>;

  /**
   * Logout's entry point: revoke the chain a refresh token belongs to, whatever
   * state that particular token is in. Returns the chain id, or null if no such
   * token was ever issued.
   *
   * Deliberately NOT expressed as "read, then revoke". The access token is only
   * live for `SESSION_TTL_SECONDS`, so a logout an hour into a session finds
   * nothing to read — and the refresh chain, good for thirty days, would survive
   * it. Clearing cookies is browser-side only; anyone holding a copy of the
   * refresh token would still be signed in. So the refresh token itself is the
   * handle, and its own rotated/expired state is irrelevant to the request "end
   * this session".
   *
   * @throws {SessionInputError} when `refreshTokenHash` is not a usable hash.
   */
  revokeChainByRefreshTokenHash(refreshTokenHash: string, now: Date): Promise<string | null>;

  /** All generations of a chain, oldest first. Read-only; used by tests and audit. */
  listChain(sessionId: string): Promise<readonly SessionGeneration[]>;
}
