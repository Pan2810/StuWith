import { CONTRACT_VERSION } from '@stuwith/contracts';

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
    </main>
  );
}
