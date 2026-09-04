import path from 'node:path';
import type { NextConfig } from 'next';

/** The pnpm workspace root — `next` itself lives in the root virtual store. */
const workspaceRoot = path.resolve(__dirname, '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Typed, checked builds. `ignoreBuildErrors` must stay false: apps/web is the one
  // place the TS 7.0.2 branch of the dual-TypeScript policy is exercised end to end,
  // and silencing it would make that half of the policy unverifiable.
  typescript: { ignoreBuildErrors: false },
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  /**
   * Normally `.next`; overridden only by the E2E suite.
   *
   * `NEXT_PUBLIC_API_BASE_URL` is inlined into the browser bundle at BUILD time, so
   * an E2E run that points the app at its fake API has to build its own copy —
   * restarting with a different value changes nothing. Without a separate directory
   * that build would overwrite the one a developer is running, and the overwrite is
   * invisible until a page starts calling a port that is not there.
   *
   * ## It has a side effect on a TRACKED file, and the reason it is survivable is
   * ## not the reason you would guess
   *
   * `next build` REGENERATES `apps/web/next-env.d.ts` from this value, so every
   * `pnpm test:e2e` rewrites that file to `import "./.next-e2e/types/routes.d.ts"`
   * and leaves it dirty in `git status`. The file's own header says it should not
   * be edited, which is precisely why it gets committed by accident.
   *
   * Measured, not assumed: with the E2E spelling in place `pnpm typecheck` and
   * `next build` both still exit 0 — but only because `tsconfig.base.json` sets
   * `skipLibCheck: true`. Turn that flag off and the same import is `TS2882`,
   * because `.next-e2e/types/routes.d.ts` does not exist after an ordinary build.
   * The tolerance is therefore incidental, and one unrelated config change from
   * becoming a repository that does not typecheck on a clean checkout.
   *
   * `tests/gates/next-env-distdir.test.ts` fails CI if that file is ever committed
   * naming anything but `./.next/`. After running the E2E suite, restore it with
   * `git checkout -- apps/web/next-env.d.ts`.
   */
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',
};

export default nextConfig;
