import type { ProviderIdentity } from '@stuwith/domain';
import { toProviderIdentity } from '@stuwith/domain';
import {
  ProviderExchangeError,
  fetchJson,
  type AuthorizationRequest,
  type CallbackExchange,
  type FetchLike,
  type ProviderAdapter,
} from './types';

/**
 * Facebook is the odd one out and needs its own adapter.
 *
 * It speaks OAuth 2.0 but not OpenID Connect: there is no discovery document, no
 * JWKS and no `id_token` to verify. The identity comes from a Graph API call made
 * with the access token, which means the trust argument is different — the profile
 * is trusted because it came back over TLS from `graph.facebook.com` in response
 * to a token this process just obtained, not because anything was signed.
 *
 * That difference is why this is a separate file rather than a flag on the OIDC
 * adapter: the two have genuinely different security properties, and a shared
 * implementation with an `if (isOidc)` in it hides that.
 */
export interface FacebookProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl: FetchLike;
  /** Pinned. Facebook retires Graph versions on a schedule; drifting is not an option. */
  readonly graphVersion?: string;
}

interface FacebookTokenResponse {
  readonly access_token?: unknown;
}

interface FacebookProfile {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly email?: unknown;
  readonly picture?: { readonly data?: { readonly url?: unknown } };
}

const DEFAULT_GRAPH_VERSION = 'v21.0';

export class FacebookProviderAdapter implements ProviderAdapter {
  readonly provider = 'facebook' as const;

  private readonly version: string;

  constructor(private readonly options: FacebookProviderOptions) {
    this.version = options.graphVersion ?? DEFAULT_GRAPH_VERSION;
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const url = new URL(`https://www.facebook.com/${this.version}/dialog/oauth`);
    const params: Record<string, string> = {
      client_id: this.options.clientId,
      redirect_uri: request.redirectUri,
      state: request.state,
      response_type: 'code',
      scope: 'public_profile,email',
      // Facebook supports PKCE, and it is used here for the same reason as
      // everywhere else: a stolen authorization code must not be redeemable.
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
    };
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async identityFromCallback(exchange: CallbackExchange): Promise<ProviderIdentity> {
    const tokenUrl = new URL(`https://graph.facebook.com/${this.version}/oauth/access_token`);
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      redirect_uri: exchange.redirectUri,
      code: exchange.code,
      code_verifier: exchange.codeVerifier,
    });

    const tokens = (await fetchJson(
      this.options.fetchImpl,
      this.provider,
      tokenUrl.toString(),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      },
      'token exchange',
    )) as FacebookTokenResponse;

    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
      throw new ProviderExchangeError('token response carried no access_token', this.provider);
    }

    const profileUrl = new URL(`https://graph.facebook.com/${this.version}/me`);
    profileUrl.searchParams.set('fields', 'id,name,email,picture.type(large)');

    const profile = (await fetchJson(
      this.options.fetchImpl,
      this.provider,
      profileUrl.toString(),
      {
        // In the Authorization header rather than in the query string: a token in a
        // URL ends up in proxy logs, browser history and referrers.
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          accept: 'application/json',
        },
      },
      'profile',
    )) as FacebookProfile;

    return toProviderIdentity({
      provider: this.provider,
      providerUserId: profile.id,
      // Facebook returns an email only when the user granted the scope AND the
      // address is confirmed. Missing is normal, not an error.
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.picture?.data?.url,
    });
  }
}
