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
 *
 * ## The two Story 1.4 flags, and why they are two
 *
 * `profile_completed` and `is_over_18` are different facts and neither implies
 * the other in the direction a client needs. "Not completed" has to send somebody
 * to the declaration screen; "completed but under 18" must not, and would be
 * indistinguishable from it if the only field were the age flag. A profile with
 * no date of birth answers `false` to BOTH — an unknown age fails closed, which
 * is the only safe direction for a control that protects minors.
 *
 * Both are OPTIONAL, which is what makes adding them compatible rather than
 * breaking (AD-13). `apps/api` always sends them; a client written against the
 * Story 1.2 shape keeps typechecking, and a client written against this one has
 * to decide what an absent flag means — for which the answer is the same as
 * `false`, because that is the fail-closed reading.
 *
 * The date of birth itself is deliberately absent and must stay absent. It is
 * PII, the product needs only the two booleans below, and a field that is never
 * sent is a field that cannot leak.
 */
export const currentUserSchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(120),
  avatar_url: z.url().nullable(),
  role: globalUserRoleSchema,
  /** Whether the first-login declaration is done. `NULL` date of birth is "not yet". */
  profile_completed: z.boolean().optional(),
  /** The whole of what leaves the API about somebody's age. Never a date, never a number. */
  is_over_18: z.boolean().optional(),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Both Story 1.4 flags read the same way whether the field is present or absent.
 *
 * The schema makes them optional so that adding them is a compatible change, and
 * an optional boolean has three states while the product has two. Every reader —
 * `apps/web` today, a mobile client later — must collapse the third the same way,
 * and "absent means no" is the only collapse that fails closed: a client talking
 * to an older deployment that cannot answer "is this person 18" must not conclude
 * that they are.
 *
 * It lives here rather than in `apps/web` for the reason the whole file exists:
 * two processes reading one field must not read it two ways (AD-13).
 */
export function isProfileCompleted(user: Pick<CurrentUser, 'profile_completed'>): boolean {
  return user.profile_completed === true;
}

export function isOver18(user: Pick<CurrentUser, 'is_over_18'>): boolean {
  return user.is_over_18 === true;
}

/**
 * A `/v1/auth/me` body turned into a profile, or `null` — the one place a client
 * decides that what came back IS a profile.
 *
 * Same shape as every other parser here: nothing throws, everything that is not
 * valid is `null`, and the caller decides what a `null` means.
 *
 * It exists because both `apps/web` screens were writing `(await
 * response.json()) as CurrentUser`. A cast is a claim about a body this process
 * did not write, and it is the exact opposite of the argument this story rests
 * on: `toCurrentUser` parses the projection on the way OUT so that adding a
 * column cannot publish it, and then the client trusted any 200 at all. A body
 * with `is_over_18: "yes"` would have reached `isOver18` as truthy-looking data
 * on the one boolean that protects minors.
 *
 * Here rather than in `apps/web` for the reason the whole file exists: two
 * processes reading one shape must not read it two ways (AD-13), and a mobile
 * client has the same 200 to judge.
 */
