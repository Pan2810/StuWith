import { Inject, Injectable } from '@nestjs/common';
import {
  AUTH_COOKIE_PATH,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_PATHNAME,
  currentUserSchema,
  isAuthProvider,
  makeError,
  parseDateOfBirth,
  parseInternalReturnPath,
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
  bruteForceCounterKey,
  bruteForceSubjectFor,
  bruteForceLockKey,
  isAdult,
  isProfileComplete,
} from '@stuwith/domain';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { RateLimitHealth } from '../rate-limit/rate-limit-health';
import { isStoreFault } from '../rate-limit/store-fault';
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
  /**
   * Where to send the browser after a SUCCESSFUL login — an internal path, and
   * absent when none was proposed or when what was proposed was not internal.
   *
   * This is the one field here that is not merely unforgeable-in-principle but
   * unforgeable-in-consequence: it decides a redirect target. The client proposes
   * it at `/start`, `parseInternalReturnPath` judges it there, and the SIGNATURE
   * is what carries the verdict to the callback. Nothing on the callback leg reads
   * a path from a query parameter, a cookie of its own or a header, so producing a
   * destination of your choosing requires producing a signature — which requires
   * `SESSION_COOKIE_SECRET`.
   *
   * Short name for the same reason the other four are short: it rides in a cookie
   * on every `/v1/auth` request until the handshake ends.
   */
  readonly r?: string;
}

/**
 * Where a login lands when nothing else was asked for.
 *
 * The login page itself, which is also where every FAILED attempt lands — see
 * `failedSignIn`, which deliberately drops the return path: the person is looking
 * at the login page, so "put them back where they were" has nothing to mean yet.
 *
 * The literal lives in `packages/contracts` (AD-13) because `apps/web` needs the
 * same string to answer "is this person already on the sign-in page", and the
 * docblock at the top of `contracts/src/auth.ts` says nothing there may be
 * redeclared in `apps/*`. Two copies is how one of them gets renamed alone, and
 * both failures that produces are silent.
 */
const DEFAULT_RETURN_PATH = SIGN_IN_PATHNAME;

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
 * The two Story 1.4 refusals. Both sentences live in `packages/contracts`, for
 * the same reason `RATE_LIMITED_MESSAGE` does: `apps/web` shows the first one
 * beside the field without waiting for a round trip, so the two processes would
 * otherwise each hold their own copy and one of them would be edited alone.
 *
 * Neither carries `details`. There is nothing a client could do with "the month
 * was 13" that the sentence does not already cover, and every diagnostic in an
 * error body is a diagnostic in somebody's screenshot.
 */
function invalidDateOfBirth(): ErrorEnvelope {
  return makeError('validation_failed', DATE_OF_BIRTH_INVALID_MESSAGE);
}

