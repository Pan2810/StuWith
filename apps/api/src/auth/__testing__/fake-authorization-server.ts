import type { AuthProvider } from '@stuwith/contracts';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { createHash, randomUUID } from 'node:crypto';

/**
 * An OpenID Connect provider, in this process.
 *
 * This is the only way the four-provider acceptance criterion can be demonstrated
 * before anyone has a real Google or Entra credential. It is not a stub of our own
 * code: it signs real `id_token`s with a real key, publishes a real JWKS, and the
 * production `OidcProviderAdapter` verifies them the same way it verifies Google's
 * — so a bug in signature verification, `iss`/`aud` checking, `nonce` binding or
 * PKCE shows up here rather than in production.
 *
 * The keys are generated at construction time and never written to disk, which
 * also means nothing in this repository looks like a private key to CI gate #1.
 */
export interface FakeProfile {
  readonly subject: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly picture?: string | null;
  /** Microsoft only: the pair `(tid, oid)` is what becomes the provider subject. */
  readonly objectId?: string;
  readonly tenantId?: string;
}

interface RegisteredProvider {
  readonly provider: AuthProvider;
  readonly oidc: boolean;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly profileEndpoint?: string;
  readonly clientId: string;
}

interface PendingAuthorization {
  readonly provider: AuthProvider;
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly profile: FakeProfile;
}

export interface AuthorizeResult {
  readonly code: string;
  readonly state: string;
  /** The URL the browser would be sent to, for a test that wants to assert on it. */
  readonly callbackUrl: string;
  /**
   * How the provider delivers the callback. Apple asks for `form_post` and then
   * POSTs a form-encoded body to the redirect URI instead of redirecting with
   * query parameters; the harness has to imitate that or the POST route and its
   * body parser go untested.
   */
  readonly responseMode: 'query' | 'form_post';
}

const KEY_ID = 'fake-signing-key-1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

export class FakeAuthorizationServer {
  private privateKey: KeyLike | undefined;
  private publicJwk: JWK | undefined;

  private readonly providers = new Map<AuthProvider, RegisteredProvider>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly facebookTokens = new Map<string, FakeProfile>();

  /** Counts every token exchange, so a test can prove a code is single-use. */
  tokenExchanges = 0;

  /**
   * The most recent authorization code handed out. The PII test needs the exact
   * value to assert it never reached a log line — searching for "code=" alone
   * would pass against a log that printed the code under a different key.
   */
  lastIssuedCode = '';

