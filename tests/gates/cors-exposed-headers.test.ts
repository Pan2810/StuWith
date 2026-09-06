import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
/**
 * The contract's SOURCE, by relative path, not `@stuwith/contracts`.
 *
 * `tests/gates` is not a workspace package, so the bare specifier does not resolve
 * here. Of the two ways out, this is the one that cannot go stale: importing
 * `packages/contracts/dist` would reproduce the Story 1.7 trap where a mutation run
 * that skipped `build:packages` silently tested the PREVIOUS policy and reported
 * green. Reading the source means the gate always judges the code in the tree.
 */
import {
  BROWSER_READABLE_RESPONSE_HEADERS,
  REQUEST_ID_HEADER,
  RETRY_AFTER_HEADER,
  SERVER_ONLY_RESPONSE_HEADERS,
} from '../../packages/contracts/src/http';

/**
 * Every response header the API sets must have a DECISION attached: browser-readable
 * or server-only. Silence is what shipped the bug.
 *
 * ## The bug this rule exists for
 *
 * `rate-limited.filter.ts` set `Retry-After` on every `429` from the day the limit
 * landed. `http-setup.ts` listed `['x-request-id']` as `exposedHeaders` and nothing
 * else. Cross-origin, a browser hands script only the CORS-safelisted headers plus
 * the exposed list — silently, with no error — so `apps/web` read `null` on all
 * three of its call sites, rendered the no-clock copy, and left
 * `disabled={retryAfterSeconds !== null}` evaluating to `false`: the retry button
 * stayed live for the whole lockout. The immediate-retry loop the rate limit exists
 * to break.
 *
 * Measured in Chromium against the real API before the fix:
 * `{"status":429,"retryAfter":null,"visibleHeaders":["content-length","content-type"]}`.
 *
 * ## Why an assertion was not enough
 *
 * Three suites straddled this seam and all three were green. `apps/api`'s flow
 * tests use Node's `fetch`, which ignores CORS. `apps/web`'s unit tests are handed
 * the header string as a function argument. The E2E fake API mirrored the omission
 * by sending no `Access-Control-Expose-Headers` at all. Adding a fourth assertion
 * covers `Retry-After` and nothing else; the failure class is "a header was set and
 * nobody decided about it", and it recurs the next time somebody writes
 * `.header(...)`.
 *
 * So this scans the call sites instead. A new header name fails here until someone
 * puts it in one of the two contract arrays — which is a two-second edit and a
 * recorded decision, exactly the trade the six earlier instances of this failure
 * class wanted.
 *
 * Mutation-checked before being trusted, the way `AGENTS.md` requires: reverting
 * `exposedHeaders` to `['x-request-id']` fails `exposes every browser-readable
 * header`; adding `.header('x-secret', ...)` to `rate-limited.filter.ts` fails
 * `every header set on a response is declared`; deleting the fake API's
 * `access-control-expose-headers` line fails `the E2E fake API exposes the same set`.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Both processes: a header set by the gateway is as invisible to a browser as one
 *  set by the API, and the gateway is where Epic 2's WebSocket handshake lands. */
const SCAN_ROOTS = ['apps/api/src', 'apps/realtime-gateway/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.tsbuild', '.next', 'coverage', '__testing__']);

const HTTP_SETUP = path.join(REPO_ROOT, 'apps', 'api', 'src', 'http-setup.ts');
const FAKE_API = path.join(REPO_ROOT, 'tests', 'e2e', 'support', 'fake-api.cjs');

/**
 * Identifiers a call site may use in place of a literal, and what they resolve to.
 *
 * A header name reaching `.header()` through a variable is the ordinary case here —
 * `REQUEST_ID_HEADER` is imported from the contract on purpose — so a scanner that
 * only understood string literals would quietly skip the very sites that got it
 * right. An identifier NOT in this map is an error rather than a skip: an unknown
 * name is exactly the case where the scanner cannot tell whether a decision exists,
 * and "cannot tell" must not read as "fine".
 */
const KNOWN_HEADER_CONSTANTS = new Map<string, string>([
  ['REQUEST_ID_HEADER', REQUEST_ID_HEADER],
  ['RETRY_AFTER_HEADER', RETRY_AFTER_HEADER],
]);

