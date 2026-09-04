'use client';

import type { CurrentUser } from '@stuwith/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useAuthorizedFetch } from '../session-expiry-provider';
import {
  SignInPanel,
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

/**
 * The API is a separate process on a separate origin, so the base URL has to be
 * configured rather than assumed. `NEXT_PUBLIC_` because it is read in the browser;
 * it is an origin, not a secret.
 */
const API_BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';

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
   * cookie and only travels on a credentialed request — and it reports the status
   * so a 401 anywhere in the app raises the session-expiry dialog. Here that
   * dialog is deliberately suppressed: `nextSessionExpiry` never opens it on
   * `/dang-nhap`, because a 401 from `/v1/auth/me` on this page is the ordinary
   * signed-out answer rather than a session that just died.
   */
  const authorizedFetch = useAuthorizedFetch();

  const load = useCallback(async () => {
    try {
      const response = await authorizedFetch(`${API_BASE_URL}/v1/auth/me`);
      if (response.status !== 200) {
        /**
         * A 429 here is not "signed out", and treating it as one was the bug.
         *
         * `!response.ok` covered both, so a rate-limited visitor got an ordinary
         * login page with four links and no explanation — and the first click
         * spent an `auth_start` and bounced them back with a longer wait. The
         * decision lives in `signInNoticeFromMe` so a test can execute it.
         */
        const limited = signInNoticeFromMe(response.status, response.headers.get('retry-after'));
        if (limited !== null) {
          setNotice(limited);
        }
        setState({ status: 'signed-out' });
        return;
      }
      setState({ status: 'signed-in', user: (await response.json()) as CurrentUser });
    } catch {
      // A network failure is not a signed-in state, and it is not an expired
      // session either: nothing came back, so there is no status to report and the
      // seam is never told. The outcome banner is only about the attempt the
      // person just made.
      setState({ status: 'signed-out' });
    }
  }, [authorizedFetch]);

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
    await authorizedFetch(`${API_BASE_URL}/v1/auth/logout`, { method: 'POST' });
    await load();
  }, [authorizedFetch, load]);

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
        apiBaseUrl={API_BASE_URL}
        // The wait is over: drop the notice so the links come back.
        onCountdownFinished={() => setNotice(null)}
      />

      {state.status === 'signed-in' ? (
        <section>
          <p>
            Đang đăng nhập: <strong>{state.user.display_name}</strong> (vai trò:{' '}
            {state.user.role})
          </p>
          <button type="button" onClick={() => void logout()}>
            Đăng xuất
          </button>
        </section>
      ) : null}
    </main>
  );
}
