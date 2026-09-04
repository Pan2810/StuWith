/**
 * Working out which address a request really came from — the single most
 * dangerous decision in the rate-limit story, and the one that is wrong silently.
 *
 * ## Why trust is by ADDRESS and never by hop count
 *
 * The first version of this file trusted a declared NUMBER of hops: build
 * `[socket, …forwarded reversed]` and index `min(hops, length - 1)`. That is
 * exactly the behaviour `fastify@5.12.1` **removed as a security fix**, in its own
 * words: *"Hop-count-only trust cannot validate the immediate peer. Fail closed so
 * direct clients cannot spoof X-Forwarded-* values by supplying enough hops."*
 *
 * The attack is one request. With one declared hop, somebody who connects
 * **directly** to the API port and sends `X-Forwarded-For: 1.2.3.4` is counted as
 * `1.2.3.4`; they pick their own rate-limit key and rotate it for ever. The
 * limiter then throttles honest users behind the real proxy and nobody else —
 * which is worse than having no limiter, because it looks like having one.
 *
 * So the peer at the end of the socket is checked against a declared list of
 * proxy addresses first. A direct connection means the header is not read at all.
 *
 * ## The walk
 *
 * `X-Forwarded-For` grows to the right: each proxy appends the address it heard
 * from. So the chain, nearest hop first, is `[socket, …forwarded reversed]`, and
 * the client is the first entry in it that is not one of our own proxies. Never an
 * index, never a count — a position that a stranger can push by adding entries is
 * not a position worth computing.
 *
 * ## Two config-shaped ways to reopen the hole, both refused here
 *
 * Trusting by address only helps while the LIST means what it says. Two values
 * that looked valid used to defeat it entirely, and both are now configuration
 * errors that stop the process:
 *
 * - `0.0.0.0/0` (or `::/0`) matched every address of its family, because a
 *   zero-bit prefix compares nothing. One token, an empty `invalid` list, and the
 *   deployment was back to `trustProxy: true`.
 * - `,` — a stray comma from a half-finished edit — parsed to zero proxies with
 *   nothing invalid, so the process came up trusting nobody. Behind Caddy that
 *   collapses every visitor into one bucket. An empty result is only legitimate
 *   when the operator wrote {@link NO_TRUSTED_PROXIES} on purpose.
 */