  /**
   * Makes discovery unreachable, so a test can exercise the start leg's outage
   * path. Set it on a FRESH harness: the adapter caches the discovery document per
   * process, so flipping it after a successful login would prove nothing.
   */
  failDiscovery = false;

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = privateKey;
    this.publicJwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };
  }

  /**
   * Registers the endpoints the production registry will actually call, at the
   * real URLs. The adapters are NOT told they are talking to a fake — only
   * `fetch` is replaced — so the URL construction, the tenant segment and the
   * discovery flow are all exercised for real.
   */
  register(provider: AuthProvider, clientId: string, tenantId = 'organizations'): void {
    const registrations: Record<AuthProvider, RegisteredProvider> = {
      google: {
        provider: 'google',
        oidc: true,
        issuer: 'https://accounts.google.com',
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        clientId,
      },
      microsoft: {
        provider: 'microsoft',
        oidc: true,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        discoveryUrl: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
        authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
        clientId,
      },
      apple: {
        provider: 'apple',
        oidc: true,
        issuer: 'https://appleid.apple.com',
        discoveryUrl: 'https://appleid.apple.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
        tokenEndpoint: 'https://appleid.apple.com/auth/token',
        jwksUri: 'https://appleid.apple.com/auth/keys',
        clientId,
      },
      facebook: {
        provider: 'facebook',
        oidc: false,
        issuer: 'https://www.facebook.com',
        discoveryUrl: '',
        authorizationEndpoint: 'https://www.facebook.com/v21.0/dialog/oauth',
        tokenEndpoint: 'https://graph.facebook.com/v21.0/oauth/access_token',
        jwksUri: '',
        profileEndpoint: 'https://graph.facebook.com/v21.0/me',
        clientId,
      },
    };
    this.providers.set(provider, registrations[provider]);
  }

  /**
   * What the person does at the provider's consent screen: approve, and be sent
   * back with a `code` and the same `state`.
   */
  authorize(authorizationUrl: string, profile: FakeProfile): AuthorizeResult {
    const url = new URL(authorizationUrl);
    const registration = [...this.providers.values()].find(
      (candidate) => candidate.authorizationEndpoint === `${url.origin}${url.pathname}`,
    );
    if (registration === undefined) {
      throw new Error(`no fake provider serves ${url.origin}${url.pathname}`);
    }

    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');
    const redirectUri = url.searchParams.get('redirect_uri');
    if (state === null || challenge === null || redirectUri === null) {
      throw new Error('authorization request is missing state, code_challenge or redirect_uri');
    }
    if (method !== 'S256') {
      // `plain` defeats PKCE entirely; a real provider would accept it, so the
      // fake refuses in order to keep us honest.
      throw new Error(`code_challenge_method must be S256, got ${String(method)}`);
    }

    const code = `fake-code-${randomUUID()}`;
    this.lastIssuedCode = code;
    this.pending.set(code, {
      provider: registration.provider,
      codeChallenge: challenge,
      nonce: url.searchParams.get('nonce') ?? '',
      redirectUri,
      profile,
    });

    const requestedMode = url.searchParams.get('response_mode');
    if (registration.provider === 'apple' && requestedMode !== 'form_post') {
      // A real Apple rejects this combination outright, and a fake that accepted
      // it would hide the exact defect this test exists to catch.
      throw new Error(
        'apple requested scope name/email without response_mode=form_post; Apple rejects this',
      );
    }
    const responseMode = requestedMode === 'form_post' ? 'form_post' : 'query';

    const callback = new URL(redirectUri);
    if (responseMode === 'query') {
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
    }
    return { code, state, callbackUrl: callback.toString(), responseMode };
  }

  /** The injected `fetch`. Everything the adapters do goes through here. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const key = `${url.origin}${url.pathname}`;

    for (const registration of this.providers.values()) {
      if (registration.oidc && key === registration.discoveryUrl) {
        if (this.failDiscovery) {
          // What a provider outage actually looks like from here.
          return json({ error: 'service unavailable' }, 503);
        }
        return json({
          issuer: registration.issuer,
          authorization_endpoint: registration.authorizationEndpoint,
          token_endpoint: registration.tokenEndpoint,
          jwks_uri: registration.jwksUri,
        });
      }
      if (registration.oidc && key === registration.jwksUri) {
        return json({ keys: [this.publicJwk] });
      }
      if (key === registration.tokenEndpoint) {
        return this.exchange(registration, init);
      }
      if (registration.profileEndpoint !== undefined && key === registration.profileEndpoint) {
        return this.facebookProfile(init);
      }
    }
    throw new Error(`fake authorization server has no route for ${key}`);
  };

  private async exchange(
    registration: RegisteredProvider,
    init: RequestInit | undefined,
  ): Promise<Response> {
    this.tokenExchanges += 1;

    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const code = body.get('code') ?? '';
    const verifier = body.get('code_verifier') ?? '';
    const clientId = body.get('client_id') ?? '';
    const clientSecret = body.get('client_secret') ?? '';

    const pending = this.pending.get(code);
    if (pending === undefined || pending.provider !== registration.provider) {
      return json({ error: 'invalid_grant' }, 400);
    }
    // Authorization codes are single use. A real provider enforces this, and a
    // fake that did not would hide a replay bug.
    this.pending.delete(code);

    if (clientId !== registration.clientId || clientSecret.length === 0) {
      return json({ error: 'invalid_client' }, 401);
    }

    // The PKCE check, done properly: S256 of the verifier must equal the challenge
    // that was sent at the start of the flow.
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (verifier.length === 0 || expected !== pending.codeChallenge) {
      return json({ error: 'invalid_grant' }, 400);
    }

    if (!registration.oidc) {
      const accessToken = `fake-access-${randomUUID()}`;
      this.facebookTokens.set(accessToken, pending.profile);
      return json({ access_token: accessToken, token_type: 'bearer', expires_in: 3600 });
    }

    return json({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: `fake-access-${randomUUID()}`,
      id_token: await this.signIdToken(registration, pending),
    });
  }

  private async signIdToken(
    registration: RegisteredProvider,
    pending: PendingAuthorization,
  ): Promise<string> {
    if (this.privateKey === undefined) {
      throw new Error('start() must be awaited before the fake server signs anything');
    }

    const claims: Record<string, unknown> = { nonce: pending.nonce };
    if (pending.profile.email != null) claims['email'] = pending.profile.email;
    if (pending.profile.name != null) claims['name'] = pending.profile.name;
    if (pending.profile.picture != null) claims['picture'] = pending.profile.picture;
    if (registration.provider === 'microsoft') {
      // Entra puts the tenant and the per-tenant object id here; `sub` is pairwise
      // and is deliberately NOT what the adapter keys on.
      claims['oid'] = pending.profile.objectId ?? pending.profile.subject;
      claims['tid'] = pending.profile.tenantId ?? 'organizations';
    }

    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(registration.issuer)
      .setAudience(registration.clientId)
      .setSubject(pending.profile.subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.privateKey);
  }

  private facebookProfile(init: RequestInit | undefined): Response {
    const authorization = headerOf(init, 'authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const profile = this.facebookTokens.get(token);
    if (profile === undefined) {
      return json({ error: { message: 'Invalid OAuth access token' } }, 401);
    }
    return json({
      id: profile.subject,
      name: profile.name ?? undefined,
      email: profile.email ?? undefined,
      picture: profile.picture == null ? undefined : { data: { url: profile.picture } },
    });
  }
}
