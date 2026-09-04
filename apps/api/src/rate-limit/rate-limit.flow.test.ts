import {
  RATE_LIMITED_MESSAGE,
  REFRESH_COOKIE_NAME,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  errorEnvelopeSchema,
} from '@stuwith/contracts';
import { RateLimitInputError, type RateLimitDecision, type RateLimitPort } from '@stuwith/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { INNOCENT_SIGN_IN_FAILURES, SIGN_IN_FAILURE_REASONS } from '../auth/audit';
import { CookieJar, createAuthHarness, type AuthHarness } from '../auth/__testing__/auth-harness';

/**
 * Every row of the story's I/O matrix that involves an HTTP request, driven
 * through a real NestJS + Fastify process over real HTTP.
 *
 * The counter is exercised through the ACTUAL guard, decorator and filter rather
 * than by calling the port — because the three things most likely to be wrong are
 * not in the port. They are: whether the decorator reached the route at all,
 * whether the address was inferred the way the domain says, and whether the
 * refusal comes back in the shape the caller can use.
 */

const GOOGLE_PROFILE = {
  subject: 'google-rate-limit-1',
  email: 'an.nguyen@fpt.edu.vn',
  name: 'An Nguyen',
  picture: 'https://lh3.googleusercontent.com/a/an',
};

let harness: AuthHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * The harness connects over loopback, so this is the address that is really the
 * socket peer — and therefore the one a deployment has to declare before any
 * `X-Forwarded-For` from these tests is read at all.
 */
const CADDY = '127.0.0.1';

/** One address in the position a proxy would have appended it. */
function fromAddress(address: string): Record<string, string> {
  return { 'x-forwarded-for': address };
}

describe('Matrix row: below the threshold', () => {
  it('lets ordinary traffic through with no rate-limit response at all', async () => {
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 5 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await harness.request('/v1/auth/me');
      // 401 because there is no session, NOT 429. The distinction is the test.
      expect(response.status).toBe(401);
      expect(response.headers.get('retry-after')).toBeNull();
    }
  }, 60_000);
});

describe('Matrix row: over the threshold, by address', () => {
  it('answers a json leg with 429, the rate_limited envelope and Retry-After', async () => {
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 2 });

    await harness.request('/v1/auth/me');
    await harness.request('/v1/auth/me');
    const blocked = await harness.request('/v1/auth/me');

    expect(blocked.status).toBe(429);

    const body = errorEnvelopeSchema.parse(await blocked.json());
    expect(body.error.code).toBe('rate_limited');

    const retryAfter = blocked.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(body.error.details?.['retry_after_seconds']).toBe(Number(retryAfter));
  }, 60_000);

  it('sends a BROWSER leg back to the login page with the locked code and the seconds', async () => {
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 1 });

    // The first start is a real 302 to the provider; the second is the refusal.
    const allowed = await harness.request('/v1/auth/google/start');
    expect(allowed.status).toBe(302);

    const blocked = await harness.request('/v1/auth/google/start');

    // A JSON body here would be a wall of braces on a white page: the person got
    // to this URL by clicking a link, not with `fetch`.
    expect(blocked.status).toBe(303);
    const location = new URL(blocked.headers.get('location') ?? '');
    expect(location.origin).toBe(new URL(harness.webBaseUrl).origin);
    expect(location.pathname).toBe('/dang-nhap');
    expect(location.searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM)).toBe('bi-khoa');
    expect(Number(location.searchParams.get(SIGN_IN_RETRY_AFTER_QUERY_PARAM))).toBeGreaterThan(0);
  }, 60_000);

  it('says nothing technical: no threshold, no dimension, no key', async () => {
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 1 });

    await harness.request('/v1/auth/me');
    const blocked = await harness.request('/v1/auth/me');
    const body = errorEnvelopeSchema.parse(await blocked.json());

    /**
     * Equality with the frozen constant, not a hand-kept list of forbidden words.
     *
     * Three files used to keep their own blacklists against this same constant, so
     * a word added to one left the other two blind. What the SENTENCE may contain
     * is decided once, in `contracts.test.ts`, beside the constant itself; what is
     * checked here is that this endpoint sends exactly that sentence.
     */
    expect(body.error.message).toBe(RATE_LIMITED_MESSAGE);

    // And that no configured threshold reached the wire in any other field — the
    // number that would say exactly how slowly to go. `ipLimit: 1` above is the
    // value that must not appear as a limit; the only number a caller gets is the
    // wait, and it is checked for equality with the header.
    const envelope = JSON.stringify(body);
    expect(envelope).not.toContain('"limit"');
    expect(envelope).not.toContain('"remaining"');
    expect(Object.keys(body.error.details ?? {})).toEqual(['retry_after_seconds']);
  }, 60_000);
});

