import { z } from 'zod';

/**
 * AD-13 — the vocabulary of `/v1/auth/*`. Nothing here may be redeclared in
 * `apps/*`: the four provider names, the six roles and the shape of the signed-in
 * profile are the contract a future mobile client reads, not an implementation
 * detail of the NestJS shell.
 */

/**
 * The four providers Epic 1 promises. This list is the ONLY place the set is
 * written down: the config schema derives its credential requirements from it, the
 * migration derives its CHECK constraint from it, and the router refuses anything
 * that is not in it.
 */
export const AUTH_PROVIDERS = ['google', 'facebook', 'apple', 'microsoft'] as const;

export const authProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export function isAuthProvider(value: unknown): value is AuthProvider {
  return typeof value === 'string' && (AUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * "The role model has to hold six roles from day one" (Epic 1 constraint). All six
 * are declared here so that the model is complete before any of them has a screen.
 *
 * `host` is in the list and deliberately NOT in {@link GLOBAL_USER_ROLES}: it is a
 * permission held **per room**, not a global role a `users` row can carry. Putting
 * it in the column would make "host of one room" mean "host everywhere", which is
 * the exact confusion Epic 2 has to avoid. The split is expressed here rather than
 * in a comment on the migration so both halves come from one source.
 */
export const USER_ROLES = [
  'guest',
  'user',
  'host',
  'org_admin',
  'moderator',
  'system_admin',
] as const;

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** The five roles a `users` row may carry. `host` is per-room (Epic 2). */
export const GLOBAL_USER_ROLES = USER_ROLES.filter((role) => role !== 'host') as ReadonlyArray<
  Exclude<UserRole, 'host'>
>;

export const globalUserRoleSchema = z.enum(
  GLOBAL_USER_ROLES as unknown as [Exclude<UserRole, 'host'>, ...Array<Exclude<UserRole, 'host'>>],
);
export type GlobalUserRole = z.infer<typeof globalUserRoleSchema>;

/**
 * `GET /v1/auth/me`.
 *
 * What is NOT here is the point: no email and no provider id. The client never
 * needs either, and every field a response carries is a field that ends up in a
 * browser cache, a screenshot and eventually a support ticket. Story 1.4 adds an
 * over-18 flag; it does NOT add the date of birth.
 */
export const currentUserSchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(120),
  avatar_url: z.url().nullable(),
  role: globalUserRoleSchema,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Cookie names are part of the boundary, not of the shell: the browser is the
 * transport, so renaming one is a breaking change to `/v1` exactly as renaming a
 * JSON field would be.
 *
 * All three are `httpOnly` + `Secure` + `SameSite=Lax` and are never readable from
 * JavaScript. `Lax` (not `Strict`) is required: the OAuth callback arrives as a
 * top-level cross-site navigation from the provider, and `Strict` would withhold
 * the state cookie on exactly that request, making every login fail.
 */
export const SESSION_COOKIE_NAME = 'stuwith_session';
export const REFRESH_COOKIE_NAME = 'stuwith_refresh';

/**
 * A PREFIX, not a name. One cookie per login attempt, named
 * `stuwith_oauth_<handle>`.
 *
 * A single fixed name looks simpler and is wrong for a thing people actually do:
 * open the login page in two tabs. The second `/start` overwrites the first tab's
 * state cookie, and finishing the first tab then fails as "state missing" —
 * indistinguishable, to the user, from a broken product. Per-attempt cookies make
 * two tabs work, and the callback finds its own by matching the signed `state`
 * inside each candidate rather than by trusting the cookie name.
 *
 * Housekeeping is the `Max-Age`: an abandoned attempt's cookie disappears after
 * `OAUTH_STATE_TTL_SECONDS`, and a completed or failed one is cleared explicitly.
 */
export const OAUTH_STATE_COOKIE_PREFIX = 'stuwith_oauth_';

/** The path prefix the refresh and state cookies are scoped to. */
export const AUTH_COOKIE_PATH = '/v1/auth';

/** The session cookie is needed by every authenticated endpoint, not just `/v1/auth`. */
export const SESSION_COOKIE_PATH = '/';

/**
 * How the last sign-in attempt ended, in the vocabulary the login page is allowed
 * to read.
 *
 * AD-13: this crosses a process boundary — `apps/api` puts it in a redirect and
 * `apps/web` reads it back out of the URL — so it is declared once, here, and
 * never redeclared in either app.
 *
 * The set is deliberately TINY, and much smaller than the set of things that can
 * actually go wrong. The internal reasons (`apps/api/src/auth/audit.ts`) include
 * `provider_exchange_failed`, `state_expired` and `identity_rejected`; strung
 * together they tell a stranger which piece of our infrastructure is broken and
 * what is being refused. Collapsing many internal reasons onto two public ones is
 * what keeps "no error code, no failing provider's name" true as the internal list
 * grows.
 *
 * `da-huy` is not a failure. The person changed their mind at the consent screen,
 * and presenting that as an error is both untrue and mildly accusing.
 *
 * The closed enum is also the injection defence: this value arrives from a URL the
 * visitor controls, so the login page matches it against this list and renders a
 * string of its own. Nothing from the URL is ever echoed to the screen.
 *
 * `bi-khoa` is Story 1.3 part 2's addition and is the reason the set is still
 * this small. It says "too many attempts, wait" and NOTHING else: not whether the
 * lock is by address or by account, not what the threshold was, not how many
 * attempts were left. Each of those would tell somebody probing the login exactly
 * how to stay under it, and none of them helps the person who is simply locked
 * out. The only number that travels with it is how long to wait, in
 * {@link SIGN_IN_RETRY_AFTER_QUERY_PARAM}.
 */
export const SIGN_IN_OUTCOMES = ['that-bai', 'da-huy', 'bi-khoa'] as const;

export const signInOutcomeSchema = z.enum(SIGN_IN_OUTCOMES);
export type SignInOutcome = z.infer<typeof signInOutcomeSchema>;

export function isSignInOutcome(value: unknown): value is SignInOutcome {
  return typeof value === 'string' && (SIGN_IN_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The query parameter the outcome rides in, on the way back to `/dang-nhap`.
 *
 * Vietnamese, like the route it belongs to: the URL is a user-facing surface in a
 * product whose default locale is Vietnamese, and a `?result=` bolted onto
 * `/dang-nhap` reads as somebody else's plumbing showing through.
 */
export const SIGN_IN_OUTCOME_QUERY_PARAM = 'ket-qua';

/**
 * How many seconds the visitor should wait, riding back beside `bi-khoa`.
 *
 * Vietnamese for the same reason `ket-qua` is, and a SEPARATE parameter rather
 * than a suffix on the outcome (`bi-khoa-30`) because the two are read by
 * different rules: the outcome is matched against a closed enum, the number is
 * range-checked. Fusing them would mean the enum could no longer be closed.
 */
export const SIGN_IN_RETRY_AFTER_QUERY_PARAM = 'giay';

/**
 * The sentence a rate-limited person reads, declared ONCE.
 *
 * `apps/api` puts it in the `rate_limited` envelope and `apps/web` renders it
 * beside the countdown, so it crosses the process boundary exactly as
 * {@link SIGN_IN_OUTCOMES} does — and it lived in both packages, each pinned by
 * its own literal assertion, until one of them was going to be edited alone.
 *
 * It says what happened and what to do next, and deliberately nothing else: not
 * whether the lock is by address or by account, not the threshold, not how many
 * attempts are left. Each of those is free calibration for somebody probing the
 * login, and none of them helps the person who is simply locked out. The only
 * number that travels is how long to wait, and it is not in this sentence.
 *
 * Vietnamese is the default locale; full i18n is Story 1.6.
 */
export const RATE_LIMITED_MESSAGE = 'Bạn đã thử quá nhiều lần. Hãy chờ một lát rồi thử lại.';

/**
 * The band a retry countdown has to fall in to be shown at all.
 *
 * This value arrives in a URL that anybody can write, so `?giay=99999999` is not a
 * hypothetical — it is a link a stranger can send, and rendering it would put "thử
 * lại sau 1157 ngày" on the screen of somebody who is not locked out of anything.
 * Below the floor is just as wrong: `0` renders a countdown that has already
 * finished and invites an immediate retry.
 *
 * The ceiling is a day, comfortably above any lock this product configures
 * (`RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS` tops out there too) and far below a
 * number that reads as nonsense.
 */
export const MIN_SIGN_IN_RETRY_AFTER_SECONDS = 1;
export const MAX_SIGN_IN_RETRY_AFTER_SECONDS = 86_400;

export const signInRetryAfterSecondsSchema = z
  .number()
  .int()
  .min(MIN_SIGN_IN_RETRY_AFTER_SECONDS)
  .max(MAX_SIGN_IN_RETRY_AFTER_SECONDS);

/**
 * The one place a countdown from the outside world is turned into a number, used
 * by BOTH processes (AD-13) — `apps/api` to decide the value is worth putting in a
 * redirect, `apps/web` to decide it is worth rendering.
 *
 * Everything that is not an integer in the band is `null`, and `null` means "show
 * the lock message with no clock" rather than "show something plausible". The
 * checks are deliberately stricter than `Number()`: that accepts `'  12  '`,
 * `'0x10'`, `'1e3'` and `'12.0'`, all of which are somebody probing rather than a
 * countdown this product wrote.
 */
export function parseSignInRetryAfterSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return signInRetryAfterSecondsSchema.safeParse(raw).success ? raw : null;
  }
  // No leading zero: the floor is 1, so a value starting with `0` is either out of
  // range or padded, and neither is something this product wrote. A parser
  // described as stricter than `Number()` while quietly accepting `030` is worse
  // than a lenient one, because the description is what the next reader trusts.
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,6}$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return signInRetryAfterSecondsSchema.safeParse(parsed).success ? parsed : null;
}

/**
 * Where to send the browser once a re-login succeeds, proposed by the client on
 * the way IN to `/v1/auth/:provider/start`.
 *
 * Vietnamese, like `ket-qua` and `giay`, and for the same reason: the URL is a
 * user-facing surface in a product whose default locale is Vietnamese.
 *
 * It is a PROPOSAL and it is only ever read at `/start`. The callback reads the
 * path back out of the signed OAuth state, never out of a query parameter, a
 * cookie or a header — an attacker cannot sign a payload, so an attacker cannot
 * choose a destination. That asymmetry is the whole defence, and it only holds
 * while this parameter appears on exactly one leg.
 */
export const SIGN_IN_RETURN_PATH_QUERY_PARAM = 'quay-ve';

/**
 * The ceiling on a proposed return path.
 *
 * It rides in a cookie (inside the signed OAuth state) on every `/v1/auth`
 * request for the life of the handshake, and the browser sends every state cookie
 * it holds on each of them. A long path from a URL anybody can write is therefore
 * a way to grow the `Cookie` header until the server answers 431 instead of a
 * login page — the same failure mode `deadAttemptCookies` exists to bound from
 * the other side.
 */
export const MAX_SIGN_IN_RETURN_PATH_LENGTH = 512;

/**
 * Every character a proposed return path may contain, as an ALLOW-list.
 *
 * A deny-list here is the shape that fails: three review rounds on the trusted
 * proxy list each patched the named example and each left the class open. So this
 * names what is permitted — unreserved characters, the path separator, and the
 * handful of query punctuation an internal link actually uses — and everything
 * else is refused without having to be enumerated.
 *
 * Four exclusions are load-bearing, and each closes a family rather than an
 * example:
 *
 * - **`%`** — no percent-encoding at all, so there is no decode step and
 *   therefore no way for two readings of the same string to disagree. `%2F%2F`,
 *   `%5C`, `%00` and `%0A` are all gone by one rule instead of four. The cost is
 *   real and deliberate: a path carrying an escaped character cannot be proposed
 *   and the person lands on the default instead. Losing a convenience is the
 *   right side of that trade.
 * - **`\`** — browsers fold a backslash onto `/` inside a path, so `/\evil.com`
 *   is `//evil.com` written in a spelling a naive `startsWith('//')` misses.
 * - **`:` and `@`** — the two characters that turn a string into an authority.
 *   No internal route of this product needs either.
 * - **control characters, whitespace and `#`** — a CR or LF in a value that ends
 *   up in a `Location` header is response splitting; a fragment never reaches the
 *   server and has nothing to contribute here.
 */
const RETURN_PATH_ALLOWED = /^\/[A-Za-z0-9\-._~/?=&,+]*$/;

/**
 * The one place an internal return path is judged, used by BOTH processes
 * (AD-13) — `apps/api` at `/start` to decide whether a proposal is worth signing
 * into the OAuth state, and `apps/web` to decide whether the path it is standing
 * on is worth proposing.
 *
 * Same shape as {@link parseSignInRetryAfterSeconds}: everything that is not
 * valid is `null`, nothing throws, and `null` means "use the default" rather than
 * "this is an error". A person whose location cannot be expressed as an internal
 * path simply lands on the login page, which is exactly where they would have
 * landed before this existed.
 *
 * What "internal" means here, stated as rules over the whole string rather than
 * as a list of the tricks that have been seen:
 *
 * - it begins with exactly one `/`, so it can never carry a scheme or a host;
 * - it does not begin with `//`, the spelling that makes `new URL(path, base)`
 *   adopt a brand new origin — the one way a *validated-looking* path still
 *   becomes an open redirect;
 * - no path segment is `.` or `..`, so the string means what it reads as and no
 *   normalisation step can move it somewhere else;
 * - every character is in {@link RETURN_PATH_ALLOWED}, which is where the encoded
 *   spellings, the backslash, the authority punctuation and the header-splitting
 *   bytes all die at once;
 * - it is no longer than {@link MAX_SIGN_IN_RETURN_PATH_LENGTH}.
 *
 * The `..` check looks at the PATH only. A `//` or a `..` inside a query string is
 * an ordinary value — it cannot change the origin and it cannot be normalised
 * away — and refusing it would break real links for nothing.
 */
export function parseInternalReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.length === 0 || raw.length > MAX_SIGN_IN_RETURN_PATH_LENGTH) {
    return null;
  }
  if (!RETURN_PATH_ALLOWED.test(raw)) {
    return null;
  }
  // Protocol-relative. The character class above cannot express "not twice at the
  // start", and this is the spelling that changes the origin.
  if (raw.startsWith('//')) {
    return null;
  }
  const queryAt = raw.indexOf('?');
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') {
      return null;
    }
  }
  return raw;
}
