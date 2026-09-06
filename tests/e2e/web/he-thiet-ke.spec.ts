import { expect, test, type Page } from '@playwright/test';
import {
  DATE_OF_BIRTH_PATHNAME,
  HOME_PATHNAME,
  SIGN_IN_PATHNAME,
  scenario,
} from '../support/scenario';
import { TOKENS_CSS_RELATIVE_PATH, readRepoFile, themeBlocks } from '../../support/design-tokens';

/**
 * The third link, and the reason the other two are not enough.
 *
 * `design-tokens.test.ts` proves the stylesheet says what `DESIGN.md` says.
 * `contrast.test.ts` proves those colours clear WCAG and that every pair
 * `globals.css` composes clears it too, computed from the stylesheet rather than
 * from a table. Both read TEXT. Neither can tell you that a browser resolved
 * `--surface-base` to the value in that text on the screen a person is looking at —
 * a `@media` block with a broken guard, a stylesheet the layout forgot to import, a
 * `data-theme` written as `"system"` are each invisible to both, and each produces
 * exactly the wrong palette for somebody.
 *
 * Leaving that out would repeat the defect this repository has already paid for
 * once: two green ends and an unexecuted middle. So the expected values below are
 * read from `tokens.css` by the SAME parser the gates use, and compared with
 * `getComputedStyle` in a real Chromium at all three theme states.
 *
 * It also carries the acceptance criteria only a browser can answer: the 48px
 * button floor, the 44px touch target, a visible focus ring on every KIND of
 * control, reflow at 320px with no horizontal scrolling, the font actually loading,
 * and a countdown that keeps counting under `prefers-reduced-motion: reduce`.
 *
 * ## One thing computed style cannot see, and how it is covered instead
 *
 * An ancestor's `overflow: hidden` CLIPS a descendant's outline, and
 * `getComputedStyle` on the clipped element still reports `2px solid` — so a focus
 * ring can be measured as present and be invisible on screen. That is not
 * hypothetical: `.theme-switch` shipped with `overflow: hidden` to round its pill,
 * which ate the ring on the only three controls this story adds. The rule for it is
 * therefore STRUCTURAL — walk the ancestors of every focusable control and refuse a
 * clipping one — and it lives beside the measured cases below.
 */

/**
 * The palettes, straight out of the file the two gates check.
 *
 * `process.cwd()` is the repository root here — every `webServer.command` in
 * `playwright.config.ts` is written relative to it, and `global-teardown.ts` already
 * depends on the same fact. The support module deliberately exports a relative path
 * rather than resolving one itself, because it is loaded by two runners with two
 * different ideas of what a module knows about its own location.
 */
const BLOCKS = themeBlocks(readRepoFile(process.cwd(), TOKENS_CSS_RELATIVE_PATH));
const LIGHT_SURFACE = BLOCKS.light.get('--surface-base') ?? '';
const DARK_SURFACE = BLOCKS.mediaDark.get('--surface-base') ?? '';
const LIGHT_INK = BLOCKS.light.get('--ink-primary') ?? '';
const DARK_INK = BLOCKS.mediaDark.get('--ink-primary') ?? '';
const PRIMARY = { light: BLOCKS.light.get('--primary') ?? '', dark: BLOCKS.mediaDark.get('--primary') ?? '' };

/**
 * `#F3F0FF` → `rgb(243, 240, 255)`, which is the shape a computed style has.
 *
 * It THROWS on anything that is not a six-digit hex rather than returning
 * `rgb(NaN, NaN, NaN)`. A `NaN` string compares unequal to everything, so the
 * failure it produced was a colour mismatch pointing at the palette — sending the
 * next reader to look at `tokens.css` for a bug that is in this function.
 */
function toRgb(hex: string): string {
  const digits = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    throw new Error(
      `toRgb expects a six-digit hex colour and was given ${JSON.stringify(hex)} — ` +
        'shorthand and alpha forms are not handled because tokens.css writes neither',
    );
  }
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * One spelling for a value, so a comparison is about the design and not the build.
 *
 * `tokens.css` is minified on the way into the bundle, and the minifier is allowed
 * to rewrite a value into any equivalent form: `#FFFFFF` comes back as `#fff`,
 * `cubic-bezier(0.2, 0, 0, 1)` loses its spaces and its leading zeroes, `120ms`
 * becomes `.12s`. Those are the SAME values, and a test that failed on them would be
 * asserting about Turbopack rather than about the palette — the sort of red that
 * gets a real check deleted.
 *
 * The byte-for-byte comparison between the file and `DESIGN.md` is the gates' job
 * (`design-tokens.test.ts`), and it still happens. This file asks a different
 * question: did the browser end up with this VALUE.
 */
