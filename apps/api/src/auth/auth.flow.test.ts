import {
  AUTH_COOKIE_PATH,
  OAUTH_STATE_COOKIE_PREFIX,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  errorEnvelopeSchema,
  currentUserSchema,
} from '@stuwith/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    const second = await harness.login('google', googleProfile, new CookieJar());

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
      new CookieJar(),
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
      harness.login('google', profile, new CookieJar()),
      harness.login('google', profile, new CookieJar()),
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
      new CookieJar(),
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
      new CookieJar(),
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

    expect(callback.status).toBe(401);
    const body = errorEnvelopeSchema.parse(await callback.json());
    expect(body.error.code).toBe('unauthenticated');
    expect(await harness.identity.countUsers()).toBe(0);
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    const jar = new CookieJar();
    const started = await harness.request('/v1/auth/google/start', { jar });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);

    const tampered = new URL(authorized.callbackUrl);
    tampered.searchParams.set('state', 'not-the-state-we-issued');
    const callback = await harness.request(tampered.toString(), { jar });

    expect(callback.status).toBe(401);
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
    expect(callback.status).toBe(401);
  });

  it('names no provider and no provider error code in the response', async () => {
    const started = await harness.request('/v1/auth/google/start', { jar: new CookieJar() });
    const authorized = harness.fake.authorize(started.headers.get('location') ?? '', googleProfile);
    const callback = await harness.request(authorized.callbackUrl);

    const raw = await callback.text();
    expect(raw.toLowerCase()).not.toContain('google');
    expect(raw).not.toContain('provider_error');
    expect(raw).not.toContain('invalid_grant');
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

    expect(callback.status).toBe(401);
  });
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
    expect(second.status).toBe(401);
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

    expect((await harness.request(authorized.callbackUrl, { jar })).status).toBe(401);
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
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'avatar_url',
      'display_name',
      'id',
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

    expect(response.status).toBe(401);
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

    expect(response.status).toBe(401);
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
