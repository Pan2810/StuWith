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
 * How a file says it talks to `apps/api`: a `/v1` path written out, or one of the
 * `*_PATH` constants `packages/contracts` publishes for the same routes.
 */
const MENTIONS_API = /\/v1\/|AUTH_[A-Z0-9_]*_PATH\b/;

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
    .filter((file) => MENTIONS_API.test(withoutComments(readFileSync(join(APP_ROOT, file), 'utf8'))));

  it('finds the screens that talk to /v1, so an empty list cannot pass', () => {
    // Without this, a regex that stopped matching would silently turn the rule
    // below into no rule at all.
    expect(apiCallers).toContain(join('dang-nhap', 'page.tsx'));
    expect(apiCallers).toContain(join('khai-ngay-sinh', 'page.tsx'));
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