function canonical(value: string): string {
  // Quote style is the serialiser's choice too: `'Be Vietnam Pro'` in the file
  // comes back as `"Be Vietnam Pro"` from `getPropertyValue`.
  const lowered = value.trim().toLowerCase().replace(/\s+/g, '').replace(/"/g, "'");
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(lowered);
  const expanded =
    short === null ? lowered : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;

  // A duration is a NUMBER with a unit, and `120ms` and `.12s` are the same one.
  const time = /^(-?(?:[0-9]+)?\.?[0-9]+)(ms|s)$/.exec(expanded);
  if (time !== null) {
    return `${Number(time[1]) * (time[2] === 's' ? 1000 : 1)}ms`;
  }

  // `0.02` and `.02` are one number; the minifier prefers the shorter spelling.
  return expanded.replace(/(^|[^0-9a-z.])0\./g, '$1.');
}

/** The value the browser resolved a custom property to, on `<html>`. */
async function tokenValue(page: Page, name: string): Promise<string> {
  return canonical(
    await page.evaluate(
      (property) =>
        getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
      name,
    ),
  );
}

/** The same normalisation for the expected side, so the two are comparable. */
function token(value: string): string {
  return canonical(value);
}

/** Put the browser in a hand-picked mode without going through the switch. */
async function chooseTheme(page: Page, label: 'Sáng' | 'Tối' | 'Theo hệ điều hành'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
}

test.describe('the token layer reaches the browser', () => {
  test('every value the file declares is the value Chromium resolves, in every state', async ({
    page,
  }) => {
    // The whole point of this file: a custom property that never made it into the
    // bundle resolves to the empty string, and the page just looks slightly wrong.
    expect(LIGHT_SURFACE.length, 'the parser read tokens.css').toBeGreaterThan(0);
    expect(BLOCKS.mediaDark.size, 'the parser read the dark blocks').toBeGreaterThan(20);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HOME_PATHNAME);

    for (const [name, expected] of BLOCKS.light) {
      expect(await tokenValue(page, name), `${name} in the light palette`).toBe(token(expected));
    }

    /**
     * Both dark blocks, token by token, and the hand-picked one is the half most
     * worth looping.
     *
     * `tokens.css` writes the dark palette TWICE — once inside the media query,
     * once under `[data-theme="dark"]` — because a media query cannot be reached
     * from a DOM attribute. The gate compares those two blocks with each other, but
     * "the two blocks agree" and "the browser applies either of them" are different
     * claims, and the earlier version of this case spot-checked one token of one of
     * them.
     */
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const [name, expected] of BLOCKS.mediaDark) {
      expect(await tokenValue(page, name), `${name} from the media query`).toBe(token(expected));
    }

    await page.emulateMedia({ colorScheme: 'light' });
    await chooseTheme(page, 'Tối');
    for (const [name, expected] of BLOCKS.attributeDark) {
      expect(await tokenValue(page, name), `${name} from data-theme="dark"`).toBe(token(expected));
    }
  });

  test('painting uses the tokens, not just declaring them', async ({ page }) => {
    // A palette nothing spends is a palette that can be wrong for ever. `body` is
    // the one surface every screen has.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HOME_PATHNAME);

    const painted = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { background: style.backgroundColor, color: style.color };
    });

    expect(painted.background).toBe(toRgb(LIGHT_SURFACE));
    expect(painted.color).toBe(toRgb(LIGHT_INK));
  });

  test('the Vietnamese face is actually loaded, not merely requested', async ({ page }) => {
    /**
     * `DESIGN.md § Typography` picks Be Vietnam Pro for one reason: the two-mark
     * combinations Vietnamese needs — ế, ượ, ỗ — have to stay legible at 12.5px on an
     * old laptop, and most popular sans faces set the marks too close there. If the
     * face silently fails to load, every one of those falls back to Roboto or Segoe
     * UI and the reason for the choice is gone, with nothing on screen saying so.
     *
     * Until this case existed, `vitest.config.mts` and `tests/support/next-font-google.ts`
     * BOTH told the reader that the browser suite proved the font — and it did not.
     * A comment claiming a test exists is worse than no comment.
     */
    await page.goto(HOME_PATHNAME);
    await page.evaluate(() => document.fonts.ready);

    const loaded = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      // The weights this design actually uses: 500 for body, 800 for every heading,
      // button and chip.
      body500: document.fonts.check("500 15px 'Be Vietnam Pro'"),
      heading800: document.fonts.check("800 34px 'Be Vietnam Pro'"),
    }));

    expect(loaded.body500, 'the 500 weight never loaded').toBe(true);
    expect(loaded.heading800, 'the 800 weight never loaded').toBe(true);
    // First in the stack, or the fallbacks win even when the face is available.
    expect(loaded.body.toLowerCase()).toMatch(/^["']?be vietnam pro/);
  });
});

