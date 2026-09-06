import { expect, test, type Page } from '@playwright/test';
import { WEB_BASE_URL } from '../../../playwright.config';
import { DATE_OF_BIRTH_PATHNAME, HOME_PATHNAME, SIGN_IN_PATHNAME, scenario } from '../support/scenario';

/**
 * The boundary probe for Story 2.0, and the reason a unit test could not be one.
 *
 * The boundary is browser ↔ server. The locale is decided by the SERVER from a
 * header the BROWSER sends, then written into `<html lang>` and into the HTML of
 * components that live in the client graph. Three things have to agree across that
 * boundary — the header that went out, the `lang` the server wrote, and the words
 * the client rendered — and `resolveLocale('en-US,en;q=0.9')` executes none of the
 * three. That exact shape (tests at both ends of a seam, nothing running the
 * middle) is the failure class `AGENTS.md` §4 records seven instances of, one of
 * which shipped.
 *
 * So every case here runs in a real Chromium with a real `Accept-Language`, and
 * asserts at all three levels:
 *
 *  1. `document.documentElement.lang` is the expected locale;
 *  2. a sentence that exists ONLY in that locale is on the screen;
 *  3. the console carries no hydration error — because the `lang` attribute is
 *     written by the server and the client has to agree with it, and
 *     `layout.tsx` carries `suppressHydrationWarning` for the THEME, which would
 *     otherwise be in a position to hide a language mismatch.
 *
 * ## How it was proved to be able to fail — two mutations, run and reverted
 *
 * A probe nobody has made fail is an assertion that does not know what it is
 * watching, so both halves were broken on purpose against a real build.
 *
 * 1. **The server stops reading the request.** `requestLocale()` forced to
 *    `return 'vi'`: EIGHT cases red. Every `en-US` case failed at level 1
 *    (`html lang` was `vi`) and at level 2 (the English sentence was absent, and
 *    the failure named the Vietnamese text that appeared instead) — plus the
 *    metadata, countdown, theme-announcement and role cases, which are level 2 on
 *    their own screens. Level 3 stayed green, correctly: a server that answers
 *    Vietnamese and a client that agrees with it is consistent, just wrong.
 *
 * 2. **The client decides its own locale.** `I18nProvider` forced to
 *    `translatorFor(typeof window === 'undefined' ? locale : 'en')`, which is what
 *    reading `navigator.language` in the browser would amount to: five cases red,
 *    reporting at level 3 with `Minified React error #418` — React's minified
 *    text-mismatch — collected off the console exactly as this file expects,
 *    including in the two describes that build their own contexts.
 *
 * 3. **The page renders BOTH catalogues at once** (the sign-in sentence hard-coded
 *    beside its translated twin, which is what a half-migrated component looks
 *    like): red on level 2's absence half, `toHaveCount(0)` receiving 1. That half
 *    lived at two call sites and covered the home page only until it moved into
 *    `expectLocale`.
 *
 * 4. **The theme announcement loses its translator** (`appliedThemeNote(choice,
 *    prefersDark)`, dropping the third argument): red only in this file, and only
 *    in the `en-US` case that reads the live region. Every other suite stayed
 *    green, which is why that case had to exist.
 *
 * The two mutations fail in different places, which is the point of asserting at
 * three levels rather than one.
 *
 * ## The other 43 assertions
 *
 * `playwright.config.ts` pins the `web` project to `locale: 'vi-VN'`, so
 * `dang-nhap.spec.ts`, `khai-ngay-sinh.spec.ts` and `he-thiet-ke.spec.ts` keep
 * running in Vietnamese and keep proving what they were written to prove — that the
 * ACCESSIBLE NAMES on these screens are right. Without that line Chromium's default
 * `en-US` would have turned all 43 into assertions about the English catalogue, and
 * a locale probe is not a substitute for them.
 */

/** The cookie the server reads before it reads the header. Spelled here, as `he-thiet-ke.spec.ts` spells `stuwith-theme`. */
const LOCALE_COOKIE = 'stuwith-locale';

