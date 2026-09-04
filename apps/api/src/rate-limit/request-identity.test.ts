import {
  MAX_RATE_LIMIT_KEY_LENGTH,
  UNKNOWN_CLIENT_IP,
  bruteForceCounterKey,
  rateLimitKey,
} from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { clientIpOf, rateLimitSubjectOf, userHandleOf } from './request-identity';

/**
 * The two functions that turn a request into the values every key is built from.
 *
 * They are covered end-to-end by `rate-limit.flow.test.ts`, but only for the paths
 * a real request takes. What is asserted here is the property that has no HTTP
 * shape: the raw session token must never survive into a key, and the key must
 * stay inside the length the port will accept.
 */

const SECRET = 'unit-test-secret-'.padEnd(48, 'x');

/**
 * Only what these functions read. `raw` is there because `@fastify/proxy-addr`
 * takes the Node request, which is what Fastify hands it too.
 */
function requestWith(headers: Record<string, string | string[]>): FastifyRequest {
  const socket = { remoteAddress: '203.0.113.7' };
  return {
    headers,
    socket,
    raw: { headers, socket, connection: socket },
  } as unknown as FastifyRequest;
}

/** Stands in for "the peer is a declared proxy", without naming an address. */
const TRUST_ALL = (): boolean => true;

describe('userHandleOf', () => {
  it('is undefined when the request carries no credential at all', () => {
    // Every unauthenticated sign-in attempt is this case. Returning a constant
    // here would key every anonymous visitor onto one shared budget.
    expect(userHandleOf(requestWith({}), SECRET)).toBeUndefined();
    expect(userHandleOf(requestWith({ cookie: 'other=1' }), SECRET)).toBeUndefined();
    expect(userHandleOf(requestWith({ cookie: 'stuwith_refresh=' }), SECRET)).toBeUndefined();
  });

  it('prefers the refresh cookie over the session cookie', () => {
    /**
     * The refresh token is the one that survives an expiry: after the session
     * token ages out, `/v1/auth/refresh` still presents the same refresh token, so
     * the budget follows the person instead of resetting every hour.
     */
    const both = requestWith({ cookie: 'stuwith_session=aaa; stuwith_refresh=bbb' });
    const refreshOnly = requestWith({ cookie: 'stuwith_refresh=bbb' });

    expect(userHandleOf(both, SECRET)).toBe(userHandleOf(refreshOnly, SECRET));
  });

  it('falls back to the session cookie when there is no refresh cookie', () => {
    expect(userHandleOf(requestWith({ cookie: 'stuwith_session=aaa' }), SECRET)).toBeDefined();
  });

  it('NEVER contains the raw token', () => {
    // The handle goes into a Valkey key and could end up in a log line. A session
    // token in either place is a session anybody can take over.
    const token = 'a-very-recognisable-refresh-token';
    const handle = userHandleOf(requestWith({ cookie: `stuwith_refresh=${token}` }), SECRET) ?? '';

    expect(handle.length).toBeGreaterThan(0);
    expect(handle).not.toContain(token);
    expect(handle).toMatch(/^[0-9a-f]+$/);
  });

  it('is stable for one token and different for another', () => {
    const one = userHandleOf(requestWith({ cookie: 'stuwith_refresh=one' }), SECRET);

    expect(userHandleOf(requestWith({ cookie: 'stuwith_refresh=one' }), SECRET)).toBe(one);
    expect(userHandleOf(requestWith({ cookie: 'stuwith_refresh=two' }), SECRET)).not.toBe(one);
  });

  it('depends on the secret, so a database dump alone cannot reproduce it', () => {
    const request = requestWith({ cookie: 'stuwith_refresh=one' });

    expect(userHandleOf(request, SECRET)).not.toBe(userHandleOf(request, `${SECRET}-other`));
  });

  it('is short enough that every composed key fits the port limit', () => {
    // `assertValidRateLimitKey` refuses anything longer, and it refuses by
    // THROWING — which the guard deliberately does not swallow. An over-long
    // handle would therefore be a 500 on every authenticated request.
    const handle =
      userHandleOf(requestWith({ cookie: `stuwith_refresh=${'x'.repeat(4_000)}` }), SECRET) ?? '';

    for (const key of [
      rateLimitKey('user', 'auth_refresh', handle),
      bruteForceCounterKey('user', handle),
    ]) {
      expect(key.length).toBeLessThanOrEqual(MAX_RATE_LIMIT_KEY_LENGTH);
    }
  });
});