test.describe('three theme states, and the guard between them', () => {
  test('follows the OS when nothing was chosen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HOME_PATHNAME);

    // No attribute at all is what "theo hệ điều hành" looks like in the DOM.
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
    expect(await tokenValue(page, '--surface-base')).toBe(token(DARK_SURFACE));
    expect(await tokenValue(page, '--ink-primary')).toBe(token(DARK_INK));
  });

  test('a hand-picked light beats a dark OS — the `:not()` guard', async ({ page }) => {
    /**
     * The matrix row a missing guard breaks, and the reason it is worth a browser.
     * `@media (prefers-color-scheme: dark) { :root { … } }` — without the
     * `:not([data-theme="light"])` — looks right in a diff, passes every check on a
     * light machine, and hands the dark palette to somebody who explicitly asked
     * for light. Nothing but a dark-emulated browser can see it.
     */
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HOME_PATHNAME);

    await chooseTheme(page, 'Sáng');

    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'light',
    );
    expect(await tokenValue(page, '--surface-base')).toBe(token(LIGHT_SURFACE));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      toRgb(LIGHT_SURFACE),
    );
  });

  test('a hand-picked dark beats a light OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HOME_PATHNAME);

    await chooseTheme(page, 'Tối');

    expect(await tokenValue(page, '--surface-base')).toBe(token(DARK_SURFACE));
  });

  test('going back to "theo hệ điều hành" REMOVES the attribute', async ({ page }) => {
    /**
     * `demo-san-pham.html:1117` stamps `data-theme` unconditionally on load, so the
     * follow-the-OS state is destroyed the moment its script runs — a script that
     * only ever calls `setAttribute` leaves a stale `dark` behind for somebody who
     * has since gone back to following their machine.
     *
     * The attribute has to be REMOVED, and this is where that is observed. (It is
     * not that `data-theme="system"` would fail to match — it would match
     * `:not([data-theme="light"])` perfectly well; `theme.ts` records the actual
     * reasons, which are about having one representation of one state.)
     */
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HOME_PATHNAME);

    await chooseTheme(page, 'Sáng');
    await chooseTheme(page, 'Theo hệ điều hành');

    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
    // And the palette is the machine's again, which is the fact the attribute is for.
    expect(await tokenValue(page, '--surface-base')).toBe(token(DARK_SURFACE));
  });

  test('the OS flipping mid-session is followed, in the palette AND in the announcement', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HOME_PATHNAME);
    const note = page.getByRole('group', { name: 'Giao diện' }).locator('p');

    expect(await tokenValue(page, '--surface-base')).toBe(token(LIGHT_SURFACE));
    await expect(note).toHaveText('Đang dùng giao diện sáng.');

    // No navigation between these two lines: the media query is what re-evaluates,
    // which is only true while `data-theme` is absent.
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await tokenValue(page, '--surface-base')).toBe(token(DARK_SURFACE));

    /**
     * The half that has an owner in JavaScript, and the half that used to have no
     * test at all. The palette above is pure CSS — delete the `matchMedia` listener
     * in `theme-switch.tsx` and it still passes. The SENTENCE is what the listener
     * exists for, because "theo hệ điều hành" states a preference and never a
     * result, and somebody who cannot see the page has no other way to learn which
     * of the two modes they ended up in.
     */
    await expect(note).toHaveText('Đang dùng giao diện tối.');
  });

  test('a choice survives a reload — palette, pressed button AND announcement', async ({
    page,
  }) => {
    /**
     * The blocking script in `<head>`, end to end, plus the switch's own memory.
     *
     * Applied any later — from a `useEffect`, say — the page paints one frame in the
     * wrong palette, which is the white flash a dark-mode user sees on every
     * navigation, and React reports a hydration mismatch on `<html>` as well.
     *
     * The last two assertions cover a separate deletion: remove the `localStorage`
     * read in `theme-switch.tsx` and the boot script still paints the right palette,
     * so a returning visitor gets a correctly dark page whose switch shows "Theo hệ
     * điều hành" pressed and whose live region says "Đang dùng giao diện sáng." The
     * paint and the controls describing it are two different claims.
     *
     * `domcontentloaded` rather than the default `load`: the question is whether the
     * attribute was there BEFORE the page finished, and waiting for `load` would
     * make a late script look punctual.
     */
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(HOME_PATHNAME);
    await chooseTheme(page, 'Tối');

    await page.goto(HOME_PATHNAME, { waitUntil: 'domcontentloaded' });

    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
      'dark',
    );
    expect(await tokenValue(page, '--surface-base')).toBe(token(DARK_SURFACE));

    await expect(page.getByRole('button', { name: 'Tối', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByRole('button', { name: 'Theo hệ điều hành', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('group', { name: 'Giao diện' }).locator('p')).toHaveText(
      'Đang dùng giao diện tối.',
    );
  });

  test('a corrupt stored value falls back to the OS instead of breaking the page', async ({
    page,
  }) => {
    // Somebody else's tab, an older version of this app, or a person poking at
    // devtools. The script must not throw in `<head>`: that stops the parser.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HOME_PATHNAME);
    await page.evaluate(() => localStorage.setItem('stuwith-theme', 'purple'));

    await page.goto(HOME_PATHNAME, { waitUntil: 'domcontentloaded' });

    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
    expect(await tokenValue(page, '--surface-base')).toBe(token(DARK_SURFACE));
    // The page rendered at all, which is the failure mode a thrown script produces.
    await expect(page.getByRole('heading', { name: 'StuWith' })).toBeVisible();
  });

  test('the announcement is never wrong, not even for one frame', async ({ page }) => {
    /**
     * A live region is the one place a briefly-wrong value does real damage: the
     * wrong value is the one that gets spoken, and the correction a tick later is
     * spoken too. `prefersDark` therefore starts as `null` and the note renders
     * nothing until the browser has been asked — so on a dark machine the region
     * never says "sáng" on its way to saying "tối".
     */
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(HOME_PATHNAME, { waitUntil: 'domcontentloaded' });

    // Whatever the region says, it says it once and it is right.
    await expect(page.getByRole('group', { name: 'Giao diện' }).locator('p')).toHaveText(
      'Đang dùng giao diện tối.',
    );
    // And the server-rendered HTML carries no announcement at all, which is what
    // "renders nothing until the browser has been asked" means before hydration.
    const served = await (await page.request.get(HOME_PATHNAME)).text();
    expect(served).not.toContain('Đang dùng giao diện');
  });
});

test.describe('the accessibility floor, measured rather than asserted', () => {
  /**
   * Every KIND of control this product renders, and the screen each one is on.
   *
   * The earlier version of these cases pressed `Tab` exactly once, so it only ever
   * measured the header's brand link — and a reviewer showed what that costs:
   * narrow the global rule to `:focus-visible:not(.field)` and no `outline: none`
   * string is written anywhere, the CSS text gate stays green, the single Tab still
   * lands on `.brand`, and somebody typing into the date field has no indicator at
   * all. Which is precisely the `demo-san-pham.html:184` defect this story documents
   * itself as refusing to port.
   */
  const FOCUSABLE: ReadonlyArray<{
    readonly what: string;
    readonly path: string;
    readonly selector: string;
  }> = [
    { what: 'the brand link', path: '/', selector: '.brand' },
    { what: 'a theme-switch button', path: '/', selector: '.theme-switch button' },
    { what: 'a primary button (link)', path: '/', selector: 'main .button-primary' },
    { what: 'a provider link', path: SIGN_IN_PATHNAME, selector: 'nav .button-secondary' },
    { what: 'the date input', path: DATE_OF_BIRTH_PATHNAME, selector: '.field' },
    { what: 'the submit button', path: DATE_OF_BIRTH_PATHNAME, selector: 'button[type="submit"]' },
  ];

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const control of FOCUSABLE) {
      test(`${control.what} shows a focus ring in ${colorScheme} mode`, async ({ page }) => {
        await scenario(page, { signedIn: control.path === DATE_OF_BIRTH_PATHNAME, declared: false });
        await page.emulateMedia({ colorScheme });
        await page.goto(control.path);

        const target = page.locator(control.selector).first();
        await expect(target).toBeVisible();
        // `focus()` rather than counting Tab presses: the number of stops between
        // here and there is a layout detail, and a case that breaks when a link is
        // added is a case somebody deletes. What is under test is the RING.
        await target.focus();

        const ring = await target.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            width: style.outlineWidth,
            style: style.outlineStyle,
            color: style.outlineColor,
            offset: style.outlineOffset,
          };
        });

        // `outline: none` in any spelling is the failure — `demo-san-pham.html:184`
        // has exactly that on its input, and it was deliberately not ported.
        expect(ring.style, `outline-style on ${control.selector}`).not.toBe('none');
        expect(ring.width, `outline-width on ${control.selector}`).toBe('2px');
        expect(ring.offset, `outline-offset on ${control.selector}`).toBe('2px');
        expect(ring.color, `outline-color on ${control.selector}`).toBe(toRgb(PRIMARY[colorScheme]));
      });
    }
  }

  test('no focusable control has an ancestor that would clip its ring', async ({ page }) => {
    /**
     * The rule computed style CANNOT enforce, and the reason it needs its own case.
     *
     * An ancestor's `overflow: hidden` clips a descendant's ink overflow, outlines
     * included — and `getComputedStyle` on the clipped element still cheerfully
     * reports `2px solid`. So every measured case above can pass while the ring is
     * invisible on screen.
     *
     * That is exactly what shipped: `.theme-switch` used `overflow: hidden` to round
     * its pill, and the three buttons inside it fill its content box while the ring
     * is drawn at `outline-offset: 2px`, i.e. outside them. The fix moved the corner
     * radii onto the first and last button; this is what stops it coming back.
     */
    await scenario(page, { signedIn: true, declared: false });

    for (const path of ['/', SIGN_IN_PATHNAME, DATE_OF_BIRTH_PATHNAME]) {
      await page.goto(path);

      const clipped = await page.evaluate(() => {
        const focusable = [
          ...document.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, [tabindex]',
          ),
        ].filter((element) => element.getAttribute('tabindex') !== '-1');

        const offenders: string[] = [];
        for (const element of focusable) {
          for (
            let ancestor = element.parentElement;
            ancestor !== null && ancestor !== document.documentElement;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            for (const axis of ['overflowX', 'overflowY'] as const) {
              if (style[axis] !== 'visible') {
                offenders.push(
                  `${element.tagName.toLowerCase()}.${element.className || '(no class)'} is inside ${ancestor.tagName.toLowerCase()}.${ancestor.className || '(no class)'} with ${axis}: ${style[axis]}`,
                );
              }
            }
          }
        }
        return { offenders: [...new Set(offenders)], seen: focusable.length };
      });

      // The sweep found controls to check, or it proves nothing.
      expect(clipped.seen, `no focusable control found on ${path}`).toBeGreaterThan(3);
      expect(clipped.offenders, `a clipping ancestor on ${path}`).toEqual([]);
    }
  });

  test('no interactive control is under the 48px button floor or the 44px target', async ({
    page,
  }) => {
    // `DESIGN.md § Components`: "Ngưỡng 48px là sàn cứng, không ngoại lệ cho nút
    // phụ", and `Do's and Don'ts`: touch target >= 44px even on desktop. The input
    // is in the sweep too — it carries the same `min-height: 48px` and was excluded
    // by a selector list that only named buttons.
    await scenario(page, { signedIn: true, declared: false });

    for (const path of [SIGN_IN_PATHNAME, DATE_OF_BIRTH_PATHNAME]) {
      await page.goto(path);
      await expect(page.locator('.button-primary, .button-secondary, .field').first()).toBeVisible();

      const boxes = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.button-primary, .button-secondary, .field, .theme-switch button',
          ),
        ].map((element) => {
          const rect = element.getBoundingClientRect();
          return { height: rect.height, width: rect.width, classes: element.className };
        }),
      );

      expect(boxes.length, `nothing matched on ${path}`).toBeGreaterThan(3);
      for (const box of boxes) {
        // A theme-switch button is a compact control and holds the 44px touch
        // target; everything the design calls a button or a field holds 48px.
        const floor = box.classes.includes('button-') || box.classes.includes('field') ? 48 : 44;
        expect(box.height, `${box.classes} on ${path} is ${box.height}px tall`).toBeGreaterThanOrEqual(
          floor,
        );
        expect(box.width, `${box.classes} on ${path} is ${box.width}px wide`).toBeGreaterThanOrEqual(
          44,
        );
      }
    }
  });

  test('reflows at 320px on every screen, in both palettes', async ({ page }) => {
    // WCAG 1.4.10, which is also what somebody zoomed to 200% on a desktop gets.
    // Both palettes because a mode change alters nothing about layout in THIS
    // stylesheet — and that is a claim, so it is measured rather than assumed.
    await scenario(page, { signedIn: true, declared: false });
    await page.setViewportSize({ width: 320, height: 800 });

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const path of ['/', SIGN_IN_PATHNAME, DATE_OF_BIRTH_PATHNAME]) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          overflow.scrollWidth,
          `${path} in ${colorScheme} scrolls horizontally at 320px`,
        ).toBeLessThanOrEqual(overflow.clientWidth);
      }
    }
  });

  test('the declaration form carries the design system, not just the login screens', async ({
    page,
  }) => {
    /**
     * `/khai-ngay-sinh` has the only text input in the product, and the earlier
     * version of this suite never visited it — so `.field`, `.field:focus`,
     * `.field[aria-invalid="true"]` and `.form-label` were asserted by the CSS text
     * gate and rendered by nothing.
     *
     * The border colour is the one that matters most here: `DESIGN.md` prescribes a
     * dashed `border-decor` for every empty input in one sentence and forbids
     * `border-decor` as the sole boundary of a clickable component in another, and
     * `border-decor` measures 1.41:1 against `surface-raised`. The resolution keeps
     * the dash and moves to `border-ink`; this is where that is observed on screen.
     */
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);

    const field = page.getByLabel('Ngày sinh của bạn');
    await expect(field).toBeVisible();

    const resting = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.borderTopStyle, color: style.borderTopColor, width: style.borderTopWidth };
    });
    expect(resting.style, 'the "chỗ để điền" signal is the DASH').toBe('dashed');
    expect(resting.width).toBe('2px');
    expect(resting.color, 'a decorative border colour is 1.41:1 and cannot be the only boundary').toBe(
      toRgb(BLOCKS.light.get('--border-ink') ?? ''),
    );

    // Focused, the dash becomes solid `primary` — and the outline is NOT switched
    // off, so the two signals stack rather than replace each other.
    await field.focus();
    const focused = await field.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderTopStyle,
        borderColor: style.borderTopColor,
        outline: style.outlineStyle,
      };
    });
    expect(focused.border).toBe('solid');
    expect(focused.borderColor).toBe(toRgb(PRIMARY.light));
    expect(focused.outline).not.toBe('none');
  });
});

