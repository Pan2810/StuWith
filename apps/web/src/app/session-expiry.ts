import {
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
 * and `session-expiry-provider.tsx` is left holding `useState` and one read of
 * `window.location` and nothing else.
 *
 * The mechanism is deliberately general. Epic 2's live room plugs into the same
 * seam by making its authenticated calls through it; nothing in this file knows a
 * room exists, and no route of Epic 2's is guessed at here.
 */

/**
 * The route the login page lives at.
 *
 * `apps/api` has the same literal — it is the default redirect target — and that
 * is not a contract crossing a process boundary so much as two processes agreeing
 * about one of this app's own URLs. If it ever becomes a third, it belongs in
 * `packages/contracts` beside the query parameter names.
 */
export const LOGIN_PATHNAME = '/dang-nhap';

/** The status that means "there is no live session behind this call any more". */
export const SESSION_EXPIRED_STATUS = 401;

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
export function isLoginPathname(pathname: string): boolean {
  return pathname === LOGIN_PATHNAME || pathname === `${LOGIN_PATHNAME}/`;
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
  if (isLoginPathname(location.pathname)) {
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
 * The whole of what the seam decides, as one pure step: given what the dialog is
 * doing now, the status an authenticated call just came back with, and where the
 * person is standing — what should the dialog be doing next?
 *
 * Three properties are worth stating because each one is a row of the story's
 * matrix and each one is a way this could have been written wrong:
 *
 * - **A non-401 leaves the dialog exactly as it was.** It does not close it. A
 *   dialog that vanished the moment some unrelated background call succeeded
 *   would blink away while the person was reading it, and nothing about a
 *   successful call proves the session came back — the seam sees status codes,
 *   not sessions.
 * - **A 401 on the login page changes nothing.** The person is already looking at
 *   the four sign-in options; telling them to sign in, on top of the page that
 *   signs them in, is noise. This is also the row that keeps the login page's own
 *   `/v1/auth/me` probe — which answers 401 for every signed-out visitor, by
 *   design — from popping a dialog on an ordinary visit.
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
  if (status !== SESSION_EXPIRED_STATUS) {
    return current;
  }
  if (isLoginPathname(location.pathname)) {
    return current;
  }
  return { returnPath: returnPathFor(location) };
}

/**
 * The `/start` URL for one provider, with the return path attached when there is
 * one — the ONE place this href is built.
 *
 * String building rather than `new URL`, because `apiBaseUrl` is legitimately the
 * empty string when the API is served from this origin and `new URL('')` throws.
 * What makes it safe is that the only variable part is put through
 * `encodeURIComponent`, so a path containing `&`, `?` or `=` — all of which
 * `parseInternalReturnPath` allows, since an internal link may carry a query —
 * arrives as one parameter value instead of silently becoming several.
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
  const base = `${apiBaseUrl}/v1/auth/${provider}/start`;
  if (returnPath === null) {
    return base;
  }
  return `${base}?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=${encodeURIComponent(returnPath)}`;
}
