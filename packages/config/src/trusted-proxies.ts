import proxyaddr from '@fastify/proxy-addr';
import { isIP } from 'node:net';

/**
 * Reading the declared proxy list, through the SAME library Fastify uses.
 *
 * ## Why there is no parser of our own here any more
 *
 * There was one, hand-written, in `packages/domain`. Three review rounds found
 * three different holes in it:
 *
 * 1. it counted hops rather than checking the peer, so a direct client with a
 *    forged `X-Forwarded-For` chose its own rate-limit key;
 * 2. it accepted `0.0.0.0/0`, which matches everything;
 * 3. it accepted `0.0.0.0/1` and `128.0.0.0/1` — two ranges that between them
 *    cover all of IPv4 — because the fix for (2) was a one-bit floor. It also
 *    accepted `1.2.3.4::` and `2001:db8:1.2.3.4::1`, which `net.isIP` rejects,
 *    while handing the same raw string to Fastify: config validated while the two
 *    views of the list disagreed.
 *
 * Each round patched the named example rather than the class of bug. So the parser
 * is deleted and this module delegates.
 *
 * ## Why `@fastify/proxy-addr` and not `proxy-addr`
 *
 * Fastify 5 resolves the FORK. Pinning the fork is what makes "Fastify and we
 * cannot disagree about who is trusted" true by construction: the string in
 * `TRUSTED_PROXY_ADDRESSES` is compiled by one implementation, and both the
 * `trustProxy` option and the rate-limit key are decided by it.
 *
 * ## Why this lives in `packages/config` and not in the domain
 *
 * AD-1: `packages/domain` may not import an infrastructure SDK, and a library that
 * parses network addresses is one. `packages/config` already owns "read the
 * environment, validate it, fail fast naming the variable", and validating this
 * value means asking the library whether it can compile it. `apps/api` then reads
 * the compiled result from here rather than re-deriving it.
 */

/**
 * The one value that means "there is no proxy in front of this process".
 *
 * A word, not an empty string and not a stray separator. `TRUSTED_PROXY_ADDRESSES=`
 * and `TRUSTED_PROXY_ADDRESSES=,` are what a half-finished edit looks like, and
 * treating either as "no proxy" makes the most likely operator mistake
 * indistinguishable from a decision. Somebody has to write `none` and mean it.
 */
export const NO_TRUSTED_PROXIES = 'none';

/** What Fastify's `trustProxy` is given, and what `proxyaddr` is given. */
export type TrustedProxyTrust = false | ((address: string, hop: number) => boolean);

export type TrustedProxyResult =
  | {
      readonly ok: true;
      /** `false` when the deployment declared `none` — the header is never read. */
      readonly trust: TrustedProxyTrust;
      /** The value for Fastify's `trustProxy` option: the same list, or `false`. */
      readonly forFastify: string | false;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Compile the declared list, or say why it cannot be used.
 *
 * Refuses, in order:
 *
 * - a value that names no proxy at all (`''`, `','`, `' , '`) unless it is
 *   literally {@link NO_TRUSTED_PROXIES}. Those pass a naive non-empty check and
 *   used to produce `trustProxy: false` in silence, which behind Caddy collapses
 *   every visitor into one bucket;
 * - anything `@fastify/proxy-addr` will not compile — a malformed address, a
 *   hostname, a bad prefix. `/0` is in this group: the library itself refuses a
 *   prefix of zero;
 * - a range that is too wide to be a proxy list, decided by {@link tokenProblem}.
 */
export function compileTrustedProxies(raw: string): TrustedProxyResult {
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 1 && tokens[0]?.toLowerCase() === NO_TRUSTED_PROXIES) {
    return { ok: true, trust: false, forFastify: false };
  }

  if (tokens.length === 0) {
    return {
      ok: false,
      problem:
        `names no proxy at all. Write "${NO_TRUSTED_PROXIES}" if nothing sits in front ` +
        'of this process, or list the proxy addresses/CIDRs.',
    };
  }

  let trust: (address: string, hop: number) => boolean;
  try {
    trust = proxyaddr.compile(tokens);
  } catch (error) {
    return {
      ok: false,
      problem:
        `is not a list of addresses: ${tokens.join(', ')} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Use IPs and CIDRs separated by commas, or the single word "${NO_TRUSTED_PROXIES}".`,
    };
  }

  for (const token of tokens) {
    const problem = tokenProblem(token);
    if (problem !== null) {
      return { ok: false, problem };
    }
  }

  return { ok: true, trust, forFastify: tokens.join(',') };
}

