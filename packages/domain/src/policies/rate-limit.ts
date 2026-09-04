/**
 * The rate-limit *decision*: which counters a request has to pass, and what the
 * keys are called.
 *
 * Nothing here touches a store, a header object or a framework.
 *
 * Working out WHICH address a request came from used to live beside this, as a
 * hand-written IP and CIDR parser. It is gone. Three review rounds found three
 * different holes in it — hop counting, then `/0`, then `/1` (two `/1` ranges
 * cover all of IPv4, so a one-bit floor bought one bit) — plus acceptance of
 * addresses `net.isIP` rejects. Each round patched the named example rather than
 * the class of bug, which is the pattern that stopped. `apps/api` now asks
 * `@fastify/proxy-addr` — the same library, at the same pinned version, that
 * Fastify itself uses — so "Fastify and we cannot disagree" is true by
 * construction rather than by a test comparing two implementations.
 */

/**
 * The bucket a request whose origin cannot be worked out falls into.
 *
 * One shared bucket over-counts unrelated callers, and that is the deliberate
 * direction of the error: the alternative — skipping the limit when the address is
 * unreadable — hands anybody who can produce an unreadable address a way past the
 * whole feature. It is never LOCKED on, though: see `bruteForceSubjectFor`.
 *
 * It lives in a namespace {@link keySegment} cannot write into. Every value from
 * outside comes back prefixed with {@link EXTERNAL_SEGMENT_PREFIX} and made of
 * `[a-z0-9._-]` only, so no outside value — however it is spelled — can come out
 * as `!unresolved`. The value was once the bare word `unknown`, which RFC 7239
 * explicitly permits as a real node identifier and which `keySegment('')` also
 * produced: three unrelated situations sharing one bucket.
 */
export const UNKNOWN_CLIENT_IP = '!unresolved';

/**
 * Every place the limit is applied, as a closed set.
 *
 * `logout` is deliberately absent and always will be. Rate-limiting sign-out
 * keeps somebody inside a session they are trying to leave — on a shared machine
 * that is a security failure, not an inconvenience. There is no action name to
 * put on that route, so the route cannot accidentally acquire one.
 */
export const RATE_LIMIT_ACTIONS = [
  'auth_start',
  'auth_callback',
  'auth_refresh',
  'auth_me',
  /**
   * Story 1.4's declaration endpoint.
   *
   * It gets an action for the same reason every route but `logout` has one: the
   * decorator's default is "no limit", so a route added without one is silently
   * unlimited. This one is a WRITE reachable with a session cookie, and while the
   * conditional UPDATE means a flood can only ever store one value, a flood still
   * costs a database round trip each.
   */
  'auth_date_of_birth',
] as const;

export type RateLimitAction = (typeof RATE_LIMIT_ACTIONS)[number];