/** A parsed address, as bytes, so a prefix comparison is arithmetic and not string work. */
export interface ParsedIpAddress {
  readonly kind: 'ipv4' | 'ipv6';
  /** 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: readonly number[];
}

/** One declared proxy: a single address, or a network in CIDR form. */
export interface TrustedProxy {
  readonly address: ParsedIpAddress;
  readonly prefixBits: number;
  /** The token as written, for error messages that name what the operator typed. */
  readonly source: string;
}

/**
 * The bucket a request whose origin cannot be worked out falls into.
 *
 * One shared bucket over-counts unrelated callers, and that is the deliberate
 * direction of the error: the alternative — skipping the limit when the address is
 * unreadable — hands anybody who can produce an unreadable address a way past the
 * whole feature.
 *
 * It starts with `!` so that NOTHING arriving from outside can equal it. The
 * previous value was the bare word `unknown`, which RFC 7239 explicitly permits as
 * a real `Forwarded` node identifier and which `keySegment('')` also produced — so
 * three unrelated situations shared one bucket. `!` is outside the key alphabet,
 * gets rewritten to `_` on the way into a key, and cannot appear in any address
 * `normalizeIpAddress` is willing to return.
 */
export const UNKNOWN_CLIENT_IP = '!unresolved';

/**
 * The one value that means "there is no proxy in front of this process".
 *
 * A word, not an empty string and not a stray separator. `TRUSTED_PROXY_ADDRESSES=`
 * and `TRUSTED_PROXY_ADDRESSES=,` are what a half-finished edit looks like, and
 * treating either as "no proxy" makes the most likely operator mistake
 * indistinguishable from a decision. Somebody has to write `none` and mean it.
 */
export const NO_TRUSTED_PROXIES = 'none';

/**
 * The widest prefix a declared proxy may use.
 *
 * A `/0` matches every address of its family, so declaring one is declaring "trust
 * whatever the client says it is" — the failure this whole module exists to
 * prevent, arriving as a single innocuous-looking config token. It is refused as a
 * configuration ERROR rather than silently narrowed, because an operator who wrote
 * it meant something, and guessing what would be worse than stopping.
 */
export const MIN_TRUSTED_PREFIX_BITS = 1;

/**
 * The most `X-Forwarded-For` entries that will be parsed.
 *
 * The header is appended to by every hop and re-read on every request, so an
 * unbounded chain is CPU a trusted proxy can be tricked into handing us: each
 * entry is parsed and then match-tested against every declared proxy. Far more
 * than any real deployment has, and small enough that the work per request stays
 * flat. The RIGHTMOST entries are kept, because those are the ones our own proxies
 * appended and the walk starts from that end.
 */
export const MAX_FORWARDED_ENTRIES = 50;

const IPV4_OCTET = /^(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const PREFIX_DIGITS = /^(0|[1-9][0-9]{0,2})$/;

/**
 * A dotted-quad, or `null`.
 *
 * Leading zeros are refused (`010.0.0.1`): they are read as octal by some
 * resolvers and as decimal by others, so an address written that way means two
 * different machines depending on who is reading. A rate-limit key must not be
 * ambiguous, and neither must a trusted-proxy declaration.
 */
function parseIpv4(text: string): ParsedIpAddress | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return { kind: 'ipv4', bytes };
}

/**
 * An IPv6 address, `::` compression and a trailing dotted-quad included.
 *
 * Hand-written rather than delegated because `packages/domain` may not import a
 * Node builtin or an SDK (AD-1) — `node:net`'s `isIP` is exactly the kind of
 * infrastructure the dependency rule exists to keep out of here.
 */
function parseIpv6(text: string): ParsedIpAddress | null {
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }

  const readGroups = (raw: string): number[][] | null => {
    if (raw.length === 0) {
      return [];
    }
    const groups: number[][] = [];
    const parts = raw.split(':');
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';
      // A trailing dotted-quad — `::ffff:192.0.2.1` — is two groups.
      if (index === parts.length - 1 && part.includes('.')) {
        const mapped = parseIpv4(part);
        if (mapped === null) {
          return null;
        }
        groups.push([mapped.bytes[0] ?? 0, mapped.bytes[1] ?? 0]);
        groups.push([mapped.bytes[2] ?? 0, mapped.bytes[3] ?? 0]);
        continue;
      }
      if (!IPV6_GROUP.test(part)) {
        return null;
      }
      const value = Number.parseInt(part, 16);
      groups.push([(value >> 8) & 0xff, value & 0xff]);
    }
    return groups;
  };

  const head = readGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? readGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) {
    return null;
  }

  if (halves.length === 1) {
    if (head.length !== 8) {
      return null;
    }
    return { kind: 'ipv6', bytes: head.flat() };
  }

  const missing = 8 - head.length - tail.length;
  // `::` must stand for at least one group, or the address had 8 already and the
  // `::` is a lie about its own length.
  if (missing < 1) {
    return null;
  }
  const zeros = Array.from({ length: missing }, () => [0, 0]);
  return { kind: 'ipv6', bytes: [...head, ...zeros, ...tail].flat() };
}

/** The number of leading bytes that mark an IPv4-mapped IPv6 address. */
const V4_MAPPED_PREFIX_BITS = 96;

function isIpv4Mapped(address: ParsedIpAddress): boolean {
  if (address.kind !== 'ipv6') {
    return false;
  }
  const bytes = address.bytes;
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  );
}

