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
  RateLimitPort,
  RateLimitChannel,
  RateLimitSubject,
  SessionPort,
  SessionRefusalReason,
  User,
} from '@stuwith/domain';
import {
  IdentityInputError,
  RateLimitInputError,
  bruteForceCounterKey,
  bruteForceSubjectFor,
  bruteForceLockKey,
} from '@stuwith/domain';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { RateLimitHealth } from '../rate-limit/rate-limit-health';
import { AUTH_RUNTIME, type AuthRuntime } from './auth.runtime';
import {
  INNOCENT_SIGN_IN_FAILURES,
  recordSignInFailed,
  recordSignedIn,
  type SignInFailureReason,
} from './audit';
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
  private readonly rateLimit: RateLimitPort;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_RUNTIME) runtime: AuthRuntime,
    // Shared with the guard, deliberately: one outage must produce one log line,
    // not one per request from each of the two places that touch the store.
    private readonly health: RateLimitHealth,
  ) {
    this.identity = runtime.identity;
    this.sessions = runtime.sessions;
    this.audit = runtime.audit;
    this.clock = runtime.clock;
    this.registry = runtime.registry;
    this.rateLimit = runtime.rateLimit;
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

  /**
   * `GET /v1/auth/:provider/callback`
   *
   * `subject` is passed in rather than inferred here: it is the same address and
   * rate-limit guard already counted this request against, computed by the same
   * function, so a failure recorded below lands on the key the guard will read on
   * the next attempt.
   */
  async callback(
    providerName: string,
    query: Readonly<Record<string, unknown>>,
    cookieHeader: unknown,
    requestId: string,
    subject: RateLimitSubject,
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
        subject,
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
        subject,
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
        subject,
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
      const reason = exchangeFailureReason(error);
      return this.failedSignIn(
        requestId,
        provider,
        reason,
        now,
        jar,
        stateCheck.cookieName,
        subject,
      );
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
          subject,
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

    /**
     * A real success proves the failures before it were noise — a mistyped
     * account, a consent screen dismissed by accident, a provider having a bad
     * minute. Carrying that count forward would punish somebody who has just
     * demonstrated they are exactly who they said, and the next honest slip would
     * trip a lock they half-earned yesterday.
     *
     * The COUNTER only. A lock that has already been earned is not released here:
     * it is a different key, and it runs its own course (`bruteForceLockKey`).
     * That is what makes "success clears the failure counter" and "a successful
     * attempt does not open a lock early" both true at once.
     */
    await this.forgetFailures('browser', subject);

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
  async refresh(
    cookieHeader: unknown,
    requestId: string,
    subject: RateLimitSubject,
  ): Promise<AuthOutcome> {
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
      const reason = refreshFailureReason(rotated.reason);
      await recordSignInFailed(this.audit, {
        requestId,
        reason,
        occurredAt: now,
        sessionId: rotated.revokedSessionId ?? null,
      });
      /**
       * The refresh leg is where the CREDENTIAL dimension of the brute-force lock
       * earns its keep, and the only leg where it can.
       *
       * Every request here carries a refresh token, so `subject.userHandle` is
       * present — and it does not change when the caller's address does. A stolen
       * token replayed from fifty machines is fifty addresses and one handle, so
       * the address counter never notices while the credential counter locks it.
       * That is the "distributed attack on one account" case the IP dimension
       * cannot see.
       */
      await this.countFailure('json', subject, reason);
      return {
        kind: 'json',
        status: 401,
        body: unauthenticated(),
        cookies: clearAllAuthCookies(jar),
      };
    }

    /**
     * A rotation that succeeded proves the credential is real, so its failure
     * counter goes.
     *
     * Only the callback leg used to do this, which meant refresh failures
     * accumulated for ever against a credential that had since proven itself: a
     * client that failed four times across a network wobble stayed one failure
     * from a fifteen-minute lock long after it was working again.
     *
     * The key is the OLD credential's — the one the counter was ticked against.
     * The subject was built from the presented cookie before rotation, and the new
     * token has no history to clear.
     */
    await this.forgetFailures('json', subject);

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
    subject: RateLimitSubject,
  ): Promise<AuthOutcome> {
    // One row per attempt, cancellations included. "Not an error" is a statement
    // about the interface, not about traceability.
    await recordSignInFailed(this.audit, { requestId, provider, reason, occurredAt: now });

    // And one tick on the brute-force counter, which is a different question from
    // the per-window budget the guard already spent: that one asks "how much
    // traffic", this one asks "how much of it failed".
    await this.countFailure('browser', subject, reason);

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

      /**
   * One consecutive failure, in the ONE dimension this channel both counts and
   * enforces.
   *
   * `bruteForceSubjectFor` picks it — address for the browser legs, credential for
   * the `fetch` legs — and the guard reads the lock through the same function. See
   * its docblock for why every other arrangement was a defect; the short version is
   * that a leg which can EARN a lock it cannot ENFORCE punishes bystanders, and a
   * leg which counts a credential that was not part of the attempt punishes the
   * wrong person entirely.
   *
   * The lock is set THROUGH the counter's own refusal rather than by comparing
   * counts here: the store's atomic increment is the only thing that knows the
   * real total when several attempts land at once.
   *
   * The counter's window is the lock duration, which is why there is no separate
   * variable for it: "five failures inside the period a lock would last" is the
   * question being asked, and a window shorter than the lock would let somebody
   * trickle attempts just under the rate for ever.
   */
  private async countFailure(
    channel: RateLimitChannel,
    subject: RateLimitSubject,
    reason: SignInFailureReason,
  ): Promise<void> {
    if (INNOCENT_SIGN_IN_FAILURES.has(reason)) {
      return;
    }
    const target = bruteForceSubjectFor(channel, subject);
    if (target === null) {
      return;
    }

    await this.withRateLimitStore('recording a failed sign-in', async () => {
      const counted = await this.rateLimit.hit(
        bruteForceCounterKey(target.dimension, target.value),
        this.config.RATE_LIMIT_BRUTE_FORCE_MAX,
        this.config.RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS,
      );
      if (!counted.ok) {
        await this.rateLimit.lock(
          bruteForceLockKey(target.dimension, target.value),
          this.config.RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS,
        );
      }
    });
  }

  /**
   * Clear the counter this request would have ticked — the same key, chosen the
   * same way.
   *
   * ## The trade this makes, stated plainly
   *
   * On the browser legs that key is the ADDRESS, and an address on a campus NAT is
   * shared. So one successful login there does clear the failure counter for
   * everybody on that address, and somebody with a valid account can use that to
   * keep an address counter from ever reaching the threshold. That is a real
   * weakness and it was chosen with eyes open, because the alternatives are worse:
   *
   * - clearing nothing leaves an honest person who finally got in one slip away
   *   from a fifteen-minute lock they already worked through;
   * - clearing only a credential dimension does nothing at all here, because a
   *   sign-in attempt carries no credential of its own — the clear would be a
   *   no-op and the matrix row "thành công dọn bộ đếm thất bại" would be a
   *   comment rather than a behaviour.
   *
   * What limits the damage is that the address counter is a fifteen-minute window
   * and the credential dimension — which no bystander can reset — is what catches
   * an attack on a specific account. `AGENTS.md` records the same trade.
   *
   * The COUNTER only. A lock already earned is a different key and runs its own
   * course, which is what makes "success clears the failure counter" and "a
   * successful attempt does not open a lock early" both true at once.
   */
  private async forgetFailures(
    channel: RateLimitChannel,
    subject: RateLimitSubject,
  ): Promise<void> {
    const target = bruteForceSubjectFor(channel, subject);
    if (target === null) {
      return;
    }
    await this.withRateLimitStore(
      'clearing the failure counter after a successful sign-in',
      () => this.rateLimit.clear(bruteForceCounterKey(target.dimension, target.value)),
    );
  }

  /**
   * Fail open here too, for the same reason and with the same obligation.
   *
   * Bookkeeping that cannot reach Valkey must never turn a completed login into a
   * 500, nor a properly failed one into anything other than the 303 Story 1.3
   * part 1 established — the person did everything right, or wrong, and the store
   * they have never heard of is the thing that is unwell.
   *
   * `RateLimitInputError` is deliberately NOT swallowed. That is a defect in this
   * code — a malformed key, a hashing bug — and reporting it for ever as a Valkey
   * outage would leave the brute-force counter permanently off with an alarm
   * pointing at the wrong system.
   *
   * The reporting goes through the shared {@link RateLimitHealth} rather than
   * straight to a logger, so an outage produces one line and one recovery line
   * instead of one stack trace per request from two call sites.
   */
  private async withRateLimitStore(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
      this.health.recordSuccess();
    } catch (error) {
      if (error instanceof RateLimitInputError) {
        throw error;
      }
      this.health.recordFailure(what, error);
    }
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
    case 'code_rejected':
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
 * Which kind of exchange failure this was, and therefore whether it counts.
 *
 * The distinction is the natural `/callback` attack: call `/start` once for a
 * valid `state` cookie, then submit guessed `code` values. Every one of those is
 * a token exchange the provider refuses with a 4xx — and while all of them mapped
 * to `provider_exchange_failed`, which is on the innocent list, the counter never
 * moved. Every brute-force test used `?code=nope&state=nope` with no cookie, so
 * only `state_missing` was ever exercised and the gap was invisible.
 */
function exchangeFailureReason(error: unknown): SignInFailureReason {
  if (error instanceof IdentityInputError) {
    return 'identity_rejected';
  }
  if (error instanceof ProviderExchangeError && error.refusedByProvider) {
    return 'code_rejected';
  }
  return 'provider_exchange_failed';
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