function dateOfBirthAlreadySet(): ErrorEnvelope {
  return makeError('conflict', DATE_OF_BIRTH_ALREADY_SET_MESSAGE);
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

  /**
   * `GET /v1/auth/:provider/start`
   *
   * `returnPathProposal` is exactly what its name says: untrusted, whatever the
   * query parameter happened to contain, and only a SUGGESTION. This is the one
   * leg where it is looked at, judged, and — if it survives — signed into the
   * state. Everything downstream reads the verdict, never the proposal.
   *
   * A proposal that is not an internal path is dropped in silence, and the login
   * continues to the default. It is a value a stranger can put in a link and send
   * to somebody, so refusing it with an error would turn "here is a login link"
   * into a way to break somebody's login; and it is not the visitor's mistake
   * either way. Nothing about it is logged: writing the rejected value to a log
   * line is how an attacker-chosen string gets into the operator's terminal, and
   * the acceptance criterion says as much.
   */
  async start(
    providerName: string,
    requestId: string,
    returnPathProposal?: unknown,
  ): Promise<AuthOutcome> {
    const adapter = this.adapterFor(providerName);
    if (adapter === null) {
      return { kind: 'json', status: 404, body: notFound(), cookies: [] };
    }

    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = createPkcePair();
    const now = this.clock.now();

    // `firstQueryValue`, matching how `?error=` is read on the callback leg: a
    // repeated `?quay-ve=/a&quay-ve=//evil.com` reaches Fastify as an ARRAY, and
    // code that only accepts a `string` would ignore the whole thing — harmless
    // here, but the two legs disagreeing about what a repeated parameter means is
    // the kind of difference that becomes a defect the moment one of them stops
    // being harmless.
    const returnPath = parseInternalReturnPath(firstQueryValue(returnPathProposal));

    const payload: OAuthStatePayload = {
      p: adapter.provider,
      s: state,
      v: verifier,
      n: nonce,
      x: Math.floor(now.getTime() / 1000) + this.config.OAUTH_STATE_TTL_SECONDS,
      // Absent rather than `null` when there is nothing to carry: this payload is
      // JSON in a cookie on every `/v1/auth` request, and a key worth four bytes
      // is worth not sending.
      ...(returnPath === null ? {} : { r: returnPath }),
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
      // The destination comes from the SIGNED state and from nowhere else. Not
      // from `query`, not from a cookie this leg reads for itself, not from a
      // header — see `OAuthStatePayload.r`.
      location: this.webDestination(stateCheck.payload.r),
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

  /**
   * `GET /v1/auth/me`
   *
   * It answers for a profile that has NOT declared a date of birth exactly as it
   * does for one that has — the flags differ, the status does not. Refusing here
   * would lock somebody out of the only endpoint that could tell them what is
   * missing, and out of `/logout` by extension, which is the "do not lock people
   * out of their own session" row of the story matrix.
   */
  async me(cookieHeader: unknown): Promise<AuthOutcome> {
    const user = await this.userFromSession(cookieHeader);
    if (user === null) {
      return { kind: 'json', status: 401, body: unauthenticated(), cookies: [] };
    }

    return { kind: 'json', status: 200, body: toCurrentUser(user, this.clock), cookies: [] };
  }

  /**
   * `POST /v1/auth/date-of-birth` — the first-login declaration, written once.
   *
   * ## Order of the three answers, and why it is this order
   *
   * 1. **No usable session → 401.** Nothing about the body is looked at, so an
   *    unauthenticated caller learns nothing by varying it.
   * 2. **Unusable date → 400**, decided by the shared `parseDateOfBirth` with
   *    this process's `ClockPort`. Nothing is written, and the message says what
   *    to do without naming a format, a parser or the age threshold. Telling
   *    somebody which side of eighteen they landed on is free calibration for
   *    anybody who wants to be on the other side of it.
   * 3. **The port decides.** `AlreadyRecorded` is a 409 that names no value —
   *    not the stored one and not the submitted one; `UserNotFound` means the
   *    session points at a profile that is gone, which is the same 401 as (1).
   *
   * ## What is deliberately absent
   *
   * No audit row. `audit_events` has no `DELETE` for any role, so anything
   * written there is permanent, and its `action` column is a CHECK constraint
   * duplicated by hand into a migration — adding a value is a three-place change
   * that needs asking first. More importantly, the row that would be worth
   * writing is the one carrying the date, and that is precisely the row that must
   * never exist.
   *
   * Nothing is logged either. The value never reaches a logger call in this
   * file, and `LOG_REDACT_PATHS` covers `req.body.date_of_birth` and
   * `*.dateOfBirth` as the floor underneath that.
   *
   * There is also no way BACK. No endpoint updates a date of birth that is
   * already set, by design: changing it goes through support, and that flow is
   * not part of this epic.
   */
  async recordDateOfBirth(cookieHeader: unknown, body: unknown): Promise<AuthOutcome> {
    const user = await this.userFromSession(cookieHeader);
    if (user === null) {
      return { kind: 'json', status: 401, body: unauthenticated(), cookies: [] };
    }

    // ONE reading of the clock for the whole request, not one per use.
    //
    // It was two: `parseDateOfBirth(submitted, this.clock.now())` and then
    // `recordDateOfBirth(..., this.clock.now())`. Two instants for one request, in
    // a story whose central principle is that a value must not have two readings —
    // and the gap between them straddles a midnight, so a declaration made in that
    // millisecond is judged against one day and stamped with the next.
    const now = this.clock.now();

    // `unknown` all the way in: a JSON body is whatever the caller sent, and
    // `parseDateOfBirth` is total over `unknown` for exactly this reason.
    const submitted =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)[DATE_OF_BIRTH_FIELD]
        : undefined;
    const dateOfBirth = parseDateOfBirth(submitted, now);
    if (dateOfBirth === null) {
      return { kind: 'json', status: 400, body: invalidDateOfBirth(), cookies: [] };
    }

    const outcome = await this.identity.recordDateOfBirth(user.id, dateOfBirth, now);
    if (!outcome.ok) {
      return outcome.reason === 'UserNotFound'
        ? { kind: 'json', status: 401, body: unauthenticated(), cookies: [] }
        : { kind: 'json', status: 409, body: dateOfBirthAlreadySet(), cookies: [] };
    }

    // The updated profile, through the same projection `/me` uses — so the client
    // gets the new flags without a second round trip, and gets them from the one
    // function that decides what may leave this process.
    return {
      kind: 'json',
      status: 200,
      body: toCurrentUser(outcome.user, this.clock),
      cookies: [],
    };
  }

  /**
   * The person behind a session cookie, or `null` for every reason there is.
   *
   * Extracted because `/me` and the declaration endpoint have to authenticate
   * IDENTICALLY. Written twice, the second copy is where a missing expiry check
   * or a different hash eventually appears, and the difference would show up as
   * one endpoint accepting a session the other rejects.
   *
   * It collapses "no cookie", "unknown or expired session" and "the session
   * points at a user that no longer exists" into one `null` on purpose: all three
   * are a 401 to the caller, and distinguishing them in the response tells
   * somebody probing which of the three they achieved.
   */
  private async userFromSession(cookieHeader: unknown): Promise<User | null> {
    const presented = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
    if (presented === undefined) {
      return null;
    }

    const read = await this.sessions.readByAccessTokenHash(
      this.hash(presented),
      this.clock.now(),
    );
    if (!read.ok) {
      return null;
    }

    return this.identity.findUserById(read.session.userId);
  }

  /**
   * A URL on the web client, built rather than concatenated.
   *
   * `new URL(path, base)` and not `` `${base}${path}` ``: the second one takes a
   * value that varies and splices it into a string that is about to be parsed as
   * a URL, which is the shape every open redirect has ever had.
   *
   * Two things guard the result, and they are deliberately not the same thing
   * twice:
   *
   * 1. The path is run back through `parseInternalReturnPath`. That is NOT a
   *    second policy — it is the same shared function, applied to a value that
   *    reached here as an unchecked cast. `verifyPayload<OAuthStatePayload>()`
   *    proves the bytes were signed by us; it proves nothing about their SHAPE,
   *    which is why the expiry two screens up is guarded with
   *    `typeof payload.x !== 'number'` in the same spirit. A `TypeError` here
   *    would turn a completed login into a 500.
   * 2. The origin of what comes out must be the origin of `WEB_BASE_URL`. That
   *    invariant is what `auth.flow.test.ts` has asserted on every failure path
   *    since Story 1.3 part 1, and the success path is the leg where a variable
   *    path made it possible to break for the first time. `//evil.com` is the
   *    exact spelling that makes `new URL(path, base)` adopt a new origin, so the
   *    check is placed where it catches that even if rule 1 were ever weakened.
   *
   *    It is UNREACHABLE by design, and that is worth writing down rather than
   *    leaving as a branch somebody later deletes for having no coverage. No input
   *    exists today that satisfies rule 1 and fails rule 2: `//` and `\` and every
   *    encoded spelling of them die inside `parseInternalReturnPath`, so reaching
   *    this comparison would mean faking the shared validator. It is the second
   *    half of a belt-and-braces pair, kept for the day rule 1 is relaxed by
   *    somebody who does not read this file — which is exactly when a redirect
   *    onto another origin stops being impossible.
   *
   * Anything that fails either one lands on the default. Silence, again: there is
   * nothing here a person did wrong and nothing an operator can act on.
   */
  private webDestination(signedReturnPath: unknown): string {
    const fallback = new URL(DEFAULT_RETURN_PATH, this.config.WEB_BASE_URL);
    const path = parseInternalReturnPath(signedReturnPath);
    if (path === null) {
      return fallback.toString();
    }
    const destination = new URL(path, this.config.WEB_BASE_URL);
    return destination.origin === fallback.origin ? destination.toString() : fallback.toString();
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

    /**
     * The return path is deliberately NOT carried here, even when this attempt
     * signed one.
     *
     * `auth.flow.test.ts` pins that exactly one query parameter rides back, and
     * the docblock there says why: an extra parameter is how a diagnostic detail
     * gets smuggled to the client "just for debugging". Keeping that invariant is
     * worth more than preserving a place to stand for a login that has already
     * failed — the person is looking at the login page, and the next successful
     * attempt proposes its own path from wherever they are then.
     */
    const location = new URL(DEFAULT_RETURN_PATH, this.config.WEB_BASE_URL);
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
   * Only a STORE FAULT is swallowed, and `isStoreFault` is the same judge the
   * guard uses — this is the half that runs `countFailure` and `forgetFailures`
   * on `/callback` and `/refresh`, so if the two halves disagreed the brute-force
   * bookkeeping would fail open under conditions the enforcing half calls a bug.
   *
   * The rule used to be "anything that is not a `RateLimitInputError`", which
   * swallowed every `TypeError` and `RangeError` here too: a plain defect in this
   * file was reported for ever as "the counter store did not answer", pointed the
   * alert at Valkey, and left the counter off while looking like an infrastructure
   * incident. A defect in our code must surface as the 500 it is.
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
      if (!isStoreFault(error)) {
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
 *
 * ## Story 1.4: two booleans, and never the date
 *
 * `date_of_birth` is deliberately absent from the object literal below AND from
 * `currentUserSchema`, which is two independent reasons it cannot travel. The
 * schema is the mechanical one: `.parse()` strips keys the object does not
 * declare, so even a future edit that adds `date_of_birth: user.dateOfBirth`
 * here would produce a body without it. That is the whole reason this function
 * parses instead of returning a literal.
 *
 * What DOES travel is `isProfileComplete` and `isAdult`, both computed by
 * `packages/domain`. The rule is not re-derived here and must not be: `apps/web`
 * displays what this returns, Story 1.5's money gate will call the same domain
 * function, and a second copy of "born before which day" is how the API and the
 * guard eventually disagree about one person.
 *
 * The clock is a parameter rather than `new Date()` for the same reason it is one
 * in the domain: a projection that reads the wall clock cannot be tested at a
 * chosen instant, and the flow suite runs on a `FixedClock`.
 */
export function toCurrentUser(user: User, clock: ClockPort) {
  return currentUserSchema.parse({
    id: user.id,
    display_name: user.displayName,
    avatar_url: user.avatarUrl,
    role: user.role,
    profile_completed: isProfileComplete(user),
    is_over_18: isAdult(user, clock),
  });
}