/**
 * ## The rule: a range is trusted only if it is INTERNAL or SMALL
 *
 * This is the fourth version of "refuse a range that is too wide", and the first
 * one that decides rather than samples. The three before it patched the example
 * they were shown:
 *
 * 1. a hop count, which cannot check the peer at all;
 * 2. a one-bit floor, which refused `/0` and let `/1` through — and `0.0.0.0/1`
 *    plus `128.0.0.0/1` is all of IPv4 in two tokens;
 * 3. a spread of nine public PROBE addresses handed to the compiled predicate.
 *    That is a sample, and a sample answers "does this range contain one of my
 *    nine points", not "how far does this range reach". `32.0.0.0/3`,
 *    `40.0.0.0/5`, `96.0.0.0/4` and `132.0.0.0/6` all fitted between the probes,
 *    so a direct peer from `40.1.2.3` could forge `X-Forwarded-For` again.
 *
 * The invariant, stated over sets rather than over examples — it is the one
 * written into the spec under "Bất biến của danh sách proxy":
 *
 * > A range is accepted if and only if it lies ENTIRELY inside internal/special
 * > address space, OR it is small enough to be a real fleet of proxies.
 *
 * Both halves are decided exactly, for every possible spelling, because both are
 * computed from the range's own prefix length rather than from membership of a
 * handful of chosen addresses.
 *
 * ## How the two halves are decided without parsing an address
 *
 * "Small enough" is arithmetic on the prefix length: `2 ** (bits - prefix)` is the
 * number of addresses, compared against {@link MAX_TRUSTED_ADDRESSES}. The prefix
 * length is read from the token's own text after the last `/` — a decimal integer,
 * not an address — and the address half is validated by `node:net`, never by us.
 *
 * "Entirely inside internal space" uses a property of CIDR blocks rather than any
 * arithmetic on addresses: two CIDR blocks are either nested or disjoint, so for a
 * block `R` and an internal block `I` of the same family,
 *
 *     R ⊆ I  ⟺  prefix(R) >= prefix(I)  AND  (any address of R) ∈ I
 *
 * The token's own address half IS an address of `R`, and `∈ I` is answered by a
 * predicate {@link proxyaddr} compiled. So the containment test is the library's
 * work, not ours.
 *
 * `R ⊆ I₁ ∪ … ∪ Iₙ` is equivalent to `∃i: R ⊆ Iᵢ` for {@link INTERNAL_BLOCKS}
 * specifically: covering a block with several smaller ones requires them to be
 * adjacent and to merge back into an aligned block, and no two entries in that
 * list do (`10/8` and `127/8` are far apart, `172.16/12` and `192.168/16` are not
 * adjacent, and so on). Where the shortcut is wrong at all it is wrong in the
 * REFUSING direction, which is the safe one for this check.
 */
function tokenProblem(token: string): string | null {
  // The three names `@fastify/proxy-addr` expands itself. Every address they
  // stand for is loopback, link-local or unique-local, so they are the internal
  // branch by definition and there is no notation to measure.
  if (NAMED_INTERNAL_RANGES.has(token)) {
    return null;
  }

  const slash = token.lastIndexOf('/');
  const addressText = slash === -1 ? token : token.slice(0, slash);
  const family = isIP(addressText);

  if (family === 0) {
    // The library compiled it and `node:net` does not recognise it. That exact
    // disagreement shipped once: `1.2.3.4::` and `2001:db8:1.2.3.4::1` validated
    // here while Fastify read them as something else, so the deployment looked
    // configured and the two views of "who is trusted" were different lists.
    return (
      `contains "${token}", which is not an IP address that node:net recognises. ` +
      'Two readings of the same list is how a deployment validates while the proxy ' +
      'list and the rate limiter disagree about who is trusted. Write a plain IPv4 ' +
      'or IPv6 address, optionally followed by /<prefix length>.'
    );
  }

  const bits = family === 4 ? IPV4_BITS : IPV6_BITS;
  let prefixBits: number;

  if (slash === -1) {
    // A bare address is one address: the narrowest range there is.
    prefixBits = bits;
  } else {
    const rangeText = token.slice(slash + 1);
    if (!/^[0-9]+$/.test(rangeText)) {
      // `@fastify/proxy-addr` also accepts an IPv4 netmask here. Turning
      // `255.255.0.0` into a prefix length means walking the bits of an address,
      // which is the one thing this file may not do — and an unmeasured range
      // cannot be checked for width, so it cannot be trusted either.
      return (
        `writes the width of "${token}" as a netmask. Use a prefix length instead ` +
        `— "${addressText}/24", not "${addressText}/255.255.255.0" — so the reach of ` +
        'the range can be checked before anything is trusted.'
      );
    }
    prefixBits = Number(rangeText);
    if (!Number.isInteger(prefixBits) || prefixBits < 1 || prefixBits > bits) {
      // Unreachable through `compileTrustedProxies`, which compiles first and the
      // library refuses these. Kept so this function is total on its own.
      return `writes "${token}", whose prefix length is not between 1 and ${bits}.`;
    }
  }

  const addressCount = 1n << BigInt(bits - prefixBits);
  const ceiling = family === 4 ? MAX_TRUSTED_IPV4_ADDRESSES : MAX_TRUSTED_IPV6_ADDRESSES;
  if (addressCount <= ceiling) {
    return null;
  }

  for (const block of INTERNAL_BLOCKS) {
    if (block.family !== family || block.prefixBits > prefixBits) {
      continue;
    }
    if (block.contains(addressText)) {
      return null;
    }
  }

  return (
    `reaches too far to be a proxy list: "${token}" covers ${addressCount} addresses. ` +
    `A range wider than ${ceiling} addresses is accepted only when it lies entirely ` +
    `inside private, loopback, link-local or CGNAT space (${INTERNAL_BLOCKS.filter(
      (block) => block.family === family,
    )
      .map((block) => block.notation)
      .join(', ')}). Anything this process trusts can set X-Forwarded-For to whatever ` +
    'it likes, so list the proxies that are really in front of it — each address on ' +
    `its own, or the smallest CIDR that covers them — or write "${NO_TRUSTED_PROXIES}".`
  );
}

