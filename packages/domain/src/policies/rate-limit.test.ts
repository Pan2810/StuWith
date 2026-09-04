import { describe, expect, it } from 'vitest';
import {
  BRUTE_FORCE_DIMENSIONS,
  EMPTY_KEY_SEGMENT,
  RATE_LIMIT_ACTIONS,
  UNKNOWN_CLIENT_IP,
  bruteForceCounterKey,
  bruteForceSubjectFor,
  bruteForceLockKey,
  channelForAction,
  isRateLimitAction,
  keySegment,
  rateLimitKey,
  rateLimitRulesFor,
  retryAfterSecondsFrom,
  type RateLimitSettings,
} from './rate-limit';

/**
 * The keys and the policy.
 *
 * Working out WHICH address a request came from is no longer here at all. It was a
 * hand-written IP and CIDR parser; three review rounds found three different holes
 * in it — hop counting, `/0`, then `/1` — and `apps/api` now asks
 * `@fastify/proxy-addr`, the library Fastify itself uses, so the two cannot
 * disagree.
 */

const CLIENT = '203.0.113.7';

describe('keys cannot be reshaped by the value inside them', () => {
  it('strips characters that could impersonate another dimension', () => {
    expect(keySegment('ip:auth_me:victim')).toBe('x.ip.auth_me.victim');
  });

  it('replaces anything outside the safe alphabet', () => {
    expect(keySegment('a b/c\nd')).toBe('x.a_b_c_d');
  });

  it('caps the length, so a long header cannot grow the key without bound', () => {
    expect(keySegment('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });

  it('never produces an empty segment, and does not reuse the unknown bucket', () => {
    // They used to be the same string, so an empty segment and an unreadable
    // address shared one budget.
    expect(keySegment('').length).toBeGreaterThan(0);
    expect(keySegment('')).not.toBe(keySegment(UNKNOWN_CLIENT_IP));
  });

  /**
   * The sentinels, against outside values written to LOOK like them.
   *
   * This is the hole M1 found: cleaning replaced `!` with `_` rather than
   * rejecting it, so `'!unresolved'`, `'_unresolved'` and `'@unresolved'` from
   * outside all cleaned to the single string `_unresolved` — which was exactly
   * what `keySegment(UNKNOWN_CLIENT_IP)` produced too. Anybody who could put one
   * of those in a header shared the bucket reserved for "this address could not
   * be read", while the docblock promised that could not happen.
   *
   * The separation is now the `x.` prefix on every outside value, so it holds for
   * spellings nobody has thought of rather than for the three below.
   */
  it.each([
    'unknown',
    '!unresolved',
    '_unresolved',
    '@unresolved',
    '!empty',
    '_empty',
  ])('no outside value, however spelled, becomes a sentinel segment (%s)', (outside) => {
    expect(keySegment(outside)).not.toBe(UNKNOWN_CLIENT_IP);
    expect(keySegment(outside)).not.toBe(EMPTY_KEY_SEGMENT);
  });

  /**
   * The bucket, not just the segment — this is the assertion that would have gone
   * red on the old code.
   *
   * `keySegment` used to replace `!` with `_`, so `'!unresolved'`, `'_unresolved'`
   * and `'@unresolved'` from a header all cleaned to `_unresolved`, which was
   * exactly what the unresolved sentinel cleaned to as well. Anybody who could
   * put one of those in the address field shared the bucket reserved for "this
   * address could not be read". The separation is now the `x.` prefix, so it
   * holds for spellings nobody has thought of rather than for the three below.
   *
   * The literal string `!unresolved` is deliberately absent from the table: it IS
   * the sentinel, so "an outside value equal to it" is not a distinguishable case
   * at this layer. It is unreachable one layer up instead — `clientIpOf` returns
   * either an address `node:net` validated or the constant itself, and no IP
   * address contains `!`.
   */
  it.each(['unknown', '_unresolved', '@unresolved', '!!unresolved', 'x.!unresolved'])(
    'an outside address spelled like the sentinel (%s) gets a different key',
    (outside) => {
      const ours = rateLimitRulesFor('auth_start', { clientIp: UNKNOWN_CLIENT_IP }, SETTINGS);
      const theirs = rateLimitRulesFor('auth_start', { clientIp: outside }, SETTINGS);

      expect(theirs[0]?.key).not.toBe(ours[0]?.key);
    },
  );

  it('puts every outside value in one namespace and the sentinels in another', () => {
    // Structural, not alphabetical: the prefix is added unconditionally, so there
    // is no input at all that produces a segment in the sentinels' namespace.
    expect(keySegment('203.0.113.7').startsWith('x.')).toBe(true);
    expect(UNKNOWN_CLIENT_IP.startsWith('x.')).toBe(false);
    expect(EMPTY_KEY_SEGMENT.startsWith('x.')).toBe(false);
    expect(keySegment('')).toBe(EMPTY_KEY_SEGMENT);
  });

  it('keeps the counter and the lock distinct, which is what makes both rows true', () => {
    // A success clears the counter; a lock already earned still runs its course.
    expect(bruteForceCounterKey('ip', CLIENT)).not.toBe(bruteForceLockKey('ip', CLIENT));
  });

  it('keeps the two brute-force dimensions apart', () => {
    expect(bruteForceCounterKey('ip', 'abc')).not.toBe(bruteForceCounterKey('user', 'abc'));
    expect(bruteForceLockKey('ip', 'abc')).not.toBe(bruteForceLockKey('user', 'abc'));
  });

  it('keeps dimensions and actions apart', () => {
    expect(rateLimitKey('ip', 'auth_me', CLIENT)).not.toBe(
      rateLimitKey('user', 'auth_me', CLIENT),
    );
    expect(rateLimitKey('ip', 'auth_me', CLIENT)).not.toBe(
      rateLimitKey('ip', 'auth_refresh', CLIENT),
    );
  });
});

const SETTINGS: RateLimitSettings = {
  ipLimit: 30,
  ipWindowSeconds: 60,
  userLimit: 10,
  userWindowSeconds: 60,
  bruteForceLimit: 5,
  bruteForceLockSeconds: 900,
};

describe('rateLimitRulesFor', () => {
  it('always checks the IP dimension', () => {
    const rules = rateLimitRulesFor('auth_start', { clientIp: CLIENT }, SETTINGS);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.dimension).toBe('ip');
    expect(rules[0]?.limit).toBe(30);
    expect(rules[0]?.windowSeconds).toBe(60);
  });

  it('adds the user dimension once a credential has been presented', () => {
    const rules = rateLimitRulesFor(
      'auth_refresh',
      { clientIp: CLIENT, userHandle: 'abc123' },
      SETTINGS,
    );

    expect(rules.map((rule) => rule.dimension)).toEqual(['ip', 'user']);
    expect(rules[1]?.limit).toBe(10);
  });

  it('gives the same user the same key from a different address', () => {
    const fromOne = rateLimitRulesFor(
      'auth_refresh',
      { clientIp: '198.51.100.1', userHandle: 'abc123' },
      SETTINGS,
    );
    const fromAnother = rateLimitRulesFor(
      'auth_refresh',
      { clientIp: '198.51.100.2', userHandle: 'abc123' },
      SETTINGS,
    );

    // The whole point of the second dimension: changing address must not buy a
    // fresh budget.
    expect(fromOne[1]?.key).toBe(fromAnother[1]?.key);
    expect(fromOne[0]?.key).not.toBe(fromAnother[0]?.key);
  });

  it('ignores an empty handle rather than keying everybody onto one bucket', () => {
    expect(
      rateLimitRulesFor('auth_me', { clientIp: CLIENT, userHandle: '' }, SETTINGS),
    ).toHaveLength(1);
  });
});

describe('brute force: one dimension per channel, counted and enforced the same way', () => {
  it('declares exactly the two dimensions', () => {
    expect([...BRUTE_FORCE_DIMENSIONS]).toEqual(['ip', 'user']);
  });

  it('counts a browser leg against the ADDRESS, credential or not', () => {
    /**
     * A sign-in attempt has no credential of its own. Whatever cookie rode along
     * belongs to a different, already-signed-in session — under `SameSite=Lax` a
     * cross-site navigation to `/callback` sends it — so counting it would let
     * five induced clicks lock a person who was never part of the attempt.
     */
    expect(bruteForceSubjectFor('browser', { clientIp: CLIENT })).toEqual({
      dimension: 'ip',
      value: CLIENT,
    });
    expect(
      bruteForceSubjectFor('browser', { clientIp: CLIENT, userHandle: 'someone-else' }),
    ).toEqual({ dimension: 'ip', value: CLIENT });
  });

  it('counts a json leg against the CREDENTIAL', () => {
    // The dimension that survives an address change: a stolen refresh token
    // replayed from fifty machines is fifty addresses and one handle.
    expect(
      bruteForceSubjectFor('json', { clientIp: CLIENT, userHandle: 'abc123' }),
    ).toEqual({ dimension: 'user', value: 'abc123' });
  });

  it('counts nothing on a json leg with no credential presented', () => {
    // There is no honest key. Counting the address here would EARN a lock that
    // the browser legs enforce — locking `/start` for everyone on a campus NAT
    // because somebody hammered `/refresh` with no cookie.
    expect(bruteForceSubjectFor('json', { clientIp: CLIENT })).toBeNull();
    expect(bruteForceSubjectFor('json', { clientIp: CLIENT, userHandle: '' })).toBeNull();
  });

  it('never lets a json leg earn an address lock', () => {
    // The invariant behind M4: earn and enforce read the same function, so a
    // dimension that one leg cannot enforce is a dimension it cannot earn.
    for (const subject of [
      { clientIp: CLIENT },
      { clientIp: CLIENT, userHandle: 'abc123' },
    ]) {
      expect(bruteForceSubjectFor('json', subject)?.dimension).not.toBe('ip');
    }
  });

  it('gives one credential the same key from any address', () => {
    const here = bruteForceSubjectFor('json', { clientIp: '198.51.100.1', userHandle: 'abc' });
    const there = bruteForceSubjectFor('json', { clientIp: '198.51.100.2', userHandle: 'abc' });

    expect(bruteForceLockKey('user', here?.value ?? '')).toBe(
      bruteForceLockKey('user', there?.value ?? ''),
    );
  });
});

describe('the action vocabulary is closed, and logout is not in it', () => {
  it('does not contain a logout action at all', () => {
    // Not "logout is exempted somewhere" — there is no name to put on that route,
    // so it cannot acquire a limit by someone copying a decorator onto it.
    expect(RATE_LIMIT_ACTIONS).not.toContain('auth_logout');
    expect(isRateLimitAction('auth_logout')).toBe(false);
  });

  it.each([...RATE_LIMIT_ACTIONS])('classifies %s as a browser or a json leg', (action) => {
    expect(['browser', 'json']).toContain(channelForAction(action));
  });

  it('sends the two legs a browser reaches back as a redirect', () => {
    expect(channelForAction('auth_start')).toBe('browser');
    expect(channelForAction('auth_callback')).toBe('browser');
  });

  it('sends the two legs fetch reaches back as an envelope', () => {
    expect(channelForAction('auth_refresh')).toBe('json');
    expect(channelForAction('auth_me')).toBe('json');
  });

  it('rejects anything that is not one of the four', () => {
    expect(isRateLimitAction('anything')).toBe(false);
    expect(isRateLimitAction(undefined)).toBe(false);
    expect(isRateLimitAction(7)).toBe(false);
  });
});

describe('retryAfterSecondsFrom', () => {
  it('rounds up, so waiting exactly as told is enough', () => {
    // 4.6s rounded DOWN tells somebody to wait 4 and refuses them again at 4.
    expect(retryAfterSecondsFrom(4_600)).toBe(5);
    expect(retryAfterSecondsFrom(4_001)).toBe(5);
  });

  it('never says zero', () => {
    // `Retry-After: 0` invites an immediate retry, which is the one thing the
    // answer must not do.
    expect(retryAfterSecondsFrom(0)).toBe(1);
    expect(retryAfterSecondsFrom(-1)).toBe(1);
    expect(retryAfterSecondsFrom(Number.NaN)).toBe(1);
  });

  it('passes a whole number through unchanged', () => {
    expect(retryAfterSecondsFrom(30_000)).toBe(30);
  });
});

/**
 * L11: the unresolved bucket is ONE key shared by every caller whose address could
 * not be worked out, and that sharing is deliberate rather than an oversight.
 *
 * The alternative — skipping the limit when the address is unreadable — hands
 * anybody who can produce an unreadable address a way past the whole feature. So
 * they are counted together, and the bound on the harm is that they are never
 * LOCKED together.
 */
describe('the unresolved bucket', () => {
  it('counts every unresolvable caller on one key, on purpose', () => {
    const rules = rateLimitRulesFor('auth_start', { clientIp: UNKNOWN_CLIENT_IP }, SETTINGS);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.key).toBe(`rl:ip:auth_start:${UNKNOWN_CLIENT_IP}`);
  });

  it('never LOCKS on it, so one such caller cannot lock out the rest', () => {
    // A fifteen-minute lock covering every unresolvable peer is a different order
    // of harm from a shared per-minute window, and none of them could do anything
    // about it.
    expect(bruteForceSubjectFor('browser', { clientIp: UNKNOWN_CLIENT_IP })).toBeNull();
  });

  it('still locks a credential that happens to arrive unresolvable', () => {
    // The credential dimension is unaffected: it identifies one account holder
    // however unreadable their address is.
    expect(
      bruteForceSubjectFor('json', { clientIp: UNKNOWN_CLIENT_IP, userHandle: 'abc' }),
    ).toEqual({ dimension: 'user', value: 'abc' });
  });
});
