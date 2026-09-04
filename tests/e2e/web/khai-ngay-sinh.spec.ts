import { expect, test, type Page } from '@playwright/test';
import { FAKE_API_BASE_URL } from '../../../playwright.config';

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
const DATE_OF_BIRTH_PATHNAME = '/khai-ngay-sinh';
const RESET_URL = `${FAKE_API_BASE_URL}/__e2e__/reset`;

interface Scenario {
  readonly signedIn?: boolean;
  readonly declared?: boolean;
  readonly refreshWorks?: boolean;
  readonly meStatus?: number;
}

/**
 * Through `page.request`, not the bare `request` fixture: the session cookie has to
 * land in the BROWSER's jar, or the page that follows arrives signed out and every
 * assertion below tests the wrong screen.
 */
async function scenario(page: Page, state: Scenario): Promise<void> {
  const response = await page.request.post(RESET_URL, { data: state });
  expect(response.status(), 'the fake API must accept the scenario').toBe(200);
}

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

    await expect(page.getByRole('status')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(DATE_OF_BIRTH_PATHNAME);
  });
});