const IPV4_BITS = 32;
const IPV6_BITS = 128;

/**
 * How many addresses a PUBLIC range may cover and still be believable as the set
 * of machines in front of this process.
 *
 * IPv4: 2^20, which is a `/12`. That is not a bit count picked by feel — it is the
 * size of the largest range any real edge operator publishes (Cloudflare's
 * `104.16.0.0/12`), so an operator who genuinely fronts this API with a CDN can
 * still write one token. Everything wider has to earn its way in through the
 * internal branch, which is how `10.0.0.0/8` is accepted while `10.0.0.0/7` — the
 * same shape, but reaching into public `11.0.0.0/8` — is not.
 */
const MAX_TRUSTED_IPV4_ADDRESSES = 1n << 20n;

/**
 * IPv6: 2^16, which is a `/112`, and deliberately far TIGHTER than the IPv4
 * ceiling rather than "the same number of bits".
 *
 * Counting addresses means nothing in IPv6 — a single LAN is 2^64 — so the
 * ceiling is set by what an IPv6 range can do rather than by how big it looks.
 * The danger is `::ffff:0:0/96`: the library maps every IPv4 address into that
 * block, so trusting it trusts the entire IPv4 internet through a token that
 * reads like an ordinary IPv6 subnet. Any ceiling below 2^32 makes that
 * impossible by arithmetic, with no need to recognise the mapped spelling — and
 * inside the mapped range the /112 floor is exactly an IPv4 `/16`, i.e. stricter
 * than the IPv4 rule rather than a way around it.
 *
 * The trade, stated so it is not a surprise: an operator whose proxies live in an
 * IPv6 `/64` must list them, or a `/112`, rather than the whole subnet. Internal
 * IPv6 space (`fc00::/7`, `fe80::/10`) is unaffected — it comes in through the
 * internal branch at any width.
 */
const MAX_TRUSTED_IPV6_ADDRESSES = 1n << 16n;

/** The names `@fastify/proxy-addr` expands into internal ranges by itself. */
const NAMED_INTERNAL_RANGES: ReadonlySet<string> = new Set([
  'loopback',
  'linklocal',
  'uniquelocal',
]);

interface InternalBlock {
  readonly family: 4 | 6;
  readonly notation: string;
  readonly prefixBits: number;
  /** The library's own membership test for this block. */
  readonly contains: (address: string) => boolean;
}

function internalBlock(family: 4 | 6, notation: string, prefixBits: number): InternalBlock {
  const trust = proxyaddr.compile([notation]);
  return { family, notation, prefixBits, contains: (address) => trust(address, 0) };
}

/**
 * Address space that is not on the public internet, so a range inside it can be
 * as wide as the operator likes without trusting a stranger.
 *
 * Each family is listed separately because a prefix length only means something
 * within its own address space: `104` bits of an IPv6 address and `8` bits of an
 * IPv4 address are not comparable, and comparing them is how `::ffff:10.0.0.0/100`
 * — which reaches out of `10.0.0.0/8` into `0.0.0.0/4` once mapped — would have
 * been read as "inside 10/8". The IPv4-mapped spellings are therefore repeated as
 * IPv6 blocks at their true IPv6 widths.
 */
const INTERNAL_BLOCKS: readonly InternalBlock[] = [
  internalBlock(4, '10.0.0.0/8', 8),
  internalBlock(4, '172.16.0.0/12', 12),
  internalBlock(4, '192.168.0.0/16', 16),
  internalBlock(4, '127.0.0.0/8', 8),
  internalBlock(4, '169.254.0.0/16', 16),
  internalBlock(4, '100.64.0.0/10', 10),
  internalBlock(6, '::1/128', 128),
  internalBlock(6, 'fc00::/7', 7),
  internalBlock(6, 'fe80::/10', 10),
  internalBlock(6, '::ffff:10.0.0.0/104', 104),
  internalBlock(6, '::ffff:172.16.0.0/108', 108),
  internalBlock(6, '::ffff:192.168.0.0/112', 112),
  internalBlock(6, '::ffff:127.0.0.0/104', 104),
  internalBlock(6, '::ffff:169.254.0.0/112', 112),
  internalBlock(6, '::ffff:100.64.0.0/106', 106),
];
