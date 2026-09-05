import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The money-gate fixture controller is a TEST fixture, and nothing may make it a
 * route on a deployed process.
 *
 * `MoneyFixtureController` carries `@MoneyIn()` and a handler that would, in Epic
 * 3, move coins. Today it moves nothing — but it is a real Nest controller in
 * `src/`, and `AppModule` mounts whatever `options.fixtureControllers` contains.
 * Two edits, each individually reasonable, would put it on the wire: an import
 * from a product file, or `main.ts` growing a `fixtureControllers` key.
 *
 * Neither would fail a test. `apps/api/tsconfig.build.json` excludes
 * `src/**\/__testing__/**`, so the CLASS is absent from `dist` — but an import from
 * a compiled file would drag it back IN, and `nest build` would emit it without
 * comment. "It is not in `dist`" is a consequence of nobody importing it, not a
 * rule, and that is the difference this gate exists to close.
 *
 * Same shape as `config-cast-ban.test.ts`: scan the repository, decide over the
 * class rather than over the one example somebody thought of.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const API_SRC = path.join(REPO_ROOT, 'apps', 'api', 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.tsbuild', 'coverage']);

/** The names that must not appear outside a test or a `__testing__` directory. */
const FIXTURE_NAMES = ['MoneyFixtureController', 'money-fixture.controller'];

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, found);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/** A file allowed to know the fixture exists. */
function isTestOnly(file: string): boolean {
  const relative = path.relative(API_SRC, file).split(path.sep).join('/');
  return relative.endsWith('.test.ts') || relative.includes('__testing__/');
}

describe('nothing outside a test may reach the money fixture controller', () => {
  const files = walk(API_SRC);

  it('scanned a plausible number of files, so the sweep below is not empty', () => {
    // A `walk` that silently returned nothing would make every assertion here
    // pass. This is the assertion that says it did not.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith('money-fixture.controller.ts'))).toBe(true);
  });

  it.each(FIXTURE_NAMES)('is not named by any product file: %s', (name) => {
    const offenders = files
      .filter((file) => !isTestOnly(file))
      .filter((file) => readFileSync(file, 'utf8').includes(name))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('IS named by the test files that legitimately use it', () => {
    // The positive counterpart: without it, deleting the fixture entirely would
    // satisfy the rule above perfectly.
    const users = files
      .filter(isTestOnly)
      .filter((file) => readFileSync(file, 'utf8').includes('MoneyFixtureController'))
      .map((file) => path.basename(file));

    expect(users).toContain('money-gate.flow.test.ts');
    expect(users).toContain('logging.test.ts');
  });
});

describe('main.ts mounts no fixture controllers', () => {
  const mainSource = readFileSync(path.join(API_SRC, 'main.ts'), 'utf8');

  it('never passes the fixtureControllers seam', () => {
    /**
     * The seam's whole safety argument is that production does not use it. That
     * argument was written as "production calls `forConfig(config)`", which is
     * simply not what `main.ts` does — it calls
     * `forConfig(config, { authRuntime: runtime })`. A reader checking the claim by
     * eye would have found it contradicted and had no way to tell whether the
     * discrepancy mattered.
     *
     * So the claim is now the narrow, true one, and it is checked rather than read:
     * `authRuntime` is passed, `fixtureControllers` is not.
     */
    expect(mainSource).not.toContain('fixtureControllers');
  });

  it('does pass authRuntime, so the assertion above is about the real call site', () => {
    expect(mainSource).toContain('AppModule.forConfig(config, { authRuntime: runtime })');
  });
});
