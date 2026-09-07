import { expect, test } from '@playwright/test';
import { FAKE_API_BASE_URL } from '../../../playwright.config';
import { CREATE_ROOM_PATHNAME, HOME_PATHNAME, scenario } from '../support/scenario';

/**
 * **Boundary probe 1 — two origins, a cookie, and a form POST.**
 *
 * `AGENTS.md` §4 requires a story that crosses a boundary to name the boundary, the
 * probe that runs IN THAT MEDIUM, and the mutation on the far side that turns it
 * red. The boundary here is the browser talking to `apps/api` on a different origin
 * with the session in an `HttpOnly` cookie, and the reason it needs a probe at all
 * is measured rather than assumed: **Node's `fetch` ignores CORS entirely**, so
 * `rooms.flow.test.ts` drives the same endpoint over real HTTP without executing one
 * line of this seam. That is the exact shape that let `Retry-After` ship broken for
 * a whole epic with three green suites straddling it.
 *
 * ## The three levels, and why each is a separate assertion
 *
 * Each fails for a different cause, so collapsing them would leave two of the three
 * unproved:
 *
 *  1. a POST to `/v1/rooms` really LEAVES the browser — proof the effect and the
 *     submit handler are wired at all, which `renderToStaticMarkup` can never show;
 *  2. the answer is a `201` and the screen redraws with the room's name — proof the
 *     credentialed request was allowed through and its body was readable;
 *  3. `page.evaluate` repeats the call from inside the page with
 *     `credentials: 'include'` and gets a `201` for the same owner, while the same
 *     call with `credentials: 'omit'` gets a `401`. That PAIR is what proves the
 *     cookie is what did it, rather than something about the origin being open.
 *
 * Level 3 uses `page.evaluate` and not Playwright's `request` fixture, deliberately:
 * the fixture has its own cookie jar and is not subject to the page's CORS rules, so
 * it would have been green throughout the bug this is written to catch.
 *
 * ## What this suite runs against, stated because it is a real limit
 *
 * The stand-in origin server (`tests/e2e/support/fake-api.cjs`), not `apps/api` —
 * the built API in this suite has no database behind it. So the CORS configuration
 * these levels exercise is the fake's `corsHeaders()`, which mirrors
 * `configureHttpApp`'s.
 *
 * Both mutations were run, and the pair is what makes the arrangement defensible:
 *
 *  - **the fake's half.** Deleting `'access-control-allow-credentials': 'true'` from
 *    `corsHeaders()` turned EIGHT of the nine cases in this file red, including all
 *    three levels of the probe. The browser withholds the cookie, `/v1/auth/me`
 *    answers 401, and the form never appears;
 *  - **the product's half.** Deleting `credentials: true` from
 *    `apps/api/src/http-setup.ts` turns two examples in `apps/api`'s own
 *    `http-setup.test.ts` red — so the real server's CORS posture is already pinned,
 *    by a suite that reads the configured options rather than by anything here.
 *
 * What NEITHER covers is the two configurations agreeing with each other; they are
 * kept in step by reading. `deferred-work.md` records that with the measurement.
 */
