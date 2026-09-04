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
}
