import { AUTH_REFRESH_PATH, SIGN_IN_RETURN_PATH_QUERY_PARAM } from '@stuwith/contracts';
import { describe, expect, it } from 'vitest';
import {
  SESSION_EXPIRED_STATUS,
  SESSION_REFRESHED_STATUS,
  SIGN_IN_PATHNAME,
  authorizedCall,
  createSessionRefresher,
  isSignInPathname,
  nextSessionExpiry,
  normaliseApiBaseUrl,
  returnPathFor,
  signInStartHref,
  type FetchLike,
  type ReturnPathLocation,
  type SessionExpiryState,
} from './session-expiry';

/**
 * The web half of the story's I/O matrix.
 *
 * Every row below is a decision that used to have nowhere to live: `layout.tsx`
 * had no provider at all and the app contained two hand-written `fetch` calls, so
 * "the session just died" was a fact no screen could observe. Now it is a set of
 * plain functions, which is the only shape a project with `environment: 'node'`
 * and no DOM can actually execute.
 */

const at = (pathname: string, search = ''): ReturnPathLocation => ({ pathname, search });

/** A `Response` with nothing in it but the status the seam reads. */
const answering = (status: number): Response => new Response(null, { status });

/**
 * A `fetch` that answers from a script and records what it was asked.
 *
 * The recording is the point: "exactly one renewal was sent" and "the original
 * call was replayed once" are both claims about the CALLS, not about the answers.
 */
function scriptedFetch(answers: ReadonlyArray<Response | Error>): {
  fetchImpl: FetchLike;
  calls: Array<{ input: string; init?: RequestInit }>;
} {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    const answer = answers[index++];
    if (answer === undefined) {
      throw new Error(`unscripted call ${index} to ${input}`);
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fetchImpl, calls };
}

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
  it.each([SIGN_IN_PATHNAME, `${SIGN_IN_PATHNAME}/`])('shows nothing for a 401 at %s', (pathname) => {
    // This is also what keeps the login page's own `/v1/auth/me` probe quiet: it
    // answers 401 for every signed-out visitor, by design, and a dialog saying
    // "sign in again" on top of the page that signs you in is noise.
    expect(nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at(pathname))).toBeNull();
  });

  it('CLOSES a dialog that was opened somewhere else', () => {
    // The regression this replaced returned `current`, so a dialog raised on
    // `/phong-hoc` stayed stacked on top of `/dang-nhap` after the person clicked
    // through to sign in — the row says "no dialog here", and a dialog that is
    // already open is still a dialog. Every earlier example started from `null`,
    // which is why the whole class was invisible.
    const open: SessionExpiryState = { returnPath: '/phong-hoc/abc' };

    expect(nextSessionExpiry(open, SESSION_EXPIRED_STATUS, at(SIGN_IN_PATHNAME))).toBeNull();
  });

  it.each([200, 204, 404, 429, 500])(
    'closes it on a plain %i as well, with no 401 anywhere',
    (status) => {
      // Arriving on the login page is the whole trigger. Requiring a second 401 to
      // clear the dialog would leave it stacked for every person who navigated
      // here client-side and then made an ordinary successful call.
      const open: SessionExpiryState = { returnPath: '/phong-hoc/abc' };

      expect(nextSessionExpiry(open, status, at(SIGN_IN_PATHNAME, '?ket-qua=that-bai'))).toBeNull();
    },
  );

  it('does not treat a path that merely starts with the login route as the login page', () => {
    // `/dang-nhap-lai` is a different page and would have matched a `startsWith`.
    expect(isSignInPathname('/dang-nhap-lai')).toBe(false);
    expect(nextSessionExpiry(null, SESSION_EXPIRED_STATUS, at('/dang-nhap-lai'))).toEqual({
      returnPath: '/dang-nhap-lai',
    });
  });

  it('proposes nothing when asked from the login page itself', () => {
    // A login started here lands on the login page anyway, so a `?quay-ve=` would
    // be a parameter that changes nothing while looking like it changes something.
    expect(returnPathFor(at(SIGN_IN_PATHNAME, '?ket-qua=that-bai'))).toBeNull();
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
      nextSessionExpiry(nextSessionExpiry(null, SESSION_EXPIRED_STATUS, location), 200, location),
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

  it('never builds a PROTOCOL-RELATIVE href out of a slash-shaped base', () => {
    // `NEXT_PUBLIC_API_BASE_URL` does not go through `packages/config`'s schema,
    // so nothing else refuses `/`. Left alone it produced `//v1/auth/apple/start`
    // — a link to a host literally named `v1`, i.e. an off-origin navigation
    // wearing the shape of a local one. Same family as the `//` spelling
    // `parseInternalReturnPath` refuses at the other end of this flow.
    expect(signInStartHref('/', 'apple', null)).toBe('/v1/auth/apple/start');
    expect(signInStartHref('///', 'apple', null)).toBe('/v1/auth/apple/start');
    expect(signInStartHref('https://api.test/', 'apple', null)).toBe(
      'https://api.test/v1/auth/apple/start',
    );
  });

  it.each([
    ['', ''],
    ['/', ''],
    ['https://api.test', 'https://api.test'],
    ['https://api.test/', 'https://api.test'],
  ])('normalises %o to %o', (raw, expected) => {
    expect(normaliseApiBaseUrl(raw)).toBe(expected);
  });
});