describe('Matrix row: over the threshold, by user, across several addresses', () => {
  it('blocks the same credential arriving from a different address each time', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: CADDY,
      // Generous per address, tight per credential: the point is that changing
      // address buys nothing.
      ipLimit: 100,
      userLimit: 3,
    });

    // The same cookie every time. `userHandleOf` hashes it, so this is one
    // account holder however many machines they appear to be on.
    const credential = { cookie: 'stuwith_refresh=one-stolen-refresh-token' };
    const addresses = ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4'];

    const statuses: number[] = [];
    for (const address of addresses) {
      const response = await harness.request('/v1/auth/refresh', {
        method: 'POST',
        headers: { ...credential, ...fromAddress(address) },
      });
      statuses.push(response.status);
    }

    // Three go through (as 401s — the token is not real), the fourth is refused.
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
  }, 60_000);

  it('does not spend one visitor budget on another', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: CADDY,
      ipLimit: 100,
      userLimit: 1,
    });

    const call = (cookie: string) =>
      harness!.request('/v1/auth/refresh', { method: 'POST', headers: { cookie } });

    await call('stuwith_refresh=person-a');
    expect((await call('stuwith_refresh=person-a')).status).toBe(429);
    expect((await call('stuwith_refresh=person-b')).status).toBe(401);
  }, 60_000);
});

describe('Matrix row: the countdown is real', () => {
  it('returns fewer seconds after time has passed, not the same constant', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1,
      ipWindowSeconds: 60,
    });

    await harness.request('/v1/auth/me');
    const first = Number((await harness.request('/v1/auth/me')).headers.get('retry-after'));

    // The in-memory counter runs on the harness's clock, so this is exact and
    // instant. The Valkey pass of the contract suite proves the real store agrees.
    harness.clock.advance(30_000);
    const later = Number((await harness.request('/v1/auth/me')).headers.get('retry-after'));

    expect(first).toBeGreaterThan(0);
    expect(later).toBeLessThan(first);
  }, 60_000);
});

describe('Matrix row: waiting out the window', () => {
  it('allows again once the window has passed', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1,
      ipWindowSeconds: 30,
    });

    await harness.request('/v1/auth/me');
    expect((await harness.request('/v1/auth/me')).status).toBe(429);

    harness.clock.advance(31_000);

    expect((await harness.request('/v1/auth/me')).status).toBe(401);
  }, 60_000);
});

describe('Matrix row: the brute-force lock', () => {
  /** A callback with no state cookie: a failed sign-in, recorded as one. */
  /**
   * A COUNTED failed sign-in: a real `/start` for a state cookie we signed, then a
   * `code` the provider refuses.
   *
   * `?code=nope&state=nope` with no cookie is `state_missing`, which is innocent —
   * that is what a browser blocking the state cookie looks like. Using it here is
   * what let this whole suite pass while the attacker's actual path counted
   * nothing at all.
   */
  const failSignIn = async (h: AuthHarness) => {
    const jar = new CookieJar();
    const started = await h.request('/v1/auth/google/start', { jar });
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return h.request(`/v1/auth/google/callback?code=wrong&state=${state}`, { jar });
  };

  it('locks for longer than an ordinary window, and the ordinary window expiring does not release it', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      ipWindowSeconds: 10,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await failSignIn(harness);
      expect(failed.status).toBe(303);
    }

    const blocked = await harness.request('/v1/auth/google/start');
    const location = new URL(blocked.headers.get('location') ?? '');
    expect(location.searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM)).toBe('bi-khoa');
    const seconds = Number(location.searchParams.get(SIGN_IN_RETRY_AFTER_QUERY_PARAM));
    // Longer than the ordinary window — that difference is what makes it the
    // brute-force lock rather than another rate limit.
    expect(seconds).toBeGreaterThan(10);

    // Well past the ordinary window, and still locked.
    harness.clock.advance(20_000);
    const still = await harness.request('/v1/auth/google/start');
    expect(new URL(still.headers.get('location') ?? '').searchParams.get(
      SIGN_IN_OUTCOME_QUERY_PARAM,
    )).toBe('bi-khoa');

    // And it does run out on its own, rather than being a ban.
    harness.clock.advance(600_000);
    expect((await harness.request('/v1/auth/google/start')).status).toBe(302);
  }, 60_000);

  it('does not count a cancellation at the consent screen', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 1,
      bruteForceLockSeconds: 600,
    });

    // Story 1.3 part 1 established that changing your mind is not a failure.
    // Counting it towards a fifteen-minute lock would quietly make it one again.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cancelled = await harness.request(
        '/v1/auth/google/callback?error=access_denied&state=x',
      );
      expect(
        new URL(cancelled.headers.get('location') ?? '').searchParams.get(
          SIGN_IN_OUTCOME_QUERY_PARAM,
        ),
      ).toBe('da-huy');
    }

    expect((await harness.request('/v1/auth/google/start')).status).toBe(302);
  }, 60_000);
});

