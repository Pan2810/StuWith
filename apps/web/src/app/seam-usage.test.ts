import * as contracts from '@stuwith/contracts';
import { toOpenApiDocument } from '@stuwith/contracts';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One rule, enforced over the source: **no screen calls `fetch` for itself.**
 *
 * ## Why this is a source rule and not a behavioural test
 *
 * `dang-nhap/page.tsx` reaches the network from inside a `useEffect`. The `web`
 * Vitest project has `environment: 'node'` and no DOM — `jsdom`, `happy-dom` and
 * `@testing-library/*` are all absent on purpose, and adding one is an "Ask First"
 * item — so that effect cannot be executed by anything in this repo. Rewriting the
 * page's call back to a bare `fetch(url, { credentials: 'include' })` therefore
 * removes the entire session-expiry feature from the only screen that exists, and
 * every behavioural test in the repo stays green: `authorizedCall` is still
 * correct, the dialog still renders, the provider still mounts, and nothing asks
 * them anything.
 *
 * What is left is a property of the TEXT, and that is exactly the shape a lint
 * rule has. This repository has no ESLint and cannot have one until TypeScript 7.1
 * (`AGENTS.md`, section 6: `@typescript-eslint/parser` throws at import time under
 * TS 7.0), so the rule is written here instead. It is narrow, it names the module
 * that is allowed to break it, and it fails with the offending line.
 *
 * ## What it does NOT claim
 *
 * It does not prove the seam works — `session-expiry.test.ts` does that by running
 * it. It proves only that no screen has quietly opted out of it, which is the one
 * regression a DOM-less project cannot otherwise see.
 */

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * The seam itself, and only the seam.
 *
 * `session-expiry-provider.tsx` owns the two `fetch` calls in `apps/web`: the one
 * inside the wrapper every screen goes through, and the deliberate bare one that a
 * component rendered outside the provider falls back to. Adding a file here is
 * adding a screen that can miss a dead session, so the list is meant to stay this
 * length.
 */
const MAY_CALL_FETCH = ['session-expiry-provider.tsx'];

/**
 * The seam itself, for the second half of the rule below.
 *
 * `session-expiry.ts` builds `/v1` URLs and holds the retry policy, and
 * `session-expiry-provider.tsx` is the wrapper every screen goes through. Neither
 * is a screen, so neither can "ask the provider for the seam" — they ARE it.
 * Everything else that mentions a `/v1` path is a screen and is held to the rule.
 */
const SEAM_MODULES = ['session-expiry-provider.tsx', 'session-expiry.ts'];

/**
 * The names `packages/contracts` publishes for actual `/v1` ROUTES, discovered from
 * the contract document rather than from a naming convention.
 *
 * The previous rule was `/\/v1\/|AUTH_[A-Z0-9_]*_PATH\b/`, and it was wrong in both
 * directions at once. It anchored on the `AUTH_` PREFIX, so Epic 2's `ROOMS_PATH`
 * and Epic 3's `PAYMENTS_PATH` would not have counted as "this screen talks to the
 * API" — the repo's convention is the `_PATH` SUFFIX, and the whole point of the
 * sweep is that a screen nobody remembers to add is still covered. And it matched
 * `AUTH_COOKIE_PATH`, which is a cookie's `Path` attribute rather than a route, so a
 * module mentioning it would have been told to call a seam it has no business with.
 *
 * The suffix alone cannot separate those two, because `AUTH_COOKIE_PATH` has it. So
 * the question is answered by the CONTRACT: a constant names a route exactly when
 * its value is one of the paths the emitted OpenAPI document declares. `/v1/auth`
 * is not one of them; `/v1/auth/me`, `/v1/auth/refresh` and
 * `/v1/auth/date-of-birth` are, and any route a later epic publishes joins the set
 * the day it is documented.
 */
const API_ROUTE_VALUES = new Set(Object.keys(toOpenApiDocument()['paths'] as object));

const API_ROUTE_CONSTANTS = Object.entries(contracts)
  .filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && API_ROUTE_VALUES.has(entry[1]),
  )
  .map(([name]) => name);

/**
 * How a file says it talks to `apps/api`: a `/v1` path written out, or one of the
 * route constants above.
 */
function mentionsApi(source: string): boolean {
  return (
    source.includes('/v1/') || API_ROUTE_CONSTANTS.some((name) => new RegExp(`\\b${name}\\b`).test(source))
  );
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    found.push(full);
  }
  return found;
}

