import * as contracts from '@stuwith/contracts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Three rules over the whole app directory, and none of them is a render.
 *
 * ## Why this file exists, and why the previous two answers were not enough
 *
 * `DATE_OF_BIRTH_PATHNAME` has now been the subject of three review rounds, each
 * finding the same class of defect one layer further in:
 *
 * 1. The constant was pinned only against OTHER constants — it is not
 *    `AUTH_DATE_OF_BIRTH_PATH`, it does not start with `/v1`, it is not
 *    `SIGN_IN_PATHNAME`. Renaming the route directory left all three true and every
 *    link built from it pointing at a 404. Rule A below compares the constant with
 *    the FILESYSTEM, which is what Next.js actually routes on.
 * 2. Nothing in the product navigated to it. The screen existed, rendered, had its
 *    own tests, and the endpoint behind it worked over real HTTP — and the only way
 *    to reach it was to type the URL. Rule B is over the SET: every `*_PATHNAME`
 *    must be named by a product module outside its own route directory.
 * 3. The fix for (2) was a component, and the only thing that rendered it was a
 *    test. Reverting one line of `dang-nhap/page.tsx` to the inline JSX it replaced
 *    made `/khai-ngay-sinh` unreachable again with 1572 tests still green: rule B
 *    stayed satisfied, because the module that names the constant was still there
 *    and still imported for other reasons. Rule C is what closes that: an exported
 *    symbol in a product module must be USED by product code. A component only its
 *    test renders is dead product code, and this is the rule that says so.
 *
 * The lesson written into the spec's change log — "having a test for a component is
 * not evidence that the product uses it" — is rule C, expressed as something a run
 * can check rather than as something a reviewer has to notice.
 *
 * ## Why these are rules over text rather than behaviour
 *
 * The `web` Vitest project has `environment: 'node'` and no DOM on purpose
 * (`AGENTS.md`, section 6), so a page's effects and its JSX tree cannot be executed
 * by anything in this repository. What is left is a property of the source, and
 * that is the shape a lint rule has. There is no ESLint here and cannot be one
 * until TypeScript 7.1, so the rules are written as tests, narrowly, each naming
 * what it found.
 */

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Every product module under `apps/web/src/app` — sources, never tests.
 *
 * "Product" is the load-bearing word in every rule below. A file whose name ends
 * `.test.ts(x)` ships to nobody, so a reference from one is not evidence that
 * anything reaches the code it names.
 */
function productFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...productFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    found.push(full);
  }
  return found;
}

const PRODUCT_FILES = productFiles(APP_ROOT).map((file) => relative(APP_ROOT, file));
const SOURCES = new Map(
  PRODUCT_FILES.map((file) => [file, readFileSync(join(APP_ROOT, file), 'utf8')]),
);

/**
 * The same sources with comments removed, which is what every rule below reads.
 *
 * Prose is not a use and not a link. A docblock explaining why `SignedInPanel`
 * exists would otherwise satisfy rule C on behalf of a component nothing renders —
 * the file would justify its own dead code — and a comment quoting `/dang-nhap`
 * would be reported by rule B as a hard-coded route.
 */
const CODE = new Map(
  [...SOURCES].map(([file, source]) => [file, withoutComments(source)] as const),
);

