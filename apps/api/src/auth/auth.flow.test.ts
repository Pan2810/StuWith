import {
  AUTH_COOKIE_PATH,
  AUTH_DATE_OF_BIRTH_PATH,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  OAUTH_STATE_COOKIE_PREFIX,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  MAX_SIGN_IN_RETURN_PATH_LENGTH,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETURN_PATH_QUERY_PARAM,
  errorEnvelopeSchema,
  currentUserSchema,
  type SignInOutcome,
} from '@stuwith/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGN_IN_FAILURE_REASONS } from './audit';
import { CookieJar, createAuthHarness, type AuthHarness } from './__testing__/auth-harness';

/**
 * Every row of the story's I/O matrix, driven through a real NestJS + Fastify
 * process over real HTTP against an in-process OpenID Connect provider.
 *
 * A matrix with no test is a matrix with no effect, so each `it` below names the
 * row it covers.
 */
let harness: AuthHarness;

beforeAll(async () => {
  harness = await createAuthHarness();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  harness.identity.clear();
  harness.sessions.clear();
  harness.audit.clear();
});

const googleProfile = {
  subject: 'google-subject-1',
  email: 'an.nguyen@fpt.edu.vn',
  name: 'An Nguyen',
  picture: 'https://lh3.googleusercontent.com/a/an',
};

/**
 * Assert that a callback ended the way Story 1.3 says every callback ends: a 302
 * back to the login page carrying one public outcome code and nothing else.
 *
 * It also re-checks the leak invariant on every single call, because that is the
 * property that has to hold on EVERY path rather than on the one path somebody
 * remembered to write a test for: no internal reason, no provider name, no
 * provider error code in the URL the browser is sent to.
 */
function expectOutcomeRedirect(response: Response, outcome: SignInOutcome): URL {
  // 303, not 302: Apple's callback is a cross-site form POST, and only 303 says
  // in the status itself that the method is downgraded to GET.
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');

  // The WHOLE URL, origin included. Asserting only the path and the parameter
  // let `WEB_BASE_URL` be swapped for `OAUTH_REDIRECT_BASE_URL` — one line away
  // in the same config object — with all fourteen call sites still green, while
  // every failed login landed the browser on the API host, where `/dang-nhap` is
  // not a route. `deferred-work.md`'s AC4 entry names open-redirect as the risk
  // to guard in exactly this flow; this is where it gets guarded.
  expect(response.headers.get('location')).toBe(
    `${harness.webBaseUrl}/dang-nhap?${SIGN_IN_OUTCOME_QUERY_PARAM}=${outcome}`,
  );
  expect(location.origin).toBe(new URL(harness.webBaseUrl).origin);
  expect(location.pathname).toBe('/dang-nhap');
  expect(location.searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM)).toBe(outcome);
  // The outcome is the ONLY thing that rides back. An extra parameter is how a
  // diagnostic detail gets smuggled to the client "just for debugging".
  expect([...location.searchParams.keys()]).toEqual([SIGN_IN_OUTCOME_QUERY_PARAM]);

  const raw = location.toString();
  for (const reason of SIGN_IN_FAILURE_REASONS) {
    expect(raw, `the internal reason ${reason} must not reach the URL`).not.toContain(reason);
  }
  expect(raw.toLowerCase()).not.toContain('google');
  expect(raw.toLowerCase()).not.toContain('facebook');
  expect(raw.toLowerCase()).not.toContain('apple');
  expect(raw.toLowerCase()).not.toContain('microsoft');
  expect(raw).not.toContain('access_denied');
  expect(raw).not.toContain('server_error');

  return location;
}

function setCookieAttributes(response: Response, name: string): string {
  const found = response.headers
    .getSetCookie()
    .find((raw) => raw.startsWith(`${name}=`) && !raw.includes(`${name}=;`));
  if (found === undefined) {
    throw new Error(`no Set-Cookie for ${name} in [${response.headers.getSetCookie().join(' | ')}]`);
  }
  return found;
}

