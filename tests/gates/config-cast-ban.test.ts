import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No test may cast its way into a config object.
 *
 * `config-fail-fast.test.ts` proves the PROCESS refuses an incomplete environment.
 * It could not see the hole this file closes: four unit suites wrote
 * `{ ...a few fields } as unknown as ApiEnv`, which compiles, runs, and skips every
 * rule in `packages/config`. Adding a required variable left all four green while
 * each one claimed to stand in for a production configuration.
 *
 * The compiler was never going to catch it either. `apps/api/tsconfig.json`
 * excludes `src/**\/*.test.ts`, so those files are transpiled by vitest and
 * type-checked by nothing — which is why the fix had to be a builder that runs the
 * real parser at runtime rather than a fully-typed literal.
 *
 * The durable half is this rule, because a cast is one keystroke to reintroduce and
 * reads as ordinary test setup in review. Anything needing a config in a test calls
 * `testApiEnv()`, which feeds raw strings through `parseApiEnv`.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCAN_ROOTS = ['apps', 'packages', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.tsbuild', '.next', 'coverage']);

/** The two shapes that get a value past the schema without running it. */
const BANNED = [
  /\bas\s+unknown\s+as\s+(ApiEnv|RealtimeGatewayEnv)\b/,
  /\bas\s+(ApiEnv|RealtimeGatewayEnv)\b/,
];

/**
 * Comments are stripped before scanning: the builder's own docblock quotes the
 * banned spelling to explain why it is banned, and a rule that cannot survive being
 * described is a rule nobody can document.
 *
 * Same spelling as `routes.test.ts:352` and `seam-usage.test.ts:121`, and the
 * anchor is the whole point. An UNANCHORED line-comment rule eats everything after
 * the scheme in a URL, so a cast sitting after `'https://x'` on the same line reads
 * as an empty line and the offender disappears. Not hypothetical: this file shipped
 * with the unanchored version and passed against a deliberately reintroduced cast
 * on exactly such a line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function walk(dir: string, found: string[]): string[] {
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

function allSourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root), []));
}

describe('AD-14 — nothing casts past the config schema', () => {
  it('finds no cast to ApiEnv or RealtimeGatewayEnv anywhere in the repo', () => {
    const offenders: string[] = [];

    for (const file of allSourceFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of BANNED) {
        const match = pattern.exec(code);
        if (match) {
          offenders.push(`${path.relative(REPO_ROOT, file)} — "${match[0]}"`);
          break;
        }
      }
    }

    expect(
      offenders,
      'build the config with testApiEnv() so the real schema runs; a cast makes a ' +
        'newly required variable invisible to this suite',
    ).toEqual([]);
  });

  it('scans a meaningful number of files, so an empty pass is not a broken walk', () => {
    expect(allSourceFiles().length).toBeGreaterThan(100);
  });

  /**
   * The rule checking itself, because the first version of it did not work and
   * looked like it did. A scanner is only as good as its stripper, and the
   * stripper is the part that fails silently.
   */
  /**
   * Assembled rather than written out, because this file is inside the scanned
   * tree and a literal probe makes the rule fail on itself. The alternative —
   * exempting this path — would put a hole in the middle of the rule: a real cast
   * could then live here forever. The rule stays global; the probe hides from it.
   */
  const CAST = `as unknown as ${'ApiEnv'}`;

  it('still sees a cast that shares a line with a URL', () => {
    const line = `const CONFIG = { WEB_BASE_URL: 'https://x.example' } ${CAST};`;
    expect(BANNED[0]?.test(stripComments(line))).toBe(true);
  });

  it('does not flag the banned spelling when it appears inside a comment', () => {
    const docblock = `/**\n * Never write \`x ${CAST}\` here.\n */\nconst a = 1;`;
    expect(BANNED.some((pattern) => pattern.test(stripComments(docblock)))).toBe(false);
  });
});
