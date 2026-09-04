import {
  AUTH_REFRESH_PATH,
  RATE_LIMITED_STATUS,
  SESSION_EXPIRED_STATUS,
  SESSION_REFRESHED_STATUS,
  SIGN_IN_PATHNAME,
  SIGN_IN_RETURN_PATH_QUERY_PARAM,
  parseInternalReturnPath,
  type AuthProvider,
} from '@stuwith/contracts';

/**
 * Every decision behind "your session ended while you were using the product".
 *
 * It is a plain module with no React in it, for the reason `sign-in-outcome.tsx`
 * gives at length: the `web` Vitest project has `environment: 'node'` and no DOM
 * (`jsdom`, `happy-dom` and `@testing-library/*` are all absent, and adding one is
 * an "Ask First" item), so anything living inside a `useEffect` or behind a
 * `window` read cannot be executed by a test. What is here runs under plain Node,
 * and `session-expiry-provider.tsx` is left holding `useState`, one `window` read
 * and the wiring between them.
 *
 * The mechanism is deliberately general. Epic 2's live room plugs into the same
 * seam by making its authenticated calls through it; nothing in this file knows a
 * room exists, and no route of Epic 2's is guessed at here.
 */

/**
 * The route the login page lives at.
 *
 * Re-exported from `packages/contracts` rather than written again here: `apps/api`
 * needs the same string as its default redirect target, AD-13 says a value both
 * processes read is declared once, and two literals is how one of them gets
 * renamed alone.
 */
export { SIGN_IN_PATHNAME };

/**
 * Re-exported, not redeclared.
 *
 * These three used to be literals in this file, and one of them was wrong: the
 * renewal was accepted only on `200` while `/v1/auth/refresh` answers `204`. Both
 * sides' unit suites passed anyway — the API's asserted 204, this one stubbed 200 —
 * so the renewal silently never worked and every expiry went straight to the
 * dialog. A status a client branches on belongs to the contract (AD-13).
 */
export {
  SESSION_REFRESHED_STATUS,
  SESSION_EXPIRED_STATUS,
  RATE_LIMITED_STATUS,
} from '@stuwith/contracts';

/** The parts of `window.location` any of this needs. */
export interface ReturnPathLocation {
  readonly pathname: string;
  readonly search: string;
}

/**
 * Whether a pathname IS the login page.
 *
 * Trailing slash included, because Next serves both and a person who arrived on
 * `/dang-nhap/` is just as much on the login page. Getting this wrong is not
 * cosmetic: it is the difference between a dialog saying "sign in again" and the
 * sign-in page itself, stacked.
 */
export function isSignInPathname(pathname: string): boolean {
  return pathname === SIGN_IN_PATHNAME || pathname === `${SIGN_IN_PATHNAME}/`;
}

/**
 * The path worth proposing as a place to come back to, or `null`.
 *
 * `pathname + search`, never the hash: a fragment never reaches the server, so it
 * could not survive the round trip through the OAuth state anyway, and carrying
 * one into a `Location` header would be a promise this flow cannot keep.
 *
 * The verdict is `parseInternalReturnPath`'s — the same function `apps/api` uses
 * at `/start` (AD-13). It is asked here as well, and that is not a second rule:
 * the client asking first means an unusable path is never put in a URL at all,
 * while the server asking is what makes the answer trustworthy. The server's
 * answer is the one that decides; this one only decides whether to bother.
 */
export function returnPathFor(location: ReturnPathLocation): string | null {
  if (isSignInPathname(location.pathname)) {
    // Coming "back" to the login page is where a login lands by default, so
    // proposing it adds a parameter that changes nothing.
    return null;
  }
  return parseInternalReturnPath(`${location.pathname}${location.search}`);
}

/**
 * The dialog is open when this is not `null`, and what it carries is where to go
 * afterwards. `null` inside it means "come back to the default", never "no dialog".
 */
export interface SessionExpiryPrompt {
  readonly returnPath: string | null;
}

export type SessionExpiryState = SessionExpiryPrompt | null;

/**
 * The whole of what the seam decides about the DIALOG, as one pure step: given
 * what the dialog is doing now, the status an authenticated call finally came back
 * with, and where the person is standing — what should the dialog be doing next?
 *
 * "Finally" is load-bearing. By the time this runs, {@link authorizedCall} has
 * already tried to renew the session and replayed the call; a 401 arriving here is
 * one that survived that, which is what makes raising a dialog on it honest.
 *
 * Three properties are worth stating because each one is a row of the story's
 * matrix and each one is a way this could have been written wrong:
 *
 * - **Being on the login page CLOSES an open dialog, and never opens one.** It
 *   used to return `current`, which meant a dialog raised on `/phong-hoc` stayed
 *   stacked on top of `/dang-nhap` after the person clicked through to sign in —
 *   the exact "sign in again, on top of the page that signs you in" noise the
 *   matrix row forbids. Every existing example started from `null`, so the whole
 *   class was invisible.
 * - **Anywhere else, a non-401 leaves the dialog exactly as it was.** It does not
 *   close it. A dialog that vanished the moment some unrelated background call
 *   succeeded would blink away while the person was reading it, and nothing about
 *   a successful call proves the session came back — the seam sees status codes,
 *   not sessions.
 * - **Closing does not disarm anything.** There is no "dismissed" flag here to
 *   consult, so the next 401 produces a prompt again. Closing once and staying
 *   quiet for ever is the exact trap this feature exists to avoid: the person
 *   dismisses the dialog, keeps clicking, and every click silently does nothing.
 */
