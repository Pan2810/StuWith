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