/**
 * A sentence that exists in one catalogue and cannot exist in the other.
 *
 * Written out rather than imported, which is the policy `scenario.ts:22-24` records:
 * a test that imports the constant it is checking cannot notice the constant
 * changing under the product. (Importing a constant it is NOT checking is fine and
 * `dang-nhap.spec.ts` does it — this file just has nothing to import.)
 */
const ONLY_IN = {
  vi: {
    home: 'Khung dự án đã dựng.',
    signIn: 'Chọn tài khoản mạng xã hội để tiếp tục:',
    dateOfBirth: 'Ngày sinh của bạn',
    themeGroup: 'Giao diện',
    role: 'Thành viên',
  },
  en: {
    home: 'The project skeleton is up.',
    signIn: 'Choose a social account to continue:',
    dateOfBirth: 'Your date of birth',
    themeGroup: 'Appearance',
    role: 'Member',
  },
} as const;

/**
 * Hydration failures, in the spellings a PRODUCTION build produces.
 *
 * The E2E web server runs `next build && next start`, so React's messages are
 * minified: a text mismatch during hydration arrives as `Minified React error #418`
 * rather than as the readable development warning. Matching only the word
 * "hydration" would therefore have watched nothing in the one build this suite
 * actually runs.
 *
 * The numbered range is React's contiguous block of hydration errors — 418 through
 * 426 — rather than a hand-picked subset. The earlier version listed six of the nine
 * while its own comment named a different set again, which is the shape that lets a
 * real failure arrive under a number nobody wrote down. Measured: mutation 2 below
 * produces #418.
 */
const HYDRATION_FAILURE = /hydrat|Minified React error #(41[89]|42[0-6])/i;

/** Every console error and uncaught error the page produced, from the moment it was attached. */
function collectFailures(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      seen.push(message.text());
    }
  });
  page.on('pageerror', (error) => seen.push(`${error.name}: ${error.message}`));
  return seen;
}

/**
 * The three levels, asserted together, because any one of them alone can be right
 * while the page is wrong.
 *
 * Level 2 takes BOTH sentences and asserts presence and absence, which is a change
 * from the first version: the helper's comment promised the twin was checked while
 * only the two call sites on the home page did it by hand, so the login and
 * declaration screens were asserting "some of this locale is on the page" and
 * nothing about the other one. A page rendering both catalogues at once — a
 * provider mounted twice, a half-migrated component — satisfied every case.
 */
async function expectLocale(
  page: Page,
  locale: 'vi' | 'en',
  sentences: { readonly expected: string; readonly twin: string },
  failures: readonly string[],
): Promise<void> {
  // 1. The attribute the server wrote, read off the live document.
  expect(await page.evaluate(() => document.documentElement.lang), 'html lang').toBe(locale);

  // 2. A sentence only this catalogue has, AND the other catalogue's twin absent —
  //    so "the page contains some English" cannot satisfy a Vietnamese expectation.
  await expect(page.getByText(sentences.expected, { exact: false })).toBeVisible();
  await expect(page.getByText(sentences.twin, { exact: false })).toHaveCount(0);

  // 3. Server and client agree. `suppressHydrationWarning` on `<html>` is there for
  //    the theme attribute; this is what stops it covering a language mismatch too.
  expect(
    failures.filter((line) => HYDRATION_FAILURE.test(line)),
    'the client disagreed with the HTML the server wrote',
  ).toEqual([]);
}

/** The pair for one screen, in the order `expectLocale` wants them. */
function pair(locale: 'vi' | 'en', screen: keyof typeof ONLY_IN.vi): {
  readonly expected: string;
  readonly twin: string;
} {
  const other = locale === 'vi' ? 'en' : 'vi';
  return { expected: ONLY_IN[locale][screen], twin: ONLY_IN[other][screen] };
}

