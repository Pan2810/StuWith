import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
/**
 * The contract's SOURCE, by relative path, for the reason
 * `cors-exposed-headers.test.ts` records: `tests/gates` is not a workspace package,
 * and reading `packages/contracts/dist` would reproduce the Story 1.7 trap where a
 * run that skipped `build:packages` judged the PREVIOUS policy and reported green.
 */
import {
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_REQUEST_HEADERS,
  CORS_ALLOW_CREDENTIALS,
} from '../../packages/contracts/src/http';

/**
 * The two ends of the cross-origin seam must answer from ONE source.
 *
 * ## The bug this rule exists for
 *
 * Story 2.1's `## Probe ranh giới` named a mutation and promised a colour:
 * "bỏ `credentials: true` (`http-setup.ts:131`) → probe đỏ". Review round 1 ran it.
 * The browser probe stayed GREEN. Two assertions went red — `allows the configured
 * web origin, with credentials` and `answers the preflight a credentialed POST
 * triggers`, both in `apps/api/src/auth/auth.flow.test.ts`, neither a browser —
 * while every Playwright test passed.
 *
 * Round 1 recorded those two as living in `apps/api/src/http-setup.test.ts`, here
 * and in three other places. They do not: that file tests `fastifyAdapterOptions`
 * and `trustProxy`, and a case-insensitive search for `cors` in it returns nothing.
 * The measurement was real and the citation was wrong, which is the worse of the
 * two failures — a reader checking this gate's premise finds an empty file.
 *
 * The reason is that the E2E suite talks to `tests/e2e/support/fake-api.cjs`, and
 * that file answered `'access-control-allow-credentials': 'true'` from a literal of
 * its own. Delete the real server's `credentials` and the fake goes on being right,
 * so the browser goes on working, so the probe goes on passing. The probe was
 * measuring the fake's opinion of CORS, not the product's.
 *
 * `AGENTS.md` §4 names this shape in its `Retry-After` post-mortem — "the E2E fake
 * API mirrored the omission" — and §4's rule is that a probe whose declared
 * mutation does not turn it red is an `intent_gap`, not a patch.
 *
 * ## Why one more assertion was not the answer
 *
 * Pinning `credentials` covers `credentials` and nothing else. The failure class is
 * "a cross-origin decision was written down twice", and it recurs on the next line
 * somebody copies: `methods` and `allowedHeaders` were sitting in both files in
 * exactly the same condition, unpinned, at the moment this gate was written.
 *
 * So the fix is the shape `BROWSER_READABLE_RESPONSE_HEADERS` already proved on the
 * response half — one contract both ends spread — and this gate is what keeps them
 * spreading it. It is STRUCTURAL on purpose: it matches the identifier, not the
 * value. A literal that happens to agree today is precisely what drifted.
 *
 * ## What this gate CANNOT do, measured in review round 2
 *
 * Every assertion below is an unanchored substring match over source text, so it
 * holds the identifier APPEARING and nothing about what the server answers.
 * `methods: [...CORS_ALLOWED_METHODS].filter((m) => m !== 'POST')` satisfies the
 * `methods` regex exactly — measured: with that edit in place this file stays 9/9
 * green, and so do `test:unit`, `test:contract` and Playwright, while the deployed
 * API stops advertising `POST` cross-origin and every room creation from a browser
 * dies at the preflight.
 *
 * What closes it is an execution, and it is in the file this gate's own evidence
 * points at: `advertises exactly the methods and request headers the contract
 * declares` in `apps/api/src/auth/auth.flow.test.ts` reads both header values off a
 * real preflight response. That case goes red on the mutation above. This gate is
 * the cheap layer that catches a literal reappearing; that one is the layer that
 * catches the value being wrong.
 *
 * Mutation-checked before being trusted, as `AGENTS.md` requires. Each of these was
 * run and produced the named failure, then reverted:
 * - delete `credentials: CORS_ALLOW_CREDENTIALS` from `http-setup.ts`
 *   -> `the API takes its credentials answer from the contract`
 * - restore `'access-control-allow-credentials': 'true'` in the fake
 *   -> `the E2E fake API answers credentials from the same constant`
 * - restore `'GET, POST, OPTIONS'` in the fake
 *   -> `both ends take the allowed methods from the contract`
 * - add `'DELETE'` to `CORS_ALLOWED_METHODS`
 *   -> `never advertises a method for deleting anything`
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const HTTP_SETUP = path.join(REPO_ROOT, 'apps', 'api', 'src', 'http-setup.ts');
const FAKE_API = path.join(REPO_ROOT, 'tests', 'e2e', 'support', 'fake-api.cjs');

/**
 * Same anchored spelling as `cors-exposed-headers.test.ts` and
 * `config-cast-ban.test.ts`, for the same measured reason: an unanchored
 * line-comment rule eats everything after a `https://` on the same line, so a call
 * site sitting after a URL would vanish from the scan.
 *
 * It matters more here than usual. Both files carry long docblocks that QUOTE the
 * literals this gate forbids — including the `'true'` the fake used to send — so a
 * scanner that read comments would fail on prose describing the fixed bug.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const apiSource = (): string => stripComments(readFileSync(HTTP_SETUP, 'utf8'));
const fakeSource = (): string => stripComments(readFileSync(FAKE_API, 'utf8'));

describe('CORS request policy', () => {
  it('finds both ends of the seam at all — an empty read is not a pass', () => {
    // The floor the other assertions stand on. A renamed file or a moved call would
    // otherwise make every `not.toMatch` below pass by vacuum.
    expect(apiSource()).toContain('enableCors');
    expect(fakeSource()).toContain('access-control-allow-origin');
  });

  it('the API takes its credentials answer from the contract, not a literal', () => {
    const source = apiSource();
    expect(source).toMatch(/credentials:\s*CORS_ALLOW_CREDENTIALS\b/);
    // The literal this line held for all of Epic 1 and Story 2.1.
    expect(source).not.toMatch(/credentials:\s*(?:true|false)\b/);
  });

  it('the E2E fake API answers credentials from the same constant', () => {
    const source = fakeSource();
    expect(source).toMatch(
      /'access-control-allow-credentials':\s*String\(\s*CORS_ALLOW_CREDENTIALS\s*\)/,
    );
    expect(source).not.toMatch(/'access-control-allow-credentials':\s*['"`]/);
  });

  it('both ends take the allowed methods from the contract', () => {
    expect(apiSource()).toMatch(/methods:\s*\[\s*\.\.\.CORS_ALLOWED_METHODS\s*\]/);
    expect(fakeSource()).toMatch(/'access-control-allow-methods':\s*CORS_ALLOWED_METHODS\.join\(/);
    expect(fakeSource()).not.toMatch(/'access-control-allow-methods':\s*['"`][A-Z]/);
  });

  it('both ends take the allowed request headers from the contract', () => {
    expect(apiSource()).toMatch(/allowedHeaders:\s*\[\s*\.\.\.CORS_ALLOWED_REQUEST_HEADERS\s*\]/);
    expect(fakeSource()).toMatch(
      /'access-control-allow-headers':\s*CORS_ALLOWED_REQUEST_HEADERS\.join\(/,
    );
  });

  it('neither end answers a wildcard origin, which credentials makes invalid', () => {
    // Not a style rule: the fetch spec REFUSES `Access-Control-Allow-Origin: *`
    // whenever credentials are included, so a wildcard fails closed and presents as
    // a mystery CORS error rather than as the over-permissive setting it is.
    expect(apiSource()).not.toMatch(/origin:\s*['"`]\*['"`]/);
    expect(fakeSource()).not.toMatch(/'access-control-allow-origin':\s*['"`]\*['"`]/);
  });

  it('still allows credentials at all — every screen assumes the cookie travels', () => {
    // If this ever becomes `false`, the sign-in session stops crossing the origin
    // boundary and every authenticated screen breaks at once. Pinned so that change
    // is a deliberate edit to a failing test rather than a quiet one.
    expect(CORS_ALLOW_CREDENTIALS).toBe(true);
  });

  it('never advertises a method for deleting anything', () => {
    // Story 2.1 AC5: there is no hard-delete path for a room anywhere in this
    // system. A method advertised in the preflight that no route answers is an
    // invitation to go looking for the endpoint.
    expect([...CORS_ALLOWED_METHODS]).not.toContain('DELETE');
    expect([...CORS_ALLOWED_METHODS]).toContain('OPTIONS');
  });

  it('keeps the allowed request headers lower-case, like the response lists', () => {
    // A list that mixes spellings invites the comparison that fails on case — the
    // failure class `LOG_REDACT_PATHS` was patched for twice in Story 1.5.
    for (const name of CORS_ALLOWED_REQUEST_HEADERS) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});
