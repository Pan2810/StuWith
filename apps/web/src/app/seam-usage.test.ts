import * as contracts from '@stuwith/contracts';
import { toOpenApiDocument } from '@stuwith/contracts';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * The route BUILDERS — Story 2.2, review round 1.
 *
 * A templated route is published twice by the contract: as the template the
 * document is keyed on (`ROOM_TOKEN_PATH_TEMPLATE`, `/v1/rooms/{roomId}/token`)
 * and as a FUNCTION that fills the slot (`roomTokenPath(id)`). A screen calls the
 * function and never writes the template's name, so a rule over constants alone
 * let `import { roomTokenPath }` walk straight past `mentionsApi` — the third
 * spelling of "this screen talks to `/v1`", and the one every templated route
 * from now on will use.
 *
 * Discovered the same way the constants are, from the document rather than from
 * a list: an export whose name ends in `Path`, is a function, and — handed a probe
 * string — answers a documented template with the probe in its `{param}` slot.
 * Calling an arbitrary export with a string is safe here because a throw simply
 * means "not a builder".
 */
const PROBE_PARAM = 'seam-usage-probe';

/** The documented templates, each with how many `{param}` slots it has. */
const TEMPLATES = [...API_ROUTE_VALUES]
  .map((template) => ({ template, slots: (template.match(/\{[^}]+\}/g) ?? []).length }))
  .filter(({ slots }) => slots > 0);

function fillsDocumentedTemplate(value: unknown): boolean {
  if (typeof value !== 'function') {
    return false;
  }
  // Tried once per slot count the document has, so a builder for a two-parameter
  // route is recognised the day one is published rather than escaping because it
  // was handed one argument and returned a half-filled template.
  return TEMPLATES.some(({ template, slots }) => {
    let built: unknown;
    try {
      built = (value as (...parameters: string[]) => unknown)(
        ...Array.from({ length: slots }, () => PROBE_PARAM),
      );
    } catch {
      return false;
    }
    return typeof built === 'string' && template.replace(/\{[^}]+\}/g, PROBE_PARAM) === built;
  });
}

const API_ROUTE_BUILDERS = Object.entries(contracts)
  .filter(([name, value]) => /Path$/.test(name) && fillsDocumentedTemplate(value))
  .map(([name]) => name);

/**
 * How a file says it talks to `apps/api`: a `/v1` path written out, one of the
 * route constants above, or a call to one of the route builders.
 */
function mentionsApi(source: string): boolean {
  return (
    source.includes('/v1/') ||
    API_ROUTE_CONSTANTS.some((name) => new RegExp(`\\b${name}\\b`).test(source)) ||
    API_ROUTE_BUILDERS.some((name) => new RegExp(`\\b${name}\\b`).test(source))
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

/**
 * What the second half of the rule demands of a screen that talks to `/v1`, as a
 * list of named violations — empty when the screen complies. ONE predicate, used
 * by the sweep over real screens and by the planted-screen example, so the
 * example proves the sweep would have failed the file rather than proving that
 * a string the test wrote lacks a substring.
 */
function seamRuleViolations(rawSource: string): string[] {
  const source = withoutComments(rawSource);
  const violations: string[] = [];
  if (!source.includes('useAuthorizedFetch()')) {
    violations.push('does not call useAuthorizedFetch()');
  }
  if (!source.includes('useApiBaseUrl()')) {
    violations.push('does not call useApiBaseUrl()');
  }
  // And it must not have gone back to reading the environment for itself — the
  // root layout reads it once and hands it down.
  if (source.includes('NEXT_PUBLIC_API_BASE_URL')) {
    violations.push('reads NEXT_PUBLIC_API_BASE_URL for itself');
  }
  return violations;
}

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
    // any documented path makes its constant count, whatever its prefix. Two
    // suffixes since Story 2.2: `_PATH` for a concrete route, `_PATH_TEMPLATE` for
    // one the document keys with a `{param}` placeholder (`ROOM_TOKEN_PATH_TEMPLATE`
    // is `/v1/rooms/{roomId}/token`). The template IS the documented path, so it
    // counts; the name says it is not a string a client sends verbatim.
    expect(API_ROUTE_CONSTANTS).toContain('ROOM_TOKEN_PATH_TEMPLATE');
    expect(API_ROUTE_CONSTANTS.every((name) => /_PATH(?:_TEMPLATE)?$/.test(name))).toBe(true);
  });

  it('knows a route BUILDER from any other exported function', () => {
    // The positive pin for the third spelling. A screen that imports
    // `roomTokenPath` and never names the template is a screen that talks to
    // `/v1/rooms/{roomId}/token`, and has to be held to the seam rule.
    expect(API_ROUTE_BUILDERS).toContain('roomTokenPath');
    expect(mentionsApi('const path = roomTokenPath(room.id);')).toBe(true);
    // Other exported functions are not routes: `makeError` builds an envelope,
    // `isRoomId` answers a predicate, and neither fills a documented template.
    expect(API_ROUTE_BUILDERS).not.toContain('makeError');
    expect(API_ROUTE_BUILDERS).not.toContain('isRoomId');
    expect(mentionsApi('const ok = isRoomId(value);')).toBe(false);
  });

  it('would hold a planted screen that imports only the builder to the seam rule', () => {
    // Planted through the SAME pipeline the sweep uses — the file walker, the
    // comment stripper, `mentionsApi` — rather than asserted against a string, so
    // this proves the sweep would have caught it and not only that the regex can.
    const planted = join(APP_ROOT, 'seam-usage-probe.generated.tsx');
    writeFileSync(
      planted,
      [
        "import { roomTokenPath } from '@stuwith/contracts';",
        'export function Probe({ id }: { id: string }) {',
        '  return <a href={roomTokenPath(id)}>vào phòng</a>;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const files = sourceFiles(APP_ROOT);
      expect(files).toContain(planted);
      const callers = files.filter((file) =>
        mentionsApi(withoutComments(readFileSync(file, 'utf8'))),
      );
      expect(callers).toContain(planted);
      // And the SAME rule the sweep applies to every caller, run on the planted
      // screen: it would have FAILED the sweep, not merely joined the list. Not a
      // check on a string this test wrote three lines up — the production
      // predicate, with its findings named.
      expect(seamRuleViolations(readFileSync(planted, 'utf8'))).toEqual([
        'does not call useAuthorizedFetch()',
        'does not call useApiBaseUrl()',
      ]);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it.each(apiCallers)('%s asks the provider for the seam and for the API origin', (file) => {
    expect(seamRuleViolations(readFileSync(join(APP_ROOT, file), 'utf8'))).toEqual([]);
  });
});
