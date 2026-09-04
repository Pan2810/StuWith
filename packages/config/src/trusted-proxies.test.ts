import { describe, expect, it } from 'vitest';
import { NO_TRUSTED_PROXIES, compileTrustedProxies } from './trusted-proxies';

/**
 * The proxy list, checked over the address SPACE rather than over examples.
 *
 * Four review rounds found four different too-wide ranges in this one rule, and
 * every round's test was a list of the ranges that round had been shown: a hop
 * count, then `/0`, then `/1`, then `32.0.0.0/3`, `40.0.0.0/5`, `96.0.0.0/4` and
 * `132.0.0.0/6`. A list of examples can only prove that the examples are fixed,
 * which is precisely the thing that kept being true while the rule stayed broken.
 *
 * So the suite below sweeps prefix lengths across the whole IPv4 space and a wide
 * sample of IPv6, and compares `compileTrustedProxies` against an INDEPENDENT
 * model of the invariant written in `spec-1-3b` — accepted if and only if the
 * range lies entirely inside internal space, or covers no more than the ceiling
 * for its family. The model does arithmetic on numbers this file generated; it
 * never parses an address, and it shares no code with the implementation.
 */

const IPV4_CEILING = 1n << 20n;
const IPV6_CEILING = 1n << 16n;

interface Block {
  readonly start: bigint;
  readonly prefixBits: number;
}

const ipv4 = (a: number, b: number, c: number, d: number): bigint =>
  (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d);

const INTERNAL_V4: readonly Block[] = [
  { start: ipv4(10, 0, 0, 0), prefixBits: 8 },
  { start: ipv4(172, 16, 0, 0), prefixBits: 12 },
  { start: ipv4(192, 168, 0, 0), prefixBits: 16 },
  { start: ipv4(127, 0, 0, 0), prefixBits: 8 },
  { start: ipv4(169, 254, 0, 0), prefixBits: 16 },
  { start: ipv4(100, 64, 0, 0), prefixBits: 10 },
];

/** `::ffff:0:0` — where the library maps every IPv4 address. */
const MAPPED_BASE = 0xffffn << 32n;

const INTERNAL_V6: readonly Block[] = [
  { start: 1n, prefixBits: 128 },
  { start: 0xfc00n << 112n, prefixBits: 7 },
  { start: 0xfe80n << 112n, prefixBits: 10 },
  { start: MAPPED_BASE | (ipv4(10, 0, 0, 0) << 0n), prefixBits: 104 },
  { start: MAPPED_BASE | ipv4(172, 16, 0, 0), prefixBits: 108 },
  { start: MAPPED_BASE | ipv4(192, 168, 0, 0), prefixBits: 112 },
  { start: MAPPED_BASE | ipv4(127, 0, 0, 0), prefixBits: 104 },
  { start: MAPPED_BASE | ipv4(169, 254, 0, 0), prefixBits: 112 },
  { start: MAPPED_BASE | ipv4(100, 64, 0, 0), prefixBits: 106 },
];

/** The invariant, independently: internal in full, or no wider than the ceiling. */
function modelAccepts(
  base: bigint,
  prefixBits: number,
  totalBits: number,
  internal: readonly Block[],
  ceiling: bigint,
): boolean {
  // A prefix of zero is refused by `@fastify/proxy-addr` itself, before the rule
  // in this repo is reached at all.
  if (prefixBits === 0) {
    return false;
  }
  const size = 1n << BigInt(totalBits - prefixBits);
  const network = base & (((1n << BigInt(totalBits)) - 1n) ^ (size - 1n));
  if (size <= ceiling) {
    return true;
  }
  return internal.some((block) => {
    const blockSize = 1n << BigInt(totalBits - block.prefixBits);
    return network >= block.start && network + size <= block.start + blockSize;
  });
}