describe('Matrix: first sign-in', () => {
  it('creates one user, opens a session, sets both cookies and redirects to the web client', async () => {
    const { jar, callback } = await harness.login('google', googleProfile);

    expect(callback.status).toBe(302);
    // No `ket-qua` at all. A success that redirected with an outcome code would
    // put a message on the login page for somebody who just signed in fine.
    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}/dang-nhap`);
    expect(await harness.identity.countUsers()).toBe(1);

    expect(jar.get(SESSION_COOKIE_NAME)).toBeDefined();
    expect(jar.get(REFRESH_COOKIE_NAME)).toBeDefined();
    // The handshake cookie must not outlive the handshake.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)).toEqual([]);
  });

  it('sets HttpOnly, Secure and SameSite=Lax on both session cookies', async () => {
    const { callback } = await harness.login('google', googleProfile);

    for (const name of [SESSION_COOKIE_NAME, REFRESH_COOKIE_NAME]) {
      const cookie = setCookieAttributes(callback, name);
      expect(cookie, `${name} must be HttpOnly`).toContain('HttpOnly');
      expect(cookie, `${name} must be Secure`).toContain('Secure');
      // Lax, not Strict: the provider sends the browser back as a top-level
      // cross-site navigation, and Strict would withhold the cookie on exactly
      // that request.
      expect(cookie, `${name} must be SameSite=Lax`).toContain('SameSite=Lax');
    }
  });

  it('hands out a random opaque token, not a database id', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const sessionToken = jar.get(SESSION_COOKIE_NAME) ?? '';
    const refreshToken = jar.get(REFRESH_COOKIE_NAME) ?? '';

    // 32 random bytes as base64url. A short value, or one that looks like the row
    // id, would mean the cookie is guessable or enumerable.
    expect(sessionToken.length).toBeGreaterThanOrEqual(43);
    expect(refreshToken.length).toBeGreaterThanOrEqual(43);
    expect(sessionToken).not.toBe(refreshToken);
    expect(sessionToken).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

    // What is stored is a hash of this, never the value itself — a property the
    // `SessionPort` signature enforces (every parameter is a `...TokenHash`) and
    // that `identity-schema.test.ts` pins in the schema.
    const sessionId = harness.audit.byAction('auth.signed_in')[0]?.subjectId ?? '';
    const chain = await harness.sessions.listChain(sessionId);
    expect(chain.length).toBe(1);
    expect(JSON.stringify(chain)).not.toContain(sessionToken);
    expect(JSON.stringify(chain)).not.toContain(refreshToken);
  });

  it('writes exactly one auth.signed_in row, marked as a first login', async () => {
    await harness.login('google', googleProfile);

    const rows = harness.audit.byAction('auth.signed_in');
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toMatchObject({ provider: 'google', first_login: true });
    expect(rows[0]?.requestId.length).toBeGreaterThan(0);
    expect(harness.audit.byAction('auth.sign_in_failed').length).toBe(0);
  });

  it('keeps email and the provider subject out of the audit row', async () => {
    await harness.login('google', googleProfile);

    const serialised = JSON.stringify(harness.audit.all());
    expect(serialised).not.toContain(googleProfile.email);
    expect(serialised).not.toContain(googleProfile.subject);
  });
});

describe('Matrix: signing in again', () => {
  it('maps back onto the same user and creates no second account', async () => {
    const first = await harness.login('google', googleProfile);
    const second = await harness.login('google', googleProfile, { jar: new CookieJar() });

    expect(second.callback.status).toBe(302);
    expect(await harness.identity.countUsers()).toBe(1);

    const me = await harness.request('/v1/auth/me', { jar: first.jar });
    const meAgain = await harness.request('/v1/auth/me', { jar: second.jar });
    expect((await me.json()).id).toBe((await meAgain.json()).id);

    const rows = harness.audit.byAction('auth.signed_in');
    expect(rows.length).toBe(2);
    expect(rows[1]?.metadata).toMatchObject({ first_login: false });
  });
});

describe('Matrix: two providers, one email address', () => {
  it('produces TWO separate users — an email is not an identity', async () => {
    const email = 'shared.address@fpt.edu.vn';
    const google = await harness.login('google', { subject: 'g-1', email, name: 'A' });
    const facebook = await harness.login(
      'facebook',
      { subject: 'f-1', email, name: 'A' },
      { jar: new CookieJar() },
    );

    expect(google.callback.status).toBe(302);
    expect(facebook.callback.status).toBe(302);
    expect(await harness.identity.countUsers()).toBe(2);

    const a = await (await harness.request('/v1/auth/me', { jar: google.jar })).json();
    const b = await (await harness.request('/v1/auth/me', { jar: facebook.jar })).json();
    expect(a.id).not.toBe(b.id);
  });
});

describe('Matrix: concurrent callbacks for the same new identity', () => {
  it('creates exactly one user and does not answer 500 to the loser', async () => {
    const profile = { subject: 'racy-subject', email: 'racy@fpt.edu.vn', name: 'Racy' };
    const [first, second] = await Promise.all([
      harness.login('google', profile, { jar: new CookieJar() }),
      harness.login('google', profile, { jar: new CookieJar() }),
    ]);

    expect(first.callback.status).toBe(302);
    expect(second.callback.status).toBe(302);
    expect(await harness.identity.countUsers()).toBe(1);
  });
});

describe('Matrix: Microsoft organisational account', () => {
  it('signs in an @fpt.com account and keys it on (tid, oid)', async () => {
    const { jar, callback } = await harness.login('microsoft', {
      subject: 'pairwise-sub-that-must-not-be-the-key',
      objectId: 'oid-an-nguyen',
      tenantId: 'fpt-tenant',
      email: 'an.nguyen@fpt.com',
      name: 'An Nguyen',
    });

    expect(callback.status).toBe(302);
    const me = await harness.request('/v1/auth/me', { jar });
    expect(me.status).toBe(200);
    expect(currentUserSchema.parse(await me.json()).display_name).toBe('An Nguyen');
  });

  it('treats the same oid in two tenants as two different people', async () => {
    // `oid` is unique only inside a tenant. Keying on it alone would merge two
    // strangers from two organisations into one account.
    await harness.login('microsoft', {
      subject: 's1',
      objectId: 'same-oid',
      tenantId: 'tenant-fpt',
      name: 'One',
    });
    await harness.login(
      'microsoft',
      { subject: 's2', objectId: 'same-oid', tenantId: 'tenant-vnu', name: 'Two' },
      { jar: new CookieJar() },
    );

    expect(await harness.identity.countUsers()).toBe(2);
  });

  it('treats the same (tid, oid) as the same person even when `sub` changes', async () => {
    // `sub` is pairwise per app registration and rotates when the registration
    // does; an adapter keyed on it would silently orphan every account.
    await harness.login('microsoft', {
      subject: 'sub-before',
      objectId: 'stable-oid',
      tenantId: 'tenant-fpt',
      name: 'Stable',
    });
    await harness.login(
      'microsoft',
      { subject: 'sub-after', objectId: 'stable-oid', tenantId: 'tenant-fpt', name: 'Stable' },
      { jar: new CookieJar() },
    );

    expect(await harness.identity.countUsers()).toBe(1);
  });
});

describe('Matrix: Apple', () => {
  it('signs in with no email at all — Apple lets a user withhold it', async () => {
    const { jar, callback } = await harness.login('apple', { subject: 'apple-subject-1' });

    expect(callback.status).toBe(302);
    const me = await harness.request('/v1/auth/me', { jar });
    expect(me.status).toBe(200);
    // A login must not fail because the provider was stingy with profile fields.
    expect(currentUserSchema.parse(await me.json()).display_name.length).toBeGreaterThan(0);
  });
});

describe('Matrix: state is wrong or missing', () => {
  it('refuses a callback with no state cookie at all', async () => {
    const started = await harness.request('/v1/auth/google/start', { jar: new CookieJar() });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    // No jar — the state cookie is simply not sent.
    const callback = await harness.request(authorized.callbackUrl);

    // Not a 401 with a JSON envelope: the person got here by a browser redirect
    // from the provider, so a JSON body would BE the screen they are looking at.
    expectOutcomeRedirect(callback, 'that-bai');
    expect(await callback.text()).toBe('');
    expect(await harness.identity.countUsers()).toBe(0);
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    const tampered = new URL(authorized.callbackUrl);
    tampered.searchParams.set('state', 'not-the-state-we-issued');
    const callback = await harness.request(tampered.toString(), { jar });

    expectOutcomeRedirect(callback, 'that-bai');
    expect(await harness.identity.countUsers()).toBe(0);
  });

  it('refuses a state cookie that has been re-signed by somebody else', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    // Flip the last character of the signature. Anything less than an exact match
    // must fail: the cookie is what binds this callback to a login we started.
    const name = jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)[0] ?? '';
    const cookie = jar.get(name) ?? '';
    jar.replace(name, cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A'));

    const callback = await harness.request(authorized.callbackUrl, { jar });
    expectOutcomeRedirect(callback, 'that-bai');
  });

  /**
   * The invariant that had to survive the move from a JSON body to a redirect.
   *
   * The redirect carries NO body, so the guarantee now lives entirely in the
   * target URL — an earlier version of this test looped its assertions over the
   * response text as well, which is always `''` and therefore passed whatever the
   * URL said. The body is asserted to be empty, once, as a fact rather than as a
   * disguised leak check.
   */
  it('names no provider and no provider error code in the URL it redirects to', async () => {
    const started = await harness.request('/v1/auth/google/start', { jar: new CookieJar() });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);
    const callback = await harness.request(authorized.callbackUrl);

    const target = expectOutcomeRedirect(callback, 'that-bai').toString();
    expect(target.toLowerCase()).not.toContain('google');
    expect(target).not.toContain('provider_error');
    expect(target).not.toContain('invalid_grant');

    // There is nothing else to inspect, and saying so keeps the next reader from
    // adding assertions here that cannot fail.
    expect(await callback.text()).toBe('');
  });

  it('writes exactly one auth.sign_in_failed row and no successful one', async () => {
    const started = await harness.request('/v1/auth/google/start', { jar: new CookieJar() });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);
    await harness.request(authorized.callbackUrl);

    const failures = harness.audit.byAction('auth.sign_in_failed');
    expect(failures.length).toBe(1);
    expect(failures[0]?.actorUserId).toBeNull();
    expect(harness.audit.byAction('auth.signed_in').length).toBe(0);
  });

  it('refuses a login started at one provider and finished at another', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    const crossed = new URL(authorized.callbackUrl.replace('/google/', '/facebook/'));
    const callback = await harness.request(crossed.toString(), { jar });

    expectOutcomeRedirect(callback, 'that-bai');

    // And it does not DESTROY it either. The Google attempt is very likely a live
    // handshake in another tab; clearing its cookie from a URL anybody can build
    // would make "kill that person's login" a request away.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(1);
    expect((await harness.request(authorized.callbackUrl, { jar })).status).toBe(302);
  });
});

/**
 * Story 1.3. The provider answers the callback with `error=...` instead of a
 * `code`, and until now that parameter was never read at all: a refusal at the
 * consent screen arrived with no code, fell through to `code_missing`, and was
 * counted as a technical failure. Somebody who simply changed their mind was told
 * the product was broken.
 */
describe('Matrix: the provider says no', () => {
  /** Drives start -> consent screen -> the provider redirecting back with an error. */
  async function refusedCallback(
    providerError: string,
    provider = 'google',
    jar = new CookieJar(),
  ): Promise<{ response: Response; jar: CookieJar }> {
    const started = await harness.request(`/v1/auth/${provider}/start`, { jar });
    const authorized = harness.fake.authorize(
      started.headers.get('location') ?? '',
      googleProfile,
    );

    // Exactly what a provider sends: the `state` we issued, and an error in place
    // of the code. Nothing else.
    const target = new URL(authorized.callbackUrl);
    target.search = '';
    target.searchParams.set('state', authorized.state);
    target.searchParams.set('error', providerError);

    return { response: await harness.request(target.toString(), { jar }), jar };
  }

  it('treats access_denied as a cancellation, not a failure', async () => {
    const { response } = await refusedCallback('access_denied');
    expectOutcomeRedirect(response, 'da-huy');
    expect(await harness.identity.countUsers()).toBe(0);
  });

  it("treats Apple's user_cancelled_authorize as the same cancellation", async () => {
    // Apple does not use the RFC 6749 word. Handling only `access_denied` would
    // have made "cancel" mean two different things depending on the provider.
    const { response } = await refusedCallback('user_cancelled_authorize', 'apple');
    expectOutcomeRedirect(response, 'da-huy');
  });

  it.each(['server_error', 'temporarily_unavailable', 'invalid_client', 'unauthorized_client'])(
    'collapses the provider error %s into an ordinary failure',
    async (providerError) => {
      // The person cannot act on "Google is having a bad afternoon", and telling
      // them which provider broke and how is the disclosure AC1 forbids.
      const { response } = await refusedCallback(providerError);
      expectOutcomeRedirect(response, 'that-bai');
    },
  );

  it('records a cancellation as exactly one audit row carrying a request id', async () => {
    // "Not an error" is about the interface. A login flow that leaves no trace
    // when people abandon it cannot answer "why did everyone drop off yesterday".
    await refusedCallback('access_denied');

    const rows = harness.audit.byAction('auth.sign_in_failed');
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toMatchObject({ reason: 'user_cancelled', provider: 'google' });
    expect(rows[0]?.requestId.length).toBeGreaterThan(0);
    expect(harness.audit.byAction('auth.signed_in').length).toBe(0);
  });

  it('records a provider refusal under its own reason, not as a cancellation', async () => {
    await refusedCallback('server_error');

    const rows = harness.audit.byAction('auth.sign_in_failed');
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toMatchObject({ reason: 'provider_authorize_failed' });
  });

  it("keeps the provider's own error code out of the audit row", async () => {
    // `audit_events` is permanent and uncorrectable. A third party's vocabulary in
    // it is how that vocabulary eventually reaches a user-facing message.
    await refusedCallback('server_error');
    expect(JSON.stringify(harness.audit.all())).not.toContain('server_error');
  });

  it('clears the cancelled attempt cookie and nothing else', async () => {
    const jar = new CookieJar();
    // Two tabs: one being cancelled, one still at its consent screen.
    const first = await harness.request('/v1/auth/google/start', { jar });
    const secondStart = await harness.request('/v1/auth/google/start', { jar });
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(2);

    const authorized = harness.fake.authorize(first.headers.get('location') ?? '', googleProfile);
    const target = new URL(authorized.callbackUrl);
    target.search = '';
    target.searchParams.set('state', authorized.state);
    target.searchParams.set('error', 'access_denied');
    await harness.request(target.toString(), { jar });

    // One gone, one left — and the survivor still completes. Clearing every
    // handshake cookie would kill a login the person is still in the middle of.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(1);
    const secondTab = harness.fake.authorize(secondStart.headers.get('location') ?? '', {
      subject: 'cancel-other-tab',
      name: 'Other Tab',
    });
    expect((await harness.request(secondTab.callbackUrl, { jar })).status).toBe(302);
  });

  it('leaves an already-signed-in session alone when a NEW attempt fails', async () => {
    // A failed new login is not a reason to sign someone out of the session they
    // already had. The old code cleared every auth cookie on this path.
    const { jar } = await harness.login('google', googleProfile);
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);

    await refusedCallback('access_denied', 'google', jar);

    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);
  });

  it('answers a cancellation with no state and no cookie at all', async () => {
    // A provider can refuse before we ever see a usable handshake, and someone can
    // simply type the URL. Neither may become a 500 or a lost audit row.
    const response = await harness.request('/v1/auth/google/callback?error=access_denied');

    expectOutcomeRedirect(response, 'da-huy');
    expect(harness.audit.byAction('auth.sign_in_failed').length).toBe(1);
  });

  it('delivers the same cancellation through the Apple form POST leg', async () => {
    // `@Get` and `@Post` share one code path in the service, and this is the test
    // that keeps it that way: Apple posts the error in a form body, not a query.
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/apple/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', {
      subject: 'apple-cancelled',
    });
    const target = new URL(authorized.callbackUrl);

    const response = await harness.request(`${target.origin}${target.pathname}`, {
      jar,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        state: authorized.state,
        error: 'user_cancelled_authorize',
      }).toString(),
    });

    expectOutcomeRedirect(response, 'da-huy');
    expect(harness.audit.byAction('auth.sign_in_failed')[0]?.metadata).toMatchObject({
      reason: 'user_cancelled',
      provider: 'apple',
    });
    // And the cancelled attempt's cookie is gone, exactly as on the GET leg.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)).toEqual([]);
  });

  it('does not clear ANOTHER provider\'s live attempt, however the state is aimed', async () => {
    // `state` is matched across every handshake cookie the browser holds, so
    // without a provider check this URL — which anyone can build once they have
    // seen their own `state` go past — cancels one provider and takes a different
    // provider's live login down with it.
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', {
      subject: 'cross-provider-cancel',
      name: 'Cross Provider',
    });

    const crossed = new URL(`${harness.baseUrl}/v1/auth/facebook/callback`);
    crossed.searchParams.set('state', authorized.state);
    crossed.searchParams.set('error', 'access_denied');
    expectOutcomeRedirect(await harness.request(crossed.toString(), { jar }), 'da-huy');

    // The Google tab is untouched and still finishes.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(1);
    expect((await harness.request(authorized.callbackUrl, { jar })).status).toBe(302);
  });

  it('reads a REPEATED error parameter, which arrives as an array', async () => {
    // Fastify parses `?error=a&error=b` into an array. A bare `typeof === string`
    // guard skipped it entirely, so the callback fell through to `code_missing`
    // and a cancellation was recorded and shown as a technical failure.
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    const target = new URL(`${harness.baseUrl}/v1/auth/google/callback`);
    target.searchParams.set('state', authorized.state);
    target.searchParams.append('error', 'access_denied');
    target.searchParams.append('error', 'something_else');

    expectOutcomeRedirect(await harness.request(target.toString(), { jar }), 'da-huy');
    expect(harness.audit.byAction('auth.sign_in_failed')[0]?.metadata).toMatchObject({
      reason: 'user_cancelled',
    });
  });

  it('treats a present-but-empty error as a refusal, not as a missing code', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    const target = new URL(`${harness.baseUrl}/v1/auth/google/callback`);
    target.searchParams.set('state', authorized.state);
    target.searchParams.set('error', '');

    expectOutcomeRedirect(await harness.request(target.toString(), { jar }), 'that-bai');
    // `provider_authorize_failed`, not `code_missing`: the provider answered, and
    // the audit trail should say the provider refused rather than that we lost
    // track of a parameter.
    expect(harness.audit.byAction('auth.sign_in_failed')[0]?.metadata).toMatchObject({
      reason: 'provider_authorize_failed',
    });
  });

  it('still answers 404 for a provider that is not enabled, error or no error', async () => {
    // The refusal path must not become a way to find out which providers exist.
    const limited = await createAuthHarness({ enabledProviders: ['google'] });
    try {
      const response = await limited.request(
        '/v1/auth/apple/callback?error=access_denied&state=x',
      );
      expect(response.status).toBe(404);
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('not_found');
    } finally {
      await limited.close();
    }
  }, 60_000);
});

describe('Matrix: an authorization code is single use', () => {
  it('refuses a replayed callback', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    const replayJar = jar.clone();
    const first = await harness.request(authorized.callbackUrl, { jar });
    expect(first.status).toBe(302);

    // Same code, same state cookie: the provider must reject the second exchange,
    // and we must not open a second session off the back of it.
    const second = await harness.request(authorized.callbackUrl, { jar: replayJar });
    expectOutcomeRedirect(second, 'that-bai');
    expect(await harness.identity.countUsers()).toBe(1);
  });
});

describe('Matrix: refresh rotation', () => {
  it('issues new cookies, keeps the session chain, and spends the old access token', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const before = jar.get(SESSION_COOKIE_NAME);
    const staleJar = jar.clone();

    const refreshed = await harness.request('/v1/auth/refresh', { method: 'POST', jar });
    expect(refreshed.status).toBe(204);
    expect(jar.get(SESSION_COOKIE_NAME)).not.toBe(before);

    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);
    // The previous cookie is spent the instant a newer generation exists — not
    // when its own TTL runs out.
    expect((await harness.request('/v1/auth/me', { jar: staleJar })).status).toBe(401);
  });

  it('refuses a refresh with no refresh cookie', async () => {
    const response = await harness.request('/v1/auth/refresh', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('unauthenticated');
  });
});

describe('Matrix: a refresh token that comes back after rotation', () => {
  it('revokes the whole chain and records it as a theft signal', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const stolen = jar.clone();

    expect((await harness.request('/v1/auth/refresh', { method: 'POST', jar })).status).toBe(204);

    // The attacker replays the refresh token they captured before rotation.
    const replay = await harness.request('/v1/auth/refresh', { method: 'POST', jar: stolen });
    expect(replay.status).toBe(401);

    // Not "that one token is dead" — the whole chain is, including the session the
    // legitimate client is holding. A user losing their session is the cheap half
    // of this trade.
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(401);

    const failures = harness.audit.byAction('auth.sign_in_failed');
    expect(failures.length).toBe(1);
    expect(failures[0]?.metadata).toMatchObject({ reason: 'session_reuse_detected' });
  });
});

describe('Matrix: an expired session', () => {
  it('answers 401 once the TTL has passed', async () => {
    const { jar } = await harness.login('google', googleProfile);
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);

    harness.clock.advance((harness.config.SESSION_TTL_SECONDS + 1) * 1000);

    const expired = await harness.request('/v1/auth/me', { jar });
    expect(expired.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await expired.json()).error.code).toBe('unauthenticated');
  });

  it('lets a refresh recover the session, because the refresh TTL is longer', async () => {
    const { jar } = await harness.login('google', googleProfile);
    harness.clock.advance((harness.config.SESSION_TTL_SECONDS + 1) * 1000);

    expect((await harness.request('/v1/auth/refresh', { method: 'POST', jar })).status).toBe(204);
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);
  });

  it('refuses a login left at the consent screen past the state TTL', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    harness.clock.advance((harness.config.OAUTH_STATE_TTL_SECONDS + 1) * 1000);

    // `state_expired` is one of the internal reasons that would tell a stranger
    // exactly which step of our handshake they broke. It collapses to `that-bai`
    // like every other technical failure.
    expectOutcomeRedirect(await harness.request(authorized.callbackUrl, { jar }), 'that-bai');
  });
});

describe('/v1/auth/me', () => {
  it('publishes no email and no provider id', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const response = await harness.request('/v1/auth/me', { jar });
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).not.toContain(googleProfile.email);
    expect(raw).not.toContain(googleProfile.subject);
    // Story 1.4 added two booleans, and the exact-set assertion is the point:
    // a body that gains a field nobody decided to publish fails here rather than
    // in somebody's browser cache.
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'avatar_url',
      'display_name',
      'id',
      'is_over_18',
      'profile_completed',
      'role',
    ]);
  });

  it('gives a new account the `user` role and nothing more', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const me = currentUserSchema.parse(await (await harness.request('/v1/auth/me', { jar })).json());
    expect(me.role).toBe('user');
  });

  it('answers 401 with the standard envelope when no cookie is presented', async () => {
    const response = await harness.request('/v1/auth/me');
    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.safeParse(await response.json()).success).toBe(true);
  });
});

describe('/v1/auth/logout', () => {
  it('revokes the chain so neither the session nor the refresh token survives', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const keptRefresh = jar.clone();

    const response = await harness.request('/v1/auth/logout', { method: 'POST', jar });
    expect(response.status).toBe(204);

    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(401);
    // The refresh token must not bring the session back.
    expect(
      (await harness.request('/v1/auth/refresh', { method: 'POST', jar: keptRefresh })).status,
    ).toBe(401);
  });

  it('answers 204 even when nothing was presented, revealing nothing', async () => {
    expect((await harness.request('/v1/auth/logout', { method: 'POST' })).status).toBe(204);
  });
});

describe('Matrix: a provider that is not enabled', () => {
  let limited: AuthHarness;

  beforeAll(async () => {
    limited = await createAuthHarness({ enabledProviders: ['google'] });
  }, 60_000);

  afterAll(async () => {
    await limited?.close();
  });

  it.each(['apple', 'facebook', 'microsoft'])('answers 404 for %s/start', async (provider) => {
    const response = await limited.request(`/v1/auth/${provider}/start`);
    expect(response.status).toBe(404);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('not_found');
  });

  it('answers 404 for a disabled callback too, so the URL cannot be probed', async () => {
    const response = await limited.request('/v1/auth/apple/callback?code=x&state=y');
    expect(response.status).toBe(404);
  });

  it('reveals nothing about which providers ARE enabled', async () => {
    const disabled = await limited.request('/v1/auth/apple/start');
    const unknown = await limited.request('/v1/auth/zalo/start');

    expect(disabled.status).toBe(unknown.status);
    expect(await disabled.text()).toBe(await unknown.text());
  });

  it('answers 404 the same way when a return path is proposed', async () => {
    // The controller reads `?quay-ve=` BEFORE the 404 is decided — that is the
    // real order, and the docblock there used to claim the opposite. What has to
    // hold is that reading it changes nothing: same status, same body, byte for
    // byte, whatever the query said. Otherwise `/start` starts telling a stranger
    // which providers this deployment has configured.
    const plain = await limited.request('/v1/auth/apple/start');
    const proposing = await limited.request(
      `/v1/auth/apple/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=%2Fphong-hoc%2Fabc`,
    );
    const hostile = await limited.request(
      `/v1/auth/apple/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=%2F%2Fevil.com`,
    );

    expect(proposing.status).toBe(404);
    expect(hostile.status).toBe(404);
    const body = await plain.text();
    expect(await proposing.text()).toBe(body);
    expect(await hostile.text()).toBe(body);
  });

  it('still serves the provider that IS enabled', async () => {
    const response = await limited.request('/v1/auth/google/start');
    expect(response.status).toBe(302);
  });
});

describe('CORS — the web client is on another origin', () => {
  /**
   * `apps/web` and `apps/api` are two processes on two origins, and the login page
   * calls `/v1/auth/me` and `/v1/auth/logout` with `credentials: 'include'`.
   * Without CORS the browser blocks the response before any JavaScript sees it and
   * the page can never read a session back — while every server-side test stays
   * green, because Node's `fetch` ignores CORS entirely. So the headers are
   * asserted directly.
   */
  it('allows the configured web origin, with credentials', async () => {
    const response = await harness.request('/v1/auth/me', {
      headers: { origin: harness.webBaseUrl },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe(harness.webBaseUrl);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('answers the preflight a credentialed POST triggers', async () => {
    const response = await harness.request('/v1/auth/logout', {
      method: 'OPTIONS',
      headers: {
        origin: harness.webBaseUrl,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('access-control-allow-origin')).toBe(harness.webBaseUrl);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does NOT reflect a foreign origin, and never answers with a wildcard', async () => {
    const response = await harness.request('/v1/auth/me', {
      headers: { origin: 'http://evil.example' },
    });

    const allowed = response.headers.get('access-control-allow-origin');
    expect(allowed).not.toBe('http://evil.example');
    // A wildcard is not merely lax with credentials — the fetch spec rejects the
    // response outright, so it would fail closed and look like a mystery.
    expect(allowed).not.toBe('*');
  });
});

describe('cookie attributes carry the right Path', () => {
  /**
   * Asserted because the cookie jar used to key on name alone, which models a
   * browser that ignores paths. Under that model, clearing the session cookie at
   * `/v1/auth` instead of `/` reads as a successful logout while a real browser
   * keeps the user signed in.
   */
  it.each([
    [SESSION_COOKIE_NAME, SESSION_COOKIE_PATH],
    [REFRESH_COOKIE_NAME, AUTH_COOKIE_PATH],
  ])('sets %s at Path=%s', async (name, path) => {
    const { callback, jar } = await harness.login('google', googleProfile);

    expect(setCookieAttributes(callback, name)).toContain(`Path=${path}`);
    expect(jar.pathOf(name)).toBe(path);
  });

  it('scopes the handshake cookie to /v1/auth', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const stateName = jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)[0] ?? '';

    expect(stateName).not.toBe('');
    expect(setCookieAttributes(started, stateName)).toContain(`Path=${AUTH_COOKIE_PATH}`);
  });

  it('clears each cookie on the SAME path it was set on', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const response = await harness.request('/v1/auth/logout', { method: 'POST', jar });

    const cleared = response.headers.getSetCookie();
    const clearing = (name: string) =>
      cleared.find((raw) => raw.startsWith(`${name}=;`) || raw.startsWith(`${name}=; `));

    // A clear on a different path creates a SECOND cookie and leaves the first
    // one being sent forever.
    expect(clearing(SESSION_COOKIE_NAME)).toContain(`Path=${SESSION_COOKIE_PATH}`);
    expect(clearing(REFRESH_COOKIE_NAME)).toContain(`Path=${AUTH_COOKIE_PATH}`);
    expect(jar.get(SESSION_COOKIE_NAME)).toBeUndefined();
    expect(jar.get(REFRESH_COOKIE_NAME)).toBeUndefined();
  });

  it('does not send the refresh cookie to endpoints outside /v1/auth', async () => {
    const { jar } = await harness.login('google', googleProfile);

    // Path scoping is the reason the refresh token is not attached to every
    // request in the app; if the jar sent it everywhere, that claim would be
    // untested.
    expect(jar.header('/healthz')).not.toContain(REFRESH_COOKIE_NAME);
    expect(jar.header('/healthz')).toContain(SESSION_COOKIE_NAME);
    expect(jar.header('/v1/auth/refresh')).toContain(REFRESH_COOKIE_NAME);
  });
});

describe('Apple uses response_mode=form_post', () => {
  /**
   * Apple REQUIRES `form_post` once the scope includes `name` or `email`, and then
   * POSTs a form-encoded body instead of redirecting with query parameters. The
   * fake server refuses the wrong combination the way Apple does, so dropping
   * `response_mode` from the registry fails here rather than at the first real
   * Apple login.
   */
  it('asks for form_post in the authorization request', async () => {
    const started = await harness.request('/v1/auth/apple/start', { jar: new CookieJar() });
    const location = new URL(started.headers.get('location') ?? '');

    expect(location.searchParams.get('response_mode')).toBe('form_post');
    expect(location.searchParams.get('scope')).toContain('email');
  });

  it('completes a login delivered as a cross-site form POST', async () => {
    const { jar, callback } = await harness.login('apple', {
      subject: 'apple-form-post-subject',
      email: 'apple.user@privaterelay.appleid.com',
      name: 'Apple User',
    });

    expect(callback.status).toBe(302);
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);
  });

  it('refuses a form POST whose state does not match', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/apple/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', {
      subject: 'apple-bad-state',
    });
    const target = new URL(authorized.callbackUrl);

    const response = await harness.request(`${target.origin}${target.pathname}`, {
      jar,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: authorized.code, state: 'wrong' }).toString(),
    });

    expectOutcomeRedirect(response, 'that-bai');
  });
});

describe('two login attempts in two tabs', () => {
  /**
   * Ordinary user behaviour, and it used to be broken: one fixed state cookie name
   * meant the second `/start` overwrote the first tab's cookie, so finishing the
   * FIRST tab failed as "state missing" — indistinguishable, to the person, from a
   * product that does not work.
   */
  it('lets EITHER tab complete, including the older one', async () => {
    const jar = new CookieJar();

    const firstStart = await harness.request('/v1/auth/google/start', { jar });
    await harness.request('/v1/auth/google/start', { jar });

    // Two attempts in flight means two cookies, not one overwritten.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(2);

    const firstTab = harness.fake.authorize(firstStart.headers.get('location') ?? '', {
      subject: 'two-tabs-subject',
      name: 'Two Tabs',
    });
    // Finish the OLDER tab — the one a single fixed cookie name would have lost.
    const callback = await harness.request(firstTab.callbackUrl, { jar });
    expect(callback.status).toBe(302);
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(200);
  });

  it('clears only the attempt that completed, leaving the other tab usable', async () => {
    const jar = new CookieJar();
    const firstStart = await harness.request('/v1/auth/google/start', { jar });
    const secondStart = await harness.request('/v1/auth/google/start', { jar });

    const firstTab = harness.fake.authorize(firstStart.headers.get('location') ?? '', {
      subject: 'two-tabs-cleanup',
      name: 'Two Tabs',
    });
    await harness.request(firstTab.callbackUrl, { jar });

    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(1);

    const secondTab = harness.fake.authorize(secondStart.headers.get('location') ?? '', {
      subject: 'two-tabs-cleanup',
      name: 'Two Tabs',
    });
    expect((await harness.request(secondTab.callbackUrl, { jar })).status).toBe(302);
  });
});

describe('handshake cookies left behind by abandoned logins', () => {
  /**
   * `start()` mints one cookie per attempt under a random handle, with no cap, and
   * nothing removed them until their own `Max-Age` ran out. Somebody who opens the
   * login page repeatedly and finishes nothing carries all of them, on every
   * `/v1/auth` request, and a large enough pile is answered with 431 rather than a
   * login page. Dropping `clearAllAuthCookies` from the failure path was right for
   * the session cookies and left this with no sweeper at all.
   */
  it('clears the expired attempts on a failed callback, and only those', async () => {
    const jar = new CookieJar();
    for (let i = 0; i < 5; i += 1) {
      await harness.request('/v1/auth/google/start', { jar });
    }
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(5);

    // All five are now past their TTL, and nothing has swept them.
    harness.clock.advance((harness.config.OAUTH_STATE_TTL_SECONDS + 1) * 1000);

    // A sixth attempt, still live, and the one that will fail.
    const live = await harness.request('/v1/auth/google/start', { jar });
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(6);

    const failing = await harness.request(
      `${harness.baseUrl}/v1/auth/google/callback?state=nothing-we-issued`,
      { jar },
    );
    expectOutcomeRedirect(failing, 'that-bai');

    // The five dead ones are gone; the live attempt survives AND still completes,
    // which is the half a blanket "clear every state cookie" sweep would break.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(1);
    const authorized = harness.fake.authorize(live.headers.get('location') ?? '', {
      subject: 'survived-the-sweep',
      name: 'Survivor',
    });
    expect((await harness.request(authorized.callbackUrl, { jar })).status).toBe(302);
  });

  it('sweeps a cookie we can no longer verify, which is what a rotated secret leaves', async () => {
    const jar = new CookieJar();
    await harness.request('/v1/auth/google/start', { jar });
    const name = jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)[0] ?? '';
    const value = jar.get(name) ?? '';
    jar.replace(name, `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`);

    const response = await harness.request(
      `${harness.baseUrl}/v1/auth/google/callback?state=nothing-we-issued`,
      { jar },
    );

    expectOutcomeRedirect(response, 'that-bai');
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)).toEqual([]);
  });

  it('leaves a live attempt alone when an unrelated callback fails', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });

    await harness.request(`${harness.baseUrl}/v1/auth/google/callback?state=not-ours`, { jar });

    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX).length).toBe(1);
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', {
      subject: 'untouched-by-a-stranger',
      name: 'Untouched',
    });
    expect((await harness.request(authorized.callbackUrl, { jar })).status).toBe(302);
  });
});

describe('logging out after the session token has expired', () => {
  /**
   * The defect: logout revoked the chain only while the ACCESS token was still
   * readable. An hour in, the read refused, nothing was revoked, and the thirty-day
   * refresh chain stayed valid server-side — so a retained copy of the refresh
   * token still worked. Clearing cookies is browser-side only and protects nobody
   * who already has the token.
   */
  it('still revokes the refresh chain', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const retained = jar.clone();

    harness.clock.advance((harness.config.SESSION_TTL_SECONDS + 1) * 1000);
    // Sanity: the access token really is unusable by now, so this test is
    // exercising the path it claims to.
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(401);

    expect((await harness.request('/v1/auth/logout', { method: 'POST', jar })).status).toBe(204);

    const afterLogout = await harness.request('/v1/auth/refresh', {
      method: 'POST',
      jar: retained,
    });
    expect(afterLogout.status).toBe(401);
  });

  it('revokes from the refresh cookie even when the session cookie is gone', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const refreshOnly = new CookieJar();
    refreshOnly.set(REFRESH_COOKIE_NAME, jar.get(REFRESH_COOKIE_NAME) ?? '', AUTH_COOKIE_PATH);

    expect(
      (await harness.request('/v1/auth/logout', { method: 'POST', jar: refreshOnly })).status,
    ).toBe(204);
    expect((await harness.request('/v1/auth/me', { jar })).status).toBe(401);
  });
});

describe('every failure leaves an audit row', () => {
  it('records a refresh presented with no cookie', async () => {
    await harness.request('/v1/auth/refresh', { method: 'POST' });

    const failures = harness.audit.byAction('auth.sign_in_failed');
    expect(failures.length).toBe(1);
    expect(failures[0]?.metadata).toMatchObject({ reason: 'refresh_cookie_missing' });
  });

  it('records a refresh token nobody issued', async () => {
    const jar = new CookieJar();
    jar.set(REFRESH_COOKIE_NAME, 'not-a-token-we-ever-minted', AUTH_COOKIE_PATH);

    await harness.request('/v1/auth/refresh', { method: 'POST', jar });

    expect(harness.audit.byAction('auth.sign_in_failed')[0]?.metadata).toMatchObject({
      reason: 'refresh_token_unknown',
    });
  });

  it('records a refresh against a chain that was logged out', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const retained = jar.clone();
    await harness.request('/v1/auth/logout', { method: 'POST', jar });
    harness.audit.clear();

    await harness.request('/v1/auth/refresh', { method: 'POST', jar: retained });

    expect(harness.audit.byAction('auth.sign_in_failed')[0]?.metadata).toMatchObject({
      reason: 'session_revoked',
    });
  });

  it('records an identity the store would refuse, instead of answering 500', async () => {
    // A provider that returns a blank subject makes `toProviderIdentity` throw an
    // IdentityInputError, which is not a ProviderExchangeError and used to escape
    // the catch entirely.
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', {
      subject: '   ',
      name: 'Blank Subject',
    });

    const response = await harness.request(authorized.callbackUrl, { jar });

    expectOutcomeRedirect(response, 'that-bai');
    expect(harness.audit.byAction('auth.sign_in_failed')[0]?.metadata).toMatchObject({
      reason: 'identity_rejected',
    });
    expect(await harness.identity.countUsers()).toBe(0);
  });
});

describe('a provider that cannot be reached on the START leg', () => {
  /**
   * The three OIDC providers fetch a discovery document on this leg, so it touches
   * the network. An unguarded failure was a 500 with no audit row — the one
   * outcome an investigation cannot see.
   *
   * This gets its OWN harness because the discovery document is cached per
   * process: reusing the shared one would make the result depend on whether some
   * earlier example had already warmed the cache.
   */
  let unreachable: AuthHarness;

  beforeAll(async () => {
    unreachable = await createAuthHarness({ enabledProviders: ['google'] });
    unreachable.fake.failDiscovery = true;
  }, 60_000);

  afterAll(async () => {
    await unreachable?.close();
  });

  it('answers 502 — not 401, which would blame the user for an outage', async () => {
    const response = await unreachable.request('/v1/auth/google/start', { jar: new CookieJar() });

    expect(response.status).toBe(502);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('internal_error');
  });

  it('writes an auth.sign_in_failed row naming the leg that failed', async () => {
    unreachable.audit.clear();
    await unreachable.request('/v1/auth/google/start', { jar: new CookieJar() });

    const failures = unreachable.audit.byAction('auth.sign_in_failed');
    expect(failures.length).toBe(1);
    expect(failures[0]?.metadata).toMatchObject({
      provider: 'google',
      reason: 'provider_start_failed',
    });
  });

  it('leaks no provider detail into the response body', async () => {
    const raw = await (
      await unreachable.request('/v1/auth/google/start', { jar: new CookieJar() })
    ).text();
    expect(raw.toLowerCase()).not.toContain('google');
    expect(raw.toLowerCase()).not.toContain('discovery');
  });
});

describe('Matrix: coming back to where you were standing', () => {
  /**
   * Story 1.3 part 3. A session that dies mid-visit must not cost somebody their
   * place, and the mechanism is general on purpose — Epic 2's live room plugs into
   * it, and nothing on this side knows a room exists.
   *
   * The security argument fits in one sentence: the destination is read from the
   * SIGNED state and from nowhere else, so choosing one means signing one. The
   * examples below are therefore not "does the validator work" —
   * `packages/contracts/src/auth.test.ts` sweeps that by class — they are "does a
   * hostile proposal that travels the real road, through real HTTP and a real
   * signed cookie, end up anywhere other than our own origin".
   */
  const internalPath = '/phong-hoc/abc-123?tab=chat';

  const startWith = (proposal: string, jar: CookieJar): Promise<Response> =>
    harness.request(
      `/v1/auth/google/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=${encodeURIComponent(proposal)}`,
      { jar },
    );

  it('sends the browser back to the proposed internal path', async () => {
    const { callback } = await harness.login('google', googleProfile, { returnPath: internalPath });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}${internalPath}`);
  });

  it('still clears that handshake cookie and still opens the session', async () => {
    const { jar } = await harness.login('google', googleProfile, { returnPath: internalPath });

    // A changed redirect target must not quietly cost the flow its cleanup.
    expect(jar.namesMatching(OAUTH_STATE_COOKIE_PREFIX)).toEqual([]);
    expect(jar.get(SESSION_COOKIE_NAME)).toBeDefined();
    expect(jar.get(REFRESH_COOKIE_NAME)).toBeDefined();
  });

  it('lands on the login page when nothing was proposed', async () => {
    const { callback } = await harness.login('google', googleProfile);

    // The row this story must not break: `/start` exactly as it was before, and
    // the destination it has always had.
    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}/dang-nhap`);
  });

  it.each([
    ['an absolute URL', 'https://evil.com/x'],
    ['protocol-relative', '//evil.com'],
    ['a backslash spelling of protocol-relative', '/\\evil.com'],
    ['an encoded slash pair', '/%2F%2Fevil.com'],
    ['a parent segment', '/../x'],
    ['userinfo punctuation', '/@evil.com'],
    ['a scheme behind a leading slash', '/https://evil.com'],
    ['an empty proposal', ''],
  ])('drops %s and completes the login on our own origin', async (_label, proposal) => {
    const { callback } = await harness.login('google', googleProfile, { returnPath: proposal });

    // Not an error: the login SUCCEEDS and simply lands where it always did.
    // Refusing would turn "here is a login link" into a way to break somebody's
    // login, and the visitor did nothing wrong either way.
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get('location') ?? '');
    expect(location.origin).toBe(new URL(harness.webBaseUrl).origin);
    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}/dang-nhap`);
    expect(location.toString()).not.toContain('evil.com');
  });

  it('never lets a proposal move the redirect onto the API origin', async () => {
    // `OAUTH_REDIRECT_BASE_URL` is one line away from `WEB_BASE_URL` in the same
    // config object, which is why every failure path has asserted the whole origin
    // since Story 1.3 part 1. The success path is where a variable path made that
    // breakable for the first time.
    const { callback } = await harness.login('google', googleProfile, { returnPath: internalPath });

    expect(new URL(callback.headers.get('location') ?? '').origin).not.toBe(
      new URL(harness.baseUrl).origin,
    );
  });

  it('writes nothing about a rejected proposal into the audit trail', async () => {
    // `audit_events` is append-only (AD-12) — no role holds DELETE — so an
    // attacker-chosen string that reached a row could never be taken back out.
    const marker = 'kokoro-marker-9x';
    await harness.login('google', googleProfile, { returnPath: `//evil.com/${marker}` });

    expect(JSON.stringify(harness.audit.all())).not.toContain(marker);
  });

  it('drops the return path on the FAILURE branch, keeping exactly one parameter', async () => {
    const jar = new CookieJar();
    const started = await startWith(internalPath, jar);
    expect(started.status).toBe(302);

    // A real signed state, then a code the provider will not honour.
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);
    const target = new URL(authorized.callbackUrl);
    target.searchParams.set('code', 'not-a-real-code');
    const callback = await harness.request(target.toString(), { jar });

    // `expectOutcomeRedirect` re-asserts the whole invariant, including "exactly
    // one query parameter rides back" — which is what forbids the return path
    // here even though this attempt signed a perfectly valid one.
    const location = expectOutcomeRedirect(callback, 'that-bai');
    expect(location.pathname).toBe('/dang-nhap');
    expect(location.toString()).not.toContain('phong-hoc');
  });

  /**
   * `/start` with a query string written EXACTLY as given — no `encodeURIComponent`
   * between the example and the wire.
   *
   * That distinction is the whole point of the block below. Every earlier example
   * went through `encodeURIComponent`, so a value like `%2F%2Fevil.com` reached the
   * server as `%252F%252Fevil.com` — a DOUBLE-encoded string. Fastify percent-
   * decodes the query once before any handler runs, so the single-encoded spelling
   * an attacker actually writes arrives at `parseInternalReturnPath` already
   * decoded, and is refused by a different rule than the one the tests were
   * demonstrating. Two spellings, two roads; both need driving.
   */
  const startRaw = (rawQueryValue: string, jar: CookieJar): Promise<Response> =>
    harness.request(
      `/v1/auth/google/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=${rawQueryValue}`,
      { jar },
    );

  /** Consent and callback for a `/start` that was driven by hand. */
  const finish = async (started: Response, jar: CookieJar): Promise<Response> => {
    expect(started.status).toBe(302);
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);
    return harness.request(authorized.callbackUrl, { jar });
  };

  it('takes the FIRST value when the parameter is repeated', async () => {
    // `?quay-ve=/a&quay-ve=//evil.com` reaches Fastify as an ARRAY. The callback
    // leg has read `?error=` through `firstQueryValue` since Story 1.3 part 1, and
    // the comment there records that a bare `typeof === 'string'` was a real
    // defect; this leg had the same code and no example. Last-wins, or "an array
    // is not a string so ignore the whole thing", are both one line away.
    const jar = new CookieJar();
    const callback = await finish(await startRaw('/a&quay-ve=//evil.com', jar), jar);

    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}/a`);
  });

  it.each([
    ['a single-encoded slash pair', '%2F%2Fevil.com'],
    ['a single-encoded backslash', '%5Cevil.com'],
    ['single-encoded parent segments', '%2e%2e/x'],
    // CR and LF ALONE, with nothing else in the string the allow-list would
    // refuse: a value like `/x%0d%0aX-Injected:%201` also dies on the `:`, so it
    // would pass even with the newline rule gone.
    ['a single-encoded CRLF', '/x%0d%0aY'],
    ['a double-encoded slash pair', '%252F%252Fevil.com'],
    ['a single-encoded scheme', 'https%3A%2F%2Fevil.com'],
  ])('drops %s sent RAW over HTTP and lands on the login page', async (_label, rawValue) => {
    const jar = new CookieJar();
    const callback = await finish(await startRaw(rawValue, jar), jar);

    const raw = callback.headers.get('location') ?? '';
    expect(raw).toBe(`${harness.webBaseUrl}/dang-nhap`);
    expect(new URL(raw).origin).toBe(new URL(harness.webBaseUrl).origin);
    expect(raw.toLowerCase()).not.toContain('evil.com');
    // A `Location` header carrying a CR or an LF is response splitting, and no
    // amount of "it was rejected anyway" makes an emitted one safe.
    expect(raw).not.toMatch(/[\r\n]/);
  });

  it('accepts a path at the ceiling and brings the person back to it', async () => {
    // `MAX_SIGN_IN_RETURN_PATH_LENGTH` exists because the value rides in a cookie
    // on every `/v1/auth` request until the handshake ends, and a `Cookie` header
    // that grows past the server's limit answers 431 instead of a login page. Only
    // the unit test had ever exercised the number; nothing had pushed a path of
    // that size through a real cookie, a real signature and a real callback.
    const atCeiling = `/p/${'a'.repeat(MAX_SIGN_IN_RETURN_PATH_LENGTH - 3)}`;
    expect(atCeiling.length).toBe(MAX_SIGN_IN_RETURN_PATH_LENGTH);

    const jar = new CookieJar();
    const started = await startRaw(encodeURIComponent(atCeiling), jar);

    // The state cookie carries it. Measured rather than assumed: this is the
    // number `deferred-work.md` records, and a change to the payload shape that
    // doubled it would be invisible without an assertion here.
    const stateCookie = started.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(OAUTH_STATE_COOKIE_PREFIX));
    expect(stateCookie).toBeDefined();
    const bare = await harness.request('/v1/auth/google/start', { jar: new CookieJar() });
    const bareCookie = bare.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(OAUTH_STATE_COOKIE_PREFIX));

    // Measured on 2026-09-04: 374 bytes with no proposal, 1066 with one at the
    // ceiling — 2.85x, because 512 characters of path become ~683 of base64
    // inside the signed payload. The bounds are loose enough not to be brittle
    // and tight enough that doubling the payload shape fails here. What the
    // number MEANS for concurrent attempts is in `deferred-work.md`.
    expect((bareCookie ?? '').length).toBeLessThan(450);
    expect((stateCookie ?? '').length).toBeLessThan(1200);
    expect((stateCookie ?? '').length - (bareCookie ?? '').length).toBeLessThan(750);

    const callback = await finish(started, jar);
    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}${atCeiling}`);
  });

  it('drops a path one character over the ceiling, silently', async () => {
    const overCeiling = `/p/${'a'.repeat(MAX_SIGN_IN_RETURN_PATH_LENGTH - 2)}`;
    expect(overCeiling.length).toBe(MAX_SIGN_IN_RETURN_PATH_LENGTH + 1);

    const jar = new CookieJar();
    const callback = await finish(await startRaw(encodeURIComponent(overCeiling), jar), jar);

    // Not an error, and not a truncation: a truncated path is a DIFFERENT page,
    // and sending somebody to one because their URL was long is worse than
    // sending them to the login page they expected.
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${harness.webBaseUrl}/dang-nhap`);
  });

  /**
   * The acceptance criterion says "no log line contains the value", and until now
   * only the audit trail was checked. `logLines` is what a REAL pino wrote through
   * the real serialisers, which is the only place that claim can be tested — and
   * it needs its own harness, because `captureLogs` is off by default and a logger
   * that was never wired up passes every "does not contain" assertion perfectly.
   */
  describe('and nothing about it reaches a log line', () => {
    const marker = 'kokoro-log-marker-7q';
    let logged: AuthHarness;
    let output: string;

    beforeAll(async () => {
      logged = await createAuthHarness({ captureLogs: true });
      const jar = new CookieJar();
      const started = await logged.request(
        `/v1/auth/google/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=//evil.com/${marker}`,
        { jar },
      );
      const authorized = logged.fake.authorize(started.headers.get('location') ?? '', googleProfile);
      await logged.request(authorized.callbackUrl, { jar });
      output = logged.logLines.join('\n');
    }, 60_000);

    afterAll(async () => {
      await logged?.close();
    });

    it('actually logged something — otherwise the assertions below are vacuous', () => {
      expect(logged.logLines.length).toBeGreaterThan(0);
      expect(output).toContain('/v1/auth/google/start');
    });

    it('never writes the rejected proposal', () => {
      // The proposal rides in `req.url`, and no `redact` path can reach inside a
      // string — `sanitizeLoggedUrl` dropping the whole query is what closes it.
      expect(output).not.toContain(marker);
      expect(output.toLowerCase()).not.toContain('evil.com');
    });

    it('and writes nothing about it into the append-only audit trail', () => {
      // `audit_events` holds no DELETE grant (AD-12), so an attacker-chosen string
      // that reached a row could never be taken back out.
      expect(JSON.stringify(logged.audit.all())).not.toContain(marker);
    });
  });

  it('takes the ordinary failure road when the state has expired', async () => {
    const jar = new CookieJar();
    const started = await startWith(internalPath, jar);
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    // The signed path is bounded by the same clock the rest of the handshake is,
    // so there is no separate lifetime for it to outlive.
    harness.clock.advance((harness.config.OAUTH_STATE_TTL_SECONDS + 1) * 1000);

    expectOutcomeRedirect(await harness.request(authorized.callbackUrl, { jar }), 'that-bai');
  });
});

