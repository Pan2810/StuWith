'use client';

import { AUTH_ME_PATH, parseCurrentUser, type CurrentUser } from '@stuwith/contracts';
import { useCallback, useEffect, useState } from 'react';
import { profileLoadOutcome } from '../profile-load';
import { useApiBaseUrl, useAuthorizedFetch } from '../session-expiry-provider';
import {
  SignInPanel,
  SignedInPanel,
  nextLocationAfterOutcome,
  type SignInNotice,
} from './sign-in-outcome';

/**
 * Deliberately unstyled. The design system — tokens, light/dark, the "Cắm trại"
 * identity — is Story 1.6, and putting provisional styling here would only have to
 * be deleted. What this page proves now is the thing Story 1.2 owns: four links
 * into the real OAuth start endpoints, and a session the browser can read back
 * through `/v1/auth/me`.
 *
 * `apps/web` stays a pure client (AD-13 / the "web is a thin client" constraint):
 * the provider list and the response type both come from `@stuwith/contracts`, and
 * there is no business rule in this file.
 *
 * What is left here is only what needs a browser: two calls through the shared
 * `authorizedFetch` seam, `setState`, and `history.replaceState`. Every DECISION —
 * which notice to show, whether the login links may be offered, what a 429 from
 * `/me` means, whether a 401 raises the session-expiry dialog — is an exported
 * function or component in `sign-in-outcome.tsx` or `session-expiry.ts`, because
 * this project has no DOM environment and a decision left in this file is a
 * decision no test can execute.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: CurrentUser }
  /**
   * The state this page did not have, and the loop that produced.
   *
   * `/v1/auth/me` answering `200` with a body that is not a `CurrentUser` used to
   * land on `signed-out`, which shows four login links to somebody who IS signed in
   * — and signing in again cannot help, because the body still will not parse. The
   * declaration screen had already rejected exactly this collapse in writing, for
   * exactly this answer. One reading now serves both (`../profile-load`).
   *
   * It carries the wait, because `429` is the case it was invented for and the
   * seconds are the only thing anybody can act on.
   */
  | { status: 'unavailable'; retryAfterSeconds: number | null };

