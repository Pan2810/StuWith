import { AUTH_PROVIDERS } from '@stuwith/contracts';
import { expect, test } from '@playwright/test';
import { DATE_OF_BIRTH_PATHNAME, SIGN_IN_PATHNAME, scenario } from '../support/scenario';

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

  test('the dialog takes focus when it appears, and Escape gives it back', async ({ page }) => {
    /**
     * The behavioural gap `deferred-work.md` recorded against Story 1.3c, closed and
     * now watched.
     *
     * The dialog is INSERTED into the tree rather than changed inside an existing
     * live region, so nothing announced it: a screen reader stayed silent, and a
     * keyboard user standing at the bottom of a page never learned that four sign-in
     * links had appeared above them. Moving focus into it is what a non-blocking
     * `role="dialog"` is supposed to do — the reader announces the dialog on entry,
     * and Tab still walks straight back out because nothing traps it.
     *
     * This case belongs in a browser and nowhere else: the focus move is a
     * `useEffect` in the provider, and the `web` Vitest project has no DOM.
     */
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await expect(page.getByLabel('Ngày sinh của bạn')).toBeVisible();

    await scenario(page, { signedIn: false, refreshWorks: false });
    await page.reload();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Focus is ON the dialog container — which is focusable and NOT in the tab
    // order, so it never becomes a stop nobody asked for on an ordinary page.
    await expect(dialog).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('tabindex'))).toBe('-1');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Escape still closes the dialog after focus has LEFT it', async ({ page }) => {
    /**
     * The case that catches the version of Escape this file shipped with first.
     *
     * The handler was an `onKeyDown` on the dialog element, justified by "focus is
     * inside it when it opens, so the event bubbles". True for exactly as long as the
     * person stays inside — and the whole design is that they need not: nothing traps
     * focus, and the case below asserts they can walk straight out. Once focus is on
     * the page behind, the key event never passes through the dialog and Escape is
     * dead. The existing case stayed green because it pressed Escape at the one
     * instant the broken version worked.
     *
     * Shift+Tab rather than Tab, and that is the point: the dialog is the LAST thing
     * in the document, so tabbing forward from inside it leaves the page entirely.
     * Backwards lands on the screen behind — which is the whole promise of a
     * non-blocking dialog, and the position from which Escape has to keep working.
     */
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await scenario(page, { signedIn: false, refreshWorks: false });
    await page.reload();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    const outside = await page.evaluate(() => {
      const element = document.querySelector('[role="dialog"]');
      return element !== null && document.activeElement !== null
        ? !element.contains(document.activeElement)
        : false;
    });
    expect(outside, 'Shift+Tab must leave the dialog — nothing traps focus').toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the screen behind the dialog is never locked, blurred or covered', async ({ page }) => {
    // The acceptance criterion the whole dialog is shaped around: no backdrop, no
    // focus trap, and the page underneath still scrolls. Styling arrived in Story
    // 1.6, and a `position: fixed` card with an overlay is what a designer reaches
    // for by default — so the promise is measured rather than trusted.
    await scenario(page, { signedIn: true, declared: false });
    await page.goto(DATE_OF_BIRTH_PATHNAME);
    await scenario(page, { signedIn: false, refreshWorks: false });
    await page.reload();

    await expect(page.getByRole('dialog')).toBeVisible();

    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      const style = getComputedStyle(dialog);
      return {
        position: style.position,
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        inert: document.body.hasAttribute('inert'),
      };
    });

    expect(layout.position).not.toBe('fixed');
    expect(layout.bodyOverflow).not.toBe('hidden');
    expect(layout.htmlOverflow).not.toBe('hidden');
    expect(layout.inert).toBe(false);

    /**
     * Tab LEAVES the dialog rather than cycling inside it.
     *
     * Focus starts on the container, so one press per provider link plus one to
     * step off the container reaches the dismiss button; a trap would send it back
     * to the first link instead. The count comes from `AUTH_PROVIDERS` rather than
     * from a literal, because the number of ways back in is a contract decision and
     * this case is not about it — an added provider should not turn a focus-trap
     * assertion red for an unrelated reason.
     */
    for (let press = 0; press <= AUTH_PROVIDERS.length; press += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(page.getByRole('button', { name: 'Để sau' })).toBeFocused();
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