/**
 * Story 1.4 — the first-login declaration, over real HTTP.
 *
 * Every row of the story's matrix that involves the network is here. The pure
 * halves are covered where they live (`packages/contracts` for the parser,
 * `packages/domain` for the age rule, `packages/db`'s contract suite for the
 * write-once property against BOTH adapters); what only a running process can
 * show is that those pieces are actually wired to each other — that the endpoint
 * uses the shared parser, that `/me` reports the flags the domain computed, and
 * that the value never comes back out.
 */
describe('POST /v1/auth/date-of-birth', () => {
  /** The harness clock is fixed at 2026-09-04, so these two are stable for ever. */
  const ADULT_BIRTHDAY = '2008-09-04';
  const DAY_BEFORE_ADULT = '2008-09-05';

  const declare = (jar: CookieJar, body: unknown): Promise<Response> =>
    harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const me = async (jar: CookieJar) =>
    currentUserSchema.parse(await (await harness.request('/v1/auth/me', { jar })).json());

  it('is mounted at the path the contract declares', () => {
    // The controller composes it from `@Controller('v1/auth')` + `@Post(...)`,
    // so the two halves can drift from the constant `apps/web` navigates to.
    expect(AUTH_DATE_OF_BIRTH_PATH).toBe('/v1/auth/date-of-birth');
  });

  it('Matrix row: a brand-new profile is reported as NOT completed', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const profile = await me(jar);

    expect(profile.profile_completed).toBe(false);
    // Unknown age fails closed. "We have not asked yet" must never read as "adult".
    expect(profile.is_over_18).toBe(false);
  });

  it('Matrix row: a valid declaration is stored and /me then reports it', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const response = await declare(jar, { date_of_birth: '1999-04-02' });

    expect(response.status).toBe(200);
    const profile = await me(jar);
    expect(profile.profile_completed).toBe(true);
    expect(profile.is_over_18).toBe(true);
  });

  it('answers with the same projection /me does, and nothing more', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const body = await (await declare(jar, { date_of_birth: '1999-04-02' })).json();

    expect(Object.keys(body as object).sort()).toEqual([
      'avatar_url',
      'display_name',
      'id',
      'is_over_18',
      'profile_completed',
      'role',
    ]);
  });

  it('Matrix row: the eighteenth birthday itself counts as over 18', async () => {
    const { jar } = await harness.login('google', googleProfile);

    await declare(jar, { date_of_birth: ADULT_BIRTHDAY });

    expect((await me(jar)).is_over_18).toBe(true);
  });

  it('Matrix row: one day short of eighteen is not over 18, but IS completed', async () => {
    const { jar } = await harness.login('google', googleProfile);

    await declare(jar, { date_of_birth: DAY_BEFORE_ADULT });

    const profile = await me(jar);
    // The two flags are independent, and this is the row that proves it: the step
    // is finished, and the answer is still "no".
    expect(profile.profile_completed).toBe(true);
    expect(profile.is_over_18).toBe(false);
  });

  it('Matrix row: the date NEVER comes back out, on either endpoint', async () => {
    const { jar } = await harness.login('google', googleProfile);
    const declared = '1999-04-02';

    const written = await (await declare(jar, { date_of_birth: declared })).text();
    const read = await (await harness.request('/v1/auth/me', { jar })).text();

    for (const body of [written, read]) {
      expect(body).not.toContain(declared);
      expect(body).not.toContain('1999');
      expect(body).not.toContain('date_of_birth');
    }
    // And the responses were not simply empty, which would satisfy the above.
    expect(read).toContain('display_name');
  });

  it('Matrix row: a second declaration is refused and the first value stands', async () => {
    const { jar } = await harness.login('google', googleProfile);
    await declare(jar, { date_of_birth: '1999-04-02' });

    // A second attempt with a date that WOULD flip the age flag, so a silent
    // overwrite could not hide behind an unchanged answer.
    const second = await declare(jar, { date_of_birth: DAY_BEFORE_ADULT });

    expect(second.status).toBe(409);
    expect(errorEnvelopeSchema.safeParse(await second.json()).success).toBe(true);
    expect((await me(jar)).is_over_18).toBe(true);
  });

  it('does not disclose the stored value when it refuses the second attempt', async () => {
    const { jar } = await harness.login('google', googleProfile);
    await declare(jar, { date_of_birth: '1999-04-02' });

    const raw = await (await declare(jar, { date_of_birth: '2000-01-01' })).text();

    expect(raw).not.toContain('1999-04-02');
    expect(raw).not.toContain('1999');
  });

  it('Matrix row: two simultaneous declarations, exactly one wins', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const [first, second] = await Promise.all([
      declare(jar, { date_of_birth: '1999-04-02' }),
      declare(jar, { date_of_birth: '1970-01-01' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    // A 409 is not an error the caller did something wrong with — it is the
    // normal answer to "somebody else got there first", and it must never be a 5xx.
    expect(statuses).not.toContain(500);
  });

  describe('Matrix row: input that is not a date of birth is refused, and nothing is stored', () => {
    /**
     * One example per CLASS, not a list of spellings — the exhaustive sweep over
     * each family lives in `packages/contracts/src/auth.test.ts`, where it runs in
     * milliseconds. What this proves is that the endpoint asks that parser at all,
     * over real HTTP with Fastify's own JSON decoding in front of it.
     */
    it.each([
      ['a day that does not exist', { date_of_birth: '2026-02-30' }],
      ['a wrong shape', { date_of_birth: '02/04/1999' }],
      ['an ISO instant', { date_of_birth: '1999-04-02T00:00:00.000Z' }],
      ['surrounding whitespace', { date_of_birth: ' 1999-04-02 ' }],
      ['an implausible year', { date_of_birth: '0001-01-01' }],
      ['a value that is not a string', { date_of_birth: 19_990_402 }],
      ['null', { date_of_birth: null }],
      ['a missing field', {}],
      ['a body that is not an object', 'nope'],
      ['the field under the camelCase name a careless client would send', {
        dateOfBirth: '1999-04-02',
      }],
    ])('refuses %s with 400', async (_label, body) => {
      const { jar } = await harness.login('google', googleProfile);

      const response = await declare(jar, body);

      expect(response.status).toBe(400);
      expect(errorEnvelopeSchema.safeParse(await response.json()).success).toBe(true);
      // Nothing was written, so the one write this person is allowed is still theirs.
      expect((await me(jar)).profile_completed).toBe(false);
    });

    it('Matrix row: a date in the future is refused', async () => {
      const { jar } = await harness.login('google', googleProfile);

      // The harness clock is fixed at 2026-09-04.
      const response = await declare(jar, { date_of_birth: '2026-09-05' });

      expect(response.status).toBe(400);
      expect((await me(jar)).profile_completed).toBe(false);
    });

    it('says nothing technical and nothing about the threshold', async () => {
      const { jar } = await harness.login('google', googleProfile);

      const envelope = errorEnvelopeSchema.parse(
        await (await declare(jar, { date_of_birth: '2026-02-30' })).json(),
      );

      expect(envelope.error.message).toBe(DATE_OF_BIRTH_INVALID_MESSAGE);
      // No parser vocabulary, no field name, no age.
      for (const leak of ['parse', 'YYYY', 'zod', 'date_of_birth', '18']) {
        expect(envelope.error.message).not.toContain(leak);
      }
      // And no `details`, which is where diagnostics leak out of an envelope.
      expect(envelope.error.details).toBeUndefined();
    });
  });

  it('refuses an unauthenticated caller without looking at the body', async () => {
    const anonymous = new CookieJar();

    const response = await declare(anonymous, { date_of_birth: '1999-04-02' });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.safeParse(await response.json()).success).toBe(true);
  });

  it('answers 401 the same way for a valid and an invalid body, so nothing is enumerable', async () => {
    const anonymous = new CookieJar();

    const valid = await declare(anonymous, { date_of_birth: '1999-04-02' });
    const invalid = await declare(anonymous, { date_of_birth: 'nope' });

    expect(valid.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(await valid.text()).toBe(await invalid.text());
  });

  it('writes the declaration to the person holding the cookie, not to somebody else', async () => {
    const first = await harness.login('google', googleProfile);
    const second = await harness.login('google', {
      subject: 'google-subject-2',
      email: 'binh.tran@fpt.edu.vn',
      name: 'Binh Tran',
      picture: 'https://lh3.googleusercontent.com/a/binh',
    });

    await declare(second.jar, { date_of_birth: '1999-04-02' });

    expect((await me(second.jar)).profile_completed).toBe(true);
    expect((await me(first.jar)).profile_completed).toBe(false);
  });
});

describe('Matrix row: an incomplete profile is not locked out of its own session', () => {
  /**
   * The failure this rules out is the obvious over-correction: making the age
   * gate mean "nothing works until you declare". Somebody who has not answered
   * yet has to be able to read `/me` — the only endpoint that can tell them what
   * is missing — and to sign out, which on a shared machine is a security
   * question rather than a convenience.
   */
  it('answers /v1/auth/me for a profile with no date of birth', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const response = await harness.request('/v1/auth/me', { jar });

    expect(response.status).toBe(200);
    expect(currentUserSchema.parse(await response.json()).profile_completed).toBe(false);
  });

  it('answers /v1/auth/logout for a profile with no date of birth', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const response = await harness.request('/v1/auth/logout', { method: 'POST', jar });

    expect(response.status).toBe(204);
  });

  it('refreshes the session for a profile with no date of birth', async () => {
    const { jar } = await harness.login('google', googleProfile);

    const response = await harness.request('/v1/auth/refresh', { method: 'POST', jar });

    expect(response.status).toBe(204);
  });
});
