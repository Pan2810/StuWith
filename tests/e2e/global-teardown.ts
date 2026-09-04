import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  NEXT_ENV_RELATIVE_PATH,
  nextEnvDistDirs,
  normaliseNextEnv,
  DEFAULT_NEXT_DIST_DIR,
} from './support/next-env';

/**
 * Put `apps/web/next-env.d.ts` back before this suite hands the machine over.
 *
 * ## The failure this exists to stop, which was real and was mine
 *
 * The `web` webServer runs `next build` with `NEXT_DIST_DIR=.next-e2e`, and Next
 * REGENERATES that tracked file from `distDir`. So every `pnpm test:e2e` left it
 * saying `import "./.next-e2e/types/routes.d.ts"`.
 *
 * A gate was added asserting the committed form — and that turned a cosmetic dirty
 * file into a BROKEN LOCAL LOOP: `pnpm test:e2e` followed by `pnpm test` failed
 * three examples, every time, on a clean checkout. That is not an exotic sequence,
 * and the failure had nothing to do with what either suite was testing. Asserting
 * about a value while leaving the thing that rewrites it in place is the mistake;
 * the gate was fine.
 *
 * ## Why here, and why not `git checkout --`
 *
 * It belongs to the suite that caused the change, it runs in Node so it is
 * cross-platform, and it needs no shell. Shelling out to git would fail in a
 * checkout where git is unavailable — a container, a CI image built from a
 * tarball — and would restore whatever the INDEX holds rather than a correct file,
 * which is a different thing on a branch that is mid-edit.
 *
 * It writes the normalised file rather than a captured copy; `normaliseNextEnv`
 * explains that choice and its cost. `tests/gates/next-env-distdir.test.ts` remains
 * the backstop for the case this cannot cover: a run killed before teardown.
 */
export default function globalTeardown(): void {
  // Playwright runs from the repository root — every `webServer.command` in
  // `playwright.config.ts` is written relative to it, so this is the same
  // assumption the suite already depends on rather than a new one.
  const file = path.resolve(process.cwd(), NEXT_ENV_RELATIVE_PATH);
  if (!existsSync(file)) {
    // Nothing built it, so there is nothing to put back. Not an error: a run of
    // the `api` project alone never starts the web build.
    return;
  }

  const before = readFileSync(file, 'utf8');
  const after = normaliseNextEnv(before);
  if (after === before) {
    return;
  }

  writeFileSync(file, after, 'utf8');
  // One line, only when something was actually changed. Silence would make a
  // teardown that had quietly stopped working indistinguishable from one with
  // nothing to do — and the gate would then be the first thing to notice, which is
  // precisely the loop this exists to keep unbroken.
  const restored = [...new Set(nextEnvDistDirs(before))].filter(
    (dir) => dir !== DEFAULT_NEXT_DIST_DIR,
  );
  process.stdout.write(
    `[e2e teardown] ${NEXT_ENV_RELATIVE_PATH}: ${restored.join(', ')} -> ${DEFAULT_NEXT_DIST_DIR}\n`,
  );
}
