import { AUTH_PROVIDERS } from '@stuwith/contracts';
import { signInStartHref } from './session-expiry';

/**
 * The four ways back in, as one list, rendered by the two screens that offer them.
 *
 * It exists because both of them used to render their own copy of the same
 * `<li><a href={signInStartHref(...)}>Tiếp tục với …</a></li>` block, and the
 * duplication was the thing exporting `PROVIDER_LABELS` was supposed to prevent.
 * Two copies of a login link is how one of them keeps a parameter the other drops.
 *
 * It also fixes a bundling problem that had nothing to do with tidiness. The
 * session-expiry dialog is mounted in `layout.tsx`, so it is in the client tree of
 * EVERY route; it used to import `PROVIDER_LABELS` from `dang-nhap/sign-in-outcome`,
 * which imports `./countdown` — a `'use client'` module with a timer in it — so
 * `SignInPanel`, `OUTCOME_NOTICES` and `SignInCountdown` were pulled into every
 * page of the product to render four anchors. This module imports nothing but the
 * provider list and the href builder.
 *
 * No `'use client'`, no state, no effect, no `window`: it renders under
 * `renderToStaticMarkup` in the `web` Vitest project, which has no DOM.
 */

/**
 * Vietnamese, because Vietnamese is the only locale this product has.
 *
 * This used to say "full i18n arrives with Story 1.6", and so did `layout.tsx`.
 * Neither was true: `epics.md` gives Story 1.6 the design system and says nothing
 * about internationalisation, so two files were promising work no story owned —
 * the shape that turns into "somebody must have done it" three stories later.
 * `EXPERIENCE.md:27` does want VI + EN eventually; that intention now sits in
 * `deferred-work.md` with no owner, which is what an unfunded intention is.
 *
 * One table, because the two screens must not be able to say different things
 * about the same provider.
 */
export const PROVIDER_LABELS: Record<(typeof AUTH_PROVIDERS)[number], string> = {
  google: 'Google',
  facebook: 'Facebook',
  apple: 'Apple',
  microsoft: 'Microsoft',
};

export function SignInProviderLinks({
  apiBaseUrl,
  returnPath,
}: {
  readonly apiBaseUrl: string;
  /**
   * Where to come back to after a successful sign-in, or `null` for the default.
   *
   * REQUIRED even though `null` is a legal value. An optional prop defaulting to
   * `null` is one a careless edit drops while everything still typechecks, and the
   * failure that produces — the session-expiry dialog silently losing the place
   * the person was standing — is exactly what this story exists to prevent.
   */
  readonly returnPath: string | null;
}) {
  return (
    /*
      `provider-list` rather than a bare `<ul>`: the list markers and the default
      padding are the browser's, not this design's, and the four links are stacked
      full-width buttons — a shape a Vietnamese label ("Tiếp tục với Microsoft") has
      to fit without being cut, since Vietnamese runs 15-25% longer than English.
    */
    <ul className="provider-list">
      {AUTH_PROVIDERS.map((provider) => (
        <li key={provider}>
          {/*
            A plain anchor, not a `fetch`. The OAuth flow is a top-level browser
            navigation: it has to leave this origin, come back, and carry the
            `SameSite=Lax` state cookie on the way in. An XHR can do none of that.

            The return path rides on the href, which is the only leg allowed to
            carry it: `apps/api` judges the proposal once at `/start` and signs the
            verdict into the OAuth state. Nothing on the way back reads a path out
            of a URL.
          */}
          <a
            className="button-secondary"
            href={signInStartHref(apiBaseUrl, provider, returnPath)}
          >
            Tiếp tục với {PROVIDER_LABELS[provider]}
          </a>
        </li>
      ))}
    </ul>
  );
}