describe('Matrix row: a success clears the failure counter', () => {
  it('lets somebody who finally got in start from zero again', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    // Two failures — one short of the lock.
    await harness.request('/v1/auth/google/callback?code=nope&state=nope');
    await harness.request('/v1/auth/google/callback?code=nope&state=nope');

    const { callback } = await harness.login('google', GOOGLE_PROFILE);
    expect(callback.status).toBe(302);

    // Two more. Without the clear, this would be attempts three and four and the
    // lock would already have snapped shut on somebody who has just proved who
    // they are.
    await harness.request('/v1/auth/google/callback?code=nope&state=nope');
    await harness.request('/v1/auth/google/callback?code=nope&state=nope');

    expect((await harness.request('/v1/auth/google/start')).status).toBe(302);
  }, 60_000);
});

describe('Matrix row: a forged X-Forwarded-For on a DIRECT connection', () => {
  /**
   * The attack the frozen block was amended for, driven through the real server.
   *
   * Under the hop-count trust this story originally shipped, one declared hop plus
   * a direct connection carrying `X-Forwarded-For: <anything>` made the header the
   * rate-limit key — so an attacker picked their own key, rotated it per request,
   * and was never limited while honest users behind the real proxy were. Here the
   * harness IS a direct connection, and the deployment declares a proxy that is
   * not the peer.
   */
  it('ignores the header entirely and counts the socket address', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      // Somewhere else entirely. The peer (127.0.0.1) is not it.
      trustedProxies: '10.99.99.99',
      ipLimit: 2,
    });

    const statuses: number[] = [];
    for (const forged of ['1.2.3.4', '5.6.7.8', '9.10.11.12', '13.14.15.16']) {
      statuses.push((await harness.request('/v1/auth/me', { headers: fromAddress(forged) })).status);
    }

    // A brand-new address on every request, and the budget still runs out — the
    // header bought nothing at all.
    expect(statuses).toEqual([401, 401, 429, 429]);
  }, 60_000);

  it('ignores the header when the deployment declared no proxy at all', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: 'none',
      ipLimit: 1,
    });

    await harness.request('/v1/auth/me', { headers: fromAddress('1.2.3.4') });
    expect(
      (await harness.request('/v1/auth/me', { headers: fromAddress('5.6.7.8') })).status,
    ).toBe(429);
  }, 60_000);
});

