'use client';

import { parseCurrentUser, type CurrentUser } from '@stuwith/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useApiBaseUrl, useAuthorizedFetch } from '../session-expiry-provider';
import {
  SignInPanel,
  SignedInPanel,
  nextLocationAfterOutcome,
  signInNoticeFromMe,
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
  | { status: 'signed-in'; user: CurrentUser };

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
      const response = await authorizedFetch(`${apiBaseUrl}/v1/auth/me`);
      if (response.status !== 200) {
        /**
         * A 429 here is not "signed out", and treating it as one was the bug.
         *
         * `!response.ok` covered both, so a rate-limited visitor got an ordinary
         * login page with four links and no explanation — and the first click
         * spent an `auth_start` and bounced them back with a longer wait. The
         * decision lives in `signInNoticeFromMe` so a test can execute it.
         *
         * `status !== 200` rather than `!response.ok`, and the difference is not
         * cosmetic: `ok` is true for the whole 2xx range, and the only shape this
         * page can render is the `CurrentUser` body a 200 carries. A 204 or a 206
         * would be parsed as JSON and throw. The signed-in branch takes exactly
         * the one status that means "here is the profile".
         */
        const limited = signInNoticeFromMe(response.status, response.headers.get('retry-after'));
        if (limited !== null) {
          setNotice(limited);
        }
        setState({ status: 'signed-out' });
        return;
      }
      // Parsed, never cast. `as CurrentUser` is a claim about a body this process
      // did not write, and the whole reason `toCurrentUser` parses on the way out
      // is that a shape nobody checks is a shape that drifts. A 200 carrying
      // something else is not a session this page can render, so it takes the same
      // branch as no session at all — which is what the `catch` below already did
      // for a body that would not even parse as JSON.
      const user = parseCurrentUser(await response.json());
      setState(user === null ? { status: 'signed-out' } : { status: 'signed-in', user });
    } catch {
      // A network failure is not a signed-in state, and it is not an expired
      // session either: nothing came back, so there is no status to report and the
      // seam is never told. The outcome banner is only about the attempt the
      // person just made.
      setState({ status: 'signed-out' });
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
        canSignIn={state.status === 'signed-out'}
        loading={state.status === 'loading'}
        apiBaseUrl={apiBaseUrl}
        // The wait is over: drop the notice so the links come back.
        onCountdownFinished={() => setNotice(null)}
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
