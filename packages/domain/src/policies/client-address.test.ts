import { describe, expect, it } from 'vitest';
import {
  MAX_FORWARDED_ENTRIES,
  NO_TRUSTED_PROXIES,
  UNKNOWN_CLIENT_IP,
  formatIpAddress,
  isTrustedProxy,
  normalizeIpAddress,
  parseIpAddress,
  parseTrustedProxies,
  requireTrustedProxies,
  resolveClientIp,
  type TrustedProxy,
} from './client-address';

/**
 * The design note says the counter is not the dangerous part — deciding whose
 * address a request carries is, because it is wrong SILENTLY and in two opposite
 * directions. This file is why that claim is checkable: every direction is a
 * hand-written header string here, with no proxy, no server and no network.
 *
 * The review that produced this file found the first version implementing
 * hop-count trust — the behaviour `fastify@5.12.1` removed as a security fix. The
 * first describe block below is the attack that motivated the rewrite.
 */

const CADDY = '10.0.0.2';
const SECOND_PROXY = '10.0.0.3';
const CLIENT = '203.0.113.7';

const trust = (raw: string): readonly TrustedProxy[] => {
  const parsed = parseTrustedProxies(raw);
  expect(parsed.invalid, `fixture "${raw}" must parse`).toEqual([]);
  return parsed.proxies;
};

const ONE_PROXY = trust(CADDY);
const PROXY_NETWORK = trust('10.0.0.0/24');
const NO_PROXY = trust(NO_TRUSTED_PROXIES);

describe('Matrix row: a direct connection with a forged X-Forwarded-For', () => {
  /**
   * The whole reason this file was rewritten. Under hop-count trust, one declared
   * hop plus a direct connection carrying `X-Forwarded-For: 1.2.3.4` returned
   * `1.2.3.4` — the attacker chose their own rate-limit key and rotated it for
   * ever, so the limiter throttled honest users and nobody else.
   */
  it('ignores the header completely when the peer is not a declared proxy', () => {
    expect(
      resolveClientIp({
        socketAddress: '203.0.113.9',
        forwardedFor: '1.2.3.4',
        trustedProxies: ONE_PROXY,
      }),
    ).toBe('203.0.113.9');
  });

  it('cannot be moved by adding hops, however many', () => {
    const attacker = '203.0.113.9';
    for (const forged of [
      '1.2.3.4',
      '1.2.3.4, 5.6.7.8',
      '1.2.3.4, 5.6.7.8, 9.10.11.12',
      `${CADDY}, ${CADDY}, ${CADDY}`,
    ]) {
      expect(
        resolveClientIp({
          socketAddress: attacker,
          forwardedFor: forged,
          trustedProxies: ONE_PROXY,
        }),
        `"${forged}" must not change the counted address`,
      ).toBe(attacker);
    }
  });

  it('ignores the header when nothing is declared at all', () => {
    expect(
      resolveClientIp({
        socketAddress: '203.0.113.9',
        forwardedFor: '1.2.3.4',
        trustedProxies: NO_PROXY,
      }),
    ).toBe('203.0.113.9');
  });
});

describe('Matrix row: two people behind the same proxy are two addresses', () => {
  const behindCaddy = (forwardedFor: string | readonly string[]): string =>
    resolveClientIp({ socketAddress: CADDY, forwardedFor, trustedProxies: ONE_PROXY });

  it('reads the address the proxy appended, not the proxy', () => {
    expect(behindCaddy(CLIENT)).toBe(CLIENT);
  });

  it('separates two visitors arriving through one proxy', () => {
    expect(behindCaddy('198.51.100.4')).not.toBe(behindCaddy(CLIENT));
    expect(behindCaddy(CLIENT)).not.toBe(CADDY);
  });

  it('accepts the proxy by CIDR as well as by address', () => {
    expect(
      resolveClientIp({
        socketAddress: '10.0.0.77',
        forwardedFor: CLIENT,
        trustedProxies: PROXY_NETWORK,
      }),
    ).toBe(CLIENT);
  });

  it('falls back to the socket when a trusted peer sends no header', () => {
    expect(behindCaddy('')).toBe(CADDY);
    expect(
      resolveClientIp({ socketAddress: CADDY, forwardedFor: undefined, trustedProxies: ONE_PROXY }),
    ).toBe(CADDY);
  });
});

