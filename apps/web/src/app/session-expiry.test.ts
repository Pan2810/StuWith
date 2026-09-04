import { SIGN_IN_RETURN_PATH_QUERY_PARAM } from '@stuwith/contracts';
import { describe, expect, it } from 'vitest';
import {
  LOGIN_PATHNAME,
  SESSION_EXPIRED_STATUS,
  isLoginPathname,
  nextSessionExpiry,
  returnPathFor,
  signInStartHref,
  type SessionExpiryState,
} from './session-expiry';

/**
 * The web half of the story's I/O matrix.
 *
 * Every row below is a decision that used to have nowhere to live: `layout.tsx`
 * had no provider at all and the app contained two hand-written `fetch` calls, so
 * "the session just died" was a fact no screen could observe. Now it is one pure
 * function, which is the only shape a project with `environment: 'node'` and no
 * DOM can actually execute.
 */

const at = (pathname: string, search = ''): { pathname: string; search: string } => ({
  pathname,
  search,
});

describe('Matrix: a session that dies mid-visit', () => {
  it('opens the dialog on a 401 and remembers where the person was standing', () => {
    const state = nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at('/phong-hoc/abc', '?tab=chat'));

    expect(state).toEqual({ returnPath: '/phong-hoc/abc?tab=chat' });
  });

  it('opens with no path rather than not at all when the location cannot be expressed', () => {
    // A path carrying a percent escape is refused by the shared validator (see
    // `packages/contracts/src/auth.test.ts` for why there is no decode step). The
    // person still gets the dialog — losing the place to come back to must not
    // cost them the way back in.
    const state = nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at('/tim-kiem', '?q=%C3%A1'));

    expect(state).toEqual({ returnPath: null });
  });

  it.each([200, 201, 204, 400, 403, 404, 429, 500, 502, 503])(
    'leaves the dialog exactly as it was on a %i',
    (status) => {
      // Not "closes it". A dialog that vanished because some unrelated background
      // call succeeded would blink away while the person was reading it, and a
      // successful call proves nothing about the session — the seam sees status
      // codes, not sessions.
      const open: SessionExpiryState = { returnPath: '/phong-hoc/abc' };

      expect(nextSessionExpiry(null, status, at('/phong-hoc/abc'))).toBeNull();
      expect(nextSessionExpiry(open, status, at('/phong-hoc/abc'))).toBe(open);
    },
  );
});

describe('Matrix: already on the login page', () => {
  it.each([LOGIN_PATHNAME, `${LOGIN_PATHNAME}/`])('shows nothing for a 401 at %s', (pathname) => {
    // This is also what keeps the login page's own `/v1/auth/me` probe quiet: it
    // answers 401 for every signed-out visitor, by design, and a dialog saying
    // "sign in again" on top of the page that signs you in is noise.
    expect(nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at(pathname))).toBeNull();
  });

  it('does not treat a path that merely starts with the login route as the login page', () => {
    // `/dang-nhap-lai` is a different page and would have matched a `startsWith`.
    expect(isLoginPathname('/dang-nhap-lai')).toBe(false);
    expect(nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at('/dang-nhap-lai'))).toEqual({
      returnPath: '/dang-nhap-lai',
    });
  });

  it('proposes nothing when asked from the login page itself', () => {
    // A login started here lands on the login page anyway, so a `?quay-ve=` would
    // be a parameter that changes nothing while looking like it changes something.
    expect(returnPathFor(at(LOGIN_PATHNAME, '?ket-qua=that-bai'))).toBeNull();
  });
});

describe('Matrix: dismissed, then it happens again', () => {
  it('reopens on the next 401', () => {
    const location = at('/phong-hoc/abc');

    const opened = nextSessionExpiry(null, SESSION_EXPIRED_STATUS, location);
    expect(opened).not.toBeNull();

    // The person closes it and carries on.
    const dismissed: SessionExpiryState = null;

    // The very next authenticated call still has no session behind it.
    const reopened = nextSessionExpiry(dismissed, SESSION_EXPIRED_STATUS, location);
    expect(reopened).toEqual({ returnPath: '/phong-hoc/abc' });
  });

  it('has no dismissed flag to consult, which is what makes that true', () => {
    // Closing once and staying quiet for ever is the exact trap this feature
    // exists to avoid: the person dismisses the dialog, keeps clicking, and every
    // click silently does nothing. The state is the prompt itself, so there is
    // nowhere for a "seen it" bit to be stored.
    const location = at('/phong-hoc/abc');
    const seenTwice = nextSessionExpiry(
      nextSessionExpiry(
        nextSessionExpiry(null, SESSION_EXPIRED_STATUS, location),
        200,
        location,
      ),
      SESSION_EXPIRED_STATUS,
      location,
    );
    expect(seenTwice).toEqual({ returnPath: '/phong-hoc/abc' });
  });

  it('follows the person to a new location between two 401s', () => {
    const first = nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at('/a'));
    const second = nextSessionExpiry(first, SESSION_EXPIRED_STATUS, at('/b', '?x=1'));

    expect(second).toEqual({ returnPath: '/b?x=1' });
  });
});

describe('what gets proposed', () => {
  it.each([
    ['a plain path', '/phong-hoc/abc', '', '/phong-hoc/abc'],
    ['a path with a query', '/phong-hoc/abc', '?tab=chat', '/phong-hoc/abc?tab=chat'],
    ['the root', '/', '', '/'],
  ])('proposes %s', (_label, pathname, search, expected) => {
    expect(returnPathFor(at(pathname, search))).toBe(expected);
  });

  it('never proposes a hash, because a fragment cannot survive the round trip', () => {
    // `returnPathFor` reads `pathname` and `search` only. A fragment never reaches
    // the server, so carrying one would be a promise this flow cannot keep — and
    // `#` is not an allowed character in the shared validator either.
    expect(returnPathFor(at('/phong-hoc/abc', '?tab=chat'))).toBe('/phong-hoc/abc?tab=chat');
  });

  it.each([
    ['a location that has somehow lost its leading slash', 'phong-hoc/abc'],
    ['a protocol-relative pathname', '//evil.com'],
    ['a backslash spelling', '/\\evil.com'],
  ])('proposes nothing for %s', (_label, pathname) => {
    expect(returnPathFor(at(pathname))).toBeNull();
  });
});

describe('the /start href', () => {
  it('omits the parameter entirely when there is nothing to propose', () => {
    expect(signInStartHref('https://api.test', 'google', null)).toBe(
      'https://api.test/v1/auth/google/start',
    );
  });

  it('attaches the proposal under the contract parameter name', () => {
    const href = signInStartHref('https://api.test', 'google', '/phong-hoc/abc');

    expect(href).toBe(
      `https://api.test/v1/auth/google/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=%2Fphong-hoc%2Fabc`,
    );
  });

  it('encodes a path carrying its own query so it stays ONE parameter', () => {
    // The validator allows `?`, `=` and `&` — an internal link may carry a query —
    // so leaving them raw would split one proposal into several parameters, and
    // the server would read a truncated path or none at all.
    const href = signInStartHref('', 'microsoft', '/phong-hoc/abc?tab=chat&x=1');

    const query = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect([...query.keys()]).toEqual([SIGN_IN_RETURN_PATH_QUERY_PARAM]);
    expect(query.get(SIGN_IN_RETURN_PATH_QUERY_PARAM)).toBe('/phong-hoc/abc?tab=chat&x=1');
  });

  it('works with an empty base, which is what a same-origin API looks like', () => {
    expect(signInStartHref('', 'apple', null)).toBe('/v1/auth/apple/start');
  });
});
