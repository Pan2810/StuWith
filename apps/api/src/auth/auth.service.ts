import { Inject, Injectable } from '@nestjs/common';
import {
  AUTH_COOKIE_PATH,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  currentUserSchema,
  isAuthProvider,
  makeError,
  type AuthProvider,
  type ErrorEnvelope,
  type SignInOutcome,
} from '@stuwith/contracts';
import type {
  AuditPort,
  ClockPort,
  IdentityPort,
  SessionPort,
  SessionRefusalReason,
  User,
} from '@stuwith/domain';
import { IdentityInputError } from '@stuwith/domain';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { AUTH_RUNTIME, type AuthRuntime } from './auth.runtime';
import { recordSignInFailed, recordSignedIn, type SignInFailureReason } from './audit';
import {
  clearAllAuthCookies,
  clearCookie,
  oauthStateCookie,
  oauthStateCookies,
  parseCookies,
  refreshCookie,
  serializeCookie,
  sessionCookie,
} from './cookies';
import { redirectUriFor, type ProviderRegistry } from './providers/registry';
import { ProviderExchangeError } from './providers/types';
import {
  createPkcePair,
  hashSessionToken,
  randomHandle,
  randomToken,
  safeEquals,
  signPayload,
  verifyPayload,
} from './tokens';

/**
 * The login flow, with no Fastify in it.
 *
 * Every method returns a description of a response — status, body, cookies,
 * redirect — and the controller turns that into an actual reply. Keeping the two
 * apart is what lets the flow test drive every row of the I/O matrix through real
 * HTTP without needing a browser, and it keeps this file readable as a sequence of
 * decisions rather than as reply plumbing.
 */
export type AuthOutcome =
  | {
      readonly kind: 'redirect';
      readonly location: string;
      /** Defaults to 302. 303 where the request may have been a POST — see `failedSignIn`. */
      readonly status?: 302 | 303;
      readonly cookies: readonly string[];
    }
  | {
      readonly kind: 'json';
      readonly status: number;
      readonly body: unknown;
      readonly cookies: readonly string[];
    }
  | { readonly kind: 'empty'; readonly status: number; readonly cookies: readonly string[] };

/**
 * The signed cookie that carries a half-finished login across the trip to the
 * provider. Short field names because it rides in a cookie on every auth request.
 *
 * It is signed, not encrypted — see `signPayload`. Nothing in it is a secret from
 * the person holding the browser: the `state` is theirs, the PKCE verifier is
 * theirs, and the nonce is meaningless on its own. What matters is that none of
 * them can be CHANGED, which is what the signature provides.
 */
interface OAuthStatePayload {
  readonly p: AuthProvider;
  readonly s: string;
  readonly v: string;
  readonly n: string;
  /** Expiry, epoch seconds. */
  readonly x: number;
}

/**
 * The strings the JSON endpoints (`/me`, `/refresh`) answer with. They say
 * something true and nothing technical: no provider name, no provider error code,
 * no hint about which step failed. That last part is not laziness — telling an
 * attacker whether the `state` or the `code` was wrong is free information.
 *
 * The CALLBACK leg no longer has a message here at all. A person arriving on that
 * URL got there by a browser redirect from a provider, so a JSON body is a wall of
 * braces on a white page; Story 1.3 turned every callback outcome into a redirect
 * back to the login page carrying a {@link SignInOutcome}, and the sentence they
 * read lives in `apps/web`.
 */
const MESSAGES = {
  unauthenticated: 'Phiên đăng nhập không hợp lệ. Hãy thử đăng nhập lại.',
  notFound: 'Không tìm thấy nội dung.',
  upstreamUnavailable: 'Chưa kết nối được với dịch vụ đăng nhập. Hãy thử lại sau ít phút.',
} as const;

function unauthenticated(): ErrorEnvelope {
  return makeError('unauthenticated', MESSAGES.unauthenticated);
}

function notFound(): ErrorEnvelope {
  return makeError('not_found', MESSAGES.notFound);
}

/**
 * The provider could not be reached. Distinct from `unauthenticated` because
 * nothing about the person was rejected — telling them to "try signing in again"
 * when the provider is down sends them round the same loop.
 */
