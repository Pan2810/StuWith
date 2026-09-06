import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SessionExpiryProvider } from './session-expiry-provider';
import { ThemeSwitch } from './theme-switch';
import { themeBootScript } from './theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'StuWith',
  description: 'Phòng học live, ẩn danh khi cần.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Be Vietnam Pro, self-hosted by the build.
 *
 * Chosen for its diacritics rather than its looks (`DESIGN.md § Typography`): the
 * two-mark combinations Vietnamese needs — ế, ượ, ỗ — have to stay legible at the
 * 12.5px `meta` size on an old laptop, and most popular sans faces set the marks
 * too close there. `vietnamese` in the subsets is therefore not optional: drop it
 * and every accented character falls back to the next font in the stack, which is
 * the exact quality this typeface was picked for.
 *
 * `next/font/google` is not a new dependency — it ships inside `next` — and it
 * downloads the faces AT BUILD TIME and serves them from our own origin, so a
 * visitor's browser never contacts Google. The price is that the first
 * `next build` on a machine needs network access. If that ever becomes a problem
 * the alternative is committing the `woff2` files and self-hosting them by hand,
 * and that is a human's decision rather than this file's.
 *
 * Weight 800 is listed because this design uses it densely — every heading, every
 * button, every chip — and 500 rather than 400 is the body weight, which is part of
 * the identity and also serves the context: reading in a dark room, tired eyes.
 *
 * There is deliberately no `variable:` option. It was here, naming
 * `--font-be-vietnam-pro`, and nothing anywhere read that custom property: the
 * stack comes from `--typography-base-font-family` in `tokens.css`, which is the
 * 1:1 translation of `DESIGN.md`. A configuration option nothing consumes is a
 * claim nothing keeps, and the next person would have had to work out for
 * themselves which of the two spellings the page actually uses.
 *
 * That the face genuinely LOADS is a browser fact and is asserted as one:
 * `he-thiet-ke.spec.ts` waits on `document.fonts.ready` and checks
 * `document.fonts.check("500 15px 'Be Vietnam Pro'")`.
 */
const beVietnamPro = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '800'],
  display: 'swap',
});

/**
 * The API is a separate process on a separate origin, so the base URL is
 * configured rather than assumed. `NEXT_PUBLIC_` because it is read in the
 * browser; it is an origin, not a secret.
 *
 * This is the ONE read of it in the app, and the claim is now true rather than
 * aspirational: it used to say so while `dang-nhap/page.tsx` read the variable
 * again for itself. `process.env` is inlined at build time so either place
 * "works", but two reads is two answers the moment one of them gains a fallback,
 * a trim or a normalisation the other does not. It goes down as a prop, and
 * `useApiBaseUrl()` is how a screen below asks for it.
 */
const API_BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';

/**
 * Vietnamese is the only locale this product has, and nothing here is waiting for
 * a second one.
 *
 * This docblock used to say "EN arrives with Story 1.6", as did `sign-in-links.tsx`.
 * Both were wrong: `epics.md` gives Story 1.6 the design system and says nothing
 * about internationalisation, so two files were promising work no story owned.
 * `EXPERIENCE.md:27` does call for VI + EN eventually; that promise now lives in
 * `deferred-work.md` as an unowned item, where an unfunded intention belongs.
 *
 * This stays a SERVER component. `SessionExpiryProvider` and `ThemeSwitch` carry
 * their own `'use client'`, which is what keeps the boundary at the components that
 * need a browser rather than dragging the whole layout — and every page under it —
 * into the client bundle.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /**
     * `suppressHydrationWarning` because the script below is EXPECTED to change
     * this element before React sees it.
     *
     * The server cannot know what somebody chose — the choice lives in their
     * browser — so the server always emits `<html>` with no `data-theme`, and the
     * boot script adds one a millisecond later. Without this attribute React
     * reports that mismatch as an error on every load for everybody who ever
     * picked a mode by hand. It suppresses the warning for THIS element only, not
     * for the tree beneath it.
     */
    <html lang="vi" className={beVietnamPro.className} suppressHydrationWarning>
      <head>
        {/*
          Before the first paint, or it is worse than useless.

          A theme applied from a `useEffect` renders one frame in the wrong palette
          — the white flash a dark-mode user sees on every navigation — and, since
          it changes `<html>`, React reports a hydration mismatch as well. The only
          place that runs earlier than the first paint is a blocking script in
          `<head>`, and nothing there can import a module, so the code arrives as a
          string.

          `themeBootScript()` builds that string, and `theme.test.ts` executes it
          against a fake `localStorage` and compares its answer with the pure
          function the switch uses. A string in a `<head>` that nothing runs is how
          a product ships a blank page; this one is run.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
      </head>
      <body>
        <SessionExpiryProvider apiBaseUrl={API_BASE_URL}>
          {/*
            The header is OUTSIDE the page's `<main>` and before it in document
            order, so the theme switch is reachable with two Tab presses from the
            top of any screen — `EXPERIENCE.md` puts the same rule on the room's
            control bar, for the same reason.
          */}
          <header className="page-header">
            <Link className="brand" href="/">
              Stu<span className="brand-accent">With</span>
            </Link>
            <ThemeSwitch />
          </header>
          {children}
        </SessionExpiryProvider>
      </body>
    </html>
  );
}
