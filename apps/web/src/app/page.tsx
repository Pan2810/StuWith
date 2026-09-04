import Link from 'next/link';
import { CONTRACT_VERSION, SIGN_IN_PATHNAME } from '@stuwith/contracts';

/**
 * Deliberately bare. Story 1.1 only has to prove that the TS 7.0.2 branch builds a
 * real Next.js 16.3 app in the same repo as the tsc6 branch, and that apps/web can
 * resolve packages/contracts (and nothing else).
 * The design system lands in Story 1.6.
 */
export default function Page() {
  return (
    <main>
      <h1>StuWith</h1>
      <p>Khung dự án đã dựng. Hợp đồng API: {CONTRACT_VERSION}.</p>
      <p>
        {/*
          The CONSTANT, not the literal it used to be. `routes.test.ts` proves that
          every `*_PATHNAME` names a directory that exists — and a literal written
          out here is exactly the spelling that check cannot see, so renaming the
          route would have left the home page's only link pointing at a 404 with
          every gate green. The reverse rule in that file now refuses the literal.
        */}
        <Link href={SIGN_IN_PATHNAME}>Đăng nhập</Link>
      </p>
    </main>
  );
}
