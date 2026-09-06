import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout from './layout';
import { SessionExpiryProvider } from './session-expiry-provider';
import { ThemeSwitch } from './theme-switch';
import { themeBootScript } from './theme';

/**
 * The root layout is the only place the session seam is mounted, so "is it
 * mounted" is a property of this file and of nothing else.
 *
 * Removing `<SessionExpiryProvider>` from it deletes the feature for every route
 * in the product, and until this test existed it did so with the whole suite
 * green. What is asserted is deliberately structural: the layout is a Server
 * Component whose provider starts CLOSED, so there is no dialog in the markup to
 * look for — the observable fact is which component wraps the children.
 *
 * Story 1.6 gave the layout three more jobs, and each of them is deletable in
 * exactly the same silent way, so each has an example here: the stylesheet that
 * carries the whole design system, the blocking script that decides the palette
 * before the first paint, and the switch that lets somebody change it.
 *
 * `next/font/google` is aliased to a stub for this project — its real module is a
 * zero-byte compile-time placeholder. See `vitest.config.mts` and
 * `tests/support/next-font-google.ts`; the font itself is proved by `next build`
 * and by the browser suite, not here.
 */

/** One step down a returned element tree, with a readable failure. */
function onlyChild(element: ReactElement, expectedType: unknown): ReactElement {
  const props = element.props as { children?: unknown };
  const child = props.children as ReactElement;
  expect(child, `expected a child under ${String(element.type)}`).toBeTruthy();
  expect(child.type).toBe(expectedType);
  return child;
}

/** Every element in a subtree, so a search does not depend on nesting depth. */
function descendants(node: unknown): ReactElement[] {
  if (!isValidElement(node)) {
    return Children.toArray(node as never).flatMap((child) =>
      isValidElement(child) ? descendants(child) : [],
    );
  }
  const props = node.props as { children?: unknown };
  return [
    node,
    ...Children.toArray(props.children as never).flatMap((child) => descendants(child)),
  ];
}

describe('RootLayout', () => {
  const children = <p id="trang">Nội dung</p>;

  it('renders exactly a head and a body under <html>, and nothing else', () => {
    /**
     * The guard `onlyChild(html, 'body')` used to be, restored after `<head>`
     * arrived and made a single-child assertion impossible.
     *
     * Dropping it left `<html>` open: a third element emitted there — a stray
     * script, a provider somebody moved up one level — would have passed
     * unremarked, and `<html>` is the one place in a Next app where a mistake like
     * that is invisible in every screenshot and every page of markup a reviewer
     * scrolls past.
     */
    const html = RootLayout({ children }) as ReactElement;
    const props = html.props as { children?: unknown };
    const kinds = ([] as unknown[])
      .concat(props.children as never)
      .filter((child) => isValidElement(child))
      .map((child) => (child as ReactElement).type);

    expect(html.type).toBe('html');
    expect(kinds).toEqual(['head', 'body']);
  });

  it('wraps the page in the session-expiry provider, inside the body', () => {
    const html = RootLayout({ children }) as ReactElement;

    expect(html.type).toBe('html');
    const props = html.props as { children?: unknown };
    const body = Children.toArray(props.children as never).find(
      (child) => isValidElement(child) && child.type === 'body',
    ) as ReactElement;
    expect(body, 'the layout must still render a <body>').toBeTruthy();
    // The one assertion that matters: without this the seam exists and nothing
    // mounts it, so no 401 anywhere in the app can raise a dialog.
    onlyChild(body, SessionExpiryProvider);
  });

  it('hands the provider the API origin, read once here', () => {
    const html = RootLayout({ children }) as ReactElement;
    const provider = descendants(html).find((element) => element.type === SessionExpiryProvider);
    expect(provider, 'the provider must be mounted').toBeTruthy();
    const props = (provider as ReactElement).props as { apiBaseUrl: string; children: unknown };

    // A string, always — `undefined` would reach `signInStartHref` and produce
    // `undefined/v1/auth/google/start`.
    expect(typeof props.apiBaseUrl).toBe('string');
    // The page is INSIDE the provider, beside the header rather than instead of
    // it: the header was added in Story 1.6 and a layout that mounted it and lost
    // the page would still pass a `children === children` identity check.
    // The RAW array, not `Children.toArray`: that helper clones every element to
    // stamp a key on it, so identity is gone and the assertion would be about a
    // copy rather than about the element the layout was handed.
    expect(([] as unknown[]).concat(props.children as never)).toContain(children);
  });

  it('still renders the page itself', () => {
    // The provider must WRAP the children, not replace them. A layout that mounted
    // the seam and dropped its child would pass the structural check above.
    const markup = renderToStaticMarkup(RootLayout({ children }) as ReactElement);

    expect(markup).toContain('<html lang="vi"');
    expect(markup).toContain('id="trang"');
  });

  it('renders no dialog on an ordinary page load', () => {
    // The seam starts closed. A dialog in the markup of every route would be the
    // opposite of the feature.
    const markup = renderToStaticMarkup(RootLayout({ children }) as ReactElement);

    expect(markup).not.toContain('role="dialog"');
  });
});