export function parseCurrentUser(body: unknown): CurrentUser | null {
  const parsed = currentUserSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

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
 * The route the login page lives at, in `apps/web`.
 *
 * AD-13 puts it here because both processes now read it and the docblock at the
 * top of this file says nothing here may be redeclared in `apps/*`: `apps/api`
 * uses it as the default redirect target for a completed and for a refused login,
 * and `apps/web` uses it to answer "is the person already looking at the sign-in
 * page". Two literals is how one of them gets renamed and the other does not, and
 * the failure that produces — a dialog stacked on top of the login page, or a
 * redirect to a route that no longer exists — is silent on both sides.
 */
export const SIGN_IN_PATHNAME = '/dang-nhap';

/**
 * `POST /v1/auth/refresh`, spelled once.
 *
 * `apps/web` calls it from the session seam before it disturbs anybody, so the
 * path is a thing the browser and the server have to agree about — the same kind
 * of agreement as a cookie name, and breaking in the same silent way.
 */
export const AUTH_REFRESH_PATH = '/v1/auth/refresh';

/**
 * The three statuses the session seam turns on, spelled once for both processes.
 *
 * They were declared inside `apps/web/src/app/session-expiry.ts`, and the renewal
 * status was WRONG there: `apps/api` answers `204` on a successful refresh
 * (`auth.flow.test.ts` asserts it in four places) while the seam accepted only
 * `200`. Every renewal therefore reported failure, and Story 1.3c's whole promise —
 * renew silently, disturb somebody only as a last resort — was dead on the real
 * product while both sides' unit tests stayed green: the API suite asserted 204,
 * the web suite stubbed 200, and nothing ran the middle.
 *
 * A status a client branches on IS part of the `/v1` contract (AD-13), the same as
 * a path or a cookie name, and it breaks the same silent way when each side keeps
 * its own copy.
 */
export const SESSION_REFRESHED_STATUS = 204;

/** The status that means "there is no live session behind this call any more". */
export const SESSION_EXPIRED_STATUS = 401;

/**
 * The status `/v1/auth/refresh` answers when the rate limiter has had enough.
 *
 * It matters separately from 401 because it is the one refusal that says "asking
 * again is the problem" rather than "sign in again".
 */
export const RATE_LIMITED_STATUS = 429;

/**
 * `GET /v1/auth/me`, spelled once.
 *
 * Here for the same reason {@link AUTH_REFRESH_PATH} is, and it was the last `/v1`
 * route in this family still written as a literal: two screens in `apps/web`, the
 * OpenAPI document and the contract suite each carried their own copy, so renaming
 * the route meant finding four strings that nothing connects.
 */
export const AUTH_ME_PATH = '/v1/auth/me';

/**
 * The route the date-of-birth declaration lives at, in `apps/web`.
 *
 * Here for the same reason {@link SIGN_IN_PATHNAME} is: it crosses the process
 * boundary. `apps/web` navigates to it and `apps/api` publishes it in the OpenAPI
 * description of the endpoint behind it, so a literal in either app is a literal
 * that gets renamed alone.
 *
 * Vietnamese, like `/dang-nhap`: the URL is a user-facing surface in a product
 * whose default locale is Vietnamese.
 */
export const DATE_OF_BIRTH_PATHNAME = '/khai-ngay-sinh';

/**
 * `POST /v1/auth/date-of-birth`, spelled once.
 *
 * English, like `/v1/auth/refresh` and `/v1/auth/me`: the `/v1` surface is the
 * contract a future mobile client reads, and it is already in English throughout.
 * The Vietnamese half of the pair is the WEB route above, which is the one a
 * person actually sees.
 */
export const AUTH_DATE_OF_BIRTH_PATH = '/v1/auth/date-of-birth';

/** The single field in the declaration body. snake_case, like every other wire field. */
export const DATE_OF_BIRTH_FIELD = 'date_of_birth';

/**
 * The floor on a plausible birth year.
 *
 * Not a rule about age — the age rule lives in `packages/domain` and is the ONLY
 * place a threshold is decided. This is a rule about whether a string is a date
 * somebody could have been born on at all, and `1900` is comfortably below the
 * oldest living person while refusing `0001-01-01`, which is what a broken client
 * or a probe sends.
 */
export const MIN_DATE_OF_BIRTH_YEAR = 1900;

/**
 * Exactly `YYYY-MM-DD`, and nothing that merely starts that way.
 *
 * `\d` in JavaScript is ASCII `0-9` only, so no other decimal digit family gets
 * in. The anchors are what refuse a time component, an offset, a trailing `Z` and
 * any surrounding whitespace — all of which `new Date(...)` would have accepted
 * and silently reinterpreted in the runtime's own time zone.
 */
export const DATE_OF_BIRTH_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar day that actually exists, written the one way this product accepts.
 *
 * Two steps, and the second is the one that matters: the pattern says the string
 * is shaped like a date, and the round trip through `Date.UTC` says it NAMES one.
 * `2026-02-30` and `2025-02-29` pass the pattern and are not days; constructing
 * them rolls the value forward into March, so comparing the components back out
 * is what catches them. Doing it in UTC keeps the answer independent of where the
 * process is running — the same reason every timestamp in this repo is UTC.
 *
 * Deliberately NOT `new Date(raw)`: that parser accepts `2026-02-30` (rolling it
 * to March 2nd), accepts `2026-2-3`, accepts a time and an offset, and is
 * implementation-defined for anything it does not recognise. A parser described
 * as strict must not be one of those.
 */
export function isCalendarDate(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !DATE_OF_BIRTH_PATTERN.test(raw)) {
    return false;
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  // `Date.UTC` maps years 0-99 onto 1900-1999, so a four-digit year in that band
  // would come back as a different year. Rejecting it here keeps the round trip
  // below an honest comparison rather than one with a hole in it; the year floor
  // in `parseDateOfBirth` refuses the same range again for its own reason.
  if (year < 100) {
    return false;
  }
  const instant = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(instant);
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

/**
 * The one place a date of birth from the outside world is judged, used by BOTH
 * processes (AD-13) — `apps/api` before it writes one, `apps/web` before it
 * offers to send one.
 *
 * Same shape as {@link parseSignInRetryAfterSeconds} and
 * {@link parseInternalReturnPath}: everything that is not valid is `null`,
 * nothing throws, and the caller decides what a `null` means. Testing it by
 * CLASS rather than by a list of examples is the point — the examples-first
 * approach is what cost four review rounds on the trusted-proxy list.
 *
 * The classes it refuses, stated as rules over the whole input rather than as the
 * spellings that have been seen:
 *
 * - anything that is not a string, including a `Date`, a number and `null`;
 * - anything not shaped exactly `YYYY-MM-DD` — which is where a time component,
 *   a time zone, a `T`, surrounding whitespace and `2026-2-3` all die at once;
 * - a string shaped like a date that names no day (`2026-02-30`, `2025-02-29`);
 * - a year below {@link MIN_DATE_OF_BIRTH_YEAR};
 * - a day after `today`, judged on the UTC calendar.
 *
 * ## `today` is a parameter, and that is not decoration
 *
 * There is no `new Date()` in this function. A rule about ages that reads the
 * wall clock for itself is a rule that cannot be tested at a chosen instant, and
 * a product with two processes then has two answers to "what day is it". The
 * caller supplies the instant — `apps/api` from its `ClockPort`, `apps/web` from
 * the clock the component was handed — and the comparison is made on UTC calendar
 * days, so a person at UTC+7 is treated as one day younger rather than one day
 * older. For a control that protects minors, the strict side is the safe one.
 */
export function parseDateOfBirth(raw: unknown, today: Date): string | null {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) {
    return null;
  }
  if (!isCalendarDate(raw)) {
    return null;
  }
  const year = Number(raw.slice(0, 4));
  if (year < MIN_DATE_OF_BIRTH_YEAR) {
    return null;
  }
  const declared = Date.UTC(year, Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)));
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (declared > todayUtc) {
    return null;
  }
  return raw;
}