test.describe('reduced motion turns off decoration and nothing else', () => {
  test('CSS transitions are off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(HOME_PATHNAME);

    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector('.button-primary') as Element).transitionDuration,
    );
    expect(duration).toBe('0s');
  });

  test('transitions are ON without the preference, so the rule above is not vacuous', async ({
    page,
  }) => {
    // Without this, a stylesheet that simply never declared a transition would pass
    // the case above and claim to respect a preference it never had to act on.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(HOME_PATHNAME);

    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector('.button-primary') as Element).transitionDuration,
    );
    expect(duration).not.toBe('0s');
  });

  test('the countdown keeps counting under `reduce`, because it is information', async ({
    page,
  }) => {
    /**
     * `DESIGN.md § motion`: "đồng hồ đếm ngược vẫn cập nhật vì đó là thông tin,
     * không phải hiệu ứng". The clock runs on `setTimeout` in React rather than on
     * a CSS animation, so the blanket `animation: none !important` above cannot
     * reach it — but "cannot reach it" is a claim about a mechanism, and this is
     * the case that turns it into an observation.
     *
     * It also closes the residue `deferred-work.md` recorded for Story 1.3b: the
     * `web` project has no DOM, so nothing had ever seen React actually call the
     * callback inside that `setTimeout`. A real browser watching the number go down
     * is exactly that missing observation.
     */
    await scenario(page, { signedIn: false });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${SIGN_IN_PATHNAME}?ket-qua=bi-khoa&giay=30`);

    // The countdown's own class, not a text match: the component wraps every tick
    // after the first in an `aria-hidden` span, so a text locator matches two
    // nested elements and Playwright's strict mode refuses both.
    const clock = page.locator('.notice-countdown');
    await expect(clock).toBeVisible();
    const first = (await clock.textContent()) ?? '';

    await expect(clock).not.toHaveText(first, { timeout: 5_000 });

    const seconds = (text: string): number => Number(/(\d+)/.exec(text)?.[1] ?? '0');
    expect(seconds((await clock.textContent()) ?? '')).toBeLessThan(seconds(first));
  });
});