describe('clientIpOf', () => {
  it('is total: a malformed header yields a bucket rather than a throw', () => {
    /**
     * This runs INSIDE the guard's fail-open try block now, but it must also be
     * total on its own: the values it reads are a header and a socket, both
     * attacker-supplied, on a layer whose whole posture is to let requests
     * through when it cannot decide.
     */
    // The NUL is written as an ESCAPE, never as a literal byte: a raw one makes
    // git treat the whole file as binary and hides it from grep. Same value.
    const inputs = ['', '   ', ',,,', 'not-an-ip', '\u0000', 'x'.repeat(5_000)];
    for (const forwardedFor of inputs) {
      expect(() =>
        clientIpOf(requestWith({ 'x-forwarded-for': forwardedFor }), TRUST_ALL),
      ).not.toThrow();
    }
  });

  it('ignores the header when nothing is declared as a proxy', () => {
    // `false` is what `compileTrustedProxies('none')` produces: the header is not
    // evidence of anything and must not be read at all.
    expect(clientIpOf(requestWith({ 'x-forwarded-for': '1.2.3.4' }), false)).toBe('203.0.113.7');
  });

  it('reads the header when the peer IS a declared proxy', () => {
    expect(clientIpOf(requestWith({ 'x-forwarded-for': '1.2.3.4' }), TRUST_ALL)).toBe('1.2.3.4');
  });

  it('survives a request with no socket at all', () => {
    const headless = { headers: {}, raw: { headers: {}, socket: {} } } as unknown as FastifyRequest;
    expect(clientIpOf(headless, false)).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpOf(headless, TRUST_ALL)).toBe(UNKNOWN_CLIENT_IP);
  });

  /**
   * What a TRUSTED proxy forwards is still not a fact.
   *
   * `@fastify/proxy-addr` answers with the left-most entry of `X-Forwarded-For`
   * that is not trusted, and it never checks that the entry is an address at all —
   * that is not its job. So a proxy forwarding junk, or a caller upstream of one
   * appending junk, turned the junk straight into a rate-limit key: rotate the
   * junk, rotate the key, and the limit counts nothing. Every one of these is a
   * value the library will hand back verbatim.
   */
  it.each([
    ['a word', 'not-an-ip'],
    ['a hostname', 'proxy.internal'],
    ['an address with a port', '203.0.113.9:443'],
    ['an out-of-range quad', '999.0.0.1'],
    ['an IPv6 shape node:net rejects', '1.2.3.4::'],
    ['punctuation', '@@@@'],
    ['something long', 'a'.repeat(300)],
  ])('refuses to key on %s forwarded by a trusted proxy', (_label, forged) => {
    expect(clientIpOf(requestWith({ 'x-forwarded-for': forged }), TRUST_ALL)).toBe(
      UNKNOWN_CLIENT_IP,
    );
  });

  it('gives two junk values the SAME bucket, so rotating junk buys nothing', () => {
    const first = clientIpOf(requestWith({ 'x-forwarded-for': 'junk-one' }), TRUST_ALL);
    const second = clientIpOf(requestWith({ 'x-forwarded-for': 'junk-two' }), TRUST_ALL);

    expect(first).toBe(second);
  });

  /**
   * A zone index names an interface on the machine READING the address, not the
   * machine the address belongs to. Keeping it means `fe80::1%eth0` and
   * `fe80::1%eth1` are two budgets for one peer.
   */
  it.each([
    ['fe80::1%eth0', 'fe80::1'],
    ['fe80::1%25eth0', 'fe80::1'],
    ['FE80::1%eth1', 'fe80::1'],
  ])('drops the zone index: %s counts as %s', (raw, expected) => {
    expect(clientIpOf(requestWith({ 'x-forwarded-for': raw }), TRUST_ALL)).toBe(expected);
  });

  it('folds the mapped spelling of an address onto the plain one', () => {
    expect(clientIpOf(requestWith({ 'x-forwarded-for': '::ffff:198.51.100.4' }), TRUST_ALL)).toBe(
      '198.51.100.4',
    );
  });

  it('leaves a real IPv6 address alone rather than slicing it', () => {
    // `::ffff:cb00:7107` is IPv4-mapped written in hex; slicing the prefix would
    // leave `cb00:7107`, which is not an address, and hand one machine a second
    // budget for free.
    expect(clientIpOf(requestWith({ 'x-forwarded-for': '2001:db8::1' }), TRUST_ALL)).toBe(
      '2001:db8::1',
    );
    expect(clientIpOf(requestWith({ 'x-forwarded-for': '::ffff:cb00:7107' }), TRUST_ALL)).toBe(
      '::ffff:cb00:7107',
    );
  });
});

/**
 * The whole subject, computed ONCE for both callers.
 *
 * The guard and `AuthController` each used to build this pair themselves, and the
 * copies had drifted: the controller's wrapped both calls in a single `try`, so a
 * throw out of the cookie half discarded the address as well. The guard, on the
 * same request, had resolved that address fine — so a failed sign-in was recorded
 * against the unresolved bucket while the guard was counting the real one, and the
 * two halves of the brute-force bookkeeping keyed on different values.
 */
describe('rateLimitSubjectOf', () => {
  const TRUST_NONE = false as const;

  it('answers with both halves for an ordinary request', () => {
    const subject = rateLimitSubjectOf(
      requestWith({ cookie: 'stuwith_refresh=bbb' }),
      TRUST_NONE,
      SECRET,
    );

    expect(subject.clientIp).toBe('203.0.113.7');
    expect(subject.userHandle).toBeDefined();
  });

  /**
   * The mutation this example exists for: put the two calls back under one `try`
   * and the credential disappears with the address.
   */
  it('keeps the credential when reading the ADDRESS is what failed', () => {
    const hostile = {
      // A socket that cannot be read at all. `clientIpOf` does not wrap this
      // branch, so the throw escapes it.
      get socket(): never {
        throw new TypeError('socket is not readable');
      },
      headers: { cookie: 'stuwith_refresh=bbb' },
      raw: { headers: {}, socket: {} },
    } as unknown as FastifyRequest;

    const subject = rateLimitSubjectOf(hostile, TRUST_NONE, SECRET);

    expect(subject.clientIp).toBe(UNKNOWN_CLIENT_IP);
    expect(
      subject.userHandle,
      'a fault in one half must not discard the other half',
    ).toBe(userHandleOf(requestWith({ cookie: 'stuwith_refresh=bbb' }), SECRET));
  });

  it('is total, so neither half can turn a login into a 500', () => {
    const hostile = {
      get socket(): never {
        throw new TypeError('socket is not readable');
      },
      get headers(): never {
        throw new TypeError('headers are not readable');
      },
      raw: { headers: {}, socket: {} },
    } as unknown as FastifyRequest;

    expect(() => rateLimitSubjectOf(hostile, TRUST_NONE, SECRET)).not.toThrow();
    expect(rateLimitSubjectOf(hostile, TRUST_NONE, SECRET).clientIp).toBe(UNKNOWN_CLIENT_IP);
  });
});
