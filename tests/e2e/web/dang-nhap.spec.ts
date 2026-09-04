import { expect, test, type Page } from '@playwright/test';
import { FAKE_API_BASE_URL } from '../../../playwright.config';

/**
 * The route into Story 1.4's screen, walked by a browser.
 *
 * `routes.test.ts` rule C keeps `SignedInPanel` from becoming unreachable code, and
 * `sign-in-outcome.test.tsx` covers what the panel decides. Neither one navigates:
 * until this spec existed, "somebody signed in without a date of birth is offered
 * the way to declare one" was proved by static markup and a lint rule, and the link
 * could have pointed anywhere.
 *
 * This also covers the deferred entry from Story 1.2 — `/dang-nhap` had no E2E at
 * all — and the session-expiry dialog from Story 1.3c, which is a browser-only
 * behaviour by construction: it exists precisely because a `useEffect` noticed a
 * 401, and the `web` Vitest project never runs one.
 */
const SIGN_IN_PATHNAME = '/dang-nhap';
const DATE_OF_BIRTH_PATHNAME = '/khai-ngay-sinh';
const RESET_URL = `${FAKE_API_BASE_URL}/__e2e__/reset`;

async function scenario(
  page: Page,
  state: { signedIn?: boolean; declared?: boolean; refreshWorks?: boolean },
): Promise<void> {
  const response = await page.request.post(RESET_URL, { data: state });
  expect(response.status(), 'the fake API must accept the scenario').toBe(200);
}

test.describe('đăng nhập', () => {
  test('offers the declaration link to somebody whose profile is incomplete', async ({ page }) => {
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(SIGN_IN_PATHNAME);

    const link = page.getByRole('link', { name: 'Khai ngày sinh' });
    await expect(link).toBeVisible();

    // The href is checked by following it, not by reading the attribute: a link
    // that points at a route which does not exist reads correctly and goes nowhere.
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${DATE_OF_BIRTH_PATHNAME}$`));
    await expect(page.getByLabel('Ngày sinh của bạn')).toBeVisible();
  });

  test('offers nothing extra to somebody whose profile is complete', async ({ page }) => {
    await scenario(page, { signedIn: true, declared: true });
    await page.goto(SIGN_IN_PATHNAME);

    await expect(page.getByRole('link', { name: 'Khai ngày sinh' })).toHaveCount(0);
  });

  test('stays quiet on the login page when there is no session', async ({ page }) => {
    // Story 1.3c's rule: `/dang-nhap` is where a signed-out visitor is SUPPOSED to
    // be, so a 401 here is an ordinary answer and must not raise the expiry dialog.
    // Popping "your session ended" at somebody who came to sign in is nonsense.
    await scenario(page, { signedIn: false });
    await page.goto(SIGN_IN_PATHNAME);

    await expect(page.getByText('Phiên đăng nhập đã kết thúc')).toHaveCount(0);
  });

  test('raises the expiry dialog when a session dies away from the login page', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await expect(page.getByLabel('Ngày sinh của bạn')).toBeVisible();

    // The session ends underneath a screen that is not `/dang-nhap`, and the refresh
    // does not rescue it. The seam tries the renewal first and only then disturbs
    // anybody — that ordering is the whole point of Story 1.3c's frozen block.
    await scenario(page, { signedIn: false, refreshWorks: false });
    await page.reload();

    await expect(page.getByText('Phiên đăng nhập đã kết thúc')).toBeVisible();
    // Non-blocking, as decided: the screen underneath stays where it was rather
    // than being replaced by a full-page interruption.
    expect(new URL(page.url()).pathname).toBe(DATE_OF_BIRTH_PATHNAME);
  });

  test('a renewal that works keeps the dialog away entirely', async ({ page }) => {
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await expect(page.getByLabel('Ngày sinh của bạn')).toBeVisible();

    // Session gone, but the refresh succeeds. Nobody should ever learn this
    // happened — that is what "try refresh first, dialog as a last resort" means.
    await scenario(page, { signedIn: false, refreshWorks: true, declared: false });
    await page.reload();

    await expect(page.getByText('Phiên đăng nhập đã kết thúc')).toHaveCount(0);
    await expect(page.getByLabel('Ngày sinh của bạn')).toBeVisible();
  });
});
