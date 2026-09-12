import { expect, type Page } from '@playwright/test';
import type { UserPlan } from '@stuwith/contracts';
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
export const CREATE_ROOM_PATHNAME = '/tao-phong';

export interface Scenario {
  readonly signedIn?: boolean;
  readonly declared?: boolean;
  readonly refreshWorks?: boolean;
  readonly meStatus?: number;
  /**
   * Story 2.1. Which plan the signed-in person is on, which is the ONE input to a
   * room's participant cap.
   *
   * `UserPlan`, from the contract — NOT the plain `string` this was first written
   * as. The reason the route constants above are spelled by hand does not transfer:
   * a route is a constant this suite is CHECKING, so importing it would make the
   * check circular, while a plan is an argument this suite SENDS. Typed as `string`
   * it took `'campus_plus'` silently, and the first thing that noticed was
   * `roomSchema.parse` throwing inside an async handler two hops away. Omitted means
   * the free plan, which is what every existing case runs on.
   */
  readonly plan?: UserPlan;
  /**
   * Story 2.1. What `POST /v1/rooms` answers, so a spec can drive the screen's
   * REFUSALS and not only its happy path.
   *
   * Every non-201 branch of the submit handler was unreachable in a browser while
   * this did not exist: the fake could only answer 201, 400 (a body the real parser
   * rejects) or 401 (signed out), so `createRoomOutcomeFor`'s 413, 415, 429 and
   * `default` arms — five of its six outcomes — were pinned by
   * `renderToStaticMarkup` alone, which cannot press a button. Deleting
   * `setNotice(outcome.notice)` from `page.tsx` left every suite green.
   *
   * `retryAfterSeconds` rides along because a 429 without `Retry-After` is a
   * different screen from a 429 with one, and the difference is the whole point of
   * the countdown.
   */
  readonly roomsStatus?: number;
  readonly roomsRetryAfterSeconds?: number;
}

export async function scenario(page: Page, state: Scenario): Promise<void> {
  const response = await page.request.post(RESET_URL, { data: state });
  expect(response.status(), 'the fake API must accept the scenario').toBe(200);
}
