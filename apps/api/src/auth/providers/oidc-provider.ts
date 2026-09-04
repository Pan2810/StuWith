import type { AuthProvider } from '@stuwith/contracts';
import type { ProviderIdentity } from '@stuwith/domain';
import { toProviderIdentity } from '@stuwith/domain';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import {
  ProviderExchangeError,
  fetchJson,
  type AuthorizationRequest,
  type CallbackExchange,
  type FetchLike,
  type ProviderAdapter,
} from './types';

/**
 * The OIDC half of the four providers: Google, Microsoft/Entra and Apple.
 *
 * All three publish a discovery document, so one adapter serves all three and the
 * per-provider differences shrink to four values: the discovery URL, the scope,
 * how the subject is derived from the claims, and how the client secret is
 * produced (Apple signs a fresh JWT; the other two hold a static string).
 *
 * ## Why the id_token is verified here and not merely decoded
 *
 * The token endpoint answered over TLS, so it is tempting to trust its body. That
 * reasoning breaks the moment anything sits between this process and the provider
 * — a corporate proxy, a mis-set `discoveryUrl`, a test double left switched on in
 * staging. Verifying the signature against the provider's JWKS, plus `iss`, `aud`
 * and `nonce`, is what makes "this token is about the person who just consented"
 * a checked fact rather than an assumption.
 */
export interface OidcProviderOptions {
  readonly provider: AuthProvider;
  readonly discoveryUrl: string;
  readonly clientId: string;
  /** Async because Apple's "secret" is a JWT that has to be signed per request. */
  readonly clientSecret: () => Promise<string>;
  readonly scope: string;
  /** e.g. Apple's `response_mode=form_post`, Microsoft's prompt behaviour. */
  readonly extraAuthorizationParams?: Readonly<Record<string, string>>;
  /**
   * How this provider's claims become a stable subject. Google uses `sub`;
   * Microsoft must use `(tid, oid)` because `oid` alone is unique only inside one
   * tenant and `sub` changes with the app registration.
   */
  readonly subjectFrom: (claims: JWTPayload) => string;
  readonly fetchImpl: FetchLike;
  /** Seconds of clock skew tolerated on `exp`/`iat`. */
  readonly clockToleranceSeconds?: number;
}

interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

interface TokenResponse {
  readonly id_token?: unknown;
  readonly access_token?: unknown;
}

export class OidcProviderAdapter implements ProviderAdapter {
  readonly provider: AuthProvider;

  private discovery: DiscoveryDocument | undefined;
  private jwks: JSONWebKeySet | undefined;

  constructor(private readonly options: OidcProviderOptions) {
    this.provider = options.provider;
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const discovery = await this.discover();
    const url = new URL(discovery.authorization_endpoint);
    const params: Record<string, string> = {
      client_id: this.options.clientId,
      response_type: 'code',
      redirect_uri: request.redirectUri,
      scope: this.options.scope,
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      ...this.options.extraAuthorizationParams,
    };
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async identityFromCallback(exchange: CallbackExchange): Promise<ProviderIdentity> {
    const discovery = await this.discover();
    const clientSecret = await this.options.clientSecret();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      client_id: this.options.clientId,
      client_secret: clientSecret,
      // PKCE. Without it a stolen authorization code is enough on its own.
      code_verifier: exchange.codeVerifier,
    });

    const tokens = (await fetchJson(
      this.options.fetchImpl,
      this.provider,
      discovery.token_endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      },
      'token exchange',
    )) as TokenResponse;

    if (typeof tokens.id_token !== 'string' || tokens.id_token.length === 0) {
      throw new ProviderExchangeError('token response carried no id_token', this.provider);
    }

    const claims = await this.verifyIdToken(tokens.id_token, discovery, exchange.nonce);
    return this.toIdentity(claims);
  }

  /**
   * The discovery document is fetched once per process and kept. Endpoints change
   * on the order of years; re-fetching them on every login would add a round trip
   * to the critical path and make the provider's availability our availability.
   */
  private async discover(): Promise<DiscoveryDocument> {
    if (this.discovery !== undefined) {
      return this.discovery;
    }
    const document = (await fetchJson(
      this.options.fetchImpl,
      this.provider,
      this.options.discoveryUrl,
      { headers: { accept: 'application/json' } },
      'discovery',
    )) as Partial<DiscoveryDocument>;

    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof document[field] !== 'string' || document[field].length === 0) {
        throw new ProviderExchangeError(
          `discovery document is missing ${field}`,
          this.provider,
        );
      }
    }
    this.discovery = document as DiscoveryDocument;
    return this.discovery;
  }

  /**
   * The JWKS is fetched through the SAME injected `fetch` as everything else and
   * verified locally, rather than through jose's remote key set.
   *
   * That is deliberate: a remote key set would open its own connection, which
   * would make this flow untestable without either real network access or a
   * library-specific fetch hook. One cache and one explicit refresh-on-miss is
   * both simpler and the thing that makes the end-to-end test possible.
   */
  private async keySet(discovery: DiscoveryDocument, forceRefresh: boolean): Promise<JSONWebKeySet> {
    if (this.jwks !== undefined && !forceRefresh) {
      return this.jwks;
    }
    const fetched = (await fetchJson(
      this.options.fetchImpl,
      this.provider,
      discovery.jwks_uri,
      { headers: { accept: 'application/json' } },
      'jwks',
    )) as JSONWebKeySet;

    if (!Array.isArray(fetched?.keys)) {
      throw new ProviderExchangeError('jwks document has no keys array', this.provider);
    }
    this.jwks = fetched;
    return fetched;
  }

  private async verifyIdToken(
    idToken: string,
    discovery: DiscoveryDocument,
    nonce: string,
  ): Promise<JWTPayload> {
    const verify = async (refresh: boolean): Promise<JWTPayload> => {
      const jwks = createLocalJWKSet(await this.keySet(discovery, refresh));
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: discovery.issuer,
        audience: this.options.clientId,
        clockTolerance: this.options.clockToleranceSeconds ?? 60,
      });
      return payload;
    };

    let claims: JWTPayload;
    try {
      claims = await verify(false);
    } catch (first) {
      // Providers rotate signing keys without warning, and the first login after a
      // rotation would otherwise fail for every user until the process restarted.
      // One forced refresh, then give up — retrying forever would turn a malformed
      // token into a request amplifier against the provider's JWKS endpoint.
      try {
        claims = await verify(true);
      } catch {
        throw new ProviderExchangeError(
          `id_token failed verification: ${first instanceof Error ? first.name : 'unknown'}`,
          this.provider,
        );
      }
    }

    // The nonce ties this token to the authorization request WE started. Without
    // it, a token minted for another session of the same client is accepted here.
    if (typeof claims['nonce'] !== 'string' || claims['nonce'] !== nonce) {
      // The provider answered and the answer does not belong to this login. That
      // is a replay or a forgery, not an outage, so it counts.
      throw new ProviderExchangeError(
        'id_token nonce does not match this login',
        this.provider,
        true,
      );
    }
    return claims;
  }

  private toIdentity(claims: JWTPayload): ProviderIdentity {
    const subject = this.options.subjectFrom(claims);
    return toProviderIdentity({
      provider: this.provider,
      providerUserId: subject,
      email: claims['email'],
      displayName: claims['name'] ?? claims['given_name'],
      avatarUrl: claims['picture'],
    });
  }
}