test.describe('a browser that asks for Vietnamese', () => {
  test.use({ locale: 'vi-VN' });

  test('is answered in Vietnamese on every screen', async ({ page }) => {
    const failures = collectFailures(page);

    await scenario(page, { signedIn: false });
    await page.goto(HOME_PATHNAME);
    await expectLocale(page, 'vi', pair('vi', 'home'), failures);

    // Signed OUT for the login page: the provider list, and the sentence above it,
    // exist only for somebody who can still sign in.
    await page.goto(SIGN_IN_PATHNAME);
    await expectLocale(page, 'vi', pair('vi', 'signIn'), failures);

    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await expectLocale(page, 'vi', pair('vi', 'dateOfBirth'), failures);
  });
});

test.describe('a browser that asks for English', () => {
  test.use({ locale: 'en-US' });

  test('is answered in English on every screen', async ({ page }) => {
    const failures = collectFailures(page);

    await scenario(page, { signedIn: false });
    await page.goto(HOME_PATHNAME);
    await expectLocale(page, 'en', pair('en', 'home'), failures);

    await page.goto(SIGN_IN_PATHNAME);
    await expectLocale(page, 'en', pair('en', 'signIn'), failures);

    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await expectLocale(page, 'en', pair('en', 'dateOfBirth'), failures);
  });

  test('translates the layout too, not only the pages', async ({ page }) => {
    // The header is rendered by `layout.tsx`, so a story that translated the pages
    // and forgot the shell would leave every screen half-Vietnamese with nothing
    // above saying so.
    await page.goto(HOME_PATHNAME);

    await expect(page.getByRole('group', { name: ONLY_IN.en.themeGroup })).toBeVisible();
    await expect(page.getByRole('group', { name: ONLY_IN.vi.themeGroup })).toHaveCount(0);
  });

  test('announces the theme in English, in the live region nothing else reads', async ({
    page,
  }) => {
    /**
     * The sentence with the least coverage in the whole product, and the one a
     * sighted person never sees.
     *
     * `appliedThemeNote(choice, prefersDark, t)` takes the translator as a third
     * argument that DEFAULTS to Vietnamese, which is what keeps `theme.test.ts`
     * calling it with two. Dropping the third argument at the call site therefore
     * leaves every suite green: the unit tests pass two arguments themselves,
     * `he-thiet-ke.spec.ts` runs at `vi-VN`, and the gate sees no new literal
     * because none was added. The result is an English-speaking screen-reader user
     * hearing "Đang dùng giao diện tối." after every theme change, on every screen.
     *
     * Same locator `he-thiet-ke.spec.ts` uses for the Vietnamese half — the group's
     * `<p>`, which is `aria-live` and deliberately not `role="status"`.
     */
    await page.goto(HOME_PATHNAME);
    await page.emulateMedia({ colorScheme: 'light' });

    const note = page.getByRole('group', { name: ONLY_IN.en.themeGroup }).locator('p');

    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(note).toHaveText('The dark appearance is in use.');

    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(note).toHaveText('The light appearance is in use.');

    // And never the Vietnamese sentence, which is what a dropped translator says.
    await expect(note).not.toHaveText(/giao diện/);
  });

  test('describes the document in English as well, not only its body', async ({ page }) => {
    // `generateMetadata` rather than a static `metadata` object. A description is a
    // sentence, and a static export is evaluated with no request in scope — so this
    // is the assertion that stops it silently reverting to one language.
    await page.goto(HOME_PATHNAME);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute('content', /study rooms/i);
  });

  test('renders the countdown sentence in English, plural and all', async ({ page }) => {
    /**
     * Matrix row 6 as far as a BROWSER can carry it, and deliberately not further.
     *
     * The first version asked for `?giay=1` and `?giay=2` and asserted the singular
     * and the plural. That is racy by construction rather than by luck: the deadline
     * is one second from the first render, and load + hydrate + Playwright's first
     * poll can exceed it — at which point the element already says "You can try
     * again now." and `toHaveText` can never match. The wait cannot be lengthened
     * without changing what is being asserted, because the singular only exists at
     * exactly 1.
     *
     * So the SINGULAR/PLURAL boundary is proved where time can be held still —
     * `messages.test.tsx` drives `Intl.PluralRules` directly, and
     * `date-of-birth-form.test.tsx` renders the panel at 1 and at 2 through an
     * English provider. What a browser is uniquely able to say is that the sentence
     * reaching a real screen comes from the English catalogue at all, and 30 seconds
     * is the value every other suite here already uses for that.
     */
    await scenario(page, { signedIn: false });

    await page.goto(`${SIGN_IN_PATHNAME}?ket-qua=bi-khoa&giay=30`);

    const clock = page.locator('.notice-countdown');
    await expect(clock).toHaveText(/Retry in \d+ seconds\./);
    await expect(clock).not.toHaveText(/giây/);
  });
});