describe('Matrix row: two people behind one proxy, and a forged X-Forwarded-For', () => {
  it('counts two visitors behind the same proxy separately', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: CADDY,
      ipLimit: 1,
    });

    await harness.request('/v1/auth/me', { headers: fromAddress('203.0.113.7') });
    expect(
      (await harness.request('/v1/auth/me', { headers: fromAddress('203.0.113.7') })).status,
    ).toBe(429);

    // The failure this rules out is the silent one: with `trustProxy` left at its
    // default, both of these would be 127.0.0.1 and the second person would be
    // locked out by the first.
    expect(
      (await harness.request('/v1/auth/me', { headers: fromAddress('198.51.100.4') })).status,
    ).toBe(401);
  }, 60_000);

  it('ignores hops the client invented before the proxy appended the real one', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: CADDY,
      ipLimit: 1,
    });

    const spoofed = (forged: string) => ({
      'x-forwarded-for': `${forged}, 203.0.113.7`,
    });

    await harness.request('/v1/auth/me', { headers: spoofed('9.9.9.9') });

    // A different invented hop each time, and the same real client each time. If
    // the forged entry counted, every one of these would be a fresh budget and
    // the limit would exist without ever blocking anything.
    expect((await harness.request('/v1/auth/me', { headers: spoofed('1.1.1.1') })).status).toBe(
      429,
    );
    expect(
      (await harness.request('/v1/auth/me', { headers: spoofed('2.2.2.2, 3.3.3.3') })).status,
    ).toBe(429);
  }, 60_000);
});

describe('Matrix rows: Valkey is down, and Valkey is slow', () => {
  /** Every call rejects, exactly as the adapter does when it cannot reach the store. */
  class DeadRateLimitPort implements RateLimitPort {
    constructor(private readonly delayMs = 0) {}

    private async fail(): Promise<never> {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      throw new Error('Command timed out');
    }

    hit(): Promise<RateLimitDecision> {
      return this.fail();
    }
    remainingSeconds(): Promise<number | null> {
      return this.fail();
    }
    lock(): Promise<number> {
      return this.fail();
    }
    clear(): Promise<void> {
      return this.fail();
    }
  }

  /**
   * `captureLogs` and not a spy on `Logger.prototype`.
   *
   * A spy intercepts the method and throws the message away, so it proves a call
   * happened and nothing about what production writes. The harness with
   * `captureLogs` calls `app.useLogger(app.get(PinoLogger))` exactly as `main.ts`
   * does and collects what a REAL pino emitted — so removing `app.useLogger(...)`
   * from `main.ts`, which would silence this line in production entirely, turns
   * these assertions red. That is the control AGENTS.md tells operators to alert
   * on; a test of a spy would have let it disappear.
   */
  const degraded = (delayMs = 0) =>
    createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1,
      bruteForceLimit: 1,
      captureLogs: true,
      rateLimitPort: new DeadRateLimitPort(delayMs),
    });

  it.each([
    ['down', 0],
    ['slow enough to time out', 20],
  ] as const)('lets the request through when the counter store is %s', async (_label, delayMs) => {
    harness = await degraded(delayMs);

    // Far past the limit. Every one of these has to go through: the human
    // decision on 2026-09-04 was fail OPEN.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await harness.request('/v1/auth/me');
      expect(response.status, 'a blind counter must not become a 429 or a 500').toBe(401);
    }

    // And a whole login still works, end to end.
    const { callback } = await harness.login('google', GOOGLE_PROFILE);
    expect(callback.status).toBe(302);

    // The other half of the decision, and the half that keeps it honest: an
    // outage nobody is told about is a control that has been off for a week.
    const outage = harness.logLines
      .join('')
      .split('\n')
      .filter((line) => line.includes('rate limiting is not working'));

    expect(outage).toHaveLength(1);
    // The level of THAT line. Asserting `"level":50` against the whole joined
    // buffer was satisfied by any error pino happened to write, including one from
    // an unrelated failure in the same run.
    expect(outage[0]).toContain('"level":50');
  }, 60_000);

  /**
   * The other fail-open path, and the one with no test at all until now.
   *
   * `failedSignIn` records the brute-force tick, and moving that pair out of
   * `withRateLimitStore` is a plausible tidy-up. It would turn every genuinely
   * failed sign-in into a 500 instead of the 303 Story 1.3 part 1 established —
   * during a Valkey outage, which is precisely when users are already failing.
   */
  it('still answers a FAILED sign-in the way Story 1.3 part 1 says, during an outage', async () => {
    harness = await degraded();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await harness.request('/v1/auth/google/callback?code=nope&state=nope');

      expect(failed.status, 'a failed login during an outage is still a 303').toBe(303);
      expect(
        new URL(failed.headers.get('location') ?? '').searchParams.get(
          SIGN_IN_OUTCOME_QUERY_PARAM,
        ),
      ).toBe('that-bai');
    }
  }, 60_000);

  /**
   * One line in, not one per request.
   *
   * The first version logged an `error` with a full stack from two call sites on
   * every single request. During exactly the incident this design anticipates —
   * the store down while the login page is being hammered — that is a log storm
   * that buries the one line an operator needs under thousands of copies of it.
   */
  it('reports the outage ONCE rather than once per request', async () => {
    harness = await degraded();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await harness.request('/v1/auth/me');
    }
    await harness.request('/v1/auth/google/callback?code=nope&state=nope');

    // LINES, not occurrences of the phrase: one pino event carries the message
    // twice — once as `msg` and once inside the serialised `err`.
    const lines = harness.logLines
      .join('')
      .split('\n')
      .filter((line) => line.includes('rate limiting is not working'));

    expect(lines, 'a degraded store must not write one stack per request').toHaveLength(1);
  }, 60_000);

  it('never puts the store failure in front of the user', async () => {
    harness = await degraded();

    const body = JSON.stringify(await (await harness.request('/v1/auth/me')).json());

    expect(body.toLowerCase()).not.toContain('valkey');
    expect(body.toLowerCase()).not.toContain('timed out');
    expect(body).not.toContain('rate limiting is not working');
  }, 60_000);
});