export function isRateLimitAction(value: unknown): value is RateLimitAction {
  return typeof value === 'string' && (RATE_LIMIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * How a refusal has to travel back, which is a property of who is calling.
 *
 * `auth_start` and `auth_callback` are reached by a browser following a
 * navigation, so a JSON body there is a page of braces where a person expected to
 * be back in the app — the same reasoning that turned every callback failure into
 * a redirect in Story 1.3 part 1. `auth_refresh` and `auth_me` are called with
 * `fetch` by code that can read an envelope.
 */
export const RATE_LIMIT_ACTION_CHANNELS = {
  auth_start: 'browser',
  auth_callback: 'browser',
  auth_refresh: 'json',
  auth_me: 'json',
  // Called with `fetch` from the declaration screen, by code that reads an
  // envelope — so a refusal travels as JSON, not as a redirect.
  auth_date_of_birth: 'json',
} as const satisfies Record<RateLimitAction, 'browser' | 'json'>;

export type RateLimitChannel = (typeof RATE_LIMIT_ACTION_CHANNELS)[RateLimitAction];

export function channelForAction(action: RateLimitAction): RateLimitChannel {
  return RATE_LIMIT_ACTION_CHANNELS[action];
}

/** The two directions a counter can be keyed in, plus the longer brute-force lock. */
export const RATE_LIMIT_DIMENSIONS = ['ip', 'user', 'brute_force'] as const;
export type RateLimitDimension = (typeof RATE_LIMIT_DIMENSIONS)[number];

/** Everything a key segment may contain. Anything else becomes `_`. */
const UNSAFE_KEY_SEGMENT = /[^a-z0-9._:-]/g;
const MAX_KEY_SEGMENT_LENGTH = 80;

/**
 * The namespace every value from OUTSIDE is written into.
 *
 * This is what keeps the sentinels below unforgeable, and it replaces a claim that
 * was simply false. The old rule was "both sentinels start with `!`, and `!` is
 * not in the safe alphabet" — but cleaning REPLACES `!` with `_` rather than
 * rejecting it, so `keySegment('!unresolved')`, `keySegment('_unresolved')` and
 * `keySegment('@unresolved')` all produced the one string `_unresolved`, which was
 * also what `keySegment(UNKNOWN_CLIENT_IP)` produced. Three outside spellings and
 * the sentinel, one bucket — while the docblock promised the opposite.
 *
 * With a prefix the two spaces are separated by CONSTRUCTION rather than by which
 * characters happen to survive: a segment either begins with `x.`, in which case
 * something outside produced it, or it begins with `!`, in which case this file
 * did. The two cannot meet whatever anybody writes in a header.
 */
const EXTERNAL_SEGMENT_PREFIX = 'x.';

/**
 * What an empty value becomes — distinct from `UNKNOWN_CLIENT_IP`.
 *
 * They used to be the same string, so "the address could not be read" and "the
 * caller passed an empty segment" shared one bucket with each other and with any
 * chain entry that literally said `unknown` (RFC 7239 permits that word). Three
 * unrelated situations, one budget.
 *
 * Nothing outside can reach it: an outside value is prefixed and cleaned, and the
 * empty string is the only input that produces this branch at all, because
 * cleaning replaces characters rather than dropping them and therefore never
 * shortens a value.
 */
export const EMPTY_KEY_SEGMENT = '!empty';

/**
 * A value from the outside world, made safe to concatenate into a key.
 *
 * Keys are built from a header and from a cookie, so this is the boundary where a
 * hostile value stops being able to change the SHAPE of the key — a segment
 * containing a `:` could otherwise impersonate a different dimension — and, since
 * the `x.` prefix, the boundary where it stops being able to impersonate one of
 * this file's own sentinels either.
 *
 * There is deliberately NO branch that returns a value unchanged. A sentinel is
 * never produced by this function for a non-empty input, whatever the input is —
 * which is what makes "an outside value cannot become a sentinel" a property of
 * the code rather than a claim about which characters survive cleaning. The one
 * place a sentinel is legitimately the value of a key is
 * {@link rateLimitRulesFor}, which composes the segment itself rather than asking
 * this function to recognise one.
 */
export function keySegment(value: string): string {
  const cleaned = value.toLowerCase().replace(UNSAFE_KEY_SEGMENT, '_').replace(/:/g, '.');
  if (cleaned.length === 0) {
    return EMPTY_KEY_SEGMENT;
  }
  return `${EXTERNAL_SEGMENT_PREFIX}${cleaned}`.slice(0, MAX_KEY_SEGMENT_LENGTH);
}

/** `rl:<dimension>:<action>:<value>` — one namespace, so a flush is possible later. */
export function rateLimitKey(
  dimension: RateLimitDimension,
  action: RateLimitAction | 'sign_in',
  value: string,
): string {
  return keyFromSegment(dimension, action, keySegment(value));
}

/**
 * The same key, from a segment this file already owns.
 *
 * Separate from {@link rateLimitKey} so that {@link keySegment} needs no
 * "unless it is one of ours" branch. That branch is what made the sentinels
 * forgeable: recognising `!unresolved` on the way IN means an outside value
 * spelled that way is recognised too.
 */
function keyFromSegment(
  dimension: RateLimitDimension,
  action: RateLimitAction | 'sign_in',
  segment: string,
): string {
  return `rl:${dimension}:${action}:${segment}`;
}

/**
 * Which side of a failure is being counted.
 *
 * Both are needed and neither is enough on its own, which is what the epic means
 * by "rate limit theo IP **và** theo user":
 *
 * - by `ip` alone, an attack spread across a botnet never trips anything, while
 *   one hostile student on a campus NAT locks `/start` for the whole campus;
 * - by `user` alone, an attacker who presents no credential at all — which is
 *   every unauthenticated sign-in attempt — is counted by nothing.
 */
export const BRUTE_FORCE_DIMENSIONS = ['ip', 'user'] as const;
export type BruteForceDimension = (typeof BRUTE_FORCE_DIMENSIONS)[number];

/**
 * The counter of consecutive sign-in FAILURES for one origin or one credential.
 *
 * Not keyed by action: a brute-force attempt is a sequence of failures across the
 * start and callback legs, and counting each leg separately would let an attacker
 * stay under both thresholds while going well over the real one.
 */
export function bruteForceCounterKey(dimension: BruteForceDimension, value: string): string {
  return rateLimitKey('brute_force', 'sign_in', `count.${dimension}.${value}`);
}

/**
 * The lock a tripped brute-force counter sets. Separate from the counter so that
 * clearing the counter after a genuine success does NOT release a lock that has
 * already been earned — the two matrix rows that look contradictory until the
 * keys are separate.
 */
export function bruteForceLockKey(dimension: BruteForceDimension, value: string): string {
  return rateLimitKey('brute_force', 'sign_in', `lock.${dimension}.${value}`);
}

export interface BruteForceKeySubject {
  readonly dimension: BruteForceDimension;
  readonly value: string;
}

/**
 * The brute-force dimension this leg counts AND enforces — exactly one, chosen by
 * the channel.
 *
 * The rule is one sentence: **a browser leg is counted and locked by address; a
 * `fetch` leg is counted and locked by credential.** Every earlier arrangement got
 * one of the two halves wrong, and each way was a real defect:
 *
 * - counting both dimensions everywhere while enforcing the address lock only on
 *   browser legs meant refresh failures EARNED an address lock that then blocked
 *   `/start` and `/callback` for everyone behind that address — which is the very
 *   thing skipping the address lock on `fetch` legs was meant to avoid;
 * - counting the credential on a browser leg punished the wrong person entirely. A
 *   signed-in visitor navigated cross-site to `/callback` sends their session
 *   cookie under `SameSite=Lax`, so a handful of induced clicks with a bogus
 *   `state` locked a credential that was never part of the attempt.
 *
 * Splitting it by channel also matches what each leg actually knows. A sign-in
 * attempt has no credential of its own — whatever cookie rode along belongs to a
 * different session — so the address is the only honest identity. A refresh
 * carries exactly one credential and reaches us from anywhere, so the credential
 * is the only identity that survives an address change.
 */
export function bruteForceSubjectFor(
  channel: RateLimitChannel,
  subject: RateLimitSubject,
): BruteForceKeySubject | null {
  if (channel === 'browser') {
    /**
     * Never lock on the unresolved bucket.
     *
     * `UNKNOWN_CLIENT_IP` is one shared key for every caller whose address could
     * not be worked out. Over-COUNTING them together is the deliberate trade — the
     * alternative lets anyone with an unreadable address skip the limit — but
     * LOCKING on it is different in kind: one such caller would earn a
     * fifteen-minute lock covering every other unresolvable peer, and none of them
     * can do anything about it. The per-window counter still applies to them.
     */
    if (subject.clientIp === UNKNOWN_CLIENT_IP) {
      return null;
    }
    return { dimension: 'ip', value: subject.clientIp };
  }
  if (subject.userHandle === undefined || subject.userHandle.length === 0) {
    // A `fetch` leg with no credential presented. There is nothing to count that
    // would not be somebody else's bucket; the per-window address counter still
    // applies.
    return null;
  }
  return { dimension: 'user', value: subject.userHandle };
}

/**
 * The operational knobs, read from the environment by `packages/config` and passed
 * in. They are limits and windows, not secrets, so they carry defaults there — but
 * they are still injected here rather than imported, because a policy that reads
 * its own configuration cannot be tested at two different settings.
 */
export interface RateLimitSettings {
  readonly ipLimit: number;
  readonly ipWindowSeconds: number;
  readonly userLimit: number;
  readonly userWindowSeconds: number;
  readonly bruteForceLimit: number;
  readonly bruteForceLockSeconds: number;
}

export interface RateLimitRule {
  readonly dimension: Exclude<RateLimitDimension, 'brute_force'>;
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitSubject {
  readonly clientIp: string;
  /**
   * A stable, non-reversible handle for the account behind the request, when the
   * request carries one.
   *
   * Before authentication there is no user id to key on, so this is derived from
   * the credential presented — the refresh or session cookie, hashed. That is what
   * makes "cùng user, nhiều IP khác nhau" a real limit: the credential does not
   * change when the address does, so twenty machines replaying one stolen refresh
   * token share one budget. It is `undefined` on the two legs where the visitor
   * has presented nothing, and those are IP-only by necessity rather than choice.
   */
  readonly userHandle?: string | undefined;
}

/**
 * Which counters this request has to pass, in the order they are checked.
 *
 * IP first, on purpose: it is the dimension that is always available, and it is
 * the cheaper key to reach a verdict on.
 */
export function rateLimitRulesFor(
  action: RateLimitAction,
  subject: RateLimitSubject,
  settings: RateLimitSettings,
): readonly RateLimitRule[] {
  const rules: RateLimitRule[] = [
    {
      dimension: 'ip',
      /**
       * The one place a sentinel is the value of a key, and the reason it is
       * composed here rather than recognised inside `keySegment`.
       *
       * `clientIpOf` returns either an address `node:net` validated or exactly
       * {@link UNKNOWN_CLIENT_IP}; nothing else can be in this field. So the
       * comparison is on a value this codebase produced, while `keySegment` — the
       * function that sees strings from headers and cookies — keeps no branch that
       * could be tricked into producing a sentinel.
       */
      key:
        subject.clientIp === UNKNOWN_CLIENT_IP
          ? keyFromSegment('ip', action, UNKNOWN_CLIENT_IP)
          : rateLimitKey('ip', action, subject.clientIp),
      limit: settings.ipLimit,
      windowSeconds: settings.ipWindowSeconds,
    },
  ];

  if (subject.userHandle !== undefined && subject.userHandle.length > 0) {
    rules.push({
      dimension: 'user',
      key: rateLimitKey('user', action, subject.userHandle),
      limit: settings.userLimit,
      windowSeconds: settings.userWindowSeconds,
    });
  }

  return rules;
}

/**
 * Whole seconds a client should be told to wait, from a real remaining lifetime.
 *
 * Rounded UP and floored at 1. Rounding down would tell somebody to wait 4
 * seconds when 4.6 remain, and being refused a second time after doing exactly
 * what the message said is worse than waiting an extra second.
 */
export function retryAfterSecondsFrom(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(remainingMs / 1000));
}