/**
 * Fold an IPv4-mapped IPv6 address onto the plain IPv4 it stands for.
 *
 * The SAME folding has to happen on both sides of every comparison, and for a
 * while it did not: candidate addresses were folded (through `normalizeIpAddress`)
 * while declared proxies were not, so an operator who wrote `::ffff:10.0.0.2` —
 * a spelling `.env.example` invites, and the one Node hands back on a
 * dual-stack socket — got a configuration that validated perfectly and matched
 * nothing, because `withinPrefix` refuses to compare across families. That is the
 * "trusts nothing" failure direction, arriving from a correct-looking config.
 */
function foldIpv4Mapped(address: ParsedIpAddress): ParsedIpAddress {
  return isIpv4Mapped(address) ? { kind: 'ipv4', bytes: address.bytes.slice(12) } : address;
}

/**
 * Strip an IPv6 zone identifier.
 *
 * `fe80::1%eth0` is what a link-local peer looks like on a multi-homed host. It
 * used to fail to parse, so the peer became {@link UNKNOWN_CLIENT_IP}, never
 * matched a declared proxy, and every request from that interface shared one
 * rate-limit bucket. The zone names a local interface and says nothing about which
 * machine is calling, so it is dropped rather than kept in the key.
 */
function stripZoneId(text: string): string {
  const percent = text.indexOf('%');
  return percent === -1 ? text : text.slice(0, percent);
}

/** The unfolded parse, used only where the written FORM matters (a CIDR prefix). */
function parseIpAddressRaw(text: string): ParsedIpAddress | null {
  const value = stripZoneId(text.trim()).toLowerCase();
  if (value.length === 0) {
    return null;
  }
  return value.includes(':') ? parseIpv6(value) : parseIpv4(value);
}

/** One address, in the canonical form every comparison and every key uses. */
export function parseIpAddress(text: string): ParsedIpAddress | null {
  const parsed = parseIpAddressRaw(text);
  return parsed === null ? null : foldIpv4Mapped(parsed);
}

/**
 * One address, cleaned up enough to be a stable key — or `null` when it is not an
 * address at all.
 *
 * It VALIDATES, and that is the change this function most needed: an earlier
 * version passed `not-an-ip` and any eighty characters of junk straight through,
 * so its own docblock ("returns `null` for anything that cannot be a key") was
 * false. With trust decided by address, an entry that cannot be parsed also cannot
 * be matched against the proxy list, so letting junk through would let a proxy's
 * own header content decide where the walk stops.
 */
export function normalizeIpAddress(raw: string): string | null {
  let value = raw.trim();
  if (value.length === 0) {
    return null;
  }

  if (value.startsWith('[')) {
    // `[::1]:53124` — the bracketed form, with or without a port.
    const close = value.indexOf(']');
    if (close === -1) {
      return null;
    }
    value = value.slice(1, close);
  } else {
    const firstColon = value.indexOf(':');
    // Exactly one colon means `host:port`; two or more means it is IPv6 and the
    // colons belong to the address.
    if (firstColon !== -1 && value.indexOf(':', firstColon + 1) === -1) {
      value = value.slice(0, firstColon);
    }
  }

  const parsed = parseIpAddress(value);
  return parsed === null ? null : formatIpAddress(parsed);
}

/**
 * The canonical text for a parsed address.
 *
 * An IPv4-mapped IPv6 address has already been folded by {@link parseIpAddress},
 * so it arrives here as plain IPv4: it is the same machine, Node hands back
 * whichever form the listening socket produced, and two spellings would be two
 * independent rate-limit budgets for one person.
 */
export function formatIpAddress(address: ParsedIpAddress): string {
  if (address.kind === 'ipv4') {
    return address.bytes.join('.');
  }
  const bytes = address.bytes;
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}

export interface TrustedProxyParseResult {
  readonly proxies: readonly TrustedProxy[];
  /**
   * Everything wrong with the value, as the operator wrote it. Non-empty means the
   * configuration is wrong and the process must not start — an unparseable token,
   * a range wide enough to trust everybody, or a value that names no proxy at all
   * without saying `none`.
   */
  readonly invalid: readonly string[];
}