test.describe('the locale a person chose beats the one their browser asks for', () => {
  test.use({ locale: 'en-US' });

  test('a `vi` cookie wins over an English header', async ({ page, context }) => {
    // Matrix row 3, and the acceptance criterion "when they open it again, their
    // choice wins". Nothing in the product WRITES this cookie yet — no language
    // switch ships in this story — so the probe plants it, which is exactly what a
    // returning visitor's browser would do.
    await context.addCookies([{ name: LOCALE_COOKIE, value: 'vi', url: WEB_BASE_URL }]);

    const failures = collectFailures(page);
    await page.goto(HOME_PATHNAME);

    await expectLocale(page, 'vi', pair('vi', 'home'), failures);
  });

  test('a junk cookie is dropped, and the header decides instead', async ({ page, context }) => {
    // Matrix row 5. The value must not be repaired, echoed or trusted: this answer
    // is written into `<html lang>`, so a cookie a stranger set would otherwise put
    // their text into an attribute of the document element.
    await context.addCookies([{ name: LOCALE_COOKIE, value: '../../etc', url: WEB_BASE_URL }]);

    const failures = collectFailures(page);
    await page.goto(HOME_PATHNAME);

    await expectLocale(page, 'en', pair('en', 'home'), failures);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });
});

test.describe('a browser that asks for a language nobody here speaks', () => {
  test.use({ locale: 'fr-FR' });

  test('is answered in Vietnamese, with no error and no raw key', async ({ page }) => {
    // Matrix row 4: not a 404, not a blank, and above all not `home.frameReady` on
    // the screen — the failure mode a library's runtime fallback produces.
    const failures = collectFailures(page);
    await page.goto(HOME_PATHNAME);

    await expectLocale(page, 'vi', pair('vi', 'home'), failures);
    expect(await page.locator('body').innerText()).not.toMatch(/home\.|signIn\.|dateOfBirth\./);
  });
});

test.describe('markup that says which language a fragment is in', () => {
  test.use({ locale: 'vi-VN' });

  test('an English name inside a Vietnamese sentence carries lang="en"', async ({ page }) => {
    /**
     * The acceptance criterion "a piece of English embedded in a Vietnamese sentence
     * carries `lang="en"`", and the reason `t.nodes` exists at all.
     *
     * Without it a screen reader in the Vietnamese locale pronounces "Microsoft"
     * with Vietnamese phonology. Concatenating the name after the sentence would
     * have made the markup possible but the sentence untranslatable as a unit, which
     * is the trade this shape refuses.
     */
    await scenario(page, { signedIn: false });
    await page.goto(SIGN_IN_PATHNAME);

    const google = page.locator('nav .button-secondary').first();
    await expect(google).toBeVisible();
    await expect(google.locator('[lang="en"]')).toHaveText('Google');

    // The brand in the header, for the same reason: a proper noun is not a
    // translation, so it is marked rather than catalogued.
    await expect(page.locator('.brand')).toHaveAttribute('lang', 'en');
  });
});