function upstreamUnavailable(): ErrorEnvelope {
  return makeError('internal_error', MESSAGES.upstreamUnavailable);
}

@Injectable()
export class AuthService {
  private readonly identity: IdentityPort;
  private readonly sessions: SessionPort;
  private readonly audit: AuditPort;
  private readonly clock: ClockPort;
  private readonly registry: ProviderRegistry;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_RUNTIME) runtime: AuthRuntime,
  ) {
    this.identity = runtime.identity;
    this.sessions = runtime.sessions;
    this.audit = runtime.audit;
    this.clock = runtime.clock;
    this.registry = runtime.registry;
  }

  /** `GET /v1/auth/:provider/start` */
  async start(providerName: string, requestId: string): Promise<AuthOutcome> {
    const adapter = this.adapterFor(providerName);
    if (adapter === null) {
      return { kind: 'json', status: 404, body: notFound(), cookies: [] };
    }

    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = createPkcePair();
    const now = this.clock.now();

    const payload: OAuthStatePayload = {
      p: adapter.provider,
      s: state,
      v: verifier,
      n: nonce,
      x: Math.floor(now.getTime() / 1000) + this.config.OAUTH_STATE_TTL_SECONDS,
    };

    let location: string;
    try {
      location = await adapter.authorizationUrl({
        state,
        nonce,
        codeChallenge: challenge,
        redirectUri: redirectUriFor(this.config, adapter.provider),
      });
    } catch (error) {
      // This leg reaches the network: the three OIDC providers fetch a discovery
      // document here. An unguarded failure was a 500 with no audit row, which is
      // the one outcome an investigation cannot see. It is not the user's fault
      // and not an authentication decision, so it is 502 rather than 401.
      if (error instanceof ProviderExchangeError) {
        await recordSignInFailed(this.audit, {
          requestId,
          provider: adapter.provider,
          reason: 'provider_start_failed',
          occurredAt: now,
        });
        return { kind: 'json', status: 502, body: upstreamUnavailable(), cookies: [] };
      }
      throw error;
    }

    // One cookie per attempt (see OAUTH_STATE_COOKIE_PREFIX): two tabs are a thing
    // people do, and a single fixed name makes the older tab fail as "state missing".
    return {
      kind: 'redirect',
      location,
      cookies: [
        serializeCookie(
          oauthStateCookie(
            randomHandle(),
            signPayload(this.config.SESSION_COOKIE_SECRET, payload),
            this.config.OAUTH_STATE_TTL_SECONDS,
          ),
        ),
      ],
    };
  }

  /** `GET /v1/auth/:provider/callback` */
  async callback(
    providerName: string,
    query: Readonly<Record<string, unknown>>,
    cookieHeader: unknown,
    requestId: string,
  ): Promise<AuthOutcome> {
    const adapter = this.adapterFor(providerName);
    if (adapter === null) {
      // A provider that is not enabled must be indistinguishable from a URL that
      // does not exist — otherwise this endpoint enumerates the deployment's
      // configuration for anyone who asks.
      return { kind: 'json', status: 404, body: notFound(), cookies: [] };
    }
    const provider = adapter.provider;
    const now = this.clock.now();
    const jar = parseCookies(cookieHeader);

    // The provider's own verdict, read BEFORE anything of ours.
    //
    // This is where "the user cancelled" is born. Until Story 1.3 the parameter
    // was not read at all, so a refusal at the consent screen arrived with no
    // `code`, fell through to `code_missing`, and was counted as a failure — the
    // product telling someone who simply changed their mind that something broke.
    //
    // Checking it first is also the honest order: once the provider has said no,
    // our `state` bookkeeping has nothing left to decide.
    //
    // `firstQueryValue`, not `typeof === 'string'`: a repeated `?error=a&error=b`
    // reaches Fastify as an ARRAY, and a bare `typeof` check let it fall through
    // to the `code` test below — reporting a cancellation as a technical failure,
    // which is the exact confusion this branch exists to end. A present-but-empty
    // `?error=` is a refusal too, so PRESENCE is the condition, not length.
    const providerError = firstQueryValue(query['error']);
    if (providerError !== undefined) {
      return this.failedSignIn(
        requestId,
        provider,
        isCancellation(providerError) ? 'user_cancelled' : 'provider_authorize_failed',
        now,
        jar,
        this.attemptCookieFor(provider, query, jar),
      );
    }

    const stateCheck = this.readState(provider, query, jar, now);
    if (!stateCheck.ok) {
      return this.failedSignIn(
        requestId,
        provider,
        stateCheck.reason,
        now,
        jar,
        stateCheck.cookieName,
      );
    }

    const code = query['code'];
    if (typeof code !== 'string' || code.length === 0) {
      return this.failedSignIn(
        requestId,
        provider,
        'code_missing',
        now,
        jar,
        stateCheck.cookieName,
      );
    }

    let identity;
    try {
      identity = await adapter.identityFromCallback({
        code,
        codeVerifier: stateCheck.payload.v,
        nonce: stateCheck.payload.n,
        redirectUri: redirectUriFor(this.config, provider),
      });
    } catch (error) {
      // EVERYTHING that can go wrong between here and the provider ends as a
      // refused sign-in with an audit row — never as a 500 with no trace.
      //
      // `ProviderExchangeError` is only the expected half. The other half is what
      // this catch used to miss: a malformed `APPLE_PRIVATE_KEY` makes `jose`
      // throw while minting the client secret, and a provider that returns a blank
      // or oversized subject makes `toProviderIdentity` throw `IdentityInputError`.
      // Both are "this login cannot complete", both used to be a silent 500.
      const reason =
        error instanceof IdentityInputError ? 'identity_rejected' : 'provider_exchange_failed';
      return this.failedSignIn(requestId, provider, reason, now, jar, stateCheck.cookieName);
    }

    let resolved;
    try {
      resolved = await this.identity.findOrCreateByIdentity(identity, now);
    } catch (error) {
      if (error instanceof IdentityInputError) {
        return this.failedSignIn(
          requestId,
          provider,
          'identity_rejected',
          now,
          jar,
          stateCheck.cookieName,
        );
      }
      // A store FAULT is not a refusal. A database outage must not read to the
      // user as "your account was rejected" — that is the distinction the whole
      // port design exists to preserve.
      throw error;
    }

    const issued = await this.openSession(resolved.user.id, now);

    await recordSignedIn(this.audit, {
      requestId,
      userId: resolved.user.id,
      sessionId: issued.sessionId,
      provider,
      firstLogin: resolved.created,
      occurredAt: now,
    });

    return {
      kind: 'redirect',
      location: `${this.config.WEB_BASE_URL}/dang-nhap`,
      cookies: [
        ...issued.cookies,
        // The handshake is over; this attempt's state cookie must not survive it.
        // Only THIS one is cleared — another tab may still have a login in flight,
        // and clearing its cookie here would break it.
        clearCookie(stateCheck.cookieName, AUTH_COOKIE_PATH),
      ],
    };
  }

  /** `POST /v1/auth/refresh` */
  async refresh(cookieHeader: unknown, requestId: string): Promise<AuthOutcome> {
    const jar = parseCookies(cookieHeader);
    const presented = jar[REFRESH_COOKIE_NAME];
    const nowIfMissing = this.clock.now();
    if (presented === undefined) {
      await recordSignInFailed(this.audit, {
        requestId,
        reason: 'refresh_cookie_missing',
        occurredAt: nowIfMissing,
      });
      return {
        kind: 'json',
        status: 401,
        body: unauthenticated(),
        cookies: clearAllAuthCookies(jar),
      };
    }

    const now = this.clock.now();
    const sessionToken = randomToken();
    const refreshToken = randomToken();

    const rotated = await this.sessions.rotate({
      presentedRefreshTokenHash: this.hash(presented),
      accessTokenHash: this.hash(sessionToken),
      refreshTokenHash: this.hash(refreshToken),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.config.SESSION_TTL_SECONDS * 1000),
      refreshExpiresAt: new Date(now.getTime() + this.config.SESSION_REFRESH_TTL_SECONDS * 1000),
    });

    if (!rotated.ok) {
      // EVERY refusal is recorded, not just the theft signal. A refresh that
      // silently 401s leaves no trace at all, and "users are being logged out and
      // we do not know why" is then unanswerable — the reused-token case would be
      // the only one visible, which is exactly the case you would rather not have
      // to distinguish from noise.
      await recordSignInFailed(this.audit, {
        requestId,
        reason: refreshFailureReason(rotated.reason),
        occurredAt: now,
        sessionId: rotated.revokedSessionId ?? null,
      });
      return {
        kind: 'json',
        status: 401,
        body: unauthenticated(),
        cookies: clearAllAuthCookies(jar),
      };
    }

    return {
      kind: 'empty',
      status: 204,
      cookies: [
        serializeCookie(sessionCookie(sessionToken, this.config.SESSION_TTL_SECONDS)),
        serializeCookie(refreshCookie(refreshToken, this.config.SESSION_REFRESH_TTL_SECONDS)),
      ],
    };
  }

  /** `POST /v1/auth/logout` */
  async logout(cookieHeader: unknown): Promise<AuthOutcome> {
    const jar = parseCookies(cookieHeader);
    const now = this.clock.now();

    // The REFRESH token is the handle, not the session token.
    //
    // The session token is only live for an hour; logging out after that found
    // nothing to revoke and returned 204, while the thirty-day refresh chain
    // stayed valid server-side. Clearing cookies is browser-side only, so anyone
    // holding a copy of the refresh token stayed signed in — a "log out on the
    // shared laptop" that does nothing.
    const refresh = jar[REFRESH_COOKIE_NAME];
    if (refresh !== undefined) {
      await this.sessions.revokeChainByRefreshTokenHash(this.hash(refresh), now);
    }

    // Belt and braces for the case where only the session cookie survived (the
    // refresh cookie is scoped to /v1/auth and a client could have dropped it).
    const session = jar[SESSION_COOKIE_NAME];
    if (session !== undefined) {
      const read = await this.sessions.readByAccessTokenHash(this.hash(session), now);
      if (read.ok) {
        await this.sessions.revokeChain(read.session.sessionId, now);
      }
    }

    // Always 204, whatever was presented. Logging out is not a place to tell the
    // caller whether the token they held was real.
    return { kind: 'empty', status: 204, cookies: clearAllAuthCookies(jar) };
  }

  /** `GET /v1/auth/me` */
  async me(cookieHeader: unknown): Promise<AuthOutcome> {
    const presented = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
    if (presented === undefined) {
      return { kind: 'json', status: 401, body: unauthenticated(), cookies: [] };
    }

    const read = await this.sessions.readByAccessTokenHash(
      this.hash(presented),
      this.clock.now(),
    );
    if (!read.ok) {
      return { kind: 'json', status: 401, body: unauthenticated(), cookies: [] };
    }

    const user = await this.identity.findUserById(read.session.userId);
    if (user === null) {
      return { kind: 'json', status: 401, body: unauthenticated(), cookies: [] };
    }

    return { kind: 'json', status: 200, body: toCurrentUser(user), cookies: [] };
  }

  /** Null when the provider is unknown OR not enabled — the caller cannot tell. */
  private adapterFor(providerName: string) {
    if (!isAuthProvider(providerName)) {
      return null;
    }
    return this.registry.get(providerName) ?? null;
  }

  private hash(token: string): string {
    return hashSessionToken(this.config.SESSION_COOKIE_SECRET, token);
  }

  private async openSession(
    userId: string,
    now: Date,
  ): Promise<{ sessionId: string; cookies: string[] }> {
    const sessionToken = randomToken();
    const refreshToken = randomToken();

    const opened = await this.sessions.open({
      userId,
      // Only hashes cross this boundary; the plaintext exists in this function and
      // in the browser, and nowhere else.
      accessTokenHash: this.hash(sessionToken),
      refreshTokenHash: this.hash(refreshToken),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.config.SESSION_TTL_SECONDS * 1000),
      refreshExpiresAt: new Date(now.getTime() + this.config.SESSION_REFRESH_TTL_SECONDS * 1000),
    });

    return {
      sessionId: opened.sessionId,
      cookies: [
        serializeCookie(sessionCookie(sessionToken, this.config.SESSION_TTL_SECONDS)),
        serializeCookie(refreshCookie(refreshToken, this.config.SESSION_REFRESH_TTL_SECONDS)),
      ],
    };
  }

  /**
   * Find the login attempt this callback belongs to.
   *
   * The browser may be carrying several state cookies — one per open tab — so the
   * cookie is located by CONTENT, not by name: each candidate's signature is
   * verified and its payload compared against the `state` that came back. That is
   * strictly safer than trusting a name, and it is what makes two tabs work.
   */
  private readState(
    provider: AuthProvider,
    query: Readonly<Record<string, unknown>>,
    jar: Record<string, string>,
    now: Date,
  ):
    | { ok: true; payload: OAuthStatePayload; cookieName: string }
    | { ok: false; reason: SignInFailureReason; cookieName?: string } {
    const presented = query['state'];
    if (typeof presented !== 'string' || presented.length === 0) {
      return { ok: false, reason: 'state_missing' };
    }

    if (oauthStateCookies(jar).length === 0) {
      return { ok: false, reason: 'state_missing' };
    }

    const attempt = this.findAttempt(query, jar);
    if (attempt === undefined) {
      // Nothing the browser is carrying is both signed by us and about this
      // `state`. There is no attempt to name, and so no cookie to clear.
      return { ok: false, reason: 'state_mismatch' };
    }

    if (attempt.payload.p !== provider) {
      // A login started at one provider must not be completable at another — and
      // it must not be DESTROYED at another either. The cookie name is withheld
      // here on purpose: this attempt belongs to a different provider, so it is
      // very likely a live handshake in another tab, and returning its name would
      // hand the caller a cookie to clear. `/facebook/callback?state=<a Google
      // attempt's state>` would then kill the Google tab's login on demand.
      return { ok: false, reason: 'state_mismatch' };
    }

    // Past this point the attempt is identified AND is ours, so the refusal below
    // can say which handshake died — which is what lets the caller clear one
    // cookie instead of all of them.
    if (typeof attempt.payload.x !== 'number' || attempt.payload.x * 1000 <= now.getTime()) {
      return { ok: false, reason: 'state_expired', cookieName: attempt.name };
    }
    return { ok: true, payload: attempt.payload, cookieName: attempt.name };
  }

  /**
   * The in-flight attempt this callback belongs to, located by verified CONTENT
   * rather than by cookie name — see `readState`'s note. Two open tabs mean two
   * cookies, and only the one whose signed `state` matches is this attempt.
   *
   * It is split out because the provider-said-no path needs the same answer
   * BEFORE `readState` runs: even a cancelled handshake leaves a cookie to clean
   * up, and cleaning up the other tab's would break a login still in progress.
   */
  private findAttempt(
    query: Readonly<Record<string, unknown>>,
    jar: Record<string, string>,
  ): { name: string; payload: OAuthStatePayload } | undefined {
    const presented = query['state'];
    if (typeof presented !== 'string' || presented.length === 0) {
      return undefined;
    }
    for (const [name, value] of oauthStateCookies(jar)) {
      const payload = verifyPayload<OAuthStatePayload>(this.config.SESSION_COOKIE_SECRET, value);
      if (payload === null) {
        continue;
      }
      // Constant time: `state` is the CSRF defence for the whole flow, and `===`
      // leaks the length of the matching prefix.
      if (safeEquals(presented, payload.s)) {
        return { name, payload };
      }
    }
    return undefined;
  }

  /**
   * This attempt's cookie, but only if the attempt is actually THIS provider's.
   *
   * The provider check is the whole point. `state` is matched across every state
   * cookie the browser holds, so without it `/v1/auth/facebook/callback?
   * error=access_denied&state=<a Google attempt's state>` clears the Google
   * handshake and ends a login happening in another tab — a URL anyone can build
   * once they have seen their own `state` go past.
   */
  private attemptCookieFor(
    provider: AuthProvider,
    query: Readonly<Record<string, unknown>>,
    jar: Record<string, string>,
  ): string | undefined {
    const attempt = this.findAttempt(query, jar);
    return attempt?.payload.p === provider ? attempt.name : undefined;
  }

  /**
   * Handshake cookies that cannot possibly belong to a live login: past their
   * expiry, or not signed by us at all (a rotated `SESSION_COOKIE_SECRET` leaves
   * exactly that).
   *
   * Somebody has to sweep these. `start()` mints one per attempt under a random
   * handle with no cap, and a person who opens the login page repeatedly and
   * finishes nothing accumulates one cookie per attempt until each `Max-Age`
   * runs out — the browser sends them all, on every `/v1/auth` request, and a
   * large enough pile is answered with a 431 rather than a login page. Clearing
   * every state cookie would be the easy sweep and is wrong: it kills whatever
   * the other tab is in the middle of. Dead ones only.
   */
  private deadAttemptCookies(jar: Record<string, string>, now: Date): string[] {
    const dead: string[] = [];
    for (const [name, value] of oauthStateCookies(jar)) {
      const payload = verifyPayload<OAuthStatePayload>(this.config.SESSION_COOKIE_SECRET, value);
      if (
        payload === null ||
        typeof payload.x !== 'number' ||
        payload.x * 1000 <= now.getTime()
      ) {
        dead.push(name);
      }
    }
    return dead;
  }

  /**
   * How every callback that does not end in a session ends instead.
   *
   * A 401 with a JSON envelope used to live here, and it was wrong for the one
   * reason that matters: nobody reaches this URL with `fetch`. The provider sends
   * the BROWSER here, so the JSON body *is* the screen — a page of braces where a
   * person expected to be back in the app. The outcome now travels as a redirect
   * to the login page carrying one word from a closed public vocabulary.
   *
   * Two things are deliberately not done here:
   *
   * - the internal `reason` is not forwarded. It goes into the audit row and stops
   *   there; {@link publicOutcomeFor} is the only bridge, and it is many-to-few.
   * - the session and refresh cookies are not cleared. A new login that fails is
   *   no reason to sign someone out of a session they already had.
   *
   * What IS cleared: this attempt's handshake cookie, plus any handshake cookie
   * that is already dead (see {@link deadAttemptCookies}). Live attempts belonging
   * to other tabs are left exactly where they are.
   *
   * `303`, not `302`. Apple delivers its callback as a cross-site form POST, and
   * a 302 answer to a POST only means "repeat the request over there" — browsers
   * downgrade it to GET in practice, but that is convention rather than the spec.
   * 303 says the downgrade explicitly, and the destination is a page to look at
   * rather than a resource to re-submit to.
   */
  private async failedSignIn(
    requestId: string,
    provider: AuthProvider,
    reason: SignInFailureReason,
    now: Date,
    jar: Record<string, string>,
    stateCookieName: string | undefined,
  ): Promise<AuthOutcome> {
    // One row per attempt, cancellations included. "Not an error" is a statement
    // about the interface, not about traceability.
    await recordSignInFailed(this.audit, { requestId, provider, reason, occurredAt: now });

    const location = new URL(`${this.config.WEB_BASE_URL}/dang-nhap`);
    location.searchParams.set(SIGN_IN_OUTCOME_QUERY_PARAM, publicOutcomeFor(reason));

    // A Set keeps this attempt's cookie from being cleared twice when it is also
    // the expired one — two identical `Set-Cookie` headers for the same name.
    const doomed = new Set(this.deadAttemptCookies(jar, now));
    if (stateCookieName !== undefined) {
      doomed.add(stateCookieName);
    }

    return {
      kind: 'redirect',
      status: 303,
      location: location.toString(),
      cookies: [...doomed].map((name) => clearCookie(name, AUTH_COOKIE_PATH)),
    };
  }
}