/**
 * Read the declared proxy list.
 *
 * Accepts single addresses and CIDR ranges only — no keywords beyond
 * {@link NO_TRUSTED_PROXIES}, because the same string is handed to Fastify's
 * `trustProxy` and has to mean the same thing on both sides. Anything it cannot
 * parse comes back in `invalid` rather than being dropped: a typo in this variable
 * silently narrows or widens who is trusted, so it has to stop the process.
 */
export function parseTrustedProxies(raw: string): TrustedProxyParseResult {
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 1 && tokens[0]?.toLowerCase() === NO_TRUSTED_PROXIES) {
    return { proxies: [], invalid: [] };
  }

  if (tokens.length === 0) {
    // `''`, `','`, `' , '` — a half-finished edit, not a decision. Silently
    // meaning "no proxy" here is how a deployment behind Caddy comes up counting
    // every visitor as Caddy, with nothing said.
    return {
      proxies: [],
      invalid: [raw.trim().length === 0 ? '(empty)' : raw.trim()],
    };
  }

  const proxies: TrustedProxy[] = [];
  const invalid: string[] = [];

  for (const token of tokens) {
    const slash = token.indexOf('/');
    const addressText = slash === -1 ? token : token.slice(0, slash);
    const written = parseIpAddressRaw(addressText);
    if (written === null) {
      invalid.push(token);
      continue;
    }

    // Folded to the SAME canonical form candidate addresses use, so
    // `::ffff:10.0.0.2` and `10.0.0.2` are one declaration rather than two that
    // can never match each other.
    const address = foldIpv4Mapped(written);
    const folded = address !== written;
    const maxBits = address.bytes.length * 8;

    if (slash === -1) {
      proxies.push({ address, prefixBits: maxBits, source: token });
      continue;
    }

    const prefixText = token.slice(slash + 1);
    if (!PREFIX_DIGITS.test(prefixText)) {
      invalid.push(token);
      continue;
    }

    let prefixBits = Number(prefixText);
    if (folded) {
      // The prefix was written against the 128-bit mapped form. Below the mapped
      // prefix it covers more than IPv4 space, which is not something this list
      // can express — and is a range far too wide to trust in any case.
      if (prefixBits < V4_MAPPED_PREFIX_BITS) {
        invalid.push(token);
        continue;
      }
      prefixBits -= V4_MAPPED_PREFIX_BITS;
    }

    // `/0` matches every address of its family: one token, and the deployment is
    // back to trusting whatever the client claims. It is a configuration error,
    // not something to quietly accept.
    if (prefixBits < MIN_TRUSTED_PREFIX_BITS || prefixBits > maxBits) {
      invalid.push(token);
      continue;
    }
    proxies.push({ address, prefixBits, source: token });
  }

  return { proxies, invalid };
}

/**
 * The declared proxies, or a thrown error.
 *
 * `packages/config` validates this variable before a port is opened, so by the
 * time any request-path code reads it the list is known good. That makes a
 * non-empty `invalid` here *impossible* — and the three call sites that used to
 * ignore it were quietly continuing with a SHORTENED list if it ever happened,
 * which is the "trusts too few" failure with nothing said. Loud is the only honest
 * option for a state that cannot occur.
 */
export function requireTrustedProxies(raw: string): readonly TrustedProxy[] {
  const { proxies, invalid } = parseTrustedProxies(raw);
  if (invalid.length > 0) {
    throw new Error(
      `TRUSTED_PROXY_ADDRESSES is not usable: ${invalid.join(', ')}. ` +
        'The environment schema should have refused to start; this is a bug in packages/config.',
    );
  }
  return proxies;
}