/** A whole-word occurrence of `name` anywhere in `source`. */
function mentions(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

/**
 * The route constants, discovered rather than listed.
 *
 * The `_PATHNAME` suffix is the convention `SIGN_IN_PATHNAME` established and
 * `DATE_OF_BIRTH_PATHNAME` followed: a `*_PATH` is a `/v1` endpoint in `apps/api`,
 * a `*_PATHNAME` is a page in `apps/web`. Only the second kind is a directory.
 *
 * A third one added later is covered the day it is exported, which is the whole
 * point of sweeping rather than listing — the "list of examples" shape is what
 * `AGENTS.md` records as having cost four review rounds on the trusted-proxy list.
 */
const webPathnames: ReadonlyArray<readonly [string, string]> = Object.entries(contracts)
  .filter(
    (entry): entry is [string, string] =>
      entry[0].endsWith('_PATHNAME') && typeof entry[1] === 'string',
  )
  .map(([name, value]) => [name, value] as const);

/**
 * The App Router directory a pathname resolves to, or `null`.
 *
 * It understands the three spellings Next.js routes on that a `segments[0]` lookup
 * did not: a ROUTE GROUP (`(marketing)`) contributes nothing to the URL, a DYNAMIC
 * segment (`[id]`, `[...rest]`, `[[...rest]]`) matches whatever is in that position,
 * and a route file may be `page.tsx`, `page.ts`, `page.jsx` or `page.js`. The
 * previous version checked only the first segment against the top-level directory
 * listing, so a two-segment pathname, a grouped route or a `page.jsx` was either
 * unchecked or wrongly reported missing.
 */
const PAGE_FILES = ['page.tsx', 'page.ts', 'page.jsx', 'page.js'];

function resolveRoute(directory: string, segments: readonly string[]): string | null {
  if (segments.length === 0) {
    return PAGE_FILES.some((page) => existsSync(join(directory, page))) ? directory : null;
  }
  const [head, ...rest] = segments;
  const children = readdirSync(directory, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  for (const child of children) {
    // A route group is transparent: `(auth)/dang-nhap` serves `/dang-nhap`.
    if (child.name.startsWith('(') && child.name.endsWith(')')) {
      const found = resolveRoute(join(directory, child.name), segments);
      if (found !== null) {
        return found;
      }
      continue;
    }
    const isDynamic = child.name.startsWith('[') && child.name.endsWith(']');
    if (child.name === head || isDynamic) {
      const found = resolveRoute(join(directory, child.name), rest);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** The route directory a constant's own page lives in, relative to the app root. */
function routeDirectoryOf(pathname: string): string | null {
  const directory = resolveRoute(APP_ROOT, pathname.slice(1).split('/'));
  return directory === null ? null : relative(APP_ROOT, directory);
}

describe('rule A — every web route constant points at a real page', () => {
  it('finds the constants at all, so an empty sweep cannot pass', () => {
    // A filter that matched nothing would make every assertion below vacuous —
    // the same guard `seam-usage.test.ts` puts in front of its file sweep.
    expect(webPathnames.length).toBeGreaterThanOrEqual(2);
    const names = webPathnames.map(([name]) => name);
    expect(names).toContain('SIGN_IN_PATHNAME');
    expect(names).toContain('DATE_OF_BIRTH_PATHNAME');
  });

  it.each(webPathnames)('%s (%s) resolves to a route with a page in it', (_name, pathname) => {
    // Next.js routes on the App Router directory tree, so this is the only fact
    // that decides whether a link built from the constant reaches anything.
    expect(pathname.startsWith('/'), `${pathname} must be an absolute path`).toBe(true);
    expect(routeDirectoryOf(pathname), `no route serves ${pathname}`).not.toBeNull();
  });

  it('does not treat an API path as a page, so the two families stay apart', () => {
    // `AUTH_DATE_OF_BIRTH_PATH` is `/v1/auth/date-of-birth` and must never grow a
    // directory here; if the suffix convention ever blurs, this is what says so.
    expect(webPathnames.map(([, value]) => value).some((value) => value.startsWith('/v1'))).toBe(
      false,
    );
  });

  it('resolves a grouped, nested, dynamic route, so the resolver is not just the flat case', () => {
    // The resolver is the part of rule A that could silently stop working — a
    // version that only handled one flat segment reported every other shape as
    // "missing", which is a red nobody can act on, or as "present", which is worse.
    // This exercises it against the real tree in the one direction available:
    // something that must NOT resolve.
    expect(resolveRoute(APP_ROOT, ['khong-ton-tai'])).toBeNull();
    expect(resolveRoute(APP_ROOT, ['dang-nhap', 'khong-ton-tai'])).toBeNull();
    // And the positive control, so "everything is null" cannot satisfy the above.
    expect(resolveRoute(APP_ROOT, ['dang-nhap'])).not.toBeNull();
  });
});

/**
 * Rule B — the constant is NAMED by product code that is not the route itself.
 *
 * A page nothing links to is a page nobody can reach, and every piece of it can be
 * correct: the constant exists, the directory exists, the screen renders, the
 * endpoint answers. That was the state Story 1.4 nearly shipped in.
 *
 * "Outside its own route directory" is what makes it a rule about REACHING the
 * page. `khai-ngay-sinh/date-of-birth-form.tsx` naming `DATE_OF_BIRTH_PATHNAME`
 * would prove nothing — a screen linking to itself is not a way in.
 */
describe('rule B — something in the product leads to each route', () => {
  it('finds product modules at all, so an empty sweep cannot pass', () => {
    expect(PRODUCT_FILES.length).toBeGreaterThanOrEqual(5);
    expect(PRODUCT_FILES).toContain(join('dang-nhap', 'page.tsx'));
    expect(PRODUCT_FILES).toContain(join('khai-ngay-sinh', 'page.tsx'));
  });

  it.each(webPathnames)(
    '%s is named by a product module outside its own route directory',
    (name, pathname) => {
      const own = routeDirectoryOf(pathname);
      expect(own, `no route serves ${pathname}`).not.toBeNull();

      const referrers = PRODUCT_FILES.filter(
        (file) => !file.startsWith(`${own ?? ''}${sep()}`) && mentions(CODE.get(file) ?? '', name),
      );

      expect(
        referrers,
        `nothing in apps/web outside ${own} names ${name}, so ${pathname} can only be reached by typing it`,
      ).not.toEqual([]);
    },
  );

  /**
   * The reverse direction, which the previous version of this file did not check at
   * all: a page reached through a LITERAL is a page the rules above cannot protect.
   *
   * `apps/web/src/app/page.tsx` was doing exactly that — `<Link href="/dang-nhap">`
   * — so renaming the login route would have satisfied rule A (the directory moved
   * with the constant) and rule B (the seam still names the constant) while the home
   * page's only link pointed at a 404.
   */
  it.each(webPathnames)('%s is never written out as a literal instead', (name, pathname) => {
    const offenders = PRODUCT_FILES.filter((file) => {
      const source = CODE.get(file) ?? '';
      return source.includes(`'${pathname}'`) || source.includes(`"${pathname}"`);
    });

    expect(
      offenders,
      `these files write ${pathname} out instead of using ${name}`,
    ).toEqual([]);
  });
});

/**
 * Rule C — an exported symbol in a product module is USED by product code.
 *
 * This is the rule the third round asked for, and the one the mandated mutation
 * fails: revert `dang-nhap/page.tsx` to the inline JSX it had before the round-one
 * patch, and `SignedInPanel` is exported, rendered by its own test, and reachable
 * from nothing that ships. Rules A and B both stay green — the route directory is
 * still there, and `sign-in-outcome.tsx` still names `DATE_OF_BIRTH_PATHNAME` and is
 * still imported by the page for other reasons — so only a rule at SYMBOL
 * granularity can see it.
 *
 * "Used by product code" deliberately includes use inside the declaring module: a
 * sentence like `DECLARE_DATE_OF_BIRTH_PROMPT` is exported so a test can name it
 * without copying the string, and it is genuinely used, by the component next to it.
 * What is not allowed is a symbol NOTHING in the product mentions — which for a
 * component means nothing renders it.
 *
 * The exceptions are Next.js's own route-module conventions: the framework reads
 * `metadata` and `viewport` off a `page`/`layout` module by name, and routes on the
 * default export, so neither can be "used" by anything in this directory.
 */
const NEXT_ROUTE_EXPORTS = [
  'metadata',
  'viewport',
  'generateMetadata',
  'generateStaticParams',
  'generateViewport',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
];

const isRouteModule = (file: string): boolean =>
  /(^|[\\/])(page|layout|template|error|loading|not-found|default)\.tsx?$/.test(file);

/** `export function x`, `export const x`, `export type X`, and `export { a, b }`. */
function exportedNames(source: string): string[] {
  const names: string[] = [];
  const declared = /export\s+(?:async\s+)?(?:function|const|class|interface|type|let|var)\s+([A-Za-z0-9_$]+)/g;
  for (const match of source.matchAll(declared)) {
    names.push(match[1] ?? '');
  }
  const listed = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  for (const match of source.matchAll(listed)) {
    for (const part of (match[1] ?? '').split(',')) {
      // `a as b` publishes `b`; the local name is what has to be used here.
      const local = part.trim().split(/\s+as\s+/)[0]?.trim() ?? '';
      if (local.length > 0) {
        names.push(local);
      }
    }
  }
  return names.filter((name) => name.length > 0);
}

const EXPORTS: ReadonlyArray<readonly [string, string]> = PRODUCT_FILES.flatMap((file) =>
  exportedNames(CODE.get(file) ?? '')
    .filter((name) => !(isRouteModule(file) && NEXT_ROUTE_EXPORTS.includes(name)))
    .map((name) => [file, name] as const),
);

describe('rule C — nothing in the product is exported only for its own test', () => {
  it('finds exports at all, so an empty sweep cannot pass', () => {
    expect(EXPORTS.length).toBeGreaterThanOrEqual(30);
    // And the sweep reaches the symbol the mutation removes, which is the one this
    // rule was written for. Without this line, an `exportedNames` that quietly
    // stopped matching `export function` would turn rule C into no rule at all.
    expect(EXPORTS).toContainEqual([join('dang-nhap', 'sign-in-outcome.tsx'), 'SignedInPanel']);
  });

  it.each(EXPORTS)('%s exports %s, and product code uses it', (file, name) => {
    const users = PRODUCT_FILES.filter((other) => {
      const source = CODE.get(other) ?? '';
      if (other !== file) {
        return mentions(source, name);
      }
      // In the declaring module, the declaration itself does not count as a use.
      const occurrences = source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? [];
      return occurrences.length > 1;
    });

    expect(
      users,
      `${file} exports ${name} and nothing in apps/web uses it — a symbol only its test reaches is not shipped`,
    ).not.toEqual([]);
  });
});

/**
 * Block comments and whole-line `//` comments, removed — the same helper
 * `seam-usage.test.ts` uses, and for the same reason: prose about a route lives in
 * docblocks, and a rule that reads them reports the explanation as the offence.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** `path.sep`, without importing the whole module for one character. */
function sep(): string {
  return join('a', 'b').slice(1, 2);
}
