import { expect, type Page } from '@playwright/test';
import { FAKE_API_BASE_URL } from '../../../playwright.config';

/**
 * Telling the stand-in API what to answer, in one place.
 *
 * Three spec files needed the same four lines — the reset URL, the POST, the status
 * assertion, and the two route literals every case navigates to. `deferred-work.md`
 * already carries an open item about `stripComments` existing twice and the two
 * copies having to comment their own anchoring to stay in step; landing a third copy
 * of anything in the change set that records that lesson would be a poor joke.
 *
 * ## Why `page.request` and not the bare `request` fixture
 *
 * The session cookie the fake API mints has to land in the BROWSER's jar. Sent
 * through the standalone fixture it lands in a different context, and the page that
 * follows arrives signed out — so every assertion after it tests the wrong screen,
 * green, for a reason nothing on the failure path would mention.
 */
const RESET_URL = `${FAKE_API_BASE_URL}/__e2e__/reset`;

/** Routes, spelled once. `apps/web` reads these from `@stuwith/contracts`; the E2E
 *  suite deliberately does not, because a test that imports the constant it is
 *  checking cannot notice the constant changing under the product. */
export const HOME_PATHNAME = '/';
export const SIGN_IN_PATHNAME = '/dang-nhap';
export const DATE_OF_BIRTH_PATHNAME = '/khai-ngay-sinh';

export interface Scenario {
  readonly signedIn?: boolean;
  readonly declared?: boolean;
  readonly refreshWorks?: boolean;
  readonly meStatus?: number;
}

export async function scenario(page: Page, state: Scenario): Promise<void> {
  const response = await page.request.post(RESET_URL, { data: state });
  expect(response.status(), 'the fake API must accept the scenario').toBe(200);
}
