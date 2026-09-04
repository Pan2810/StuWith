import type { AuthProvider, GlobalUserRole } from '@stuwith/contracts';

/**
 * AD-1 — "which user does this provider identity belong to" is a domain question.
 * The OAuth SDK, the HTTP call and the `pg` driver that answer it live in
 * `apps/api` and `packages/db`; this file names no library at all.
 *
 * ## Why the identity is separate from the user
 *
 * `(provider, provider_user_id)` is the key. An email address is NOT: providers
 * verify email to different standards and Apple hands out relay addresses, so
 * merging on email is an account-takeover route rather than a convenience. Two
 * providers reporting the same address produce two users, and that is the correct
 * answer — deliberate account linking is a later epic.
 */

/**
 * What a provider told us about the person who just authenticated, after the
 * shell has finished parsing whatever shape that provider uses.
 *
 * `email` is nullable because Apple lets a user withhold it, and `displayName`
 * has a fallback for the same reason: a login must not fail because the provider
 * was stingy with profile fields.
 */
export interface ProviderIdentity {
  readonly provider: AuthProvider;
  /** Stable, provider-scoped subject. Normalised by `normalizeProviderUserId`. */
  readonly providerUserId: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface User {
  readonly id: string;
  readonly displayName: string;
  /** Nullable: Apple can withhold it, and no flow may require it. */
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly role: GlobalUserRole;
  /**
   * The declared date of birth as `YYYY-MM-DD`, or `null` for "not declared yet".
   *
   * ## `null` is the profile-completion state, and there is no second one
   *
   * Story 1.2 creates a user at the moment of first login, before anybody has been
   * asked anything, so the column cannot be `NOT NULL` without breaking every
   * first sign-in. That absence is then the honest representation of "the profile
   * is not finished" — and a `profileCompleted` flag beside it would be a second
   * field describing the same fact, with nothing keeping the two in step.
   *
   * ## It is a STRING, not a `Date`
   *
   * A `Date` is an instant, and a date of birth is a day. Node's `pg` driver hands
   * back a `date` column as a `Date` at LOCAL midnight, so the same row read on two
   * machines in two zones produces two different days — the exact class of bug the
   * UTC rule exists to prevent. The adapters therefore ask Postgres for text and
   * `packages/domain` compares calendar days. See `policies/date-of-birth.ts`.
   *
   * ## It must not leave `apps/api`
   *
   * This is PII under the epic's own definition, and the release gate is "no PII
   * in a log line". It is deliberately absent from `CurrentUser` in
   * `packages/contracts`; what leaves the API is two booleans, never a date. Do
   * not add it to a response body, to an audit row, or to anything that is logged
   * — `audit_events` has no `DELETE` for any role, so a date of birth written
   * there is unremovable for ever.
   */
  readonly dateOfBirth: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `created` is not decoration: the audit row and the "first login creates a
 * profile" acceptance criterion both need to know whether this call produced a
 * user or found one, and an adapter that cannot tell the difference has almost
 * certainly implemented read-then-write.
 */
export interface ResolvedIdentity {
  readonly user: User;
  readonly created: boolean;
}

/**
 * A caller handed something that cannot describe an identity. Like
 * `HeartbeatInputError`, this is a defect in the calling code rather than an
 * outcome of a rule, so it throws instead of occupying a branch every correct
 * caller would have to handle — and it lives here so that BOTH adapters raise the
 * same error for the same input.
 */
export class IdentityInputError extends Error {
  override readonly name = 'IdentityInputError';

  constructor(message: string) {
    super(message);
  }
}

export interface IdentityPort {
  /**
   * Find the user behind this provider identity, creating one on first sight.
   *
   * Must be a single conditional write followed by a read — never read-then-write.
   * Two callbacks for the same brand-new identity arrive concurrently in practice
   * (a double-clicked provider consent screen is enough), and the UNIQUE
   * constraint on `(provider, provider_user_id)` is what decides the winner. An
   * adapter that checks-then-inserts creates two users and satisfies every
   * architecture rule while doing it.
   *
   * @throws {IdentityInputError} when the identity cannot be stored as given.
   */
  findOrCreateByIdentity(identity: ProviderIdentity, now: Date): Promise<ResolvedIdentity>;

  /** @throws {IdentityInputError} when `userId` is not a usable id. */
  findUserById(userId: string): Promise<User | null>;

  /**
   * Write the date of birth, once and only once.
   *
   * ## The write-once property belongs to the STATEMENT, not to a check
   *
   * The implementation must be a single conditional write —
   * `UPDATE users SET date_of_birth = $2 WHERE id = $1 AND date_of_birth IS NULL`
   * — and must decide the outcome from the number of rows it changed. Reading the
   * row first and then writing is a race with a window in it: two requests for the
   * same profile both see `NULL`, both take the "not set yet" branch, and the
   * second one silently overwrites the first. A double-tapped submit button is
   * enough to produce that, and the failure is invisible — both requests answer
   * success and the stored value is whichever landed last.
   *
   * With the condition inside the write, Postgres decides who won: the second
   * statement blocks on the first one's row lock, re-evaluates `IS NULL` against
   * the committed value, and matches nothing. The in-memory adapter has to reach
   * the same answer, which is what makes the shared contract suite worth running
   * twice.
   *
   * ## A refusal is a return branch, never an exception
   *
   * "This profile already has a date of birth" is a normal outcome of a rule, not
   * a fault, and the shape follows `SessionPort` (and the money ports arriving in
   * Epic 3): the caller cannot forget to handle it, because the success value is
   * not reachable without narrowing. A thrown refusal would be indistinguishable
   * at the call site from the store being down.
   *
   * `dateOfBirth` must be `YYYY-MM-DD` and name a real calendar day. Whether it is
   * PLAUSIBLE — not in the future, not before 1900 — is the caller's question,
   * because answering it needs a clock and a port has none. `apps/api` asks
   * `parseDateOfBirth` with its `ClockPort` before it gets here.
   *
   * @throws {IdentityInputError} when `userId`, `dateOfBirth` or `now` is unusable.
   */
  recordDateOfBirth(
    userId: string,
    dateOfBirth: string,
    now: Date,
  ): Promise<RecordDateOfBirthResult>;
}

/**
 * Why the write did not happen. Both are ordinary answers, not faults.
 *
 * `AlreadyRecorded` is the story's whole point. `UserNotFound` is separate rather
 * than folded into it because the two need different responses — one is "your
 * profile is already complete", the other is "your session points at a profile
 * that is gone", which is a `401` — and a single reason would make the caller
 * guess which.
 */
export type RecordDateOfBirthRefusal = 'AlreadyRecorded' | 'UserNotFound';

export type RecordDateOfBirthResult =
  | { readonly ok: true; readonly user: User }
  | { readonly ok: false; readonly reason: RecordDateOfBirthRefusal };