function withinPrefix(candidate: ParsedIpAddress, proxy: TrustedProxy): boolean {
  if (candidate.kind !== proxy.address.kind) {
    return false;
  }
  // Belt and braces for the `/0` hole: the parser refuses to build one, and a
  // zero-bit prefix would otherwise skip the loop below and match everything.
  if (proxy.prefixBits < MIN_TRUSTED_PREFIX_BITS) {
    return false;
  }
  let remaining = proxy.prefixBits;
  for (let index = 0; index < candidate.bytes.length && remaining > 0; index += 1) {
    const bits = Math.min(8, remaining);
    const mask = bits === 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((candidate.bytes[index] ?? 0) & mask) !== ((proxy.address.bytes[index] ?? 0) & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

/** Whether this address is one of the proxies we put in front of ourselves. */
export function isTrustedProxy(
  address: string,
  trustedProxies: readonly TrustedProxy[],
): boolean {
  if (trustedProxies.length === 0) {
    return false;
  }
  const parsed = parseIpAddress(address);
  if (parsed === null) {
    return false;
  }
  return trustedProxies.some((proxy) => withinPrefix(parsed, proxy));
}

export interface ClientIpInput {
  /** `request.socket.remoteAddress` — the only address nobody outside can forge. */
  readonly socketAddress: string | null | undefined;
  /** The raw `X-Forwarded-For` header(s), exactly as received. */
  readonly forwardedFor: string | readonly string[] | null | undefined;
  /** The proxies this deployment declared, already parsed. */
  readonly trustedProxies: readonly TrustedProxy[];
}

/**
 * The address to count a request against.
 *
 * ```text
 * direct, forged header   socket=203.0.113.9  XFF="1.2.3.4"              → 203.0.113.9  (header ignored)
 * behind Caddy            socket=10.0.0.2     XFF="203.0.113.7"          → 203.0.113.7
 * behind Caddy, forged    socket=10.0.0.2     XFF="9.9.9.9, 203.0.113.7" → 203.0.113.7
 * two of our proxies      socket=10.0.0.2     XFF="203.0.113.7, 10.0.0.3"→ 203.0.113.7
 * every entry is ours     socket=10.0.0.2     XFF="10.0.0.3"             → 10.0.0.3    (far end)
 * ```
 *
 * The last row is the one worth pausing on: when the whole chain is our own
 * infrastructure there is no client address in it, so the far end is used rather
 * than inventing one. That matches `proxy-addr`, and therefore matches what
 * Fastify reports as `request.ip` for the same request.
 */
export function resolveClientIp(input: ClientIpInput): string {
  const socket = readAddress(input.socketAddress);

  // Nothing declared, or the peer is not one of ours: the header is not read at
  // all. This is the whole security property, in two lines.
  if (input.trustedProxies.length === 0 || !isTrustedProxy(socket, input.trustedProxies)) {
    return socket;
  }

  const forwarded = forwardedChain(input.forwardedFor);
  if (forwarded.length === 0) {
    return socket;
  }

  // Nearest hop first: the socket, then the last thing appended to the header.
  const chain = [socket, ...forwarded.slice().reverse()];
  for (const address of chain) {
    if (!isTrustedProxy(address, input.trustedProxies)) {
      return address;
    }
  }
  return chain[chain.length - 1] ?? socket;
}

function readAddress(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return UNKNOWN_CLIENT_IP;
  }
  return normalizeIpAddress(value) ?? UNKNOWN_CLIENT_IP;
}

/**
 * `X-Forwarded-For` in order of appending, left to right, capped.
 *
 * Node collapses a repeated header into an array, and a proxy may send either one
 * header with commas or several headers — both mean the same list in the same
 * order, so both are flattened here. Unreadable entries become the unknown bucket
 * rather than being dropped: dropping them would shorten the chain, and a shorter
 * chain is a different walk.
 *
 * The cap is taken BEFORE parsing, and from the right. Parsing is not free —
 * every entry is then match-tested against every declared proxy — and the header
 * arrives from a peer we trust but whose upstream we do not. The rightmost entries
 * are the ones our own proxies appended, and the walk starts from that end, so
 * discarding the far left discards only entries nobody trusted anyway.
 */
function forwardedChain(value: string | readonly string[] | null | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries
    .slice(Math.max(0, entries.length - MAX_FORWARDED_ENTRIES))
    .map((entry) => normalizeIpAddress(entry) ?? UNKNOWN_CLIENT_IP);
}
