import {
  MAX_RATE_LIMIT_KEY_LENGTH,
  UNKNOWN_CLIENT_IP,
  bruteForceCounterKey,
  rateLimitKey,
} from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { clientIpOf, userHandleOf } from './request-identity';

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
});
