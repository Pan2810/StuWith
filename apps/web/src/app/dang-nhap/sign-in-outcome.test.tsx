import { SIGN_IN_OUTCOMES, type SignInOutcome } from '@stuwith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SignInOutcomeNotice,
  nextLocationAfterOutcome,
  resolveSignInOutcome,
} from './sign-in-outcome';

/**
 * Rows 8 and 9 of the story's I/O matrix — "a made-up outcome code" and "a
 * malicious one" — are claims about what the PAGE renders, and until this file
 * existed nothing executed that path at all. `contracts.test.ts` pins that
 * `isSignInOutcome` rejects an unknown string; nothing pinned that the login page
 * asks it. Replacing the guard with a cast would have left every other test green
 * while making both rows false.
 *
 * These render for real: `renderToStaticMarkup` is `react-dom`, already a
 * dependency, and needs no DOM environment — so the assertions are about actual
 * output HTML rather than about a value on its way to a renderer.
 */
function render(outcome: SignInOutcome | null, canSignIn = true): string {
  return renderToStaticMarkup(<SignInOutcomeNotice outcome={outcome} canSignIn={canSignIn} />);
}

/** What the page does on load: read the location, then render the result. */
function renderForSearch(search: string): string {
  return render(nextLocationAfterOutcome({ search, pathname: '/dang-nhap', hash: '' }).outcome);
}

describe('the sentences on the screen are the ones the AC specifies', () => {
  it('renders AC1 verbatim, in the voice of an error', () => {
    const html = renderForSearch('?ket-qua=that-bai');

    expect(html).toBe('<p role="alert">Không đăng nhập được. Thử lại hoặc chọn cách khác.</p>');
  });

  it('renders AC2 verbatim, and NOT as an error', () => {
    const html = renderForSearch('?ket-qua=da-huy');

    // `status` rather than `alert`: the person changed their mind, and the page
    // must not present that as something going wrong. Colour is not the channel —
    // there is no colour here yet, and there must not need to be.
    expect(html).toBe(
      '<p role="status">Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới.</p>',
    );
    expect(html).not.toContain('alert');
  });

  it.each([...SIGN_IN_OUTCOMES])('says something for the declared code %s', (outcome) => {
    // Guards against the opposite failure: an outcome added to the contract with
    // no sentence behind it, which renders an empty box instead of an explanation.
    expect(render(outcome).length).toBeGreaterThan(0);
  });
});

describe('the notice appears only where it can be acted on', () => {
  /**
   * A signed-in visitor can reach `/dang-nhap?ket-qua=da-huy` from a stale link
   * or the back button. "Chọn lại cách đăng nhập bên dưới" above a signed-in view
   * with no login buttons under it is an instruction nobody can follow.
   */
  it.each([...SIGN_IN_OUTCOMES])('renders nothing for %s when signing in is not offered', (o) => {
    expect(render(o, false)).toBe('');
  });

  it('still renders when signing in IS offered', () => {
    expect(render('that-bai', true)).not.toBe('');
  });
});

describe('Matrix row: a made-up outcome code', () => {
  it.each([
    ['a code nobody declared', '?ket-qua=khong-co-that'],
    ['an empty value', '?ket-qua='],
    ['a near miss', '?ket-qua=that-bai-roi'],
    ['different casing', '?ket-qua=That-Bai'],
    ['the parameter repeated with junk first', '?ket-qua=nonsense&ket-qua=that-bai'],
  ])('renders no message at all for %s', (_label, search) => {
    // Not "renders a fallback message" — nothing. A visit with a junk parameter
    // has to look exactly like an ordinary visit.
    expect(renderForSearch(search)).toBe('');
  });

  it('renders nothing when there is no parameter, which is the ordinary visit', () => {
    expect(renderForSearch('')).toBe('');
    expect(resolveSignInOutcome('').present).toBe(false);
  });
});

describe('Matrix row: a malicious outcome code', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '%3Cscript%3Ealert(1)%3C/script%3E',
    '"><img src=x onerror=alert(1)>',
    'javascript:alert(document.cookie)',
    'that-bai"><script>alert(1)</script>',
  ];

  it.each(payloads)('never reaches the screen: %s', (payload) => {
    const html = renderForSearch(`?ket-qua=${encodeURIComponent(payload)}`);

    // The closed enum stops it before rendering, so the strong assertion is that
    // there is no output at all — stronger than "the output was escaped", which
    // is what a test would settle for if the value were being reflected.
    expect(html).toBe('');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('onerror');
  });

  it.each(payloads)('resolves to no outcome rather than to a cast: %s', (payload) => {
    expect(resolveSignInOutcome(`?ket-qua=${encodeURIComponent(payload)}`).outcome).toBeNull();
  });

  it('does not reflect the raw value anywhere in the output', () => {
    const payload = '<script>alert("stuwith")</script>';
    const html = renderForSearch(`?ket-qua=${encodeURIComponent(payload)}`);

    expect(html).not.toContain('stuwith');
    expect(html).not.toContain(payload);
    // Escaped forms too — an escaped reflection is still a reflection, and the
    // next person to add `dangerouslySetInnerHTML` inherits it.
    expect(html).not.toContain('&lt;script&gt;');
  });

  it('never lets a payload into the URL the page writes back', () => {
    // `nextUrl` goes straight into `history.replaceState`, so it is a second
    // surface the value could survive on even after the message is suppressed.
    const change = nextLocationAfterOutcome({
      search: '?ket-qua=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      pathname: '/dang-nhap',
      hash: '',
    });

    expect(change.nextUrl).toBe('/dang-nhap');
    expect(change.outcome).toBeNull();
  });
});

