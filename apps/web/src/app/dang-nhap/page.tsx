'use client';

import { AUTH_PROVIDERS, type CurrentUser, type SignInOutcome } from '@stuwith/contracts';
import { useCallback, useEffect, useState } from 'react';
import { SignInOutcomeNotice, nextLocationAfterOutcome } from './sign-in-outcome';

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
 */

/**
 * The API is a separate process on a separate origin, so the base URL has to be
 * configured rather than assumed. `NEXT_PUBLIC_` because it is read in the browser;
 * it is an origin, not a secret.
 */
const API_BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';

/** Vietnamese is the default locale; full i18n arrives with Story 1.6. */
const PROVIDER_LABELS: Record<(typeof AUTH_PROVIDERS)[number], string> = {
  google: 'Google',
  facebook: 'Facebook',
  apple: 'Apple',
  microsoft: 'Microsoft',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: CurrentUser };

export default function DangNhapPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [outcome, setOutcome] = useState<SignInOutcome | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/v1/auth/me`, {
        // The session lives in an httpOnly cookie, so it only travels if the
        // request is explicitly credentialed.
        credentials: 'include',
      });
      if (!response.ok) {
        setState({ status: 'signed-out' });
        return;
      }
      setState({ status: 'signed-in', user: (await response.json()) as CurrentUser });
    } catch {
      // A network failure is not a signed-in state. Telling the person about a
      // session that dropped mid-visit — the dialog, and returning them to where
      // they were — was split out of Story 1.3 and is in `deferred-work.md`; the
      // outcome banner above is only about the attempt they just made.
      setState({ status: 'signed-out' });
    }
  }, []);

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
   * come back from one call and cannot be swapped here. What is left in this
   * effect is only the two things that need a browser.
   */
  useEffect(() => {
    const { outcome: resolved, nextUrl } = nextLocationAfterOutcome(window.location);
    if (nextUrl === null) {
      return;
    }
    setOutcome(resolved);
    window.history.replaceState(null, '', nextUrl);
  }, []);

  const logout = useCallback(async () => {
    await fetch(`${API_BASE_URL}/v1/auth/logout`, { method: 'POST', credentials: 'include' });
    await load();
  }, [load]);

  return (
    <main>
      <h1>Đăng nhập</h1>

      {/*
        `canSignIn` is why this can sit above everything: the notice hides itself
        for a visitor who is already signed in, rather than telling them to
        "chọn lại cách đăng nhập bên dưới" over a view with no login buttons in
        it. While the session check is still in flight the answer is not known
        yet, so nothing is claimed.

        Known limit, left for 1.6 rather than papered over: the element only
        EXISTS once the outcome is read, and a live region that appears at the
        same moment as its content is announced unreliably. It reads correctly
        in document order, which is the case that matters on a fresh load; the
        fix is a region that is always mounted, and that belongs with the layout
        work rather than in a bare skeleton.
      */}
      <SignInOutcomeNotice outcome={outcome} canSignIn={state.status === 'signed-out'} />

      {state.status === 'loading' ? <p>Đang kiểm tra phiên…</p> : null}

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

      {state.status === 'signed-out' ? (
        <nav>
          <p>Chọn tài khoản mạng xã hội để tiếp tục:</p>
          <ul>
            {AUTH_PROVIDERS.map((provider) => (
              <li key={provider}>
                {/*
                  A plain anchor, not a fetch. The OAuth flow is a top-level
                  browser navigation: it has to leave this origin, come back, and
                  carry the SameSite=Lax state cookie on the way in. An XHR cannot
                  do any of that.
                */}
                <a href={`${API_BASE_URL}/v1/auth/${provider}/start`}>
                  Tiếp tục với {PROVIDER_LABELS[provider]}
                </a>
              </li>
            ))}
          </ul>
          <p>
            Provider chưa được bật trên máy chủ này sẽ trả về &ldquo;không tìm
            thấy&rdquo;.
          </p>
        </nav>
      ) : null}
    </main>
  );
}