describe('a forged entry arriving THROUGH a trusted proxy', () => {
  const behindCaddy = (forwardedFor: string | readonly string[]): string =>
    resolveClientIp({ socketAddress: CADDY, forwardedFor, trustedProxies: ONE_PROXY });

  it('stops at the first entry that is not one of our proxies', () => {
    expect(behindCaddy(`9.9.9.9, ${CLIENT}`)).toBe(CLIENT);
    expect(behindCaddy(`1.1.1.1, 2.2.2.2, 3.3.3.3, ${CLIENT}`)).toBe(CLIENT);
  });

  it('cannot be shifted by splitting the forgery across repeated headers', () => {
    // Node hands a repeated header back as an array. Reading only the first
    // element would treat `9.9.9.9` as the whole chain.
    expect(behindCaddy(['9.9.9.9', `8.8.8.8, ${CLIENT}`])).toBe(CLIENT);
  });

  it('is not fooled by a forged entry that names one of our own proxies', () => {
    // The client claims to be Caddy. The walk skips it, because it is a declared
    // proxy — and lands on the address the REAL Caddy appended.
    expect(behindCaddy(`${CLIENT}, ${CADDY}`)).toBe(CLIENT);
  });

  it('walks past a genuine chain of two of our proxies', () => {
    expect(
      resolveClientIp({
        socketAddress: CADDY,
        forwardedFor: `${CLIENT}, ${SECOND_PROXY}`,
        trustedProxies: trust(`${CADDY}, ${SECOND_PROXY}`),
      }),
    ).toBe(CLIENT);
  });

  it('uses the far end when every entry in the chain is one of ours', () => {
    // There is no client address in the chain at all. Inventing one would be
    // worse than using the last thing we actually know about.
    expect(
      resolveClientIp({
        socketAddress: CADDY,
        forwardedFor: SECOND_PROXY,
        trustedProxies: trust(`${CADDY}, ${SECOND_PROXY}`),
      }),
    ).toBe(SECOND_PROXY);
  });

  it('keeps unreadable entries as a bucket rather than shortening the chain', () => {
    expect(behindCaddy(`not-an-ip, ${CLIENT}`)).toBe(CLIENT);
    expect(behindCaddy(`${CLIENT}, not-an-ip`)).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe('normalizeIpAddress actually validates', () => {
  it.each([
    ['plain IPv4', '203.0.113.7', '203.0.113.7'],
    ['surrounding whitespace', '  203.0.113.7 ', '203.0.113.7'],
    ['IPv4 with a port', '203.0.113.7:51234', '203.0.113.7'],
    ['bracketed IPv6', '[2001:db8::1]', '2001:db8:0:0:0:0:0:1'],
    ['bracketed IPv6 with a port', '[2001:db8::1]:443', '2001:db8:0:0:0:0:0:1'],
    ['bare IPv6', '2001:DB8::1', '2001:db8:0:0:0:0:0:1'],
    ['IPv4-mapped IPv6', '::ffff:203.0.113.7', '203.0.113.7'],
    ['IPv6 loopback', '::1', '0:0:0:0:0:0:0:1'],
  ])('%s', (_label, raw, expected) => {
    expect(normalizeIpAddress(raw)).toBe(expected);
  });

  /**
   * The previous version returned these unchanged, so its own docblock — "returns
   * `null` for anything that cannot be a key at all" — was false, and any eighty
   * characters of junk became a rate-limit key of their own.
   */
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a word', 'not-an-ip'],
    ['a hostname', 'proxy.internal'],
    ['an octet out of range', '203.0.113.999'],
    ['too few octets', '203.0.113'],
    ['too many octets', '203.0.113.7.1'],
    ['a leading zero', '010.0.0.1'],
    ['unclosed bracket', '[2001:db8::1'],
    ['a bad hex group', '2001:zzzz::1'],
    ['too many IPv6 groups', '1:2:3:4:5:6:7:8:9'],
    ['two compressions', '1::2::3'],
    ['eighty characters of junk', 'x'.repeat(80)],
  ])('returns null for %s', (_label, raw) => {
    expect(normalizeIpAddress(raw)).toBeNull();
  });

  it('folds the IPv4-mapped and plain forms of one machine onto one key', () => {
    // Node gives back whichever form the listening socket produced. Two forms
    // would be two independent budgets for the same person.
    expect(normalizeIpAddress('::ffff:203.0.113.7')).toBe(normalizeIpAddress('203.0.113.7'));
  });

  it('round-trips through parse and format', () => {
    const parsed = parseIpAddress('2001:db8::1');
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(formatIpAddress(parsed)).toBe('2001:db8:0:0:0:0:0:1');
  });
});

describe('parseTrustedProxies', () => {
  it('reads a single address', () => {
    expect(parseTrustedProxies(CADDY).proxies).toHaveLength(1);
  });

  it('reads a comma-separated list, tolerating spacing', () => {
    const result = parseTrustedProxies(` ${CADDY} , 10.0.0.0/24 , ::1 `);
    expect(result.invalid).toEqual([]);
    expect(result.proxies).toHaveLength(3);
  });

  it('understands the explicit "no proxy" word', () => {
    const result = parseTrustedProxies(NO_TRUSTED_PROXIES);
    expect(result.invalid).toEqual([]);
    expect(result.proxies).toEqual([]);
  });

  it('ignores a trailing comma rather than calling it a typo', () => {
    expect(parseTrustedProxies(`${CADDY}, `).invalid).toEqual([]);
  });

  it.each(['proxy.internal', '10.0.0.1/33', '10.0.0.1/abc', '999.0.0.1', '10.0.0.1/'])(
    'reports %s as invalid rather than dropping it',
    (token) => {
      // Dropping a token silently NARROWS who is trusted, which turns every
      // visitor behind that proxy into one bucket — the failure this whole file
      // exists to prevent, arriving from a typo.
      const result = parseTrustedProxies(`${CADDY}, ${token}`);
      expect(result.invalid.length).toBeGreaterThan(0);
    },
  );

  it('does not treat "none" as a proxy when it is listed alongside addresses', () => {
    expect(parseTrustedProxies(`${CADDY}, none`).invalid).toContain('none');
  });
});

describe('isTrustedProxy', () => {
  it('matches an exact address', () => {
    expect(isTrustedProxy(CADDY, ONE_PROXY)).toBe(true);
    expect(isTrustedProxy(SECOND_PROXY, ONE_PROXY)).toBe(false);
  });

  it('matches inside a CIDR and not outside it', () => {
    expect(isTrustedProxy('10.0.0.255', PROXY_NETWORK)).toBe(true);
    expect(isTrustedProxy('10.0.1.0', PROXY_NETWORK)).toBe(false);
  });

  it('honours a prefix that is not a whole number of bytes', () => {
    const half = trust('10.0.0.0/25');
    expect(isTrustedProxy('10.0.0.127', half)).toBe(true);
    expect(isTrustedProxy('10.0.0.128', half)).toBe(false);
  });

  it('never matches across address families', () => {
    expect(isTrustedProxy('::1', PROXY_NETWORK)).toBe(false);
    expect(isTrustedProxy('10.0.0.1', trust('::1'))).toBe(false);
  });

  it('trusts nothing when the list is empty', () => {
    expect(isTrustedProxy(CADDY, NO_PROXY)).toBe(false);
  });

  it('never trusts an unparseable address', () => {
    expect(isTrustedProxy(UNKNOWN_CLIENT_IP, ONE_PROXY)).toBe(false);
  });
});

/**
 * The two values that passed validation and put the vulnerability straight back.
 *
 * Both were found by running the built parser, not by reading it, and both are the
 * same shape of failure: one token, an empty `invalid` list, and a deployment that
 * looks correctly configured while trusting either everybody or nobody.
 */
describe('a range wide enough to trust everybody is a configuration ERROR', () => {
  it.each(['0.0.0.0/0', '::/0'])('refuses %s', (token) => {
    const result = parseTrustedProxies(token);

    expect(result.invalid).toContain(token);
    expect(result.proxies).toEqual([]);
  });

  it('refuses one buried in the middle of an otherwise sensible list', () => {
    const result = parseTrustedProxies(`${CADDY}, 0.0.0.0/0, 10.0.0.0/24`);

    // Not "keeps the good ones and drops the bad": the operator wrote something
    // that means "trust the internet", and guessing what they meant instead is
    // how the header becomes authoritative again.
    expect(result.invalid).toContain('0.0.0.0/0');
  });

  it('would have trusted a forged header from a direct connection', () => {
    // The regression itself, spelled out: with `/0` accepted, `withinPrefix`
    // compared zero bits, every address matched, and a direct client's own
    // `X-Forwarded-For` became the rate-limit key.
    const wide = parseTrustedProxies('0.0.0.0/0');
    expect(
      resolveClientIp({
        socketAddress: '203.0.113.9',
        forwardedFor: '1.2.3.4',
        trustedProxies: wide.proxies,
      }),
    ).toBe('203.0.113.9');
  });

  it('still accepts the narrowest useful ranges', () => {
    expect(parseTrustedProxies('10.0.0.0/1').invalid).toEqual([]);
    expect(parseTrustedProxies('10.0.0.2/32').invalid).toEqual([]);
    expect(parseTrustedProxies('::1/128').invalid).toEqual([]);
  });
});

describe('a value that names no proxy is a configuration ERROR unless it says "none"', () => {
  it.each([
    ['a lone separator', ','],
    ['separators and spaces', ' , '],
    ['several separators', ',,,'],
    ['empty', ''],
  ])('refuses %s rather than reading it as "no proxy"', (_label, raw) => {
    // These passed `.trim().min(1)` and produced zero proxies with nothing
    // invalid, so the process started with `trustProxy: false`. Behind Caddy that
    // collapses every visitor into one bucket and the first person to trip the
    // limit locks out the product — from a stray comma.
    const result = parseTrustedProxies(raw);

    expect(result.proxies).toEqual([]);
    expect(result.invalid.length).toBeGreaterThan(0);
  });

  it('accepts the word, which somebody had to type on purpose', () => {
    expect(parseTrustedProxies('none')).toEqual({ proxies: [], invalid: [] });
    expect(parseTrustedProxies(' NONE ')).toEqual({ proxies: [], invalid: [] });
  });
});

describe('both sides of a comparison are normalised the same way', () => {
  /**
   * The declared list used to skip the IPv4-mapped fold that candidates went
   * through, and `withinPrefix` refuses to compare across families — so an
   * operator who wrote the mapped form (which `.env.example` invites, and which
   * Node hands back on a dual-stack socket) got a config that validated perfectly
   * and trusted nothing.
   */
  it('matches a mapped declaration against a plain candidate', () => {
    expect(isTrustedProxy('10.0.0.2', trust('::ffff:10.0.0.2'))).toBe(true);
  });

  it('matches a plain declaration against a mapped candidate', () => {
    expect(isTrustedProxy('::ffff:10.0.0.2', trust('10.0.0.2'))).toBe(true);
  });

  it('reads the header when the peer arrives in the mapped form', () => {
    expect(
      resolveClientIp({
        socketAddress: '::ffff:10.0.0.2',
        forwardedFor: CLIENT,
        trustedProxies: trust('10.0.0.2'),
      }),
    ).toBe(CLIENT);
  });

  it('folds a mapped CIDR onto the IPv4 range it stands for', () => {
    expect(isTrustedProxy('10.0.0.77', trust('::ffff:10.0.0.0/120'))).toBe(true);
    expect(isTrustedProxy('10.0.1.0', trust('::ffff:10.0.0.0/120'))).toBe(false);
  });

  it('refuses a mapped CIDR wider than the mapped range itself', () => {
    // Below /96 the range covers more than IPv4 space, which this list cannot
    // express and nobody should be trusting anyway.
    expect(parseTrustedProxies('::ffff:0.0.0.0/95').invalid).toContain('::ffff:0.0.0.0/95');
  });
});

describe('Matrix row: an address with an IPv6 zone identifier', () => {
  it('reads a link-local peer instead of dropping it into the unknown bucket', () => {
    // `fe80::1%eth0` used to fail to parse, so the peer became the unknown bucket,
    // never matched a declared proxy, and every request from that interface shared
    // one rate-limit budget.
    expect(normalizeIpAddress('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:1');
    expect(normalizeIpAddress('fe80::1%eth0')).toBe(normalizeIpAddress('fe80::1'));
  });

  it('matches a zoned peer against its declared address', () => {
    expect(isTrustedProxy('fe80::1%eth0', trust('fe80::1'))).toBe(true);
  });

  it('does not put the interface name in the key', () => {
    // The zone names a local interface and says nothing about which machine is
    // calling, so two interfaces are not two visitors.
    expect(normalizeIpAddress('fe80::1%eth0')).toBe(normalizeIpAddress('fe80::1%eth1'));
  });
});

describe('the forwarded chain is bounded before it is parsed', () => {
  it('reads no more than the cap, and reads the NEAREST hops', () => {
    // The header is appended to by every hop and re-parsed on every request, and
    // each entry is then match-tested against every declared proxy. The rightmost
    // entries are the ones our own proxies wrote; the far left is whatever the
    // original client invented.
    const forged = Array.from({ length: 500 }, (_unused, index) => `1.2.3.${index % 256}`);
    const chain = [...forged, CLIENT].join(', ');

    expect(
      resolveClientIp({ socketAddress: CADDY, forwardedFor: chain, trustedProxies: ONE_PROXY }),
    ).toBe(CLIENT);
  });

  it('is not fooled into a different answer by a chain longer than the cap', () => {
    // Everything kept is one of ours, so the far end of the KEPT chain is used —
    // the truncated remainder was never trusted and could not have been the client.
    const ours = Array.from({ length: MAX_FORWARDED_ENTRIES + 20 }, () => CADDY);

    expect(
      resolveClientIp({
        socketAddress: CADDY,
        forwardedFor: ours.join(', '),
        trustedProxies: ONE_PROXY,
      }),
    ).toBe(CADDY);
  });
});

describe('requireTrustedProxies', () => {
  it('returns the list when the value is good', () => {
    expect(requireTrustedProxies(CADDY)).toHaveLength(1);
    expect(requireTrustedProxies('none')).toEqual([]);
  });

  it.each(['0.0.0.0/0', ',', 'proxy.internal', `${CADDY}, nonsense`])(
    'throws rather than continuing with a shortened list for %s',
    (raw) => {
      // All three call sites used to read `.proxies` and ignore `.invalid`, so a
      // typo silently NARROWED who was trusted with nothing said. The config layer
      // already validates this, so reaching here means a bug — and a bug is worth
      // stopping for.
      expect(() => requireTrustedProxies(raw)).toThrow(/TRUSTED_PROXY_ADDRESSES/);
    },
  );
});
