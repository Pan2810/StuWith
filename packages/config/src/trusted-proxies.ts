import proxyaddr from '@fastify/proxy-addr';

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
 *   hostname, a bad prefix;
 * - a range that reaches out into the public internet. That is deliberately NOT a
 *   prefix-arithmetic check: bit counting is what produced two review rounds of
 *   holes — `/0` was refused, then `/1` slipped through, and two `/1` ranges cover
 *   all of IPv4. Instead the compiled predicate is ASKED about a spread of public
 *   addresses that no proxy list should contain. `0.0.0.0/0`, `0.0.0.0/1`,
 *   `128.0.0.0/1` and `::/0` all trip it, and so does whatever the next spelling
 *   turns out to be, because the rule is about REACH rather than about notation.
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

  const reached = TRUST_PROBES.filter((probe) => trust(probe, 0));
  if (reached.length > 0) {
    return {
      ok: false,
      problem:
        `reaches out into the public internet: it trusts ${reached.join(', ')}. ` +
        'A proxy list names the machines in front of this process, and anything it ' +
        'trusts can set `X-Forwarded-For` to whatever it likes. List the proxies ' +
        `that are really there, or write "${NO_TRUSTED_PROXIES}".`,
    };
  }

  return { ok: true, trust, forFastify: tokens.join(',') };
}

/**
 * Public addresses spread across the space, none of which is anybody's reverse
 * proxy.
 *
 * The rule is REACH, not notation, and that is the whole point. A bit-count rule
 * refused `0.0.0.0/0` and then let `0.0.0.0/1` through — and `0.0.0.0/1` plus
 * `128.0.0.0/1` is all of IPv4 written in two tokens. Asking the compiled
 * predicate about addresses out on the public internet catches every spelling of
 * "too wide" at once, including ones nobody has thought of.
 *
 * Both halves of IPv4 are covered, so a single `/1` trips it, and so does `::/0`.
 * Private, loopback, link-local and CGNAT space is deliberately absent: those are
 * exactly where a real proxy lives, and `10.0.0.0/24`, `192.168.0.0/16`,
 * `127.0.0.1`, `::1` and `loopback` all pass untouched.
 *
 * The trade, stated so it is not a surprise: a deployment whose edge really is one
 * of these exact addresses, or a wide public CDN range containing one, is refused.
 * The error names the address it tripped on, so that operator can see why in one
 * line rather than guessing.
 */
const TRUST_PROBES: readonly string[] = [
  // Low half of IPv4.
  '1.0.0.1',
  '8.8.8.8',
  '64.0.0.1',
  '120.0.0.1',
  // High half of IPv4.
  '129.0.0.1',
  '200.0.0.1',
  '223.255.255.255',
  // IPv6, public.
  '2001:db8::1',
  '2606::1',
];
