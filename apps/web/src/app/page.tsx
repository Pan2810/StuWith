import Link from 'next/link';
import { CONTRACT_VERSION, CREATE_ROOM_PATHNAME, SIGN_IN_PATHNAME } from '@stuwith/contracts';
import { translatorFor } from './i18n/messages';
import { requestLocale } from './i18n/server-locale';

/**
 * Still a small page, and still Story 1.1's proof — that the TS 7.0.2 branch builds
 * a real Next.js 16.3 app in the same repo as the tsc6 branch, and that apps/web
 * can resolve packages/contracts (and nothing else).
 *
 * What changed with Story 1.6 is that it is no longer BARE: the "Cắm trại" tokens,
 * the typography and the two component classes now reach it, and nothing here
 * carries a colour, a size or a spacing of its own. Every visual decision on this
 * screen is a class defined in `globals.css` against a token from `tokens.css`,
 * which is what keeps the design system a system rather than a first example.
 *
 * ## Why this one asks for the locale itself
 *
 * It is a Server Component, so `useT()` — a client hook — is not available to it,
 * and a layout cannot hand props to a page. `requestLocale()` is therefore called
 * here as well as in `layout.tsx`, which calls it twice itself (`generateMetadata`
 * and `RootLayout`) — three call sites, ONE function, so there is one fallback and
 * one precedence rather than three readings of a request. Next deduplicates
 * `cookies()` and `headers()` within a request, so all three see the same two
 * objects and cannot disagree about the answer. The rule `API_BASE_URL` records —
 * one read, handed down — is kept here in the only form a page can keep it.
 *
 * The alternative was making this page a client component so it could use the hook,
 * which is a whole route in the browser bundle to render three lines of static
 * text.
 */
export default async function Page() {
  const t = translatorFor(await requestLocale());

  return (
    <main className="page-shell">
      {/*
        The product's name, not a translated string, and `lang="en"` for the same
        reason the header's brand carries it: it is an English word pair inside a
        document that may declare itself Vietnamese.
      */}
      <h1 lang="en">StuWith</h1>
      <div className="card">
        <p>{t('home.frameReady')}</p>
        {/* `numeric` for the version: tabular figures, per DESIGN.md's hard rule
            about every number that can change. */}
        <p className="meta numeric">{t('home.contractVersion', { version: CONTRACT_VERSION })}</p>
        {/*
          The CONSTANT, not the literal it used to be. `routes.test.ts` proves that
          every `*_PATHNAME` names a directory that exists — and a literal written
          out here is exactly the spelling that check cannot see, so renaming the
          route would have left the home page's only link pointing at a 404 with
          every gate green. The reverse rule in that file now refuses the literal.
        */}
        <Link className="button-primary" href={SIGN_IN_PATHNAME}>
          {t('home.signIn')}
        </Link>
        {/*
          The way IN to Story 2.1's screen, and the reason it is here rather than
          only in a menu somebody will build later: `routes.test.ts` rule B refuses a
          `*_PATHNAME` that no product module outside its own route directory names,
          because a page nothing links to is a page nobody can reach — the state
          Story 1.4 nearly shipped in, where the screen existed, rendered, had its
          own tests, and could only be visited by typing the URL.

          A `secondary` button beside the primary one: signing in is still what a
          first-time visitor needs, and the create-room screen tells a signed-out
          person so rather than refusing them silently.
        */}
        <Link className="button-secondary" href={CREATE_ROOM_PATHNAME}>
          {t('createRoom.link')}
        </Link>
      </div>
    </main>
  );
}