describe('the design system is mounted here or nowhere', () => {
  const markup = renderToStaticMarkup(RootLayout({ children: <p id="trang" /> }) as ReactElement);

  it('imports the stylesheet, which is the app’s only route to the tokens', () => {
    /**
     * A source-level check, because there is nothing else to look at: the `web`
     * project runs with Vitest's default `css: false`, so `import './globals.css'`
     * is stubbed to an empty module and produces no markup. That was MEASURED —
     * the import does not make this file red — but it also means the import can be
     * deleted with every example still green, and deleting it removes every colour,
     * every focus ring and every 48px minimum from the entire product.
     */
    expect(layoutSource()).toContain("import './globals.css'");
  });

  it('runs the theme boot script before the first paint, in the head', () => {
    // In `<head>` and blocking, or it is worse than nothing: applied later it
    // paints one frame in the wrong palette and React reports a hydration
    // mismatch on `<html>`. The exact string is the one `theme.test.ts` executes.
    expect(markup).toContain('<head>');
    expect(markup).toContain(themeBootScript());
    expect(markup.indexOf(themeBootScript())).toBeLessThan(markup.indexOf('<body>'));
  });

  it('suppresses the hydration warning on <html>, because the script changes it', () => {
    // The server cannot know a choice that lives in somebody's browser, so the
    // mismatch is expected and is suppressed for this element only. Without the
    // attribute every visitor who picked a mode by hand sees a React error.
    expect(layoutSource()).toContain('suppressHydrationWarning');
  });

  it('mounts the theme switch, so the choice is reachable from every screen', () => {
    const mounted = descendants(RootLayout({ children: <p /> }) as ReactElement).some(
      (element) => element.type === ThemeSwitch,
    );
    expect(mounted, 'the theme switch is mounted nowhere else').toBe(true);
  });

  it('puts the header before the page in document order', () => {
    // Two Tab presses from the top of any screen, and never after the whole page.
    //
    // `toContain` FIRST, and it is not belt and braces: `indexOf` returns `-1` for
    // a string that is not there, and `-1` is less than everything — so deleting the
    // header entirely made the one example guarding header order go green on the
    // header being gone. Its sibling above already had this guard; this one did not.
    expect(markup).toContain('page-header');
    expect(markup).toContain('id="trang"');
    expect(markup.indexOf('page-header')).toBeLessThan(markup.indexOf('id="trang"'));
  });
});

/**
 * The layout's own text.
 *
 * Two of the facts above are not observable from a render in this project — a CSS
 * import that the runner stubs away, and a JSX attribute React does not emit — and
 * a fact nothing can observe is a fact that can be deleted with the suite green.
 * Reading the source is the same answer `routes.test.ts` and `seam-usage.test.ts`
 * reached for the rules a DOM-less project cannot execute.
 */
function layoutSource(): string {
  return readFileSync(new URL('./layout.tsx', import.meta.url), 'utf8');
}
