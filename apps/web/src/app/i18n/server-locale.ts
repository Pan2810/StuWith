import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE_NAME, resolveLocale, type Locale } from './locale';

/**
 * The locale for the request being rendered, read from the request itself.
 *
 * ## One function, THREE callers, and why that is not "reading it three times"
 *
 * `layout.tsx` calls it twice — once in `generateMetadata` for the `<meta
 * name="description">` and once in `RootLayout` for `<html lang>` and the
 * dictionary — and the home `page.tsx` calls it a third time, because a Server
 * Component cannot receive props from a layout and cannot use the client hook
 * either. `API_BASE_URL` solved the same problem by having ONE read and passing the
 * value down, and the docblock in `layout.tsx` explains why: two reads is two
 * answers the moment one of them gains a fallback the other does not.
 *
 * The metadata call is the one with the least visible failure mode, and it is worth
 * naming: it describes the DOCUMENT rather than drawing any of it, so a description
 * in the wrong language sits in the `<head>` where nobody reading the page can see
 * it — it reaches a search result, a link preview and a screen reader's document
 * summary instead. `ngon-ngu.spec.ts` reads that meta tag for exactly that reason.
 *
 * The same rule is kept here in the only form available — one FUNCTION, so there is
 * one fallback, one cookie name and one precedence. Next.js deduplicates `cookies()`
 * and `headers()` within a request, so both callers are reading the same two objects
 * and cannot disagree.
 *
 * ## What reading a request costs
 *
 * Calling this makes the route dynamic: a page whose HTML depends on a header cannot
 * be prerendered at build time, and Next will not try. That is the price of
 * answering in the language the browser asked for on the FIRST paint, and the
 * alternative — deciding in a `useEffect` — is the one the spec forbids outright. A
 * `<html lang>` corrected after hydration is a document that was wrong for every
 * assistive technology that read it, and a page that flashes the other language.
 */
export async function requestLocale(): Promise<Locale> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  return resolveLocale(
    cookieStore.get(LOCALE_COOKIE_NAME)?.value ?? null,
    headerList.get('accept-language'),
  );
}
