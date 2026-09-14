import { expect, type Page } from '@playwright/test';
import type { RoomTokenRefusalReason, UserPlan } from '@stuwith/contracts';
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
/** Story 2.3. Spelled by hand for the reason the four above are. */
export const roomPathname = (roomId: string): string => `/phong/${roomId}`;

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
  /**
   * Story 2.3. What `POST /v1/rooms/{roomId}/token` answers — `201` when omitted —
   * so a spec can drive every refusal the pre-join screen has a sentence for.
   */
  readonly roomTokenStatus?: number;
  /**
   * For a 409: which of the two reasons the envelope carries, or `null` (the
   * default) for the Story 2.2 body with no `details` at all. Typed from the
   * contract for the reason `plan` is: an argument this suite SENDS, refused at the
   * fake rather than three hops later.
   */
  readonly roomTokenReason?: RoomTokenRefusalReason | null;
  /**
   * Story 2.4. Which person the scenario is, as a uuid — the id `/v1/auth/me`
   * reports AND the `sub` the room token is signed with, which is what LiveKit
   * reads as the participant identity.
   *
   * It exists because the LiveKit probe puts two browser contexts in one room, and
   * two connections under one identity is an eviction rather than two people
   * (`deferred-work.md`: the second connection replaces the first). Scenario state
   * is per browser context already, so the two choose their own without
   * coordinating. Omitted means the fixture's single default person, which is what
   * every other spec runs as.
   */
  readonly userId?: string;
  /**
   * Story 2.4. Ask for a REAL LiveKit token — signed by `mintRoomToken` out of
   * `apps/api/dist` with the key pair of the `livekit-server` container, naming
   * that container's URL — instead of the Story 2.3 placeholder.
   *
   * Opt-in, and only `tests/e2e/livekit` opts in. The container belongs to the
   * RUN rather than to a project, so a fixture that switched itself on whenever
   * one was up handed real tokens to the `web` specs the moment both browser
   * projects were selected — and three of them are asserting precisely that the
   * placeholder never reaches the DOM and that no socket goes anywhere but
   * `ws://127.0.0.1:7880`.
   */
  readonly useLiveKit?: boolean;
  /**
   * Story 2.4. How far from NOW the `201`'s `expires_at` sits, in seconds —
   * `ROOM_TOKEN_TTL_SECONDS` when omitted, which is what every other spec gets.
   *
   * A negative value is the whole point: it is the only way a browser can reach
   * `RoomShell`'s expiry branch. The real API never mints a lapsed admission, and
   * the alternative — waiting out a 120-second TTL inside a spec — is a timeout
   * wearing a test's clothes.
   */
  readonly expiresAtOffsetSeconds?: number;
  /**
   * Story 2.4. The LiveKit address the `201` hands back — `ws://127.0.0.1:7880`
   * when omitted, which is what every other spec gets.
   *
   * It exists for ONE property: a handshake that HANGS. A closed port on
   * `127.0.0.1` is refused immediately rather than left pending, so a spec that
   * wants to press a button "during the handshake" was really racing the SDK's
   * retry backoff and lost that race under load. A blackholed address
   * (`192.0.2.0/24`, TEST-NET-1, which RFC 5737 reserves for documentation and
   * which no router carries) makes the TCP connect sit there instead, so
   * `connecting` lasts as long as the spec needs and the press always lands where
   * it is aimed.
   */
  readonly roomTokenUrl?: string;
}

export async function scenario(page: Page, state: Scenario): Promise<void> {
  const response = await page.request.post(RESET_URL, { data: state });
  expect(response.status(), 'the fake API must accept the scenario').toBe(200);
}
