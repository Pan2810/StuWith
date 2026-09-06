import Link from 'next/link';
import { CONTRACT_VERSION, SIGN_IN_PATHNAME } from '@stuwith/contracts';

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
 */
export default function Page() {
  return (
    <main className="page-shell">
      <h1>StuWith</h1>
      <div className="card">
        <p>Khung dự án đã dựng.</p>
        {/* `numeric` for the version: tabular figures, per DESIGN.md's hard rule
            about every number that can change. */}
        <p className="meta numeric">Hợp đồng API: {CONTRACT_VERSION}.</p>
        {/*
          The CONSTANT, not the literal it used to be. `routes.test.ts` proves that
          every `*_PATHNAME` names a directory that exists — and a literal written
          out here is exactly the spelling that check cannot see, so renaming the
          route would have left the home page's only link pointing at a 404 with
          every gate green. The reverse rule in that file now refuses the literal.
        */}
        <Link className="button-primary" href={SIGN_IN_PATHNAME}>
          Đăng nhập
        </Link>
      </div>
    </main>
  );
}
