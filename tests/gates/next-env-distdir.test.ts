import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEXT_DIST_DIR,
  NEXT_ENV_RELATIVE_PATH,
  nextEnvDistDirs,
  normaliseNextEnv,
} from '../e2e/support/next-env';

/**
 * `apps/web/next-env.d.ts` must name `./.next/`, never `.next-e2e`.
 *
 * ## The mechanism, measured rather than guessed
 *
 * `next build` REGENERATES this file from `distDir`, and the E2E suite builds
 * `apps/web` with `NEXT_DIST_DIR=.next-e2e` because `NEXT_PUBLIC_API_BASE_URL` is
 * inlined at build time and the E2E run points the app at a fake API. So every
 * `pnpm test:e2e` rewrites a TRACKED file to
 * `import "./.next-e2e/types/routes.d.ts"`, and leaves it that way. The file even
 * says "This file should not be edited", which is exactly why nobody looks at it
 * in a diff before committing.
 *
 * ## Why it is not already a build failure, and why that is the alarming part
 *
 * It was measured: with the E2E spelling in place, `pnpm typecheck` and
 * `next build` BOTH still exit 0. The reason is `tsconfig.base.json`'s
 * `skipLibCheck: true` — turn that off and the same import is `TS2882`, because
 * `.next-e2e/types/routes.d.ts` does not exist after an ordinary build.
 *
 * So the tolerance is incidental. One config flag, set for an unrelated reason,
 * is all that stands between "harmless churn" and "the repository does not
 * typecheck on a clean checkout". A gate is cheaper than remembering that.
 *
 * ## This gate is a BACKSTOP, not the fix, and that distinction was learned
 *
 * The first version of this file was the whole answer, and it was worse than the
 * problem: `pnpm test:e2e` rewrote the file and this gate then failed all three
 * examples on the very next `pnpm test`. A broken local loop, caused by one suite
 * and paid for by another, on a sequence nobody would call exotic. A gate that is
 * only green when somebody remembers to tidy up first is not a gate.
 *
 * The fix is `tests/e2e/global-teardown.ts`, which normalises the file back as
 * part of the suite that rewrote it. What is left for this gate is the case the
 * teardown cannot cover — a run killed before it, `Ctrl+C` at the wrong moment —
 * where the accidental COMMIT is the failure that costs somebody an afternoon.
 *
 * If this fails, the file is dirty: re-run `pnpm test:e2e` and let its teardown
 * put it back, or edit the three `import "./…"` specifiers to name `./.next/`.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
// The SAME path and the SAME default the teardown writes, imported rather than
// spelled again — two copies of "where the file is" is two things to keep in step.
const NEXT_ENV = path.join(REPO_ROOT, NEXT_ENV_RELATIVE_PATH);

describe('apps/web/next-env.d.ts is the committed, non-E2E form', () => {
  const source = readFileSync(NEXT_ENV, 'utf8');

  it('names the default dist directory', () => {
    // The positive half. Without it this gate would pass against an empty file,
    // or against one whose imports had simply been deleted.
    expect(source).toContain(`./${DEFAULT_NEXT_DIST_DIR}/types/routes.d.ts`);
    expect(source).toContain(`./${DEFAULT_NEXT_DIST_DIR}/types/root-params.d.ts`);
  });

  it('does not name the E2E dist directory', () => {
    // The state `pnpm test:e2e` leaves behind. `.next-e2e` is spelled out rather
    // than matched loosely so the failure message says what to do.
    expect(source).not.toContain('.next-e2e');
  });

  it('names no dist directory other than the two forms above', () => {
    /**
     * The general rule rather than the one example.
     *
     * `NEXT_DIST_DIR` is an environment variable, so a future run could leave
     * `.next-storybook`, `.next-ci` or anything else behind, and a gate that only
     * knew about `.next-e2e` would pass on every one of them — the "patch the
     * example rather than the class" failure this repository has paid for before.
     */
    const imported = nextEnvDistDirs(source);
    expect(imported.length).toBeGreaterThan(0);
    expect([...new Set(imported)]).toEqual([DEFAULT_NEXT_DIST_DIR]);
  });

  it('is exactly what the teardown would write, so the two cannot drift', () => {
    /**
     * The gate and the teardown agree by CONSTRUCTION rather than by both being
     * edited: if `normaliseNextEnv` stopped recognising the shape Next writes, the
     * teardown would silently stop putting the file back and this example — not a
     * developer's next unit-test run — is what says so.
     */
    expect(normaliseNextEnv(source)).toBe(source);
  });
});
