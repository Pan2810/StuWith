import { expect, test } from '@playwright/test';
import { FAKE_API_BASE_URL } from '../../../playwright.config';
import { DATE_OF_BIRTH_PATHNAME, scenario } from '../support/scenario';

/**
 * Story 1.4's screen, in a browser, for the first time.
 *
 * `date-of-birth-form.test.tsx` covers every decision this screen makes and says
 * in its own docblock what it cannot cover: the `web` Vitest project has no DOM,
 * renders with `renderToStaticMarkup`, and therefore never runs a `useEffect`. So
 * "the page loads the profile on mount", "the form reaches the API", and "the
 * answer redraws the screen" were three claims with no test behind them, and the
 * `pnpm test:e2e` line in the spec's Verification section read like a promise the
 * suite did not keep — Playwright started two API processes and no web server.
 *
 * These cases run the shipped Next.js bundle against a stand-in origin server. What
 * they prove is the wiring; what `auth.flow.test.ts` proves is the API. Neither
 * substitutes for the other.
 */
test.describe('khai ngày sinh', () => {
  test('loads the profile on mount and offers the form to somebody who has not declared', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true, declared: false });

    // Proof the effect ran, not just that markup exists: the page has no server
    // data, so the form can only appear after a real `/v1/auth/me` round trip.
    const profileRequest = page.waitForRequest((request) =>
      request.url().endsWith('/v1/auth/me'),
    );
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await profileRequest;

    await expect(page.getByLabel('Ngày sinh của bạn')).toBeVisible();
    await expect(page.getByText('Chỉ khai một lần, và sau đó không tự đổi lại được.')).toBeVisible();
  });

  test('submitting a date reaches the API and redraws the screen as declared', async ({ page }) => {
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    const field = page.getByLabel('Ngày sinh của bạn');
    await expect(field).toBeVisible();
    await field.fill('2000-05-05');

    const write = page.waitForRequest(
      (request) =>
        request.url().endsWith('/v1/auth/date-of-birth') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Lưu ngày sinh' }).click();
    await write;

    await expect(page.getByRole('heading', { name: 'Bạn đã khai ngày sinh' })).toBeVisible();
    // The form is gone, not merely covered: a second declaration must be
    // unreachable from the screen, the same way the statement makes it unreachable
    // from the database.
    await expect(page.getByLabel('Ngày sinh của bạn')).toHaveCount(0);
  });

  test('somebody who already declared never sees the form again', async ({ page }) => {
    await scenario(page, { signedIn: true, declared: true });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    await expect(page.getByRole('heading', { name: 'Bạn đã khai ngày sinh' })).toBeVisible();
    await expect(page.getByLabel('Ngày sinh của bạn')).toHaveCount(0);
  });

  test('a 409 ends the screen instead of looping it back to the form', async ({ page }) => {
    // The exact defect the round-2 patch had to avoid: treating "already declared"
    // as a failure sends the screen back to the form, which submits, which gets 409
    // again. Somebody who declared in another tab would be stuck forever.
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    await page.getByLabel('Ngày sinh của bạn').fill('2000-05-05');
    // Declare it out from under the screen, so the submit below is the second write.
    await scenario(page, { signedIn: true, declared: true });

    await page.getByRole('button', { name: 'Lưu ngày sinh' }).click();

    await expect(page.getByRole('heading', { name: 'Bạn đã khai ngày sinh' })).toBeVisible();
    await expect(page.getByLabel('Ngày sinh của bạn')).toHaveCount(0);
  });

  test('a rate-limited profile read does not send anybody to the login page', async ({ page }) => {
    // 429 is not "signed out". Telling somebody to log in here sends them to a page
    // where every click makes the wait longer.
    await scenario(page, { signedIn: true, meStatus: 429 });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    // `.first()`, and the reason is itself the evidence the fix landed: now that
    // `Retry-After` survives the CORS boundary this screen renders TWO live regions
    // — the notice and the countdown beside it — and a bare `getByRole('status')`
    // is a strict-mode violation. Before the fix there was exactly one, which is
    // why this line passed while the screen was wrong.
    await expect(page.getByRole('status').first()).toBeVisible();
    // The specific thing that must NOT have happened. "Some status region appeared"
    // was too weak a claim to notice the no-clock branch being taken.
    await expect(page.getByText('Bạn cần đăng nhập trước khi khai ngày sinh.')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(DATE_OF_BIRTH_PATHNAME);
  });

  /**
   * The seventh instance of "tests at both ends of a seam with nothing running the
   * middle", and the one that reached production.
   *
   * `Retry-After` was missing from `Access-Control-Expose-Headers`, so the browser
   * withheld it from script — no error, just `null`. The case above passed anyway,
   * because it asked only whether SOME status region appeared. It did: the wrong
   * one, the no-clock branch, next to an enabled button that spends another attempt.
   *
   * Measured in Chromium against the real API before the fix:
   * `{"status":429,"retryAfter":null,"visibleHeaders":["content-length","content-type"]}`.
   *
   * Three assertions, deliberately at three levels, because each fails for a
   * different cause: the header is readable AT ALL (CORS), the countdown branch was
   * chosen (`profile-load.ts`), and the button that closes the retry loop is
   * actually disabled (the screen).
   */
  test('a rate-limited profile read shows the clock and disables the retry button', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true, meStatus: 429 });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    // Level 1 — the browser hands `retry-after` to script. `page.evaluate` and not
    // Playwright's `response.headers()`, which reports what the SERVER sent and
    // would have been green throughout the bug: only script inside the page is
    // subject to the CORS exposure list.
    const seen = await page.evaluate(async (apiOrigin) => {
      const response = await fetch(`${apiOrigin}/v1/auth/me`, { credentials: 'include' });
      return { status: response.status, retryAfter: response.headers.get('retry-after') };
    }, FAKE_API_BASE_URL);
    expect(seen.status).toBe(429);
    expect(seen.retryAfter, 'the browser must hand Retry-After to script').toBe('30');

    // Level 2 — the screen took the countdown branch, not the generic one.
    await expect(page.getByText('Bạn đã thử quá nhiều lần. Hãy chờ một lát rồi thử lại.')).toBeVisible();
    await expect(page.getByText(/Thử lại sau \d+ giây\./)).toBeVisible();

    // Level 3 — the loop is actually closed. This is the assertion the product
    // failed: with `retryAfterSeconds` null the button stayed enabled for the whole
    // lockout, and every press made the wait longer.
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeDisabled();
  });
});
