import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionExpiryProvider,
  SessionExpiryShell,
  defaultAuthorizedFetch,
  useApiBaseUrl,
  useAuthorizedFetch,
} from './session-expiry-provider';
import { SESSION_EXPIRY_TITLE } from './session-expiry-dialog';

/**
 * The wiring between the seam and the screen, rendered for real.
 *
 * This file exists because of a hole rather than for symmetry: with the dialog
 * rendered inline by a stateful provider, DELETING `<SessionExpiryDialog />`
 * removed the whole feature and left every test in the repo green. `useState`
 * cannot be executed by `renderToStaticMarkup`'s sibling assertions in a project
 * with no DOM, so the markup was split into {@link SessionExpiryShell}, which has
 * no hooks at all and can therefore be rendered at both of its states.
 *
 * `renderToStaticMarkup` comes from `react-dom`, which `apps/web` already depends
 * on, and needs no DOM environment — `jsdom`, `happy-dom` and `@testing-library/*`
 * are all absent on purpose and adding one is an "Ask First" item.
 */

const CHILD = <p id="phong-hoc">Phòng học</p>;

describe('the shell: the page and the dialog are siblings', () => {
  it('renders the page and nothing else while there is no prompt', () => {
    const html = renderToStaticMarkup(
      <SessionExpiryShell prompt={null} apiBaseUrl="https://api.test" onDismiss={() => undefined}>
        {CHILD}
      </SessionExpiryShell>,
    );

    expect(html).toContain('id="phong-hoc"');
    expect(html).not.toContain('role="dialog"');
  });

  it('renders the dialog AND keeps the page, in that order', () => {
    const html = renderToStaticMarkup(
      <SessionExpiryShell
        prompt={{ returnPath: '/phong-hoc/abc' }}
        apiBaseUrl="https://api.test"
        onDismiss={() => undefined}
      >
        {CHILD}
      </SessionExpiryShell>,
    );

    // Both present: the whole promise of the story is that the screen behind stays
    // where it was. A shell that replaced the page with the dialog would satisfy
    // "the dialog appears" and break the acceptance criterion.
    expect(html).toContain('id="phong-hoc"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain(SESSION_EXPIRY_TITLE);
    // A SIBLING after the page, not a wrapper around it.
    expect(html.indexOf('id="phong-hoc"')).toBeLessThan(html.indexOf('role="dialog"'));
  });

  it('hands the dialog the return path and the API origin it was given', () => {
    const html = renderToStaticMarkup(
      <SessionExpiryShell
        prompt={{ returnPath: '/phong-hoc/abc' }}
        apiBaseUrl="https://api.test"
        onDismiss={() => undefined}
      >
        {CHILD}
      </SessionExpiryShell>,
    );

    expect(html).toContain('https://api.test/v1/auth/google/start?quay-ve=%2Fphong-hoc%2Fabc');
  });
});

describe('the provider', () => {
  it('renders its children', () => {
    const html = renderToStaticMarkup(
      <SessionExpiryProvider apiBaseUrl="https://api.test">{CHILD}</SessionExpiryProvider>,
    );

    expect(html).toContain('id="phong-hoc"');
  });

  it('starts closed, so an ordinary page carries no dialog', () => {
    const html = renderToStaticMarkup(
      <SessionExpiryProvider apiBaseUrl="https://api.test">{CHILD}</SessionExpiryProvider>,
    );

    expect(html).not.toContain('role="dialog"');
  });

  it('supplies its own seam rather than leaving the default in place', () => {
    // The default is a bare credentialed `fetch` with no renewal and no reporting
    // (see below). A screen inside the provider must get the reporting one, and
    // "is it the default" is the only difference visible from a render.
    function Probe() {
      return <span>{useAuthorizedFetch() === defaultAuthorizedFetch ? 'default' : 'seam'}</span>;
    }

    const html = renderToStaticMarkup(
      <SessionExpiryProvider apiBaseUrl="https://api.test">
        <Probe />
      </SessionExpiryProvider>,
    );

    expect(html).toContain('seam');
    expect(html).not.toContain('default');
  });

  it('publishes the API origin it was given, so no screen re-reads process.env', () => {
    function Probe() {
      return <span data-base={useApiBaseUrl()} />;
    }

    const html = renderToStaticMarkup(
      <SessionExpiryProvider apiBaseUrl="https://api.test">
        <Probe />
      </SessionExpiryProvider>,
    );

    expect(html).toContain('data-base="https://api.test"');
  });
});

describe('the default outside any provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is still credentialed, and still resolves rather than throwing', async () => {
    // The road a screen takes when somebody forgets to mount the provider. Losing
    // the dialog is a degraded experience; a login screen that throws because a
    // provider is missing is a broken product. Losing `credentials: 'include'`
    // would be worse than either: the session cookie is `httpOnly`, so every
    // authenticated call would answer 401 for ever.
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const response = await defaultAuthorizedFetch('/v1/auth/me');

    expect(response.status).toBe(200);
    expect(seen[0]?.credentials).toBe('include');
  });

  it('keeps the caller’s own init', async () => {
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', (_input: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await defaultAuthorizedFetch('/v1/auth/logout', { method: 'POST' });

    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.credentials).toBe('include');
  });
});