/**
 * One query parameter's value, whatever shape the parser produced.
 *
 * Fastify turns a repeated `?error=a&error=b` into an array, and code that only
 * accepts a `string` silently ignores it — here that meant a cancellation being
 * recorded and shown as a technical failure. First value wins, matching what
 * `URLSearchParams.get` does and what every provider means by a repeated key.
 */
function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string');
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/**
 * The provider error codes that mean "the person said no", as opposed to "the
 * person could not be served".
 *
 * `access_denied` is RFC 6749's word and what Google, Facebook and Microsoft send;
 * `user_cancelled_authorize` is Apple's. Everything else a provider can put in
 * `error` — `server_error`, `temporarily_unavailable`, a misconfigured client — is
 * a failure, and the person is told so in the same words as every other failure.
 */
const PROVIDER_CANCELLATION_ERRORS: readonly string[] = [
  'access_denied',
  'user_cancelled_authorize',
];

function isCancellation(providerError: string): boolean {
  return PROVIDER_CANCELLATION_ERRORS.includes(providerError);
}

/**
 * Internal reason to the word the outside world gets. The heart of this story.
 *
 * The tempting version is `return reason` — one line, and it hands out
 * `provider_exchange_failed`, `state_expired` and `identity_rejected` to anyone
 * willing to fail a login on purpose. Together those say which part of our
 * infrastructure is unwell and what is being refused, which is precisely what the
 * acceptance criterion ("no error code, no failing provider's name") forbids.
 *
 * So the collapse is many-to-few, it lives in exactly ONE place, and it is
 * exhaustive. Adding an internal reason and forgetting to classify it is then a
 * red typecheck rather than a quiet disclosure: with no `default` branch and a
 * declared return type, a missing case makes this function fall off the end.
 *
 * ## Which of these actually reaches a browser today
 *
 * Only the callback leg calls `failedSignIn`, so only the callback reasons ever
 * become a URL. The six labels in the second group below are reached by no caller
 * right now: `provider_start_failed` answers JSON 502 from `start()`, and the four
 * refresh reasons answer JSON 401 from `refresh()` — those are `fetch` callers who
 * can read an envelope, not people staring at a redirect.
 *
 * They stay listed anyway, and not out of tidiness. The exhaustiveness is the
 * mechanism that makes forgetting impossible, and it only works over the WHOLE
 * type; carving the unreachable ones out would mean the day one of those legs
 * starts redirecting too — Story 1.3's deferred AC4, or the same fix applied to
 * the start leg — the compiler says nothing and a reason with no classification
 * ships. The grouping records which are live so the next reader is not misled
 * about how much of this vocabulary is on the wire.
 */