export default function DangNhapPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  /**
   * The outcome AND its countdown, as ONE value.
   *
   * Two pieces of state was the bug: the countdown was a separate optional prop,
   * so deleting it from the JSX below typechecked and shipped a lock message with
   * no number in it. `SignInNotice` makes that a compile error.
   */
  const [notice, setNotice] = useState<SignInNotice | null>(null);

  /**
   * The shared seam, not a bare `fetch`.
   *
   * It carries `credentials: 'include'` — the session lives in an `httpOnly`
   * cookie and only travels on a credentialed request — it tries
   * `/v1/auth/refresh` before anybody is disturbed, and it reports the surviving
   * status so a 401 anywhere in the app raises the session-expiry dialog. Both of
   * those are deliberately quiet on THIS page: `authorizedCall` does not renew on
   * `/dang-nhap` and `nextSessionExpiry` does not open a dialog there, because a
   * 401 from `/v1/auth/me` here is the ordinary signed-out answer rather than a
   * session that just died — and renewing on it would spend one rate-limited
   * `auth_refresh` for every anonymous visit.
   */
  const authorizedFetch = useAuthorizedFetch();
  /**
   * From the provider, not from `process.env`.
   *
   * `layout.tsx` reads `NEXT_PUBLIC_API_BASE_URL` once and hands it down. This
   * page used to read it a second time, which made the layout's docblock ("one
   * answer for the whole app") false the moment it was written.
   */
  const apiBaseUrl = useApiBaseUrl();

  const load = useCallback(async () => {
    try {
      const response = await authorizedFetch(`${apiBaseUrl}${AUTH_ME_PATH}`);
      /**
       * The body is parsed here and judged in `profileLoadOutcome`, which is the
       * SHARED reading `/khai-ngay-sinh` uses too.
       *
       * `status !== 200` rather than `!response.ok`, and the difference is not
       * cosmetic: `ok` is true for the whole 2xx range, and the only shape this
       * page can render is the `CurrentUser` body a 200 carries. A 204 or a 206
       * would be parsed as JSON and throw.
       *
       * Parsed, never cast. `as CurrentUser` is a claim about a body this process
       * did not write, and the whole reason `toCurrentUser` parses on the way out
       * is that a shape nobody checks is a shape that drifts. A 200 carrying
       * something else is not a session this page can render — and it is not a
       * signed-out visitor either, which is what this page used to call it.
       */
      const user =
        response.status === 200 ? parseCurrentUser(await response.json()) : null;
      const outcome = profileLoadOutcome(
        response.status,
        user,
        response.headers.get('retry-after'),
      );
      setState(
        outcome.kind === 'profile'
          ? { status: 'signed-in', user: outcome.user }
          : outcome.kind === 'signed-out'
            ? { status: 'signed-out' }
            : { status: 'unavailable', retryAfterSeconds: outcome.retryAfterSeconds },
      );
    } catch {
      // Nothing came back at all — a network failure, or a 200 whose body would not
      // even parse as JSON. That is not a signed-in state and it is not an expired
      // session either, so there is no status to report and the seam is never told.
      // `0` is the convention both screens share for it, and it reads as
      // `unavailable`: honest, and it does not offer a login that cannot help.
      setState({ status: 'unavailable', retryAfterSeconds: null });
    }
  }, [authorizedFetch, apiBaseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * How the last attempt ended, read once and then removed from the address bar.
   *
   * Read from `window.location` rather than `useSearchParams()` on purpose. The
   * parameter has to be *taken off* the URL anyway — leaving it means F5 shows
   * "Không đăng nhập được" again to somebody who has not retried anything, a
   * message that is simply lying about the present — and `history.replaceState` is
   * how that is done without a navigation. Reading the same object the write goes
   * to keeps the two halves in one place, and avoids the Suspense boundary
   * `useSearchParams()` requires while prerendering.
   *
   * Every decision is in `nextLocationAfterOutcome`, which is a pure function of
   * the location and is tested — including the ordering, since read and rewrite
   * come back from one call and cannot be swapped here.
   */
  useEffect(() => {
    const change = nextLocationAfterOutcome(window.location);
    if (change.nextUrl === null) {
      return;
    }
    setNotice(change.notice);
    window.history.replaceState(null, '', change.nextUrl);
  }, []);

  const logout = useCallback(async () => {
    // Through the seam as well. Logging out answers 204, so it raises nothing
    // today — but a `fetch` written by hand beside one that goes through the seam
    // is how the next authenticated call in this file quietly skips it.
    await authorizedFetch(`${apiBaseUrl}/v1/auth/logout`, { method: 'POST' });
    await load();
  }, [authorizedFetch, apiBaseUrl, load]);

  return (
    <main>
      <h1>Đăng nhập</h1>

      {/*
        The notice and the login links are ONE component, because they are one
        decision: a "please wait" message above four buttons that each spend
        another attempt is the failure both halves exist to prevent, and while
        they were two props of this page either could be deleted with a full
        green run.
      */}
      <SignInPanel
        notice={notice}
        // ONE prop, not `canSignIn` plus `loading`: three of those four
        // combinations meant nothing, and the fourth state — the profile could not
        // be read, and not because nobody is signed in — could not be said at all.
        status={state.status}
        retryAfterSeconds={state.status === 'unavailable' ? state.retryAfterSeconds : null}
        apiBaseUrl={apiBaseUrl}
        // The wait is over: drop the notice so the links come back, and drop the
        // rate-limit wait so the retry button works again.
        onCountdownFinished={() => {
          setNotice(null);
          setState((current) =>
            current.status === 'unavailable'
              ? { status: 'unavailable', retryAfterSeconds: null }
              : current,
          );
        }}
        onRetry={() => void load()}
      />

      {/*
        The signed-in view is ONE component for the same reason the notice and the
        login links are: who the person is, what is still missing from their
        profile and the way out are one decision. While the outstanding step was
        not rendered at all, `/khai-ngay-sinh` was a route nothing in the product
        linked to — a screen that existed, worked and could not be reached.
      */}
      {state.status === 'signed-in' ? (
        <SignedInPanel user={state.user} onSignOut={() => void logout()} />
      ) : null}
    </main>
  );
}