/**
 * Story 1.3c, round 1. The seam tries to RENEW the session before it disturbs
 * anybody, and every rule about how it does that is executable here.
 *
 * Before this block existed, `apps/web` never called `/v1/auth/refresh` at all:
 * `SESSION_TTL_SECONDS` is an hour and the refresh token lives thirty days, so a
 * person doing nothing wrong met this dialog every hour.
 */
describe('Matrix: the renewal that happens before anybody is disturbed', () => {
  const room = at('/phong-hoc/abc');
  const deps = (fetchImpl: FetchLike, renew: () => Promise<boolean>, location = room) => ({
    fetchImpl,
    locationOf: () => location,
    renew,
  });

  it('replays the original call and shows NOTHING when the renewal works', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(401), answering(200)]);
    let renewals = 0;
    const renew = async () => {
      renewals += 1;
      return true;
    };

    const outcome = await authorizedCall(deps(fetchImpl, renew), 'https://api.test/v1/auth/me');

    expect(renewals).toBe(1);
    // The SAME call, sent again — not a different URL and not a different method.
    expect(calls.map((call) => call.input)).toEqual([
      'https://api.test/v1/auth/me',
      'https://api.test/v1/auth/me',
    ]);
    expect(outcome.status).toBe(200);
    expect(outcome.response.status).toBe(200);
    // Which is the row: no dialog, and the person sees nothing at all.
    expect(nextSessionExpiry(null, outcome.status, outcome.location)).toBeNull();
  });

  it('carries the caller’s own init into the replay, credentials included', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(401), answering(204)]);

    await authorizedCall(deps(fetchImpl, async () => true), 'https://api.test/v1/auth/logout', {
      method: 'POST',
    });

    for (const call of calls) {
      expect(call.init?.method).toBe('POST');
      // The session lives in an httpOnly cookie: an uncredentialed replay would
      // answer 401 for ever and look like a dead session.
      expect(call.init?.credentials).toBe('include');
    }
  });

  it('opens the dialog when the renewal itself is refused', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(401)]);

    const outcome = await authorizedCall(deps(fetchImpl, async () => false), '/v1/auth/me');

    // No replay: there is nothing to replay a call into.
    expect(calls.length).toBe(1);
    expect(outcome.status).toBe(401);
    expect(nextSessionExpiry(null, outcome.status, outcome.location)).toEqual({
      returnPath: '/phong-hoc/abc',
    });
  });

  it('goes straight to the dialog when the REPLAY is 401, with no second renewal', async () => {
    // Not recursion. A replay that is still refused means the renewal bought
    // nothing, and asking again is how one dead session becomes a request storm.
    const { fetchImpl, calls } = scriptedFetch([answering(401), answering(401)]);
    let renewals = 0;
    const renew = async () => {
      renewals += 1;
      return true;
    };

    const outcome = await authorizedCall(deps(fetchImpl, renew), '/v1/auth/me');

    expect(renewals).toBe(1);
    expect(calls.length).toBe(2);
    expect(outcome.status).toBe(401);
    expect(nextSessionExpiry(null, outcome.status, outcome.location)).not.toBeNull();
  });

  it('does not renew on the login page, where 401 is the ordinary answer', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(401)]);
    let renewals = 0;
    const renew = async () => {
      renewals += 1;
      return true;
    };

    const outcome = await authorizedCall(
      deps(fetchImpl, renew, at(SIGN_IN_PATHNAME)),
      '/v1/auth/me',
    );

    // Renewing here would spend one rate-limited `auth_refresh` for every
    // anonymous visit to the login page, and the dialog is suppressed there
    // anyway — so the request would buy nothing at all.
    expect(renewals).toBe(0);
    expect(calls.length).toBe(1);
    expect(outcome.status).toBe(401);
  });

  it('hands a non-401 straight back without renewing or replaying', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(429)]);
    let renewals = 0;

    const outcome = await authorizedCall(
      deps(fetchImpl, async () => {
        renewals += 1;
        return true;
      }),
      '/v1/auth/me',
    );

    expect(renewals).toBe(0);
    expect(calls.length).toBe(1);
    expect(outcome.status).toBe(429);
  });

  it('refuses to renew a call whose body cannot be sent twice', async () => {
    // A `ReadableStream` body is consumed by the first request. Replaying the same
    // `init` would send an EMPTY body and very likely get a 200 back — a silent
    // wrong answer, which is worse than the 401 the caller now sees.
    const { fetchImpl, calls } = scriptedFetch([answering(401)]);
    let renewals = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    const outcome = await authorizedCall(
      deps(fetchImpl, async () => {
        renewals += 1;
        return true;
      }),
      '/v1/rooms/abc/messages',
      { method: 'POST', body },
    );

    expect(renewals).toBe(0);
    expect(calls.length).toBe(1);
    expect(outcome.status).toBe(401);
  });

  it('reads the location ONCE, so no updater has to read it for itself', async () => {
    // React calls a `setState` updater twice under StrictMode. Reading
    // `window.location` inside one makes it a non-pure function of its arguments;
    // the seam hands back the location it actually used instead.
    const { fetchImpl } = scriptedFetch([answering(401), answering(200)]);
    let reads = 0;

    const outcome = await authorizedCall(
      {
        fetchImpl,
        locationOf: () => {
          reads += 1;
          return room;
        },
        renew: async () => true,
      },
      '/v1/auth/me',
    );

    expect(reads).toBe(1);
    expect(outcome.location).toBe(room);
  });
});