test.describe('a role is a word in both languages, never a wire identifier', () => {
  for (const [locale, expected] of [
    ['vi-VN', ONLY_IN.vi.role],
    ['en-US', ONLY_IN.en.role],
  ] as const) {
    test(`${locale} reads the role as "${expected}"`, async ({ browser }) => {
      /**
       * The defect this story found rather than inherited: the signed-in panel
       * rendered `{user.role}` raw, so an organisation administrator read
       * "(vai trò: org_admin)" on their own account page.
       *
       * A fresh context per locale, which is the shape the spec asks for — two
       * browser contexts, one per `Accept-Language`, both against the same build.
       */
      const context = await browser.newContext({ locale, baseURL: WEB_BASE_URL });
      const page = await context.newPage();
      // Level 3, on a context this file builds itself. It was missing here and in
      // the reflow cases below — the two that run end to end in both languages,
      // which is exactly where a hydration mismatch would show up first.
      const failures = collectFailures(page);
      try {
        await scenario(page, { signedIn: true, declared: true });
        await page.goto(SIGN_IN_PATHNAME);

        const panel = page.locator('section.card').first();
        await expect(panel).toBeVisible();
        await expect(panel).toContainText(expected);
        // The wire value itself never reaches the screen.
        await expect(panel).not.toContainText('org_admin');
        expect(await panel.innerText()).not.toMatch(/vai trò: user\b|role: user\b/);

        expect(
          failures.filter((line) => HYDRATION_FAILURE.test(line)),
          'the client disagreed with the HTML the server wrote',
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('both languages fit the narrowest screen the design supports', () => {
  for (const [locale, sentence] of [
    ['vi-VN', ONLY_IN.vi.dateOfBirth],
    ['en-US', ONLY_IN.en.dateOfBirth],
  ] as const) {
    test(`${locale} reflows at 320px with nothing clipped`, async ({ browser }) => {
      /**
       * `EXPERIENCE.md` records that Vietnamese runs 15-25% longer than English, so
       * the language that fits is not evidence about the language that does not.
       * `he-thiet-ke.spec.ts` already measures reflow — in ONE locale, which is now
       * a choice rather than the only option.
       *
       * Two measurements, because they fail differently: the document scrolling
       * sideways is WCAG 1.4.10, and a control whose own content overflows its box
       * is a label with its end cut off on a page that scrolls perfectly well.
       */
      const context = await browser.newContext({ locale, baseURL: WEB_BASE_URL, viewport: { width: 320, height: 800 } });
      const page = await context.newPage();
      const failures = collectFailures(page);
      try {
        await scenario(page, { signedIn: true, declared: false });

        for (const path of [HOME_PATHNAME, SIGN_IN_PATHNAME, DATE_OF_BIRTH_PATHNAME]) {
          await page.goto(path);
          await expect(page.locator('main')).toBeVisible();

          const measured = await page.evaluate(() => {
            const root = document.documentElement;
            const clipped = [
              ...document.querySelectorAll<HTMLElement>(
                '.button-primary, .button-secondary, .theme-switch button, .field, .form-label, .brand',
              ),
            ]
              .filter((element) => element.scrollWidth > element.clientWidth + 1)
              .map((element) => `${element.className || element.tagName}: ${element.innerText}`);

            return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, clipped };
          });

          expect(measured.scrollWidth, `${path} scrolls sideways at 320px`).toBeLessThanOrEqual(
            measured.clientWidth,
          );
          expect(measured.clipped, `${path} clips a label at 320px`).toEqual([]);
        }

        expect(
          failures.filter((line) => HYDRATION_FAILURE.test(line)),
          'the client disagreed with the HTML the server wrote',
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

/** The declaration screen still needs a session, which is what this asserts about the probe itself. */
test.describe('the probe is looking at the screens it claims to', () => {
  test.use({ locale: 'en-US' });

  test('reaches the declaration form rather than a signed-out page', async ({ page }) => {
    // Without this, every English assertion on `/khai-ngay-sinh` could be satisfied
    // by the signed-out branch, which is a different screen with different strings.
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    await expect(page.getByLabel(ONLY_IN.en.dateOfBirth)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save date of birth' })).toBeVisible();
  });
});