describe('Matrix row: signing out is never blocked', () => {
  it('answers POST /v1/auth/logout after everything else is refused', async () => {
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 1 });

    // Spend the whole budget for this address on something else first.
    await harness.request('/v1/auth/me');
    expect((await harness.request('/v1/auth/me')).status).toBe(429);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const out = await harness.request('/v1/auth/logout', { method: 'POST' });
      // Rate-limiting sign-out keeps somebody inside a session they are trying to
      // leave — on a shared machine that is a security failure, not a nuisance.
      expect(out.status, 'logout must never be rate limited').toBe(204);
      expect(out.headers.get('retry-after')).toBeNull();
    }
  }, 60_000);
});

/**
 * The brute-force rule, in both directions, through real HTTP.
 *
 * The rule is one sentence: a browser leg is counted and locked by ADDRESS, a
 * `fetch` leg by CREDENTIAL. Deleting it, or inverting it, used to pass everything
 * — and both mistakes were live at different points: refresh failures earned an
 * address lock that blocked `/start` for a whole NAT, and a session cookie riding
 * along on a cross-site callback locked a credential that was not part of the
 * attempt.
 */
describe('Matrix row: the brute-force lock is per channel, and earn matches enforce', () => {
  /** A COUNTED failed sign-in — see the note on the other copy of this helper. */
  const failSignIn = async (h: AuthHarness, headers: Record<string, string> = {}) => {
    const jar = new CookieJar();
    const started = await h.request('/v1/auth/google/start', { jar });
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return h.request(`/v1/auth/google/callback?code=wrong&state=${state}`, { jar, headers });
  };

  const failRefresh = (h: AuthHarness, cookie: string) =>
    h.request('/v1/auth/refresh', { method: 'POST', headers: { cookie } });

  it('an ADDRESS lock earned by sign-in failures does NOT reach a json leg', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await failSignIn(harness);
    }

    // The sign-in legs are locked...
    expect(
      new URL((await harness.request('/v1/auth/google/start')).headers.get('location') ?? '')
        .searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM),
    ).toBe('bi-khoa');

    // ...and `/me` is not, because one campus NAT is one address and signing
    // everybody on it out over a stranger's failed logins is not a defence.
    expect((await harness.request('/v1/auth/me')).status).toBe(401);
  }, 60_000);

  it('a CREDENTIAL lock earned by refresh failures DOES reach a json leg', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      userLimit: 1_000,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    const cookie = 'stuwith_refresh=a-token-nobody-issued';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await failRefresh(harness, cookie)).status).toBe(401);
    }

    // The credential is locked, with a wait far longer than any per-window budget.
    const blocked = await failRefresh(harness, cookie);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(500);

    // And it follows the credential, not the address.
    const elsewhere = await harness.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { cookie, 'x-forwarded-for': '198.51.100.9' },
    });
    expect(elsewhere.status).toBe(429);
  }, 60_000);

  it('a credential lock does not spill onto a different credential', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      userLimit: 1_000,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await failRefresh(harness, 'stuwith_refresh=victim-token');
    }

    expect((await failRefresh(harness, 'stuwith_refresh=victim-token')).status).toBe(429);
    expect((await failRefresh(harness, 'stuwith_refresh=somebody-else')).status).toBe(401);
  }, 60_000);

  it('refresh failures never earn an ADDRESS lock, so they cannot block signing in', async () => {
    // The half that used to be wrong: `countFailure` ticked both dimensions on a
    // json leg, so hammering `/refresh` locked `/start` and `/callback` for
    // everyone behind that address — the exact outcome skipping the address lock
    // on json legs was meant to prevent.
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      userLimit: 1_000,
      bruteForceLimit: 1,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await failRefresh(harness, `stuwith_refresh=token-${attempt}`);
    }

    expect((await harness.request('/v1/auth/google/start')).status).toBe(302);
  }, 60_000);

  it('a signed-in visitor cannot be locked by somebody else’s failed callbacks', async () => {
    /**
     * `SameSite=Lax` sends a session cookie on a top-level cross-site navigation,
     * which is exactly what `/callback` is. So an attacker who gets a signed-in
     * person to follow a handful of links with a bogus `state` used to lock that
     * person's credential for the full lock duration — with the victim having done
     * nothing but click.
     */
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      userLimit: 1_000,
      bruteForceLimit: 1,
      bruteForceLockSeconds: 600,
    });

    const victim = { cookie: 'stuwith_session=a-real-looking-session' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failSignIn(harness, victim);
    }

    // Their own `fetch` legs still work: nothing was counted against them.
    expect((await harness.request('/v1/auth/me', { headers: victim })).status).toBe(401);
    expect((await harness.request('/v1/auth/refresh', { method: 'POST', headers: victim })).status)
      .toBe(401);
  }, 60_000);
});

