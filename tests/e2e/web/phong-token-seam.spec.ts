import { expect, test } from '@playwright/test';
import { API_BASE_URL, WEB_BASE_URL } from '../../../playwright.config';
import { HOME_PATHNAME } from '../support/scenario';

/**
 * **Boundary probe — the browser on the web origin, talking to the REAL `apps/api`.**
 *
 * `AGENTS.md` §4: a story that crosses a boundary declares the boundary, the
 * probe that runs IN THAT MEDIUM, and the mutation on the far side that turns it
 * red. The boundary is `apps/web`'s origin ↔ `apps/api` on
 * `POST /v1/rooms/{roomId}/token`: cross-origin, credentialed, and the screen has
 * to READ the answer — the JSON body and the `x-request-id` header.
 *
 * ## Why this one does not go through the fake
 *
 * Every other browser case in this suite talks to `tests/e2e/support/fake-api.cjs`,
 * and `tests/gates/cors-policy.test.ts` records what that cost Story 2.1: its probe
 * promised to go red when `apps/api` dropped `credentials: true`, and it could not,
 * because the fake answered the browser correctly whatever the real server did.
 * The seven Epic 1 failures in that post-mortem all have the shape "tests at both
 * ends of a seam with nothing running the middle".
 *
 * So this case has the page — a real page, served by the real Next.js bundle on
 * the E2E web origin — call the REAL `apps/api` process this suite already starts
 * for `health.spec.ts`. That process has no database behind it, and that is
 * exactly why the probe is a 401: with no session cookie, `SessionAuthenticator`
 * answers `null` before it touches any store (`session-authenticator.ts`), so the
 * request reaches the CORS layer, the request-id echo and the error envelope
 * without needing Postgres. What the probe proves is the SEAM, not the admission
 * logic — `room-token.flow.test.ts` owns that, over real HTTP without a browser.
 *
 * ## The mutation, and why it is now a real one
 *
 * Delete `credentials: CORS_ALLOW_CREDENTIALS` from `apps/api/src/http-setup.ts`
 * (or point `origin` at anything but `config.WEB_BASE_URL`), rebuild, and the
 * browser throws a `TypeError` on the `fetch` below before any status can be
 * read — this case goes red on the product's own configuration, which is the
 * colour Story 2.1's probe could only promise. `WEB_BASE_URL` in
 * `playwright.config.ts`'s API server env is the E2E web origin for this reason.
 *
 * ## No cookie, deliberately
 *
 * No `scenario()` call: the stand-in API's session cookie is set on `127.0.0.1`
 * and cookies ignore ports, so it WOULD travel to the real API and send it to a
 * database that is not there. A fresh context has no cookie, and "no cookie" is
 * the condition under which 401 is answered before any store is asked.
 */
test.describe('phòng — boundary probe: browser → real apps/api', () => {
  test('a credentialed cross-origin token request is answered, and the browser can read the 401 body and x-request-id', async ({
    page,
  }) => {
    await page.goto(HOME_PATHNAME);
    expect(new URL(page.url()).origin).toBe(WEB_BASE_URL);

    const seen = await page.evaluate(async (apiOrigin) => {
      const roomId = '019200f1-0000-7000-8000-000000000001';
      try {
        const response = await fetch(`${apiOrigin}/v1/rooms/${roomId}/token`, {
          method: 'POST',
          credentials: 'include',
        });
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        return {
          threw: null as string | null,
          status: response.status,
          code: body.error?.code ?? null,
          message: body.error?.message ?? null,
          requestId: response.headers.get('x-request-id'),
        };
      } catch (error) {
        return {
          threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          status: 0,
          code: null,
          message: null,
          requestId: null,
        };
      }
    }, API_BASE_URL);

    // LEVEL 1 — the browser let the credentialed request through and handed the
    // response to script. A CORS refusal is a thrown `TypeError` here, never a status.
    expect(seen.threw, 'the browser must not refuse the credentialed cross-origin call').toBeNull();

    // LEVEL 2 — the seam answered with the contract's envelope, readable in full.
    expect(seen.status).toBe(401);
    expect(seen.code).toBe('unauthenticated');
    expect(seen.message).toBeTruthy();

    // LEVEL 3 — the request id is EXPOSED, not merely set: only a header named in
    // `Access-Control-Expose-Headers` reaches script across an origin. This is the
    // exact header that was advertised for all of Epic 1 while nothing set it.
    expect(seen.requestId, 'x-request-id must be readable across the origin').toMatch(/\S+/);
  });
});
