/**
 * `next/font/google`, for the `web` Vitest project only.
 *
 * ## The measurement this file exists because of
 *
 * `node_modules/next/font/google/index.js` is **zero bytes**. That is not a
 * packaging accident: `next/font` is a compile-time API, and the real
 * implementation is injected by the Next.js SWC transform when it sees the import.
 * Anything that loads `apps/web/src/app/layout.tsx` OUTSIDE a Next build therefore
 * gets `Be_Vietnam_Pro === undefined`, and calling it fails at module scope with
 * `TypeError: Be_Vietnam_Pro is not a function` — which takes `layout.test.tsx`
 * down before a single example runs.
 *
 * ## Why the alias, rather than moving the font out of the layout
 *
 * The other two options were both worse. Removing the font would delete the reason
 * `DESIGN.md § Typography` names this typeface — Vietnamese diacritics at 12.5px on
 * an old laptop — over a limitation of the test runner. Moving the call into a
 * module the layout imports lazily would hide the same failure behind one more
 * indirection and change what ships. The font stays where it belongs, and the test
 * runner is told what that import means when there is no compiler to answer it.
 *
 * ## What it deliberately does NOT do
 *
 * It does not pretend to load a font, and it returns a class name that is
 * obviously a stand-in rather than a plausible hashed one. No test asserts on the
 * value, and that is deliberate: a stub producing convincing output would invite an
 * assertion that proves nothing.
 *
 * The font is checked where a font can be checked. `pnpm --filter web build` proves
 * it compiles and downloads, and `tests/e2e/web/he-thiet-ke.spec.ts` waits on
 * `document.fonts.ready` in a real Chromium and asserts
 * `document.fonts.check("500 15px 'Be Vietnam Pro'")` for the two weights this
 * design depends on. That case was added because this comment and the one in
 * `vitest.config.mts` both claimed the browser suite proved the font while it did
 * not — a comment promising a test that does not exist is worse than no comment.
 *
 * A second typeface needs a second export here. That is on purpose: a `Proxy` that
 * answered every name would make an import of a font that does not exist look like
 * it worked, and the failure would surface as a missing `@font-face` in production.
 */

export interface StubFont {
  readonly className: string;
  readonly style: { readonly fontFamily: string };
}

export function Be_Vietnam_Pro(): StubFont {
  return { className: 'stub-font', style: { fontFamily: 'stub-font' } };
}