export function nextSessionExpiry(
  current: SessionExpiryState,
  status: number,
  location: ReturnPathLocation,
): SessionExpiryState {
  if (isSignInPathname(location.pathname)) {
    return null;
  }
  if (status !== SESSION_EXPIRED_STATUS) {
    return current;
  }
  return { returnPath: returnPathFor(location) };
}

/**
 * An origin with no trailing slash, which is what every href in this app is built
 * on top of.
 *
 * `NEXT_PUBLIC_API_BASE_URL` does not go through `packages/config`'s schema — it
 * is read out of `process.env` and inlined into the browser bundle — so nothing
 * else refuses the spellings a person actually types. A bare `/` is the one that
 * mattered: joining it to `/v1/auth/google/start` gives
 * `//v1/auth/google/start`, a PROTOCOL-RELATIVE URL pointing at a host literally
 * named `v1`. That is an off-origin navigation wearing the shape of a local link,
 * and it is the same family as the `//` spelling `parseInternalReturnPath` refuses
 * on the other side of the flow.
 *
 * The empty string is the legitimate value for "the API is served from this
 * origin", and it stays empty.
 */
export function normaliseApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '');
}

/**
 * The `/start` URL for one provider, with the return path attached when there is
 * one — the ONE place this href is built.
 *
 * String building rather than `new URL`, because `apiBaseUrl` is legitimately the
 * empty string when the API is served from this origin and `new URL('')` throws.
 * Two things make that safe: the only variable part is put through
 * `encodeURIComponent`, so a path containing `&`, `?` or `=` — all of which
 * `parseInternalReturnPath` allows, since an internal link may carry a query —
 * arrives as one parameter value instead of silently becoming several; and the
 * base is normalised first, so no spelling of it can turn a same-origin path into
 * a protocol-relative one.
 *
 * A plain href, not a `fetch`: the OAuth flow is a top-level browser navigation
 * that has to leave this origin, come back, and carry the `SameSite=Lax` state
 * cookie on the way in.
 */
export function signInStartHref(
  apiBaseUrl: string,
  provider: AuthProvider,
  returnPath: string | null,
): string {
  const base = `${normaliseApiBaseUrl(apiBaseUrl)}/v1/auth/${provider}/start`;
  if (returnPath === null) {
    return base;
  }
  return `${base}?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=${encodeURIComponent(returnPath)}`;
}

/** `fetch`, narrowed to what this app actually calls it with. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Renew the session, at most once at a time.
 *
 * ## Why this exists at all
 *
 * `SESSION_TTL_SECONDS` defaults to one hour and `SESSION_REFRESH_TTL_SECONDS` to
 * thirty days, and until this was written `apps/web` never called
 * `/v1/auth/refresh` at all. So a 401 was treated as "your session is over" when
 * for twenty-nine days out of thirty it meant "your access token aged out and the
 * server will hand you a new one for the asking". An hourly dialog, at somebody
 * doing nothing wrong, would make a feature built to prevent an interruption into
 * the interruption.
 *
 * ## The three rules, and why each is a rule rather than an optimisation
 *
 * - **One renewal in flight, shared.** Two authenticated calls landing in the same
 *   tick both see 401 and both ask; without this they send two `POST /refresh`,
 *   and refresh tokens ROTATE — the second request presents a token the first one
 *   has just replaced, which the session store reads as a replayed token and
 *   answers by revoking the whole chain. Two honest calls would log the person
 *   out. Sharing the in-flight promise is not about saving a request; it is what
 *   stops the feature from being self-defeating.
 * - **A refusal is final until a new session exists.** `401` and `429` from the
 *   renewal itself mean, respectively, that there is nothing left to renew and
 *   that asking again is the problem. Retrying either turns one dead session into
 *   a request storm against a rate-limited endpoint, with every later call
 *   starting another. Once refused, this refresher answers `false` without a
 *   request until the page is reloaded — which is what a completed sign-in does
 *   anyway. A network failure is NOT a refusal: nothing was answered, so nothing
 *   was learnt, and the next 401 may legitimately try again.
 * - **Never recursive.** It is called from exactly one place, never from itself,
 *   and {@link authorizedCall} calls it at most once per call it makes. There is
 *   no path on which a renewal can trigger a renewal.
 */