describe('Matrix row: a successful refresh clears its own failure counter', () => {
  it('does not carry refresh failures forward once the credential has proven itself', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      userLimit: 1_000,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    // Sign in for real, then fail a couple of refreshes with a bogus token.
    const { jar } = await harness.login('google', GOOGLE_PROFILE);
    const good = jar.get(REFRESH_COOKIE_NAME) ?? '';
    expect(good.length).toBeGreaterThan(0);

    // Two failures against the REAL credential — one short of the lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await harness.request('/v1/auth/refresh', {
        method: 'POST',
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${good}x` },
      });
    }

    // A rotation that works proves the credential; its counter should go with it.
    const rotated = await harness.request('/v1/auth/refresh', { method: 'POST', jar });
    expect(rotated.status).toBe(204);

    // Two more failures against the NEW credential must not tip a counter that
    // should have been cleared.
    const next = jar.get(REFRESH_COOKIE_NAME) ?? '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await harness.request('/v1/auth/refresh', {
        method: 'POST',
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${next}x` },
      });
    }

    const again = await harness.request('/v1/auth/refresh', { method: 'POST', jar });
    expect(again.status, 'the credential must not be locked after proving itself').toBe(204);
  }, 60_000);
});

/**
 * The invariant asserted in the guard docblock, the port docblock and `AGENTS.md`.
 * `rate-limit.guard.test.ts` covers the branch; this covers what a caller SEES,
 * which is the part the fail-open decision could have hidden.
 */
describe('a CODE defect surfaces as a 500, not as a Valkey outage', () => {
  class BrokenRateLimitPort implements RateLimitPort {
    private fail(): never {
      throw new RateLimitInputError('key must not contain whitespace');
    }
    hit(): Promise<RateLimitDecision> {
      return Promise.resolve().then(() => this.fail());
    }
    remainingSeconds(): Promise<number | null> {
      return Promise.resolve().then(() => this.fail());
    }
    lock(): Promise<number> {
      return Promise.resolve().then(() => this.fail());
    }
    clear(): Promise<void> {
      return Promise.resolve().then(() => this.fail());
    }
  }

  it('answers 500 and does NOT report the blocking layer as down', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      captureLogs: true,
      rateLimitPort: new BrokenRateLimitPort(),
    });

    expect((await harness.request('/v1/auth/me')).status).toBe(500);

    // The line an operator alerts on must not fire for a bug in this repository:
    // it would point the investigation at Valkey for ever while the layer, which
    // has failed open, never blocks anybody again.
    expect(harness.logLines.join('\n')).not.toContain('rate limiting is not working');
  }, 60_000);
});