const formatIpv4 = (value: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');

const formatIpv6 = (value: bigint): string =>
  Array.from({ length: 8 }, (_unused, index) =>
    ((value >> BigInt(112 - index * 16)) & 0xffffn).toString(16),
  ).join(':');

describe('the too-wide rule decides the whole IPv4 space, not a list of examples', () => {
  /**
   * Every `/8` of IPv4, at three offsets each, at every prefix length from `/0`
   * to `/24`. That is the sweep the spec asks for: the four ranges found in round
   * four sat between the nine probe addresses the old rule sampled, and no list of
   * examples can rule out a fifth.
   */
  it('agrees with the invariant at every prefix length across every /8', () => {
    const disagreements: string[] = [];

    for (let leading = 0; leading < 256; leading += 1) {
      for (const offset of [ipv4(0, 0, 0, 0), ipv4(0, 17, 3, 0), ipv4(0, 200, 129, 7)]) {
        const base = (BigInt(leading) << 24n) | offset;
        for (let prefixBits = 0; prefixBits <= 24; prefixBits += 1) {
          const token = `${formatIpv4(base)}/${prefixBits}`;
          const expected = modelAccepts(base, prefixBits, 32, INTERNAL_V4, IPV4_CEILING);
          const actual = compileTrustedProxies(token).ok;
          if (actual !== expected) {
            disagreements.push(`${token}: expected ${expected ? 'accept' : 'refuse'}`);
          }
        }
      }
    }

    expect(disagreements.slice(0, 20)).toEqual([]);
  });

  /**
   * The same sweep read as the property an operator cares about: a range that
   * reaches public address space AND is wider than a real proxy fleet must be
   * refused, whatever it is spelled like.
   */
  it('refuses every range wider than the ceiling that is not entirely internal', () => {
    const escaped: string[] = [];

    for (let leading = 0; leading < 256; leading += 1) {
      const base = BigInt(leading) << 24n;
      for (let prefixBits = 1; prefixBits <= 11; prefixBits += 1) {
        const insideInternal = modelAccepts(base, prefixBits, 32, INTERNAL_V4, IPV4_CEILING);
        if (insideInternal) {
          continue;
        }
        const token = `${formatIpv4(base)}/${prefixBits}`;
        if (compileTrustedProxies(token).ok) {
          escaped.push(token);
        }
      }
    }

    expect(escaped).toEqual([]);
  });

  /**
   * Round four's four ranges, pinned by name as well.
   *
   * The sweep above already covers them; this example exists so the next reader of
   * a regression sees the exact strings from the finding rather than having to
   * decode a coordinate out of the sweep.
   */
  it.each(['32.0.0.0/3', '40.0.0.0/5', '96.0.0.0/4', '132.0.0.0/6', '0.0.0.0/1', '128.0.0.0/1'])(
    'refuses %s, the shape that let a direct peer forge X-Forwarded-For',
    (raw) => {
      const result = compileTrustedProxies(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toContain(raw);
    },
  );

  it.each([
    ['a single proxy', '10.0.0.2'],
    ['a private subnet', '10.0.0.0/24'],
    ['all of private space', '10.0.0.0/8'],
    ['CGNAT, where a real proxy can live', '100.64.0.0/10'],
    ['link-local', '169.254.0.0/16'],
    ['loopback', '127.0.0.0/8'],
    ["Cloudflare's largest published range", '104.16.0.0/12'],
    ['a public proxy pair', '203.0.113.7, 203.0.113.8'],
    ['unique-local IPv6', 'fc00::/7'],
    ['link-local IPv6', 'fe80::/10'],
    ['one IPv6 address', '::1'],
    ['the mapped spelling of one address', '::ffff:10.0.0.2'],
    ["the library's own name for private space", 'uniquelocal'],
    ["the library's own name for loopback", 'loopback'],
  ])('still accepts %s', (_label, raw) => {
    expect(compileTrustedProxies(raw).ok, `${raw} must be accepted`).toBe(true);
  });
});

describe('the same rule over IPv6, including the mapped IPv4 trapdoor', () => {
  const BASES: readonly bigint[] = [
    0n,
    1n,
    0x2000n << 112n,
    0x2001n << 112n,
    (0x2001n << 112n) | (0x0db8n << 96n),
    0x2606n << 112n,
    0x3fffn << 112n,
    0xfc00n << 112n,
    0xfd00n << 112n,
    0xfe80n << 112n,
    0xfec0n << 112n,
    0xff00n << 112n,
    MAPPED_BASE,
    MAPPED_BASE | ipv4(10, 0, 0, 0),
    MAPPED_BASE | ipv4(9, 9, 9, 9),
    MAPPED_BASE | ipv4(127, 0, 0, 0),
    MAPPED_BASE | ipv4(172, 16, 0, 0),
    MAPPED_BASE | ipv4(192, 168, 0, 0),
    MAPPED_BASE | ipv4(203, 0, 113, 0),
  ];

  it('agrees with the invariant across the sampled space at every prefix length', () => {
    const disagreements: string[] = [];

    for (const base of BASES) {
      for (let prefixBits = 0; prefixBits <= 128; prefixBits += 1) {
        const token = `${formatIpv6(base)}/${prefixBits}`;
        const expected = modelAccepts(base, prefixBits, 128, INTERNAL_V6, IPV6_CEILING);
        const actual = compileTrustedProxies(token).ok;
        if (actual !== expected) {
          disagreements.push(`${token}: expected ${expected ? 'accept' : 'refuse'}`);
        }
      }
    }

    expect(disagreements.slice(0, 20)).toEqual([]);
  });

  /**
   * The reason the IPv6 ceiling is tighter than the IPv4 one.
   *
   * `::ffff:0:0/96` is where the library maps every IPv4 address, so trusting it
   * trusts the entire IPv4 internet behind a token that reads like an ordinary
   * IPv6 subnet — and a `/96` looks narrow next to the `/12` IPv4 allows.
   */
  it.each(['::ffff:0.0.0.0/96', '::ffff:0.0.0.0/100', '0:0:0:0:0:ffff:0:0/97', '::/1', '2000::/3'])(
    'refuses %s',
    (raw) => {
      expect(compileTrustedProxies(raw).ok).toBe(false);
    },
  );
});

describe('a token this repo cannot measure is refused rather than trusted', () => {
  it('refuses a netmask, because its width cannot be checked without parsing it', () => {
    const result = compileTrustedProxies('10.0.0.0/255.0.0.0');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('netmask');
  });

  it('refuses an address the library compiles and node:net does not recognise', () => {
    // The round-three disagreement: the config validated while Fastify and the
    // rate limiter were reading two different lists.
    const suspects = ['1.2.3.4::', '2001:db8:1.2.3.4::1', '1.2.3.4::5'];
    const compiled = suspects.filter((raw) => compileTrustedProxies(raw).ok);

    expect(compiled).toEqual([]);
  });

  it('keeps refusing the near-empty spellings', () => {
    for (const raw of ['', ' ', ',', ' , ', ',,,']) {
      expect(compileTrustedProxies(raw).ok, `${JSON.stringify(raw)} must be refused`).toBe(false);
    }
  });

  it('accepts the one word that means "nothing is in front of this process"', () => {
    const result = compileTrustedProxies(NO_TRUSTED_PROXIES);

    expect(result.ok).toBe(true);
    expect(result.ok && result.trust).toBe(false);
    expect(result.ok && result.forFastify).toBe(false);
  });

  it('refuses a too-wide range buried in an otherwise sensible list', () => {
    expect(compileTrustedProxies('10.0.0.2, 172.16.0.0/12, 40.0.0.0/5').ok).toBe(false);
  });
});
