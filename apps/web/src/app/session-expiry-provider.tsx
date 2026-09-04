'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SessionExpiryDialog } from './session-expiry-dialog';
import { nextSessionExpiry, type SessionExpiryState } from './session-expiry';

/**
 * The seam: one place in `apps/web` that knows an authenticated call just came
 * back with a 401, and therefore one place a dialog can be raised from.
 *
 * Before this existed there was nowhere for that fact to live. `layout.tsx` had no
 * provider of any kind and the whole app contained two hand-written `fetch` calls,
 * so "the session died" was a condition each screen would have had to notice for
 * itself — which is the same as saying no screen would.
 *
 * ## Everything that decides anything is somewhere else
 *
 * This file holds `useState`, one read of `window.location` and a `fetch`
 * wrapper. `nextSessionExpiry` in `session-expiry.ts` makes every decision and is
 * executed by real tests; the `web` Vitest project has no DOM, so a decision left
 * in this file would be a decision nothing can run. That division is the same one
 * `sign-in-outcome.tsx` and `page.tsx` already follow, and `AGENTS.md` names it as
 * the pattern for this project.
 *
 * ## Why a fetch wrapper rather than a "report this status" call
 *
 * Both were possible. A wrapper is harder to forget: a screen that calls
 * `authorizedFetch` is covered by construction, whereas a screen that has to
 * remember a second call after every request is a screen that eventually will
 * not. The wrapper also owns `credentials: 'include'`, which every authenticated
 * call needs and which is easy to omit — the session lives in an `httpOnly`
 * cookie and only travels on a credentialed request.
 *
 * It is deliberately NOT a monkey-patch of the global `fetch`. Every call in the
 * app would then be treated as authenticated, including ones to third parties,
 * and the seam would be invisible at the call site.
 */

export type AuthorizedFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The default is a plain credentialed `fetch` with no reporting.
 *
 * A component rendered outside the provider still works rather than throwing —
 * losing the dialog is a degraded experience, while a crash in a login screen
 * because a provider was not mounted is a broken product. The provider is mounted
 * in the root layout, so this default is a safety net and not an expected path.
 */
const SessionExpiryContext = createContext<AuthorizedFetch>((input, init) =>
  fetch(input, { ...init, credentials: 'include' }),
);

/**
 * `fetch` for a call that expects a live session: credentialed, and reported to
 * the seam so a 401 raises the dialog.
 *
 * Do not use it for a call that is not authenticated. A 401 from one of those is
 * an ordinary answer, not a session ending.
 */
export function useAuthorizedFetch(): AuthorizedFetch {
  return useContext(SessionExpiryContext);
}

export function SessionExpiryProvider({
  children,
  apiBaseUrl,
}: {
  readonly children: ReactNode;
  readonly apiBaseUrl: string;
}) {
  const [prompt, setPrompt] = useState<SessionExpiryState>(null);

  const authorizedFetch = useCallback<AuthorizedFetch>(async (input, init) => {
    const response = await fetch(input, { ...init, credentials: 'include' });
    /**
     * `window.location` is read HERE, inside the callback, rather than through
     * `usePathname()` or `useSearchParams()`.
     *
     * The callback only ever runs in a browser, after a request has completed, so
     * there is nothing to read during prerendering — which is what makes this
     * safe without the Suspense boundary `useSearchParams()` would require, the
     * same reasoning `page.tsx` records for its own effect. It is also the only
     * way to get the search string and the path as one consistent pair.
     *
     * The functional update matters: two authenticated calls can land in the same
     * tick, and reading `prompt` from the closure would make the second one
     * decide against a value it has already superseded.
     */
    setPrompt((current) => nextSessionExpiry(current, response.status, window.location));
    return response;
  }, []);

  const dismiss = useCallback(() => setPrompt(null), []);

  // Stable identity, so a page holding `authorizedFetch` in a `useCallback`
  // dependency list does not re-run its load on every render of this provider.
  const value = useMemo(() => authorizedFetch, [authorizedFetch]);

  return (
    <SessionExpiryContext.Provider value={value}>
      {children}
      {/*
        A SIBLING of the page, after it in document order, and not a wrapper
        around it. Nothing here covers, disables or unmounts what the person was
        looking at — that is what "the screen behind stays visible and stays
        scrollable" means in markup, before there is any styling to say it in.
      */}
      <SessionExpiryDialog prompt={prompt} apiBaseUrl={apiBaseUrl} onDismiss={dismiss} />
    </SessionExpiryContext.Provider>
  );
}