describe('the guard leaves everything outside /v1/auth alone', () => {
  it('never rate-limits /healthz, however hard it is called', async () => {
    // The guard is registered GLOBALLY, so "only /v1/auth is limited" is a
    // property of the decorator being absent everywhere else — not of the routing.
    // Nothing pinned it, and a class-level decorator would have been invisible.
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 1 });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const health = await harness.request('/healthz');

      expect(health.status, '/healthz must never be rate limited').toBe(200);
      expect(health.headers.get('retry-after')).toBeNull();
    }
  }, 60_000);

  it('keeps answering /healthz while /v1/auth is refusing', async () => {
    harness = await createAuthHarness({ enabledProviders: ['google'], ipLimit: 1 });

    await harness.request('/v1/auth/me');
    expect((await harness.request('/v1/auth/me')).status).toBe(429);

    // A liveness probe that fails because somebody is hammering the login page is
    // how a rate limit turns into a restart loop.
    expect((await harness.request('/healthz')).status).toBe(200);
  }, 60_000);
});

/**
 * H9: the natural `/callback` attack, which nothing exercised.
 *
 * Every brute-force example used `?code=nope&state=nope` with NO cookie, so only
 * `state_missing` was ever counted. The attacker's actual path is one `/start` for
 * a valid `state` cookie, then guessed `code` values against it — and every one of
 * those used to map to `provider_exchange_failed`, which is on the innocent list,
 * so the counter never moved at all.
 */
describe('Matrix row: guessed codes against one valid state cookie', () => {
  it('counts them, and locks', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 2,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A real `/start`, so the browser is holding a state cookie we signed.
      const jar = new CookieJar();
      const started = await harness.request('/v1/auth/google/start', { jar });
      const authorizeUrl = new URL(started.headers.get('location') ?? '');
      const state = authorizeUrl.searchParams.get('state') ?? '';

      // ...and a `code` the provider will refuse.
      const failed = await harness.request(
        `/v1/auth/google/callback?code=guess-${attempt}&state=${state}`,
        { jar },
      );
      expect(failed.status, 'a refused code is still a redirect, not a 500').toBe(303);
    }

    const blocked = await harness.request('/v1/auth/google/start');
    expect(
      new URL(blocked.headers.get('location') ?? '').searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM),
      'guessed codes must walk towards a lock',
    ).toBe('bi-khoa');
  }, 60_000);

  /**
   * H12: the other side of the same decision.
   *
   * `state_missing` is what a browser that BLOCKS the state cookie looks like —
   * ITP, strict privacy settings. Counting it meant five honest attempts from such
   * a browser earned a fifteen-minute lock the person could do nothing about.
   */
  it('does NOT count an attempt whose browser sent no state cookie at all', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 1,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.request('/v1/auth/google/callback?code=anything&state=anything');
    }

    expect((await harness.request('/v1/auth/google/start')).status).toBe(302);
  }, 60_000);
});

/**
 * M27: the innocent list, pinned entry by entry.
 *
 * Only `user_cancelled` had an assertion. Removing `refresh_token_expired` or
 * `session_revoked` passed every test while a tab left open overnight earned a
 * lock, and removing `provider_exchange_failed` locked out everybody who tried
 * during an outage at Google.
 */
describe('the failures that must never walk anybody towards a lock', () => {
  it.each([
    ['user_cancelled', 'the person changed their mind at the consent screen'],
    ['provider_start_failed', 'the discovery document could not be fetched'],
    ['provider_authorize_failed', 'the provider refused before we saw a code'],
    ['provider_exchange_failed', 'the provider was unreachable during the exchange'],
    ['state_expired', 'the consent screen was left open too long'],
    ['state_missing', 'the browser blocks the state cookie'],
    ['refresh_cookie_missing', 'no refresh cookie was presented'],
    ['refresh_token_expired', 'a tab was left open overnight'],
    ['session_revoked', 'the session was ended from another device'],
  ])('%s is innocent — %s', (reason) => {
    expect(INNOCENT_SIGN_IN_FAILURES.has(reason as never)).toBe(true);
  });

  it.each(['state_mismatch', 'code_missing', 'code_rejected', 'identity_rejected',
    'refresh_token_unknown', 'session_reuse_detected'])(
    '%s IS counted, because it is the shape of an attack',
    (reason) => {
      expect(INNOCENT_SIGN_IN_FAILURES.has(reason as never)).toBe(false);
    },
  );

  it('classifies every declared reason one way or the other', () => {
    // Adding a reason and forgetting to decide is how a new failure path silently
    // starts (or stops) counting.
    for (const reason of SIGN_IN_FAILURE_REASONS) {
      expect(typeof INNOCENT_SIGN_IN_FAILURES.has(reason)).toBe('boolean');
    }
  });
});