/**
 * The page's whole effect, minus the two browser calls. Read and rewrite come
 * back from ONE call, which is what makes "rewrite before read" — the reorder
 * that would make AC1 and AC2 invisible to every real user — unexpressible in
 * `page.tsx`.
 */
describe('what the address bar says afterwards', () => {
  it('reports the message AND the rewritten URL from the same call', () => {
    const change = nextLocationAfterOutcome({
      search: '?ket-qua=that-bai',
      pathname: '/dang-nhap',
      hash: '',
    });

    expect(change.outcome).toBe('that-bai');
    expect(change.nextUrl).toBe('/dang-nhap');
  });

  it('leaves the URL alone when there is no outcome parameter', () => {
    const change = nextLocationAfterOutcome({
      search: '?ref=email',
      pathname: '/dang-nhap',
      hash: '#top',
    });

    // `null` and not "the same string": the page must not call `replaceState` at
    // all for an ordinary visit.
    expect(change.nextUrl).toBeNull();
    expect(change.outcome).toBeNull();
  });

  it('keeps the path and the fragment', () => {
    expect(
      nextLocationAfterOutcome({
        search: '?ket-qua=da-huy&ref=email',
        pathname: '/dang-nhap',
        hash: '#chon-provider',
      }).nextUrl,
    ).toBe('/dang-nhap?ref=email#chon-provider');
  });

  it('strips an unrecognised value too, not just a valid one', () => {
    const resolved = resolveSignInOutcome('?ket-qua=<script>alert(1)</script>');

    expect(resolved.present).toBe(true);
    expect(resolved.outcome).toBeNull();
    expect(resolved.remainingSearch).toBe('');
  });

  it('shows nothing on the re-read, which is what a refresh becomes', () => {
    const first = nextLocationAfterOutcome({
      search: '?ket-qua=that-bai&ref=email',
      pathname: '/dang-nhap',
      hash: '',
    });
    expect(render(first.outcome)).not.toBe('');

    // Exactly what the browser would hand back after `history.replaceState`.
    const second = nextLocationAfterOutcome({
      search: '?ref=email',
      pathname: '/dang-nhap',
      hash: '',
    });
    expect(second.nextUrl).toBeNull();
    expect(render(second.outcome)).toBe('');
  });
});

/**
 * The query string belongs to whoever wrote it, not to this page. Re-serialising
 * it through `URLSearchParams.toString()` quietly rewrites escaping, collapses a
 * valueless key into `key=`, and turns `%20` into `+` — changes the page then
 * commits to the address bar on somebody else's behalf.
 */
describe('every other parameter survives byte for byte', () => {
  it.each([
    ['a percent escape', '?q=a%20b&ket-qua=that-bai', 'q=a%20b'],
    ['a valueless key', '?debug&ket-qua=that-bai', 'debug'],
    ['a literal plus', '?q=a+b&ket-qua=that-bai', 'q=a+b'],
    ['an encoded ampersand', '?q=a%26b&ket-qua=da-huy', 'q=a%26b'],
    ['order and position', '?ref=email&ket-qua=da-huy&lang=vi', 'ref=email&lang=vi'],
    ['the parameter last', '?a=1&b=2&ket-qua=that-bai', 'a=1&b=2'],
    ['the parameter first', '?ket-qua=that-bai&a=1&b=2', 'a=1&b=2'],
    ['a repeated outcome key', '?ket-qua=that-bai&a=1&ket-qua=da-huy', 'a=1'],
    ['a key that merely starts the same', '?ket-qua-cu=1&ket-qua=that-bai', 'ket-qua-cu=1'],
  ])('%s', (_label, search, expected) => {
    expect(resolveSignInOutcome(search).remainingSearch).toBe(expected);
  });

  it('survives a malformed escape rather than throwing', () => {
    // `decodeURIComponent('%zz')` throws. A stray escape in a link somebody sent
    // must not take the login page down with it.
    expect(resolveSignInOutcome('?bad=%zz&ket-qua=that-bai').remainingSearch).toBe('bad=%zz');
  });
});