describe('Matrix: several 401s at once share ONE renewal', () => {
  it('sends exactly one POST /v1/auth/refresh for two simultaneous callers', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(SESSION_REFRESHED_STATUS)]);
    const renew = createSessionRefresher({ fetchImpl, apiBaseUrl: 'https://api.test' });

    const [first, second] = await Promise.all([renew(), renew()]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    // Refresh tokens ROTATE. Two requests means the second one presents a token
    // the first has just replaced, which the session store reads as a replay and
    // answers by revoking the whole chain — two honest calls would sign the person
    // out. Sharing the promise is what stops the feature defeating itself.
    expect(calls.length).toBe(1);
    expect(calls[0]?.input).toBe(`https://api.test${AUTH_REFRESH_PATH}`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
  });

  it('drives that from two real authorized calls, not from the refresher alone', async () => {
    // Both calls 401, both renew, both replay — three request slots plus ONE
    // renewal between them.
    const meAnswers = scriptedFetch([answering(401), answering(200)]);
    const roomAnswers = scriptedFetch([answering(401), answering(200)]);
    const refreshCalls: string[] = [];
    const renew = createSessionRefresher({
      fetchImpl: (input) => {
        refreshCalls.push(input);
        return Promise.resolve(answering(SESSION_REFRESHED_STATUS));
      },
      apiBaseUrl: '',
    });
    const location = { pathname: '/phong-hoc/abc', search: '' };

    await Promise.all([
      authorizedCall({ fetchImpl: meAnswers.fetchImpl, locationOf: () => location, renew }, '/me'),
      authorizedCall(
        { fetchImpl: roomAnswers.fetchImpl, locationOf: () => location, renew },
        '/room',
      ),
    ]);

    expect(refreshCalls).toEqual([AUTH_REFRESH_PATH]);
    expect(meAnswers.calls.length).toBe(2);
    expect(roomAnswers.calls.length).toBe(2);
  });

  it('renews again for a LATER expiry, once the first renewal has finished', async () => {
    // The single-flight rule is about concurrency, not about a lifetime budget: an
    // hour later the access token ages out again and that is an ordinary renewal.
    const { fetchImpl, calls } = scriptedFetch([answering(SESSION_REFRESHED_STATUS), answering(SESSION_REFRESHED_STATUS)]);
    const renew = createSessionRefresher({ fetchImpl, apiBaseUrl: '' });

    expect(await renew()).toBe(true);
    expect(await renew()).toBe(true);
    expect(calls.length).toBe(2);
  });

  it.each([401, 429])('stops asking once the renewal is refused with %i', async (status) => {
    // 401 means there is nothing left to renew; 429 means asking is the problem.
    // Retrying either turns one dead session into a storm against a rate-limited
    // endpoint, with every later call starting another.
    const { fetchImpl, calls } = scriptedFetch([answering(status)]);
    const renew = createSessionRefresher({ fetchImpl, apiBaseUrl: '' });

    expect(await renew()).toBe(false);
    expect(await renew()).toBe(false);
    expect(await renew()).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('treats a network failure as no answer at all, and will try again', async () => {
    // Nothing was answered, so nothing was learnt: the session may be perfectly
    // alive and the next 401 deserves a real attempt.
    const { fetchImpl, calls } = scriptedFetch([new Error('offline'), answering(SESSION_REFRESHED_STATUS)]);
    const renew = createSessionRefresher({ fetchImpl, apiBaseUrl: '' });

    expect(await renew()).toBe(false);
    expect(await renew()).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('builds the renewal URL from the contract path and a normalised base', async () => {
    const { fetchImpl, calls } = scriptedFetch([answering(SESSION_REFRESHED_STATUS)]);
    const renew = createSessionRefresher({ fetchImpl, apiBaseUrl: '/' });

    await renew();

    // `/` + the path would be `//v1/auth/refresh`: a request to a host named `v1`,
    // carrying the session cookie nowhere useful.
    expect(calls[0]?.input).toBe(AUTH_REFRESH_PATH);
  });
});
