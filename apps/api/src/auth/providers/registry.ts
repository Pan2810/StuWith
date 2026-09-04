import type { ApiEnv, ProviderCredentials } from '@stuwith/config';
import { enabledProviderCredentials } from '@stuwith/config';
import type { AuthProvider } from '@stuwith/contracts';
import { microsoftProviderUserId, normalizeProviderUserId } from '@stuwith/domain';
import type { JWTPayload } from 'jose';
import { createAppleClientSecretFactory } from './apple-client-secret';
import { FacebookProviderAdapter } from './facebook-provider';
import { OidcProviderAdapter } from './oidc-provider';
import type { FetchLike, ProviderAdapter } from './types';

/**
 * Turns "which providers are enabled, with which credentials" into "which adapters
 * exist".
 *
 * A provider that is not in the map does not exist as far as the router is
 * concerned, which is what makes `GET /v1/auth/apple/start` answer `404` rather
 * than `500` or, worse, a redirect built from an empty client id.
 */
export type ProviderRegistry = ReadonlyMap<AuthProvider, ProviderAdapter>;

/** `redirect_uri` must match what is registered with the provider, byte for byte. */
export function redirectUriFor(config: ApiEnv, provider: AuthProvider): string {
  return `${config.OAUTH_REDIRECT_BASE_URL}/v1/auth/${provider}/callback`;
}

function buildAdapter(credentials: ProviderCredentials, fetchImpl: FetchLike): ProviderAdapter {
  switch (credentials.provider) {
    case 'google':
      return new OidcProviderAdapter({
        provider: 'google',
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        clientId: credentials.clientId,
        clientSecret: async () => credentials.clientSecret,
        scope: 'openid email profile',
        subjectFrom: (claims) => normalizeProviderUserId(claims.sub),
        fetchImpl,
      });

    case 'microsoft':
      return new OidcProviderAdapter({
        provider: 'microsoft',
        // The tenant segment IS the organisational-account switch. `common` accepts
        // any Microsoft account, `organizations` accepts work/school accounts, and a
        // tenant GUID accepts exactly one organisation — which is what a Campus
        // customer such as `@fpt.com` is buying.
        discoveryUrl: `https://login.microsoftonline.com/${encodeURIComponent(
          credentials.tenantId,
        )}/v2.0/.well-known/openid-configuration`,
        clientId: credentials.clientId,
        clientSecret: async () => credentials.clientSecret,
        scope: 'openid email profile',
        // NOT `sub`: it is pairwise per app registration and changes if the
        // registration does. NOT `oid` alone: it is unique only inside one tenant.
        // The pair is what survives both.
        subjectFrom: (claims: JWTPayload) =>
          microsoftProviderUserId(claims['oid'], claims['tid']),
        fetchImpl,
      });

    case 'apple':
      return new OidcProviderAdapter({
        provider: 'apple',
        discoveryUrl: 'https://appleid.apple.com/.well-known/openid-configuration',
        clientId: credentials.clientId,
        clientSecret: createAppleClientSecretFactory({
          teamId: credentials.teamId,
          keyId: credentials.keyId,
          clientId: credentials.clientId,
          privateKey: credentials.privateKey,
        }),
        // Apple only returns name/email at all if `name email` is requested, and
        // only on the very first consent. Everything downstream already treats both
        // as optional.
        scope: 'openid name email',
        // NOT optional, and not a preference. Apple REJECTS the authorization
        // request outright when the scope includes `name` or `email` and the
        // response mode is the default `query` — and having accepted it, delivers
        // the callback as a cross-site POST with a form-encoded body. Dropping
        // this line breaks every real Apple login at the return trip, which is the
        // one provider whose flow cannot be checked against a live credential yet.
        // `apps/api/src/http-setup.ts` installs the matching body parser and
        // `AuthController.callbackFormPost` is the route it arrives at.
        extraAuthorizationParams: { response_mode: 'form_post' },
        subjectFrom: (claims) => normalizeProviderUserId(claims.sub),
        fetchImpl,
      });

    case 'facebook':
      return new FacebookProviderAdapter({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        fetchImpl,
      });
  }
}

export function createProviderRegistry(config: ApiEnv, fetchImpl: FetchLike): ProviderRegistry {
  const registry = new Map<AuthProvider, ProviderAdapter>();
  for (const credentials of enabledProviderCredentials(config)) {
    registry.set(credentials.provider, buildAdapter(credentials, fetchImpl));
  }
  return registry;
}
