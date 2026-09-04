import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout from './layout';
import { SessionExpiryProvider } from './session-expiry-provider';

/**
 * The root layout is the only place the session seam is mounted, so "is it
 * mounted" is a property of this file and of nothing else.
 *
 * Removing `<SessionExpiryProvider>` from it deletes the feature for every route
 * in the product, and until this test existed it did so with the whole suite
 * green. What is asserted is deliberately structural: the layout is a Server
 * Component whose provider starts CLOSED, so there is no dialog in the markup to
 * look for — the observable fact is which component wraps the children.
 */

/** One step down a returned element tree, with a readable failure. */
function onlyChild(element: ReactElement, expectedType: unknown): ReactElement {
  const props = element.props as { children?: unknown };
  const child = props.children as ReactElement;
  expect(child, `expected a child under ${String(element.type)}`).toBeTruthy();
  expect(child.type).toBe(expectedType);
  return child;
}

describe('RootLayout', () => {
  const children = <p id="trang">Nội dung</p>;

  it('wraps the page in the session-expiry provider, inside the body', () => {
    const html = RootLayout({ children }) as ReactElement;

    expect(html.type).toBe('html');
    const body = onlyChild(html, 'body');
    // The one assertion that matters: without this the seam exists and nothing
    // mounts it, so no 401 anywhere in the app can raise a dialog.
    onlyChild(body, SessionExpiryProvider);
  });

  it('hands the provider the API origin, read once here', () => {
    const html = RootLayout({ children }) as ReactElement;
    const provider = onlyChild(onlyChild(html, 'body'), SessionExpiryProvider);
    const props = provider.props as { apiBaseUrl: string; children: unknown };

    // A string, always — `undefined` would reach `signInStartHref` and produce
    // `undefined/v1/auth/google/start`.
    expect(typeof props.apiBaseUrl).toBe('string');
    expect(props.children).toBe(children);
  });

  it('still renders the page itself', () => {
    // The provider must WRAP the children, not replace them. A layout that mounted
    // the seam and dropped its child would pass the structural check above.
    const markup = renderToStaticMarkup(RootLayout({ children }) as ReactElement);

    expect(markup).toContain('<html lang="vi">');
    expect(markup).toContain('id="trang"');
  });

  it('renders no dialog on an ordinary page load', () => {
    // The seam starts closed. A dialog in the markup of every route would be the
    // opposite of the feature.
    const markup = renderToStaticMarkup(RootLayout({ children }) as ReactElement);

    expect(markup).not.toContain('role="dialog"');
  });
});