/**
 * M33: where the threshold actually is.
 *
 * `RATE_LIMIT_BRUTE_FORCE_MAX` is the number of failures ALLOWED — the lock trips
 * on the one after it, exactly as `RATE_LIMIT_IP_MAX` allows N requests and refuses
 * the N+1th. Every test did `N + 1` failures, so neither reading was distinguished
 * and the docs could say either.
 */
describe('the brute-force boundary, from both sides', () => {
  const failWithState = async (h: AuthHarness) => {
    const jar = new CookieJar();
    const started = await h.request('/v1/auth/google/start', { jar });
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
    await h.request(`/v1/auth/google/callback?code=wrong&state=${state}`, { jar });
  };

  it('allows exactly RATE_LIMIT_BRUTE_FORCE_MAX failures without locking', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 3,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await failWithState(harness);
    }

    expect((await harness.request('/v1/auth/google/start')).status).toBe(302);
  }, 60_000);

  it('locks on the one after it', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      ipLimit: 1_000,
      bruteForceLimit: 3,
      bruteForceLockSeconds: 600,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await failWithState(harness);
    }

    expect(
      new URL((await harness.request('/v1/auth/google/start')).headers.get('location') ?? '')
        .searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM),
    ).toBe('bi-khoa');
  }, 60_000);
});

/**
 * H8: the controller's own identity resolution used to sit outside any `try`,
 * while the guard's identical pair sat inside one with a comment explaining why.
 */
describe('a hostile cookie or header never turns a login into a 500', () => {
  const hostile: Record<string, string> = {
    cookie: `stuwith_refresh=${'x'.repeat(9_000)}; =broken; ;;; stuwith_session=`,
    'x-forwarded-for': `${','.repeat(400)} not-an-ip, %%%, ::::::`,
  };

  it.each([
    ['the callback leg', '/v1/auth/google/callback?code=a&state=b', 303],
    ['the me leg', '/v1/auth/me', 401],
  ])('%s answers normally', async (_label, path, expected) => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: CADDY,
      ipLimit: 1_000,
    });

    expect((await harness.request(path, { headers: hostile })).status).toBe(expected);
  }, 60_000);

  it('the refresh leg answers normally', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      trustedProxies: CADDY,
      ipLimit: 1_000,
    });

    const response = await harness.request('/v1/auth/refresh', {
      method: 'POST',
      headers: hostile,
    });
    expect(response.status).toBe(401);
  }, 60_000);
});

/**
 * H10: a plain bug in the guard is not a Valkey outage.
 *
 * The fail-open branch used to be "anything that is not a `RateLimitInputError`",
 * which swallowed every `TypeError` in this file too — reported for ever as "the
 * counter store did not answer", with the alert pointing at Valkey and the layer
 * left off.
 */
describe('a programming error is not reported as a store outage', () => {
  class BuggyRateLimitPort implements RateLimitPort {
    private fail(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'count')");
    }
    hit(): Promise<RateLimitDecision> {
      return Promise.resolve().then(() => this.fail());
    }
    remainingSeconds(): Promise<number | null> {
      return Promise.resolve().then(() => this.fail());
    }
    lock(): Promise<number> {
      return Promise.resolve().then(() => this.fail());
    }
    clear(): Promise<void> {
      return Promise.resolve().then(() => this.fail());
    }
  }

  it('answers 500 and does not claim the blocking layer is down', async () => {
    harness = await createAuthHarness({
      enabledProviders: ['google'],
      captureLogs: true,
      rateLimitPort: new BuggyRateLimitPort(),
    });

    expect((await harness.request('/v1/auth/me')).status).toBe(500);
    expect(harness.logLines.join('\n')).not.toContain('rate limiting is not working');
  }, 60_000);
});