test.describe('tạo phòng', () => {
  test('the home page leads here, so the screen is reachable without typing a URL', async ({
    page,
  }) => {
    // Rule B of `routes.test.ts` says a product module names the constant; only a
    // browser can say the link actually navigates.
    await scenario(page, { signedIn: true });
    await page.goto(HOME_PATHNAME);

    await page.getByRole('link', { name: 'Tạo phòng học' }).click();

    await expect(page).toHaveURL(new RegExp(`${CREATE_ROOM_PATHNAME}$`));
  });

  test('loads the profile on mount and offers the form', async ({ page }) => {
    await scenario(page, { signedIn: true });

    // Proof the effect ran, not just that markup exists: the page has no server
    // data, so the form can only appear after a real `/v1/auth/me` round trip.
    const profileRequest = page.waitForRequest((request) => request.url().endsWith('/v1/auth/me'));
    await page.goto(CREATE_ROOM_PATHNAME);
    await profileRequest;

    await expect(page.getByLabel('Tên phòng')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Chủ đề' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Ai vào được' })).toBeVisible();
  });

  /**
   * The probe itself. Every level is labelled in the assertions below.
   */
  test('a real form POST crosses the origin, comes back 201 and redraws the screen', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true });
    await page.goto(CREATE_ROOM_PATHNAME);

    await page.getByLabel('Tên phòng').fill('Ôn thi cuối kỳ');
    await page.getByLabel('Mô tả (không bắt buộc)').fill('Học nhóm buổi tối.');
    await page.getByRole('radio', { name: 'Ôn thi' }).check();
    await page.getByRole('radio', { name: 'Ai cũng có thể tìm thấy' }).check();

    // LEVEL 1 — a POST to the rooms endpoint leaves the browser. The URL is checked
    // against the API ORIGIN too: a request to the web server's own origin would be
    // a page navigation, which is not what this story ships.
    const write = page.waitForRequest(
      (request) =>
        request.url() === `${FAKE_API_BASE_URL}/v1/rooms` && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Tạo phòng' }).click();
    await write;

    // LEVEL 2 — the credentialed request was allowed through, the body was readable,
    // and the screen redrew with the name the SERVER stored.
    await expect(page.getByRole('heading', { name: 'Đã tạo phòng' })).toBeVisible();
    await expect(page.getByText('Ôn thi cuối kỳ')).toBeVisible();
    // The free plan's cap, from the body rather than from any arithmetic in the
    // browser — there is none.
    await expect(page.getByText('Phòng này nhận tối đa 6 người.')).toBeVisible();
    // The form is gone: "the room exists" and "here is a form to create one" are one
    // decision, and rendering both is what the single-component shape prevents.
    await expect(page.getByLabel('Tên phòng')).toHaveCount(0);

    // LEVEL 3 — the cookie is what carried the session across the origin, proved by
    // the PAIR. `page.evaluate` runs inside the page, so it is subject to exactly the
    // CORS rules the product's own `fetch` is; Playwright's `request` fixture is not,
    // and would have been green throughout the failure this exists to catch.
    const seen = await page.evaluate(async (apiOrigin) => {
      const body = JSON.stringify({
        name: 'Đọc lại qua fetch',
        description: '',
        topic: 'khac',
        visibility: 'private',
      });
      const headers = { 'content-type': 'application/json' };

      const withCookie = await fetch(`${apiOrigin}/v1/rooms`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body,
      });
      const created = withCookie.status === 201 ? await withCookie.json() : null;

      const withoutCookie = await fetch(`${apiOrigin}/v1/rooms`, {
        method: 'POST',
        credentials: 'omit',
        headers,
        body,
      });

      return {
        withCookie: withCookie.status,
        withoutCookie: withoutCookie.status,
        owner: (created as { owner_user_id?: string } | null)?.owner_user_id ?? null,
        cap: (created as { max_participants?: number } | null)?.max_participants ?? null,
      };
    }, FAKE_API_BASE_URL);

    expect(seen.withCookie, 'a credentialed cross-origin POST must be accepted').toBe(201);
    expect(seen.owner, 'the room must be owned by the signed-in person').not.toBeNull();
    expect(seen.cap).toBe(6);
    /**
     * The negative half. Without it, a server that authenticated NOBODY would
     * satisfy the line above and the level would prove nothing about the cookie.
     *
     * `not.toBe(201)` rather than `toBe(401)`, and the imprecision is the stand-in's
     * rather than the product's: `credentials: 'omit'` withholds every cookie,
     * including the one that tells `fake-api.cjs` which scenario this browser
     * context is on — so its refusal is the 418 it answers before any route is
     * reached, not the 401 `apps/api` would answer. What the PAIR establishes is the
     * thing this level is for: the same request, from the same page, to the same
     * origin, is accepted with cookies and refused without them.
     */
    expect(seen.withoutCookie, 'the same call with no cookie must be refused').not.toBe(201);
  });

  test('the cap follows the plan, and a Campus room gets 45 rather than 100', async ({ page }) => {
    // The row of the matrix that is easiest to get wrong by reading the epic's
    // "45–100" band from the wrong end. It is proved in three media on purpose: the
    // port contract, the API flow suite, and here — where a person actually reads
    // the number.
    await scenario(page, { signedIn: true, plan: 'campus' });
    await page.goto(CREATE_ROOM_PATHNAME);

    await page.getByLabel('Tên phòng').fill('Lớp lớn');
    await page.getByRole('radio', { name: 'Lập trình và công nghệ' }).check();
    await page.getByRole('radio', { name: 'Chỉ người có liên kết' }).check();
    await page.getByRole('button', { name: 'Tạo phòng' }).click();

    await expect(page.getByText('Phòng này nhận tối đa 45 người.')).toBeVisible();
    await expect(page.getByText('Phòng này nhận tối đa 100 người.')).toHaveCount(0);
  });

  test('a client-chosen cap is ignored in silence, not refused', async ({ page }) => {
    // The matrix row that cannot be tested from the form at all — there is no input
    // for it — so the request is made from inside the page instead. The field is not
    // in the contract, so it is stripped rather than rejected, and the answer is a
    // 201 carrying the plan's number.
    await scenario(page, { signedIn: true });
    await page.goto(CREATE_ROOM_PATHNAME);
    await expect(page.getByLabel('Tên phòng')).toBeVisible();

    const seen = await page.evaluate(async (apiOrigin) => {
      const response = await fetch(`${apiOrigin}/v1/rooms`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Phòng tự đặt trần',
          description: '',
          topic: 'khac',
          visibility: 'public',
          max_participants: 100,
        }),
      });
      const room = (await response.json()) as { max_participants?: number };
      return { status: response.status, cap: room.max_participants ?? null };
    }, FAKE_API_BASE_URL);

    expect(seen.status).toBe(201);
    expect(seen.cap).toBe(6);
  });

  test('a blank name is refused by the screen, and nothing is sent', async ({ page }) => {
    // The pre-flight. `required` on the input would stop an EMPTY submit, so the
    // value is whitespace — which the browser accepts and the shared parser does not.
    await scenario(page, { signedIn: true });
    await page.goto(CREATE_ROOM_PATHNAME);

    await page.getByLabel('Tên phòng').fill('   ');
    await page.getByRole('radio', { name: 'Khác' }).check();
    await page.getByRole('radio', { name: 'Ai cũng có thể tìm thấy' }).check();

    let posted = false;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/rooms')) {
        posted = true;
      }
    });
    await page.getByRole('button', { name: 'Tạo phòng' }).click();

    /**
     * The message itself, by id, and NOT `getByRole('alert')`.
     *
     * Next.js mounts its own `<div role="alert" id="__next-route-announcer__">` in
     * every page, so a bare role lookup is a strict-mode violation that reads like a
     * duplicated element in OUR markup. Asserting the role ON the message is also
     * the stronger claim: it says the sentence is what interrupts a screen reader,
     * rather than that some live region exists somewhere on the page.
     */
    const message = page.locator('#tao-phong-loi');
    await expect(message).toBeVisible();
    await expect(message).toHaveAttribute('role', 'alert');
    await expect(
      page.getByText('Chưa tạo được phòng. Hãy kiểm tra lại tên, chủ đề và quyền xem rồi thử lại.'),
    ).toBeVisible();
    expect(posted, 'a refused form must not reach the network').toBe(false);
    // Still on the form, so the person can fix it.
    await expect(page.getByLabel('Tên phòng')).toBeVisible();
  });

  test('a signed-out visitor is told to sign in, and is offered no form', async ({ page }) => {
    await scenario(page, { signedIn: false });
    await page.goto(CREATE_ROOM_PATHNAME);

    await expect(page.getByText('Bạn cần đăng nhập trước khi tạo phòng.')).toBeVisible();
    await expect(page.getByLabel('Tên phòng')).toHaveCount(0);
  });

  test('a rate-limited profile read does not send anybody to the login page', async ({ page }) => {
    // 429 is not "signed out". Telling somebody to log in here sends them to a page
    // where every click makes the wait longer — the defect Story 1.3 fixed on
    // `/dang-nhap`, arriving through a third screen.
    await scenario(page, { signedIn: true, meStatus: 429 });
    await page.goto(CREATE_ROOM_PATHNAME);

    await expect(page.getByText('Bạn đã thử quá nhiều lần. Hãy chờ một lát rồi thử lại.')).toBeVisible();
    await expect(page.getByText(/Thử lại sau \d+ giây\./)).toBeVisible();
    // The loop is closed: the retry button cannot be pressed while the clock runs.
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeDisabled();
    await expect(page.getByText('Bạn cần đăng nhập trước khi tạo phòng.')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(CREATE_ROOM_PATHNAME);
  });

  test('every label is readable at 320px, in both locales, with nothing cut off', async ({
    browser,
  }) => {
    /**
     * The reflow acceptance criterion, measured rather than eyeballed: "when đo ở
     * 320px, then không nhãn nào bị cắt chữ và mọi ô nhập có nhãn liên kết".
     *
     * Vietnamese runs 15-25% longer than English, so a layout that fits English
     * proves nothing about the product's default language — which is why this runs
     * in both. `scrollWidth > clientWidth` is what "cut off" actually means for a
     * text node; and the page itself must not scroll sideways either.
     */
    for (const locale of ['vi-VN', 'en-GB'] as const) {
      const context = await browser.newContext({ locale, viewport: { width: 320, height: 720 } });
      const page = await context.newPage();
      try {
        await scenario(page, { signedIn: true });
        await page.goto(CREATE_ROOM_PATHNAME);
        await expect(page.locator('form')).toBeVisible();

        const overflow = await page.evaluate(() => {
          const cut: string[] = [];
          for (const element of document.querySelectorAll('label, legend, button, .meta, h1, h2')) {
            if (element.scrollWidth > element.clientWidth + 1) {
              cut.push(`${element.tagName}: ${element.textContent ?? ''}`);
            }
          }
          return {
            cut,
            pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });

        expect(overflow.cut, `text is cut off at 320px in ${locale}`).toEqual([]);
        expect(overflow.pageScrollsSideways, `the page scrolls sideways in ${locale}`).toBe(false);

        // And every control still has an accessible name at this width — a label
        // that reflowed out of association would be invisible to the check above.
        const unnamed = await page.evaluate(() => {
          const missing: string[] = [];
          const controls = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input, textarea',
          );
          for (const control of controls) {
            const labelled =
              (control.labels?.length ?? 0) > 0 || control.hasAttribute('aria-label');
            if (!labelled) {
              missing.push(`${control.tagName}[name=${control.getAttribute('name') ?? ''}]`);
            }
          }
          return missing;
        });
        expect(unnamed, `these controls have no label in ${locale}`).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});
