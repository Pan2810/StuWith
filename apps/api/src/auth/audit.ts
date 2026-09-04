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
 *
 * It is a runtime array and not only a type union so that a test can walk it. The
 * assertion that matters — no value in here ever reaches a URL, a response body or
 * a log line — is worthless if it is written against a hand-copied list that
 * quietly falls behind this one.
 *
 * Two of these are Story 1.3's, and neither is an error in the user's sense:
 *
 * - `user_cancelled` — the person said no at the consent screen. The interface
 *   must not call that a failure, but the trail still has to show the attempt:
 *   "half of everyone abandoned Facebook consent since yesterday" is a signal you
 *   only get if abandonment is written down.
 * - `provider_authorize_failed` — the provider itself refused before we ever got a
 *   `code` (`server_error`, `temporarily_unavailable`, a configuration mistake in
 *   their console). Distinct from `provider_exchange_failed`, which is the later
 *   leg. The provider's own error code is deliberately NOT stored: this table is
 *   permanent and uncorrectable, and a third party's vocabulary in it is how that
 *   vocabulary eventually reaches a user-facing message.
 */
export const SIGN_IN_FAILURE_REASONS = [
  // Start leg.
  'provider_start_failed',
  // Callback leg.
  'user_cancelled',
  'provider_authorize_failed',
  'state_missing',
  'state_mismatch',
  'state_expired',
  'code_missing',
  'provider_exchange_failed',
  // The provider answered and REFUSED what we sent — a guessed `code`, a replayed
  // `id_token`. Distinct from `provider_exchange_failed`, which is the provider
  // being unreachable or broken, because only this one is somebody's doing and
  // therefore only this one counts towards a brute-force lock.
  'code_rejected',
  'identity_rejected',
  // Refresh leg.
  'refresh_cookie_missing',
  'refresh_token_unknown',
  'refresh_token_expired',
  'session_revoked',
  'session_reuse_detected',
] as const;

export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

/**
 * The failure reasons that are NOT the user's fault, and therefore must not walk
 * anybody towards a lock.
 *
 * A brute-force counter exists to answer "is somebody working through a list".
 * A provider having a bad afternoon, or a consent screen left open past its
 * state expiry, answers a different question — and counting those means an
 * outage at Google locks out every person who tried during it, on top of the
 * outage they already suffered. `user_cancelled` is here for the reason Story
 * 1.3 part 1 gave: changing your mind is not a failure, and presenting it as one
 * is both untrue and mildly accusing.
 *
 * What IS counted is the shape of an attack, and only that: a `state` that does
 * not match one we signed, a `code` the provider refused (`code_rejected`), an
 * identity the store rejected, a reused refresh token, a refresh token nobody
 * issued.
 */
export const INNOCENT_SIGN_IN_FAILURES: ReadonlySet<SignInFailureReason> = new Set([
  // Sign-in legs: the person changed their mind, or the provider was unwell.
  'user_cancelled',
  'provider_start_failed',
  'provider_authorize_failed',
  'provider_exchange_failed',
  'state_expired',
  /**
   * `state_missing` means the browser sent no state cookie AT ALL, which is what
   * a browser that blocks the cookie looks like — ITP, strict privacy settings,
   * a third-party-cookie policy. Five honest attempts from such a browser used to
   * earn a fifteen-minute address lock, and the person could do nothing about it
   * because their browser, not their behaviour, was the cause. An attacker who
   * HAS a valid state cookie and guesses codes is caught by `code_rejected`
   * instead, which is the path that actually costs them something.
   */
  'state_missing',
  // Refresh leg. A tab left open overnight, or a session ended from another
  // device, is not an attack — and locking somebody out because their own
  // client retried a stale token would be the product punishing normal use.
  'refresh_cookie_missing',
  'refresh_token_expired',
  'session_revoked',
]);

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
