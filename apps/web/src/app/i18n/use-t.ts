'use client';

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import type { Locale } from './locale';
import { VI_TRANSLATE, translatorFor, type Translate } from './messages';

/**
 * How the dictionary reaches a component, and why it travels this exact route.
 *
 * The locale is decided on the SERVER — from a cookie, then `Accept-Language` — and
 * almost every string in this product is rendered by a component in the CLIENT
 * graph. Only `layout.tsx` and the two `page.tsx` files are Server Components;
 * `sign-in-outcome`, `date-of-birth-form`, `session-expiry-dialog` and
 * `sign-in-links` have no `'use client'` of their own but are imported from
 * `'use client'` pages, so they are bundled for the browser. That is what rules out
 * `next/root-params` and every other server-only primitive: they do not run there.
 *
 * So the dictionary goes down the road `apiBaseUrl` already goes: read once at the
 * root, handed down as a prop, put in a context, read through a hook. There is one
 * answer per request and no module-level global for a second render to disagree
 * with.
 *
 * ## What crosses the boundary is the LOCALE, not the catalogue, and that was measured
 *
 * The first version passed `messages` as a prop as well. It works, and it costs more
 * than it looks: a prop from a Server Component to a client one is SERIALISED into
 * the RSC payload, so every page shipped the whole Vietnamese catalogue inside its
 * own HTML — on top of the copy already in the JS bundle, which is there either way
 * because the context default below imports it. It also turned an existing browser
 * assertion red: `he-thiet-ke.spec.ts` checks that the served HTML carries no theme
 * announcement before hydration, and the serialised catalogue contains that exact
 * sentence as a value.
 *
 * The locale is one of two string literals and selects the catalogue completely, so
 * nothing is lost by sending it instead. `<html lang>` upstairs and the sentences
 * down here still come from the same single resolution.
 *
 * ## The default value is not a placeholder
 *
 * `createContext(VI_TRANSLATE)` is what makes "no locale ever falls back to a raw
 * key on the screen" a property of the wiring. A component rendered outside the
 * provider still produces real Vietnamese — which covers the `web` Vitest project,
 * where `renderToStaticMarkup` renders panels with no provider above them, and the
 * safety net `defaultAuthorizedFetch` provides for the other context on this route.
 *
 * ## No JSX here, on purpose
 *
 * This is a `.ts` file rather than `.tsx` so it sits beside the rest of `i18n/`
 * without the directory needing two extensions for four modules. `createElement` is
 * what JSX compiles to anyway, and there is exactly one element to create.
 */

const I18nContext = createContext<Translate>(VI_TRANSLATE);

/**
 * The translator for the current request.
 *
 * Use it for every string a person reads. Do not use it for a wire value, a DOM id,
 * a query parameter or a class name — those are data that happen to be spelled with
 * letters, and `tests/gates/i18n-catalogue.test.ts` records which is which.
 */
export function useT(): Translate {
  return useContext(I18nContext);
}

/**
 * Mounted once, in the root layout, above everything.
 *
 * The client DECIDES nothing here: `locale` is the server's answer arriving as a
 * prop, and this component only turns it into a translator. The mismatch that shape
 * makes impossible is a document that says `lang="en"` while its text is Vietnamese
 * — both come from the one value the layout resolved.
 */
export function I18nProvider({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}): ReactNode {
  // A new translator every render would change the context value every render, and
  // every consumer below would re-render with it. The locale is stable per request,
  // so the memo is what makes the VALUE stable too — the same reasoning
  // `SessionExpiryProvider` records for its own `useMemo`.
  const value = useMemo(() => translatorFor(locale), [locale]);

  return createElement(I18nContext.Provider, { value }, children);
}