export function createSessionRefresher(deps: {
  readonly fetchImpl: FetchLike;
  readonly apiBaseUrl: string;
}): () => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null;
  let refused = false;

  return () => {
    if (refused) {
      return Promise.resolve(false);
    }
    if (inFlight !== null) {
      return inFlight;
    }
    const attempt = deps
      .fetchImpl(`${normaliseApiBaseUrl(deps.apiBaseUrl)}${AUTH_REFRESH_PATH}`, {
        method: 'POST',
        credentials: 'include',
      })
      .then((response) => {
        if (response.status === SESSION_EXPIRED_STATUS || response.status === RATE_LIMITED_STATUS) {
          refused = true;
        }
        // `SESSION_REFRESHED_STATUS`, not `200`. `/v1/auth/refresh` answers 204,
        // so this comparison was false on every successful renewal and the dialog
        // appeared for people whose session had just been renewed perfectly well.
        return response.status === SESSION_REFRESHED_STATUS;
      })
      // A thrown `fetch` is the network being unavailable, not an answer. It is
      // deliberately not latched: the session may be perfectly alive.
      .catch(() => false);

    inFlight = attempt.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Whether the same `init` can be sent twice.
 *
 * A `ReadableStream` body is consumed by the first request, so replaying the call
 * with the same `init` would send an empty one — silently, with a 200 coming back,
 * which is worse than any failure. Everything else `fetch` accepts as a body (a
 * string, `FormData`, `URLSearchParams`, a `Blob`, an `ArrayBuffer` or a view over
 * one) is re-readable.
 *
 * The `typeof` guard is for the server render, where `ReadableStream` need not be
 * a global. Nothing calls this there, but a module that throws while being
 * imported would take the whole page down.
 */
function isReplayableBody(body: RequestInit['body']): boolean {
  if (body === undefined || body === null || typeof body === 'string') {
    return true;
  }
  return typeof ReadableStream === 'undefined' || !(body instanceof ReadableStream);
}

/** What one authenticated call leaves behind for the dialog to be decided from. */
export interface AuthorizedCallOutcome {
  /** The response the caller gets — the replayed one when there was a replay. */
  readonly response: Response;
  /**
   * The status {@link nextSessionExpiry} should judge, which is the status of the
   * response above. It is a field rather than a second read of `response.status`
   * so that the seam's caller cannot report something else by accident.
   */
  readonly status: number;
  /**
   * Where the person was standing when the call came back, read ONCE, here.
   *
   * Not inside the `setState` updater it eventually feeds: React may call an
   * updater twice (StrictMode does, on purpose) and an updater that reads
   * `window.location` for itself is not a pure function of its arguments.
   */
  readonly location: ReturnPathLocation;
}

/**
 * One authenticated call, including the renewal that has to be tried before
 * anybody is disturbed.
 *
 * Everything it needs from the browser arrives as a dependency, so the whole
 * sequence — 401, renew, replay, decide — runs under plain Node in the `web`
 * Vitest project. That is the point: before this existed the sequence lived inside
 * a `useCallback` in a `'use client'` component, and deleting any step of it left
 * every test green.
 *
 * The order of the guards is the specification, so it is worth reading as one:
 *
 * 1. Not a 401 — nothing to do; hand the response back.
 * 2. On the login page — do NOT renew. `/v1/auth/me` answers 401 there for every
 *    signed-out visitor by design, so renewing would spend one rate-limited
 *    `auth_refresh` per anonymous page view, and the dialog is suppressed there
 *    anyway.
 * 3. A body that cannot be sent twice — do not renew and do not replay. See
 *    {@link isReplayableBody}; the caller gets the 401 exactly as it would have
 *    before this seam existed. Neither call site today has a body at all, and a
 *    caller that wants transparent replay should hand the seam a string.
 * 4. Renew once, sharing whatever renewal is already in flight.
 * 5. Renewal refused — the session really is over; report the 401.
 * 6. Renewed — replay the call ONCE and report whatever that says. A replay that
 *    is itself 401 goes straight to the dialog: there is no second renewal, ever.
 */
export async function authorizedCall(
  deps: {
    readonly fetchImpl: FetchLike;
    /** Read after the response, never inside a `setState` updater. */
    readonly locationOf: () => ReturnPathLocation;
    /** The shared, single-flight renewal — see {@link createSessionRefresher}. */
    readonly renew: () => Promise<boolean>;
  },
  input: string,
  init?: RequestInit,
): Promise<AuthorizedCallOutcome> {
  // `credentials: 'include'` belongs to the seam rather than to the call site: the
  // session lives in an `httpOnly` cookie and only travels on a credentialed
  // request, and it is the easiest thing in this app to forget.
  const credentialed: RequestInit = { ...init, credentials: 'include' };

  const first = await deps.fetchImpl(input, credentialed);
  const location = deps.locationOf();
  const unchanged: AuthorizedCallOutcome = { response: first, status: first.status, location };

  if (first.status !== SESSION_EXPIRED_STATUS) {
    return unchanged;
  }
  if (isSignInPathname(location.pathname)) {
    return unchanged;
  }
  if (!isReplayableBody(init?.body)) {
    return unchanged;
  }
  if (!(await deps.renew())) {
    return unchanged;
  }

  const replayed = await deps.fetchImpl(input, credentialed);
  return { response: replayed, status: replayed.status, location };
}