function publicOutcomeFor(reason: SignInFailureReason): SignInOutcome {
  switch (reason) {
    // Reachable: the callback leg, which is the only caller of `failedSignIn`.
    case 'user_cancelled':
      return 'da-huy';
    case 'provider_authorize_failed':
    case 'state_missing':
    case 'state_mismatch':
    case 'state_expired':
    case 'code_missing':
    case 'provider_exchange_failed':
    case 'identity_rejected':
      return 'that-bai';

    // Not reachable from here today — see the note above. Classified in advance
    // so that connecting one of these legs is a code change, not a disclosure.
    case 'provider_start_failed':
    case 'refresh_cookie_missing':
    case 'refresh_token_unknown':
    case 'refresh_token_expired':
    case 'session_revoked':
    case 'session_reuse_detected':
      return 'that-bai';
  }
}

/**
 * A `SessionPort` refusal in the audit trail's own vocabulary. The mapping is
 * exhaustive on purpose: adding a refusal reason to the port must not be able to
 * silently degrade into "no row was written".
 */
function refreshFailureReason(reason: SessionRefusalReason): SignInFailureReason {
  switch (reason) {
    case 'RefreshTokenReused':
      return 'session_reuse_detected';
    case 'SessionRevoked':
      return 'session_revoked';
    case 'SessionExpired':
      return 'refresh_token_expired';
    case 'SessionNotFound':
      return 'refresh_token_unknown';
  }
}

/**
 * The `/v1/auth/me` projection, parsed through the contract schema so a drift
 * between this shell and `packages/contracts` fails here rather than in a client
 * (AD-13) — and so that adding a column to `users` cannot silently start
 * publishing it.
 *
 * `email` is not in the output type at all. That is the point: the client has
 * never needed it, and a field that is never sent is a field that cannot leak.
 */
export function toCurrentUser(user: User) {
  return currentUserSchema.parse({
    id: user.id,
    display_name: user.displayName,
    avatar_url: user.avatarUrl,
    role: user.role,
  });
}
