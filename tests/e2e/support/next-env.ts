/**
 * `apps/web/next-env.d.ts` is a TRACKED file that `next build` REGENERATES from
 * `distDir`. This module is the one place that fact is handled.
 *
 * The E2E suite builds `apps/web` with `NEXT_DIST_DIR=.next-e2e` — it has to,
 * because `NEXT_PUBLIC_API_BASE_URL` is inlined at build time and the suite points
 * the app at a fake API on port 3200. Next therefore rewrites the tracked file to
 * `import "./.next-e2e/types/routes.d.ts"` and leaves it that way. The file's own
 * header says it should not be edited, which is exactly why it gets committed by
 * accident.
 *
 * ## Why this module contains no `import.meta` and no `__dirname`
 *
 * It is imported from BOTH runners: Playwright's global teardown (its babel emits
 * CommonJS, where `import.meta` is unavailable) and a Vitest gate (ESM, where
 * `__dirname` is unavailable). So it exports a repo-relative path and lets each
 * caller resolve the root the way its own runner already does. A module that
 * needed one of those two globals would work in one place and throw in the other.
 */

/** What `distDir` is when nobody overrides it — `apps/web/next.config.ts`. */
export const DEFAULT_NEXT_DIST_DIR = '.next';

/** From the repository root. Resolved by the caller; see the docblock above. */
export const NEXT_ENV_RELATIVE_PATH = 'apps/web/next-env.d.ts';

/**
 * The import specifiers Next writes into the file, e.g.
 * `import "./.next/types/routes.d.ts";`
 *
 * Captured in three parts so the directory can be replaced without rebuilding the
 * line, which means nothing here has to know what Next puts AFTER the directory —
 * `types/routes.d.ts` today, something else after an upgrade.
 */
const DIST_DIR_IMPORT = /(import\s+["']\.\/)([^/"']+)(\/)/g;

/** Every dist directory the file currently names, in order, with duplicates kept. */
export function nextEnvDistDirs(source: string): string[] {
  return [...source.matchAll(DIST_DIR_IMPORT)].map((match) => match[2] ?? '');
}

/**
 * The same file with every dist directory rewritten to {@link DEFAULT_NEXT_DIST_DIR}.
 *
 * ## Normalise rather than restore a captured copy — a decision, with a cost
 *
 * The obvious alternative is a `globalSetup` that stashes the file's contents and a
 * teardown that writes them back. Normalising was chosen over that for three
 * reasons, and the third is the one that decided it:
 *
 *  1. **No state has to survive between setup and teardown.** Nothing to pass
 *     through `process.env`, and the teardown is correct even when the setup never
 *     ran — an interrupted run, or a suite invoked with `--last-failed`.
 *  2. **Everything Next generated is preserved.** The reference directives, the
 *     comment header, and whatever a future Next version adds. A hard-coded
 *     known-good string would be a second copy of a GENERATED file, which is the
 *     "two copies of one truth" shape this repository dislikes for good reason: an
 *     upgrade that legitimately changes the file would be silently reverted on
 *     every E2E run, and the revert would look like the tidy-up working.
 *  3. **It self-heals a dirty start.** If a previous run was killed before its
 *     teardown, the file already says `.next-e2e` when this run begins — and a
 *     capture-then-restore would faithfully put the BAD content back. Normalising
 *     fixes it instead.
 *
 * The cost, named rather than hidden: this only understands the dist directory as
 * it appears in an `import "./<dir>/..."` specifier. If a future Next writes it in
 * some other shape, this misses it silently — which is why
 * `tests/gates/next-env-distdir.test.ts` stays, asserting over ALL dist
 * directories named rather than over the one spelling the E2E suite produces.
 */
export function normaliseNextEnv(source: string): string {
  return source.replace(DIST_DIR_IMPORT, `$1${DEFAULT_NEXT_DIST_DIR}$3`);
}
