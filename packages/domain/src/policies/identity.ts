import type { AuthProvider, GlobalUserRole } from '@stuwith/contracts';
import { IdentityInputError, type ProviderIdentity } from '../ports/identity-port';

/**
 * The identity rules, as pure functions. No database, no HTTP, no clock beyond
 * what is passed in — which is exactly why the acceptance criterion "logging in
 * twice must not create a second account" can be tested here in milliseconds
 * instead of only through a live OAuth round trip.
 */

/** Matches the `text` column and every provider subject any of the four emits. */
export const MAX_PROVIDER_USER_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 120;

/** New accounts are ordinary users. `guest` is the absence of an account. */
export const DEFAULT_USER_ROLE: GlobalUserRole = 'user';

export function defaultRoleForNewUser(): GlobalUserRole {
  return DEFAULT_USER_ROLE;
}

/**
 * Trim and validate — nothing more.
 *
 * Case is deliberately preserved. Provider subjects are opaque, and several are
 * case-sensitive base64url; lower-casing them would silently collide two distinct
 * accounts into one, which is the worst possible outcome for an identity key. The
 * only normalisation that is safe is removing transport whitespace.
 *
 * @throws {IdentityInputError}
 */
export function normalizeProviderUserId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new IdentityInputError('provider_user_id must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new IdentityInputError('provider_user_id must not be empty');
  }
  if (trimmed.length > MAX_PROVIDER_USER_ID_LENGTH) {
    throw new IdentityInputError(
      `provider_user_id must be at most ${MAX_PROVIDER_USER_ID_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * Microsoft/Entra: the subject that survives a tenant move is the PAIR `(tid, oid)`.
 *
 * `sub` is per-application-per-user and changes if the app registration changes;
 * `oid` alone is unique only inside one tenant, so two organisations could hand
 * back the same `oid` and be merged into one account. Joining them is what makes
 * the `@fpt.com` organisational-account criterion hold, and doing it in a pure
 * function is what makes that testable before any real Entra credential exists.
 *
 * @throws {IdentityInputError}
 */
export function microsoftProviderUserId(objectId: unknown, tenantId: unknown): string {
  const oid = normalizeProviderUserId(objectId);
  const tid = normalizeProviderUserId(tenantId);
  if (oid.includes(':') || tid.includes(':')) {
    // The separator has to stay unambiguous, or `(a, b:c)` and `(a:b, c)` become
    // the same key — a two-tenant account collision that no test would ever hit.
    throw new IdentityInputError('microsoft oid/tid must not contain the ":" separator');
  }
  return `${tid}:${oid}`;
}

/**
 * The identity key. Email is not part of it, and that omission is the rule.
 *
 * Two providers reporting the same verified address are still two identities and
 * therefore two accounts. Anything else means anyone who can get a provider to
 * assert an address can walk into the account that already owns it.
 */
export function identityKey(provider: AuthProvider, providerUserId: string): string {
  return `${provider}:${normalizeProviderUserId(providerUserId)}`;
}

/** True only when provider AND subject match. Email is ignored by construction. */
export function isSameIdentity(
  a: Pick<ProviderIdentity, 'provider' | 'providerUserId'>,
  b: Pick<ProviderIdentity, 'provider' | 'providerUserId'>,
): boolean {
  return identityKey(a.provider, a.providerUserId) === identityKey(b.provider, b.providerUserId);
}

/**
 * A login must never fail because the provider withheld a name. Apple returns one
 * only on the very first consent, and Facebook can return none at all.
 */
export function resolveDisplayName(candidate: unknown, provider: AuthProvider): string {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (trimmed.length === 0) {
    return fallbackDisplayName(provider);
  }
  return trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/**
 * Deliberately generic and deliberately NOT derived from the email local part:
 * `an.nguyen@fpt.com` as a public display name is a PII leak wearing a friendly
 * face, and the product's whole premise is that presence and identity are separable.
 */
export function fallbackDisplayName(provider: AuthProvider): string {
  void provider;
  return 'Bạn học mới';
}

/**
 * An email we are willing to store, or null. Never throws: a malformed address
 * from a provider is not a reason to refuse a login, it is a reason to store
 * nothing. `email` is nullable in the schema precisely so this can be the answer.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 320 || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Only an absolute **https** URL from the provider is kept (AD-29: the MVP stores
 * no binaries, so an avatar is always a remote URL).
 *
 * https only, not "http(s)": all four providers serve avatars over TLS, and a
 * plain-http image on an https page is blocked as mixed content anyway — so
 * accepting one would store a value that can never render. The scheme check is
 * also a real control rather than tidiness: a `javascript:` or `data:` value here
 * ends up in an attribute the web client renders.
 */
export function normalizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return null;
  }
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * The one place a raw provider profile becomes something the store will accept.
 * Adapters call this so that a Facebook profile and a Google id_token cannot end
 * up normalised two different ways.
 *
 * @throws {IdentityInputError} when the subject is unusable.
 */
export function toProviderIdentity(input: {
  provider: AuthProvider;
  providerUserId: unknown;
  email?: unknown;
  displayName?: unknown;
  avatarUrl?: unknown;
}): ProviderIdentity {
  return {
    provider: input.provider,
    providerUserId: normalizeProviderUserId(input.providerUserId),
    email: normalizeEmail(input.email),
    displayName: resolveDisplayName(input.displayName, input.provider),
    avatarUrl: normalizeAvatarUrl(input.avatarUrl),
  };
}