const DECIDED = new Set<string>([
  ...BROWSER_READABLE_RESPONSE_HEADERS,
  ...SERVER_ONLY_RESPONSE_HEADERS,
]);

/**
 * Same anchored spelling as `config-cast-ban.test.ts:47`, and for the same measured
 * reason: an unanchored line-comment rule eats everything after `https://` on a
 * line, so an offending call sitting after a URL would disappear from the scan.
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
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

interface HeaderSite {
  readonly file: string;
  readonly raw: string;
  readonly name: string | null;
}

/**
 * `.header('x', …)`, `.setHeader('x', …)` and `@Header('x', …)` — the three ways a
 * response header is set in this codebase. `writeHead` is not among them: nothing
 * in `apps/*` uses it, and a rule matching a spelling that does not occur is a rule
 * with no evidence behind it.
 */
const HEADER_CALL = /[.@](?:setHeader|header|Header)\(\s*(?:(['"`])([^'"`]*)\1|([A-Za-z_$][\w$]*))/g;

function headerSites(): HeaderSite[] {
  const sites: HeaderSite[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, ...root.split('/')), [])) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(HEADER_CALL)) {
        const literal = match[2];
        const identifier = match[3];
        const name =
          literal !== undefined
            ? literal.toLowerCase()
            : (KNOWN_HEADER_CONSTANTS.get(identifier ?? '') ?? null);
        sites.push({
          file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
          raw: literal ?? identifier ?? '',
          name,
        });
      }
    }
  }
  return sites;
}

describe('CORS exposed headers', () => {
  it('finds the header call sites at all — an empty scan is not a pass', () => {
    const sites = headerSites();
    // Seven at the time of writing (two `set-cookie`, two `location`, two
    // `retry-after`, two `x-request-id` — one per process). A floor rather than an
    // equality, so adding a route does not fail this line; the point is only that
    // a regex that matched nothing cannot report success.
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it('every header set on a response is declared browser-readable or server-only', () => {
    const undecided = headerSites().filter(
      (site) => site.name === null || !DECIDED.has(site.name),
    );

    expect(
      undecided.map((site) => `${site.file}: ${site.raw}`),
      'each of these headers is set on a response with no decision recorded in ' +
        'packages/contracts/src/http.ts. Add it to BROWSER_READABLE_RESPONSE_HEADERS ' +
        'if a page must read it, or to SERVER_ONLY_RESPONSE_HEADERS if it must not.',
    ).toEqual([]);
  });

  it('exposes every browser-readable header from the contract, not a literal list', () => {
    const source = stripComments(readFileSync(HTTP_SETUP, 'utf8'));

    // The structural half: the spread, not a list that merely happens to agree
    // today. A literal array is how the two drifted in the first place.
    expect(source).toMatch(/exposedHeaders:\s*\[\s*\.\.\.BROWSER_READABLE_RESPONSE_HEADERS\s*\]/);
    expect(source).not.toMatch(/exposedHeaders:\s*\[\s*['"`]/);
  });

  it('the E2E fake API exposes the same set, from the same constant', () => {
    // The third copy of this decision, and the one that made a green E2E run
    // evidence of nothing: the fake sent `retry-after` on its 429 and no
    // `Access-Control-Expose-Headers`, so the browser withheld it there exactly as
    // it did in production.
    const source = stripComments(readFileSync(FAKE_API, 'utf8'));

    expect(source).toContain('access-control-expose-headers');
    expect(source).toMatch(/BROWSER_READABLE_RESPONSE_HEADERS\.join\(/);
  });

  it('keeps the two contract lists disjoint', () => {
    // A header in both arrays makes the scan above unfalsifiable — it would pass
    // whichever answer was right. Overlap is a contradiction, not a preference.
    const exposed = new Set<string>(BROWSER_READABLE_RESPONSE_HEADERS);
    const overlap = SERVER_ONLY_RESPONSE_HEADERS.filter((name) => exposed.has(name));

    expect(overlap).toEqual([]);
  });

  it('never exposes a header that carries a session', () => {
    // `set-cookie` is on the fetch spec's forbidden-response-header list, so this
    // could never work — but the list is edited by hand and the failure would be
    // silent rather than loud, which is the same shape as the bug above.
    for (const name of BROWSER_READABLE_RESPONSE_HEADERS) {
      expect(name).not.toBe('set-cookie');
      expect(name).not.toBe('authorization');
    }
  });
});
