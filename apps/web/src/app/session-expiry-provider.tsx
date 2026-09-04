'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SessionExpiryDialog } from './session-expiry-dialog';
import {
  authorizedCall,
  createSessionRefresher,
  nextSessionExpiry,
  type FetchLike,
  type SessionExpiryState,
} from './session-expiry';

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
 * This file holds `useState`, one read of `window.location` and the wiring between
 * them. `authorizedCall` and `nextSessionExpiry` in `session-expiry.ts` make every
 * decision — including trying `/v1/auth/refresh` before anybody is disturbed — and
 * are executed by real tests; the `web` Vitest project has no DOM, so a decision
 * left in this file would be a decision nothing can run. That division is the same
 * one `sign-in-outcome.tsx` and `page.tsx` already follow, and `AGENTS.md` names it
 * as the pattern for this project.
 *
 * ## Why a fetch wrapper rather than a "report this status" call
 *
 * Both were possible. A wrapper is harder to forget: a screen that calls
 * `authorizedFetch` is covered by construction, whereas a screen that has to
 * remember a second call after every request is a screen that eventually will not.
 * The wrapper also owns `credentials: 'include'`, which every authenticated call
 * needs and which is easy to omit — the session lives in an `httpOnly` cookie and
 * only travels on a credentialed request — and it is the only place a renewal can
 * be retried transparently, because it is the only place that still holds the
 * request to replay.
 *
 * It is deliberately NOT a monkey-patch of the global `fetch`. Every call in the
 * app would then be treated as authenticated, including ones to third parties, and
 * the seam would be invisible at the call site.
 */

export type AuthorizedFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `fetch` as the seam uses it — a wrapper, so `this` is never lost. */
const browserFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * What a screen gets from the seam: the credentialed `fetch`, and the API origin
 * every URL in this app is built on.
 *
 * The base URL travels WITH the fetch rather than beside it, because a screen that
 * reads `process.env['NEXT_PUBLIC_API_BASE_URL']` for itself is a second answer to
 * a question `layout.tsx` already answered — and `dang-nhap/page.tsx` was exactly
 * that second answer until this field existed.
 */
export interface SessionApi {
  readonly authorizedFetch: AuthorizedFetch;
  readonly apiBaseUrl: string;
}

/**
 * A plain credentialed `fetch` with no reporting and no renewal.
 *
 * Exported so a test can execute the branch a screen takes when it is rendered
 * OUTSIDE the provider. It still carries `credentials: 'include'` and still
 * resolves rather than throwing: losing the dialog is a degraded experience, while
 * a crash in a login screen because a provider was not mounted is a broken
 * product. The provider is mounted in the root layout, so this is a safety net and
 * not an expected path.
 */
export const defaultAuthorizedFetch: AuthorizedFetch = (input, init) =>
  fetch(input, { ...init, credentials: 'include' });

const SessionExpiryContext = createContext<SessionApi>({
  authorizedFetch: defaultAuthorizedFetch,
  apiBaseUrl: '',
});

/**
 * `fetch` for a call that expects a live session: credentialed, renewed once
 * before anybody is disturbed, and reported to the seam so a 401 that survives the
 * renewal raises the dialog.
 *
 * Do not use it for a call that is not authenticated. A 401 from one of those is
 * an ordinary answer, not a session ending.
 */
export function useAuthorizedFetch(): AuthorizedFetch {
  return useContext(SessionExpiryContext).authorizedFetch;
}

/** The API origin, read once at the root and handed down — never re-read. */
export function useApiBaseUrl(): string {
  return useContext(SessionExpiryContext).apiBaseUrl;
}

/**
 * The provider's markup, with no hooks in it.
 *
 * Split out so it can be rendered by `renderToStaticMarkup` at both of its two
 * states. While the dialog was rendered inline by the stateful provider, the whole
 * of "the dialog is mounted at all" was untestable in a project with no DOM:
 * deleting `<SessionExpiryDialog />` removed the feature and left every test green.
 */
export function SessionExpiryShell({
  prompt,
  apiBaseUrl,
  onDismiss,
  children,
}: {
  readonly prompt: SessionExpiryState;
  readonly apiBaseUrl: string;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      {children}
      {/*
        A SIBLING of the page, after it in document order, and not a wrapper around
        it. Nothing here covers, disables or unmounts what the person was looking
        at — that is what "the screen behind stays visible and stays scrollable"
        means in markup, before there is any styling to say it in.
      */}
      <SessionExpiryDialog prompt={prompt} apiBaseUrl={apiBaseUrl} onDismiss={onDismiss} />
    </>
  );
}

export function SessionExpiryProvider({
  children,
  apiBaseUrl,
}: {
  readonly children: ReactNode;
  readonly apiBaseUrl: string;
}) {
  const [prompt, setPrompt] = useState<SessionExpiryState>(null);

  /**
   * ONE refresher for the life of the app, in a ref rather than a `useMemo`.
   *
   * "At most one renewal in flight" is a property of the closure inside
   * `createSessionRefresher`, so two instances would be two in-flight renewals and
   * the rule would be gone. `useMemo` is explicitly allowed to throw its value
   * away and recompute; a ref is not. Lazy initialisation on first render keeps it
   * to one instance under StrictMode's double invoke, which reuses the same ref.
   */
  const refresher = useRef<(() => Promise<boolean>) | null>(null);
  if (refresher.current === null) {
    refresher.current = createSessionRefresher({ fetchImpl: browserFetch, apiBaseUrl });
  }
  const renew = refresher.current;

  const authorizedFetch = useCallback<AuthorizedFetch>(
    async (input, init) => {
      const outcome = await authorizedCall(
        {
          fetchImpl: browserFetch,
          /**
           * `window.location` is read HERE — inside the seam, after the request
           * has completed — rather than through `usePathname()` or
           * `useSearchParams()`, and rather than inside the updater below.
           *
           * The callback only ever runs in a browser, after a request, so there is
           * nothing to read during prerendering; that is what makes it safe
           * without the Suspense boundary `useSearchParams()` would require, the
           * same reasoning `page.tsx` records for its own effect. It is also the
           * only way to get the path and the search string as one consistent pair.
           *
           * Reading it inside the `setPrompt` updater was the bug: an updater must
           * be a pure function of its arguments, and React calls it twice under
           * StrictMode. `authorizedCall` hands back the location it actually used,
           * so the updater below is pure.
           */
          locationOf: () => window.location,
          renew,
        },
        input,
        init,
      );

      // The functional update matters: two authenticated calls can land in the
      // same tick, and reading `prompt` from the closure would make the second one
      // decide against a value it has already superseded.
      setPrompt((current) => nextSessionExpiry(current, outcome.status, outcome.location));
      return outcome.response;
    },
    [renew],
  );

  const dismiss = useCallback(() => setPrompt(null), []);

  // A new object every render would re-run the load effect of every screen holding
  // `authorizedFetch` in a dependency list. Both halves are already stable, so
  // this memo is what makes the VALUE stable too.
  const value = useMemo<SessionApi>(
    () => ({ authorizedFetch, apiBaseUrl }),
    [authorizedFetch, apiBaseUrl],
  );

  return (
    <SessionExpiryContext.Provider value={value}>
      <SessionExpiryShell prompt={prompt} apiBaseUrl={apiBaseUrl} onDismiss={dismiss}>
        {children}
      </SessionExpiryShell>
    </SessionExpiryContext.Provider>
  );
}
