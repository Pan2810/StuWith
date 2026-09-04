import type { AuthProvider } from '@stuwith/contracts';
import type { AuditPort } from '@stuwith/domain';

/**
 * AD-12 — the two audit rows `packages/contracts` has been promising since Story
 * 1.1 (`auth.signed_in`, `auth.sign_in_failed`), now actually written.
 *
 * Exactly one row per attempt. Not zero, and not one per internal step: an audit
 * trail where a single login produces three rows is one where "how many people
 * signed in today" cannot be answered without knowing the implementation.
 *
 * ## What may go in `metadata`
 *
 * Non-PII scalars only, and the type below is the whole allowed vocabulary. The
 * provider NAME is fine — `google` identifies a mechanism, not a person. The
 * provider SUBJECT is not, and neither is the email; both are pseudonymous
 * identifiers for one human being, and this is the one table that is kept forever
 * and cannot be corrected afterwards. `packages/db`'s adapter rejects anything
 * that is not a scalar, so a whole provider response cannot be dropped in here by
 * accident.
 */

/**
 * Why a sign-in failed, in machine-readable form. Never shown to a user, and
 * deliberately OUR vocabulary rather than a provider's error code.
 *
 * The set is closed and covers every path that ends without a session, on both
 * legs of the flow and on refresh. That completeness is the point: an outcome with
 * no reason in this list is an outcome that leaves no audit row, and "the login
 * just did nothing" is the hardest possible incident to investigate.
 */
export type SignInFailureReason =
  // Start leg.
  | 'provider_start_failed'
  // Callback leg.
  | 'state_missing'
  | 'state_mismatch'
  | 'state_expired'
  | 'code_missing'
  | 'provider_exchange_failed'
  | 'identity_rejected'
  // Refresh leg.
  | 'refresh_cookie_missing'
  | 'refresh_token_unknown'
  | 'refresh_token_expired'
  | 'session_revoked'
  | 'session_reuse_detected';

export interface SignedInInput {
  readonly requestId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly provider: AuthProvider;
  readonly firstLogin: boolean;
  readonly occurredAt: Date;
}

export async function recordSignedIn(audit: AuditPort, input: SignedInInput): Promise<void> {
  await audit.append({
    sourceService: 'api',
    action: 'auth.signed_in',
    actorUserId: input.userId,
    // The session chain, so a later revocation can be traced back to the login
    // that opened it.
    subjectId: input.sessionId,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata: { provider: input.provider, first_login: input.firstLogin },
  });
}

export interface SignInFailedInput {
  readonly requestId: string;
  /** Absent for a failure that is not tied to one provider — a reused refresh token. */
  readonly provider?: AuthProvider;
  readonly reason: SignInFailureReason;
  readonly occurredAt: Date;
  /** Known only when the failure happened to an established session. */
  readonly userId?: string | null;
  readonly sessionId?: string | null;
}

export async function recordSignInFailed(
  audit: AuditPort,
  input: SignInFailedInput,
): Promise<void> {
  // `reason` is one of a closed set of our own words. It is deliberately NOT the
  // provider's error code: forwarding that would put a third party's vocabulary
  // into our permanent record and, sooner or later, into a user-facing message.
  const metadata: Record<string, string | number | boolean> = { reason: input.reason };
  if (input.provider !== undefined) {
    metadata['provider'] = input.provider;
  }

  await audit.append({
    sourceService: 'api',
    action: 'auth.sign_in_failed',
    actorUserId: input.userId ?? null,
    subjectId: input.sessionId ?? null,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata,
  });
}