/**
 * The sentence somebody reads when the date they typed is refused, declared ONCE.
 *
 * It crosses the process boundary exactly as {@link RATE_LIMITED_MESSAGE} does:
 * `apps/api` puts it in the `validation_failed` envelope and `apps/web` shows it
 * beside the field without waiting for a round trip.
 *
 * It says what to do and nothing else. No format hint that is really a parser
 * error, no "you must be over N" — the threshold is not the visitor's business
 * and telling somebody which side of it they fell on is how a refused person
 * learns exactly which year to type instead.
 */
export const DATE_OF_BIRTH_INVALID_MESSAGE =
  'Ngày sinh chưa hợp lệ. Hãy chọn lại ngày sinh của bạn rồi thử lại.';

/**
 * The sentence somebody reads when the profile already carries a date of birth.
 *
 * It names no value — not the stored one, not the submitted one.
 *
 * It also no longer says "liên hệ hỗ trợ". There IS no support channel: no inbox,
 * no operator tool, no role that can write the column a second time — the flow that
 * sentence pointed at is recorded in `deferred-work.md` as belonging to nobody yet.
 * A message that sends somebody to a queue which does not exist is worse than one
 * that simply states the fact, because it costs them the effort of looking for it.
 * The sentence says what is true today and promises nothing else; when the support
 * flow exists, this is the one string that has to change.
 */
export const DATE_OF_BIRTH_ALREADY_SET_MESSAGE =
  'Hồ sơ đã có ngày sinh, và ngày sinh không tự đổi lại được.';

