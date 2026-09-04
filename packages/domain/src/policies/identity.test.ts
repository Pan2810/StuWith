import { describe, expect, it } from 'vitest';
import { IdentityInputError } from '../ports/identity-port';
import {
  DEFAULT_USER_ROLE,
  MAX_PROVIDER_USER_ID_LENGTH,
  fallbackDisplayName,
  identityKey,
  isSameIdentity,
  microsoftProviderUserId,
  normalizeAvatarUrl,
  normalizeEmail,
  normalizeProviderUserId,
  resolveDisplayName,
  toProviderIdentity,
} from './identity';

/**
 * Runs in the `domain` Vitest project: environment `node`, no setup file, no
 * Docker, no network. That is the executable form of AD-1 — if these rules ever
 * needed a database to check, the dependency direction would already be broken.
 */
describe('provider subject normalisation', () => {
  it('trims transport whitespace', () => {
    expect(normalizeProviderUserId('  1234567890  ')).toBe('1234567890');
  });

  it('PRESERVES case — a provider subject is opaque and often case-sensitive', () => {
    // Lower-casing a base64url subject collides two distinct accounts into one.
    // That is silent, permanent, and the worst outcome an identity key can have.
    expect(normalizeProviderUserId('AbC-123_x')).toBe('AbC-123_x');
    expect(identityKey('apple', 'AbC')).not.toBe(identityKey('apple', 'abc'));
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['an over-long subject', 'x'.repeat(MAX_PROVIDER_USER_ID_LENGTH + 1)],
  ])('throws IdentityInputError for %s', (_label, value) => {
    expect(() => normalizeProviderUserId(value)).toThrow(IdentityInputError);
  });
});

describe('email is not the identity key', () => {
  const email = 'an.nguyen@fpt.edu.vn';

  it('treats the same address on two providers as two different identities', () => {
    // The acceptance criterion says two providers with one address produce two
    // accounts. Merging on email is an account-takeover route: anyone who can get
    // a provider to assert an address walks into the account that owns it.
    const google = toProviderIdentity({ provider: 'google', providerUserId: 'g-1', email });
    const facebook = toProviderIdentity({ provider: 'facebook', providerUserId: 'f-1', email });

    expect(google.email).toBe(facebook.email);
    expect(isSameIdentity(google, facebook)).toBe(false);
    expect(identityKey(google.provider, google.providerUserId)).not.toBe(
      identityKey(facebook.provider, facebook.providerUserId),
    );
  });

  it('treats the same provider subject as the same identity regardless of email', () => {
    const first = toProviderIdentity({ provider: 'google', providerUserId: 'g-1', email });
    const later = toProviderIdentity({
      provider: 'google',
      providerUserId: 'g-1',
      email: 'changed@example.com',
    });
    expect(isSameIdentity(first, later)).toBe(true);
  });
});

describe('microsoft organisational accounts', () => {
  it('keys on (tid, oid), not on oid alone', () => {
    // `oid` is unique only inside one tenant. Two organisations can hand back the
    // same value; keying on it alone merges two strangers into one account.
    const sameOidTwoTenants = [
      microsoftProviderUserId('00000000-0000-0000-0000-0000000000aa', 'tenant-fpt'),
      microsoftProviderUserId('00000000-0000-0000-0000-0000000000aa', 'tenant-vnu'),
    ];
    expect(sameOidTwoTenants[0]).not.toBe(sameOidTwoTenants[1]);
  });

  it('is stable for the same organisational account', () => {
    expect(microsoftProviderUserId('oid-1', 'tid-1')).toBe(
      microsoftProviderUserId('oid-1', 'tid-1'),
    );
    expect(microsoftProviderUserId('oid-1', 'tid-1')).toBe('tid-1:oid-1');
  });

  it('refuses a component containing the separator, so two pairs cannot collide', () => {
    // Without this, ("a", "b:c") and ("a:b", "c") produce the same key.
    expect(() => microsoftProviderUserId('a:b', 'c')).toThrow(IdentityInputError);
    expect(() => microsoftProviderUserId('a', 'b:c')).toThrow(IdentityInputError);
  });

  it('refuses a missing tenant rather than guessing one', () => {
    expect(() => microsoftProviderUserId('oid-1', '')).toThrow(IdentityInputError);
  });
});

describe('display name', () => {
  it('falls back when the provider withholds one — a login must not fail for it', () => {
    // Apple returns a name only on the very first consent; Facebook may return none.
    for (const candidate of [undefined, null, '', '   ', 7]) {
      expect(resolveDisplayName(candidate, 'apple')).toBe(fallbackDisplayName('apple'));
    }
  });

  it('never derives a name from the email local part', () => {
    const identity = toProviderIdentity({
      provider: 'google',
      providerUserId: 'g-1',
      email: 'an.nguyen@fpt.edu.vn',
    });
    expect(identity.displayName).not.toContain('an.nguyen');
    expect(identity.displayName).not.toContain('@');
  });

  it('caps the length so a provider cannot set a 10kB display name', () => {
    expect(resolveDisplayName('n'.repeat(500), 'google').length).toBe(120);
  });
});

describe('email normalisation', () => {
  it('lower-cases and trims a usable address', () => {
    expect(normalizeEmail('  An.Nguyen@FPT.edu.vn ')).toBe('an.nguyen@fpt.edu.vn');
  });

  it('returns null rather than throwing for junk — a bad email is not a failed login', () => {
    for (const bad of [undefined, null, 42, '', 'not-an-email', 'a@b', `${'x'.repeat(321)}@b.co`]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe('avatar url normalisation (AD-29: URLs only, no object store)', () => {
  it('keeps an absolute https URL', () => {
    expect(normalizeAvatarUrl('https://lh3.googleusercontent.com/a/x=s96')).toBe(
      'https://lh3.googleusercontent.com/a/x=s96',
    );
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['plain http', 'http://example.com/a.png'],
    ['a bare path', '/avatars/1.png'],
  ])('drops %s, which the web client would otherwise render', (_label, value) => {
    expect(normalizeAvatarUrl(value)).toBeNull();
  });
});

describe('default role', () => {
  it('is `user`, and never an elevated one', () => {
    expect(DEFAULT_USER_ROLE).toBe('user');
    // `host` is per-room (Epic 2) and the two admin roles have no UI yet; a new
    // account arriving as anything but `user` would be a privilege bug.
    expect(['moderator', 'system_admin', 'org_admin', 'host', 'guest']).not.toContain(
      DEFAULT_USER_ROLE,
    );
  });
});
