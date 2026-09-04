import { AUTH_PROVIDERS, SIGN_IN_RETURN_PATH_QUERY_PARAM } from '@stuwith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SESSION_EXPIRY_DISMISS_LABEL,
  SESSION_EXPIRY_MESSAGE,
  SESSION_EXPIRY_TITLE,
  SessionExpiryDialog,
} from './session-expiry-dialog';
import type { SessionExpiryPrompt } from './session-expiry';

/**
 * The dialog rendered for real.
 *
 * `renderToStaticMarkup` comes from `react-dom`, which `apps/web` already depends
 * on, and needs no DOM environment — so these assertions are about actual output
 * HTML rather than about a value on its way to a renderer. That matters most for
 * the two claims below that are properties of the MARKUP and of nothing else:
 * that the dialog does not block the page, and that it says nothing technical.
 */
function render(prompt: SessionExpiryPrompt | null): string {
  return renderToStaticMarkup(
    <SessionExpiryDialog prompt={prompt} apiBaseUrl="https://api.test" onDismiss={() => undefined} />,
  );
}

describe('closed', () => {
  it('renders nothing at all', () => {
    expect(render(null)).toBe('');
  });
});

describe('Matrix: the screen behind stays visible and stays scrollable', () => {
  const html = render({ returnPath: '/phong-hoc/abc' });

  it('is not a modal', () => {
    // The whole point of the story: somebody in the middle of a study session can
    // finish reading the sentence they were on before deciding to sign in again.
    expect(html).toContain('aria-modal="false"');
    expect(html).not.toContain('aria-modal="true"');
  });

  it('renders no backdrop, no fixed positioning and no scroll lock', () => {
    // Story 1.6 owns the styling, so there is nothing to paint yet — but the
    // things that would BLOCK the page are structural rather than decorative, and
    // none of them may appear even in a bare skeleton.
    expect(html).not.toContain('<dialog');
    expect(html.toLowerCase()).not.toContain('position:fixed');
    expect(html.toLowerCase()).not.toContain('overflow:hidden');
    expect(html.toLowerCase()).not.toContain('backdrop');
    expect(html).not.toContain('inert');
  });

  it('can be dismissed', () => {
    expect(html).toContain(SESSION_EXPIRY_DISMISS_LABEL);
    expect(html).toContain('<button type="button"');
  });

  it('is announced as a dialog and names itself', () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain(SESSION_EXPIRY_TITLE);
    expect(html).toContain(SESSION_EXPIRY_MESSAGE);
  });
});

describe('Matrix: no technical reason reaches the screen', () => {
  const words = render({ returnPath: '/phong-hoc/abc' })
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase();

  it.each([
    // English, because that is what a leak out of the API or a library would be
    // written in.
    '401',
    'token',
    'cookie',
    'oauth',
    'unauthenticated',
    'expired',
    'error',
    'v1/auth',
    /**
     * Vietnamese, because that is what a leak written by US would be in.
     *
     * The English list alone was a hole with the shape of the product: the whole
     * interface is Vietnamese, the default locale is Vietnamese, and every
     * sentence a person on this screen reads was written here — so a technical
     * reason reaching the screen would arrive as `mã lỗi 401` or `máy chủ không
     * phản hồi`, and sailed through a list that only knew the English words.
     */
    'mã lỗi',
    'máy chủ',
    'xác thực',
    'chứng thực',
    'hết hạn',
    'lỗi',
  ])('never says %s in the words a person actually reads', (forbidden) => {
    // The hrefs legitimately contain `/v1/auth` and a provider name; the
    // SENTENCES are what this checks, so the markup is stripped of tags first.
    //
    // Provider names are deliberately NOT on this list. The rule the epic states
    // is that a failing provider must not be named — offering somebody four ways
    // back in is the opposite of that, and a button reading "Tiếp tục với" and
    // nothing else would be unusable.
    //
    // "Phiên" is not on it either, and that is a judgement rather than an
    // oversight. It is the ordinary Vietnamese word for the thing that ended, and
    // it is the SUBJECT of the title — "Phiên đăng nhập đã kết thúc". Banning it
    // would not remove a technical detail, it would remove the sentence's ability
    // to say what happened, which is the one thing this dialog owes the person.
    // What the rule forbids is a REASON: a code, a component, a mechanism.
    expect(words).not.toContain(forbidden);
  });

  it('names no status code anywhere, not even in an attribute', () => {
    const html = render({ returnPath: '/phong-hoc/abc' });
    expect(html).not.toContain('401');
    expect(html).not.toContain('429');
  });
});

describe('the four ways back in', () => {
  it('offers every provider, each carrying the return path', () => {
    const html = render({ returnPath: '/phong-hoc/abc?tab=chat' });

    for (const provider of AUTH_PROVIDERS) {
      expect(html).toContain(
        `https://api.test/v1/auth/${provider}/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=%2Fphong-hoc%2Fabc%3Ftab%3Dchat`,
      );
    }
  });

  it('offers them with no parameter when there is no usable path', () => {
    // Losing the place to come back to must not cost somebody the way back in.
    const html = render({ returnPath: null });

    for (const provider of AUTH_PROVIDERS) {
      expect(html).toContain(`href="https://api.test/v1/auth/${provider}/start"`);
    }
    expect(html).not.toContain(SIGN_IN_RETURN_PATH_QUERY_PARAM);
  });

  it('renders no href pointing anywhere but our own API', () => {
    // Belt to the server's braces: the destination is decided from the signed
    // state, but a link built here is the first thing a person clicks.
    const html = render({ returnPath: '/phong-hoc/abc' });
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');

    expect(hrefs.length).toBe(AUTH_PROVIDERS.length);
    for (const href of hrefs) {
      expect(href.startsWith('https://api.test/v1/auth/')).toBe(true);
    }
  });
});