/**
 * The words a user-facing message about the declaration must never contain,
 * declared ONCE for both processes.
 *
 * It was duplicated: `packages/contracts/src/auth.test.ts` had nine words and
 * `apps/web`'s form test had seven — the web copy was missing `'dưới 18'` and
 * `'trưởng thành'`, so a screen could have said either of them and stayed green
 * while the contract suite claimed the whole vocabulary was covered. Two lists
 * about one rule are two lists that drift, which is the class of defect this story
 * is otherwise entirely about.
 *
 * The rule it serves: the threshold is not the visitor's business. Telling somebody
 * which side of it they fell on is free calibration for anybody who wants to be on
 * the other side. `'18'` and `'tuổi'` alone were both too narrow — "trên 18", "đủ
 * tuổi" and "vị thành niên" all passed — so the check is over vocabulary rather
 * than over two substrings.
 */
export const AGE_VOCABULARY = [
  '18',
  'tuổi',
  'đủ tuổi',
  'trên 18',
  'dưới 18',
  'vị thành niên',
  'người lớn',
  'trẻ em',
  'trưởng thành',
] as const;

/**
 * The sentence behind every `unauthenticated` envelope `/v1` produces, declared
 * ONCE.
 *
 * It lived as a private constant inside `AuthService`, which was fine while that
 * file was the only thing that could answer 401. Story 1.5 adds a GUARD that
 * answers 401 before any handler runs — and the two 401s have to be
 * indistinguishable, because a caller that can tell "no session" from "no session,
 * refused by the money gate" has been told something about a person the system has
 * not identified. One literal, no second copy to edit alone.
 *
 * It says what happened and what to do. It does not say which of the three
 * reasons applied — no cookie, an expired session, a profile that no longer
 * exists — because distinguishing them tells somebody probing which of the three
 * they achieved.
 */
export const UNAUTHENTICATED_MESSAGE = 'Phiên đăng nhập không hợp lệ. Hãy thử đăng nhập lại.';

/**
 * The sentence somebody reads when an inbound-money endpoint refuses them.
 *
 * ## What it must not contain, and why that is a rule rather than a preference
 *
 * Not their age, not their date of birth, not the threshold, not the word for
 * either side of it — {@link AGE_VOCABULARY} is the list, and
 * `packages/contracts/src/auth.test.ts` holds this sentence against it. The date
 * of birth is PII under the epic's own definition and the release gate is "no PII
 * leaves the API"; the THRESHOLD is a separate matter, and the reason is the same
 * one {@link DATE_OF_BIRTH_INVALID_MESSAGE} gives: telling somebody which side of
 * it they fell on is free calibration for anybody who would rather be on the other
 * side, and the only way back across this particular line is to lie about a value
 * that is written exactly once.
 *
 * So it states the refusal and the direction it applies to, and stops. "Nhận coin
 * từ người dùng khác" is the whole scope of the gate — coins the system grants and
 * coins this person SPENDS are untouched — and naming it keeps the refusal from
 * reading as "your account is suspended", which it is not.
 *
 * AD-13 puts it here rather than in `apps/api`: Story 3.3 hides the controls this
 * refusal belongs to, and it will need the same sentence.
 */
export const MONEY_IN_FORBIDDEN_MESSAGE =
  'Tài khoản của bạn chưa được phép nhận coin từ người dùng khác.';

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
 * - **`%`** — THIS function never decodes, so there is no decode step of ours
 *   and therefore no way for two readings of the same string to disagree inside
 *   it. `%2F%2F`, `%5C`, `%00` and `%0A` are all gone by one rule instead of
 *   four. The cost is real and deliberate: a path carrying an escaped character
 *   cannot be proposed and the person lands on the default instead. Losing a
 *   convenience is the right side of that trade.
 *
 *   What this rule does NOT mean, and what the docblock used to imply: that a
 *   hostile spelling arriving at `/v1/auth/:provider/start` is refused BY it.
 *   Fastify percent-decodes the query string before any handler runs, so a
 *   request carrying `?quay-ve=%2F%2Fevil.com` reaches this function as
 *   `//evil.com` and dies on the protocol-relative rule instead. What the `%`
 *   rule catches is everything left after that one decode — a double-encoded
 *   `%252F`, and any caller that hands this function a raw string with no
 *   transport in between, which is exactly what `apps/web` does when it judges
 *   the path it is standing on. `auth.flow.test.ts` sends both spellings over
 *   real HTTP so the two roads are covered separately rather than assumed equal.
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