/**
 * Block comments and whole-line `//` comments, removed.
 *
 * Whole-line only, deliberately: `'//evil.com'` is a real value in this codebase
 * and a general `//`-to-end-of-line strip would eat the rest of the line it sits
 * on. Prose about `fetch` lives in docblocks, which is what the first pass drops.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** A call to the global `fetch`. `authorizedFetch(` and `deps.fetchImpl(` are not. */
const BARE_FETCH_CALL = /(?<![.\w])fetch\s*\(/;

describe('every authenticated call goes through the seam', () => {
  const files = sourceFiles(APP_ROOT);

  it('finds the app source at all, so an empty sweep cannot pass', () => {
    // A gate that scanned nothing would be green for ever. This is the same
    // failure `dep-check` guards against with its module count.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.map((file) => relative(APP_ROOT, file))).toContain(
      join('dang-nhap', 'page.tsx'),
    );
  });

  it.each(
    sourceFiles(APP_ROOT)
      .map((file) => relative(APP_ROOT, file))
      .filter((file) => !MAY_CALL_FETCH.includes(file)),
  )('%s calls no global fetch of its own', (file) => {
    const offending = withoutComments(readFileSync(join(APP_ROOT, file), 'utf8'))
      .split('\n')
      .filter((line) => BARE_FETCH_CALL.test(line));

    expect(offending, `${file} must call the seam, not fetch`).toEqual([]);
  });

  /**
   * The other half of the same rule: not calling `fetch` is not enough if a page
   * never asks for the wrapper either.
   *
   * This half used to be an `it.each` listing two pages by hand — which is a list
   * of examples, and the third screen nobody remembers to add to it walks straight
   * through. The sweep above has covered every file since the day it was written;
   * this one now does too. A screen is "one that talks to `/v1`" if its code —
   * comments stripped — mentions a `/v1` path or one of the contract's `*_PATH`
   * constants, which is every way a URL into `apps/api` can be spelled here.
   */
  const apiCallers = sourceFiles(APP_ROOT)
    .map((file) => relative(APP_ROOT, file))
    .filter((file) => !SEAM_MODULES.includes(file))
    .filter((file) => mentionsApi(withoutComments(readFileSync(join(APP_ROOT, file), 'utf8'))));

  it('finds the screens that talk to /v1, so an empty list cannot pass', () => {
    // Without this, a rule that stopped matching would silently turn the one below
    // into no rule at all.
    expect(apiCallers).toContain(join('dang-nhap', 'page.tsx'));
    expect(apiCallers).toContain(join('khai-ngay-sinh', 'page.tsx'));
  });

  it('knows a route constant from a cookie constant', () => {
    // The two halves of the M9 defect, pinned. `AUTH_COOKIE_PATH` is a cookie's
    // `Path` attribute; a module naming it is not a module calling the API, and the
    // old prefix rule said otherwise. Meanwhile the rule is over the SUFFIX
    // convention in practice, so a route constant from a later epic has to count the
    // day the contract publishes it — which is what deriving the set from the
    // document buys.
    expect(API_ROUTE_CONSTANTS).toContain('AUTH_ME_PATH');
    expect(API_ROUTE_CONSTANTS).toContain('AUTH_REFRESH_PATH');
    expect(API_ROUTE_CONSTANTS).toContain('AUTH_DATE_OF_BIRTH_PATH');
    expect(API_ROUTE_CONSTANTS).not.toContain('AUTH_COOKIE_PATH');
    expect(mentionsApi('const p = AUTH_COOKIE_PATH;')).toBe(false);
    expect(mentionsApi('const p = AUTH_ME_PATH;')).toBe(true);
    // A future epic's route: not written out here, but the shape is what matters —
    // any documented path makes its constant count, whatever its prefix.
    expect(API_ROUTE_CONSTANTS.every((name) => name.endsWith('_PATH'))).toBe(true);
  });

  it.each(apiCallers)('%s asks the provider for the seam and for the API origin', (file) => {
    const source = withoutComments(readFileSync(join(APP_ROOT, file), 'utf8'));

    expect(source).toContain('useAuthorizedFetch()');
    expect(source).toContain('useApiBaseUrl()');
    // And it must not have gone back to reading the environment for itself — the
    // root layout reads it once and hands it down.
    expect(source).not.toContain('NEXT_PUBLIC_API_BASE_URL');
  });
});
