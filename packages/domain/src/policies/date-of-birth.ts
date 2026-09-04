import { isCalendarDate, parseDateOfBirth } from '@stuwith/contracts';
import type { ClockPort } from '../ports/clock-port';

/**
 * The age rule, as pure functions. No database, no HTTP, no `new Date()`.
 *
 * This is the file Story 1.5's money gate stands on, which is why it is here and
 * not in `apps/api`: a threshold written in a NestJS guard is a threshold the
 * realtime process cannot read and no test can execute without a request. The
 * spine says the same thing about `canReceiveMoney`, and that function will call
 * {@link isAdult} rather than re-deriving anything.
 *
 * ## `NULL` is "not declared yet", and it is the only state that says so
 *
 * There is no `profile_completed` column and there must not be one. Two columns
 * describing one fact are two columns that can disagree, and no database
 * constraint keeps them in step; one source of truth has no skew to repair. So a
 * profile is complete exactly when it has a USABLE date of birth, and
 * {@link readStoredDateOfBirth} is that sentence written once.
 *
 * ## ONE reading of the stored value, for every question asked about it
 *
 * This file used to answer two questions with two different rules on one column:
 * `isProfileComplete` asked `isCalendarDate`, and `isAtLeastYearsOld` asked
 * `parseDateOfBirth` — which also enforces the year floor and "not in the future".
 * Forty-seven lines apart, in the file whose whole subject is that a value must not
 * have two readings.
 *
 * What that produced was a state nothing could name and nothing could escape. A row
 * holding `1899-12-31` — hand-edited, migrated in from somewhere else, or written
 * while a server clock was wrong — answered `profile_completed: true` AND
 * `is_over_18: false`, for ever: the endpoint refuses a second write, so no screen
 * could offer the form again, and no log, metric or inventory said the row existed.
 *
 * Now there is one rule, {@link readStoredDateOfBirth}, and it has three outcomes
 * rather than two. The third one, `unusable`, is the state that had no name. Both
 * published flags are derived from the same call, so they cannot disagree, and
 * `apps/api` has something to report when it meets one.
 *
 * ## Everything here fails CLOSED
 *
 * An absent date of birth, an unusable one, a broken clock: every one of them
 * answers "not an adult" AND "not complete". The alternative — treating "we do not
 * know" as "old enough", or as "the step is done" — is a control that protects
 * minors reading its own ignorance as permission.
 */

/**
 * The threshold, as a business constant rather than a knob.
 *
 * Deliberately NOT an environment variable. Eighteen is the age the product's
 * legal posture is built on, not something an operator tunes per deployment, and
 * a `MIN_ADULT_AGE` in `.env` would drag `packages/config` into a package whose
 * only dependency is `packages/contracts` (AD-1). It is a parameter of the
 * function below only so a test can prove the arithmetic on a second value.
 *
 * On the dependency: this file is where `packages/domain` first began importing
 * `packages/contracts` at RUNTIME rather than with `import type`. That is allowed
 * and always was — `packages/domain/tsconfig.json` references `packages/contracts`
 * and nothing else, which is precisely the shape AD-1 permits — but it is worth
 * stating, because an earlier version of this docblock said the domain "depends on
 * nothing", and after {@link readStoredDateOfBirth} started calling
 * `parseDateOfBirth` that sentence was simply false. The rule it depends on is the
 * one shared with `apps/web` and `apps/api`, which is the entire point: three
 * readers, one parser.
 */
export const ADULT_AGE_YEARS = 18;

/**
 * What a value stored in `users.date_of_birth` IS, under one rule.
 *
 * Three outcomes, because the column has three states and only two of them used to
 * have a name:
 *
 * - `not-declared` — the first-login declaration has not happened. `NULL`, and also
 *   every shape the product never writes (`undefined`, `''`, a hand-edited word),
 *   because "this is not a date at all" and "nobody has answered yet" are the same
 *   answer to every question the product asks.
 * - `declared` — a calendar day this product would accept today. The `value` is
 *   carried so callers do not re-derive it.
 * - `unusable` — it names a real calendar day, but not one this product accepts: a
 *   year below the contract's plausibility floor, or a day after `now`. Nothing can
 *   be concluded from it, and the profile is NOT complete.
 */
export type StoredDateOfBirth =
  | { readonly kind: 'not-declared' }
  | { readonly kind: 'declared'; readonly value: string }
  | { readonly kind: 'unusable' };

/**
 * The ONE reading of a stored date of birth. Every other function here is a
 * projection of this one.
 *
 * ## Why `undefined` has to be handled and is not hypothetical
 *
 * `selectUserColumns` in `packages/db` reads the column as
 * `to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth`; drop that alias and
 * Postgres names the output column `to_char`, so `row.date_of_birth` — and
 * therefore `user.dateOfBirth` — is `undefined` with every type still satisfied,
 * because the row object is shaped by a runtime driver rather than by `tsc`. Asking
 * `!== null` there is fail-OPEN, and the answer it gives is the one that sends
 * somebody past the declaration screen for ever.
 *
 * ## Why it asks `parseDateOfBirth` and not something looser
 *
 * `parseDateOfBirth` is the one rule (AD-13) — the same call `apps/api` makes
 * before it writes and `apps/web` makes before it offers to send. A second, looser
 * reading on the way back OUT is exactly how a value the product would refuse to
 * accept gets silently treated as if it had been accepted.
 *
 * ## One request, one instant
 *
 * The port is how the spec says the age rule receives time, and it stays a port.
 * What must not happen is a caller reading a LIVE clock once per question: a
 * request that asks "is the profile complete" and then "is this person 18" from two
 * `new Date()`s straddles a midnight and answers about two different days. Callers
 * that already hold the request's instant wrap it with {@link fixedAt}, which
 * answers every call with the same millisecond.
 */
export function readStoredDateOfBirth(
  user: { readonly dateOfBirth: string | null },
  clock: ClockPort,
): StoredDateOfBirth {
  if (!isCalendarDate(user.dateOfBirth)) {
    return { kind: 'not-declared' };
  }
  const usable = parseDateOfBirth(user.dateOfBirth, clock.now());
  return usable === null ? { kind: 'unusable' } : { kind: 'declared', value: usable };
}

/**
 * A profile is complete exactly when it carries a date of birth this product would
 * accept. Nothing else.
 *
 * `unusable` answers `false` — the honest reading, and the one that does not claim
 * a step is finished when the value it produced cannot be used for anything. The
 * cost is named rather than hidden: the column is spent, so nobody in that state
 * can complete the step by themselves, and the screen has to say so instead of
 * showing a form whose submit is refused. `deferred-work.md` owns the support flow
 * that would repair it.
 */
export function isProfileComplete(
  user: { readonly dateOfBirth: string | null },
  clock: ClockPort,
): boolean {
  return readStoredDateOfBirth(user, clock).kind === 'declared';
}

/**
 * Whether somebody born on `dateOfBirth` has had their `years`-th birthday, as of
 * `now`'s UTC calendar day.
 *
 * ## Why the comparison is on calendar days and not on elapsed milliseconds
 *
 * "Old enough" is a statement about dates on a calendar, not about a duration.
 * Subtracting two instants and dividing by a year's worth of milliseconds gets
 * leap years wrong in both directions and puts the boundary at an arbitrary
 * moment of the day. What this does instead is name the day the person turns
 * `years` old and ask whether that day has arrived.
 *
 * ## Why UTC
 *
 * Because two places choosing their own zone is the "two readings of one value"
 * class of bug this repository has already paid four review rounds for. UTC is
 * also the SAFE direction here: it is behind UTC+7, so somebody in Vietnam is
 * treated as not-yet-eighteen for another seven hours rather than as eighteen
 * seven hours early. A gate protecting minors should err late.
 *
 * ## The 29th of February
 *
 * `Date.UTC(2044, 1, 29)` in a non-leap year rolls forward to the 1st of March,
 * so somebody born on a leap day turns 18 on the 1st of March rather than on the
 * 28th of February. That is the same conservative direction as the UTC choice,
 * and it is a consequence worth naming rather than an accident: this function
 * never makes anybody an adult a day early.
 */
export function isAtLeastYearsOld(
  dateOfBirth: string | null,
  clock: ClockPort,
  years: number = ADULT_AGE_YEARS,
): boolean {
  // The SAME reader every other question goes through, so "old enough" and
  // "declared" can never be answered from two different rules again.
  const stored = readStoredDateOfBirth({ dateOfBirth }, clock);
  if (stored.kind !== 'declared') {
    return false;
  }
  const now = clock.now();

  const birthYear = Number(stored.value.slice(0, 4));
  const birthMonth = Number(stored.value.slice(5, 7));
  const birthDay = Number(stored.value.slice(8, 10));

  const nthBirthday = Date.UTC(birthYear + years, birthMonth - 1, birthDay);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // `<=`, not `<`: the day somebody turns eighteen, they are eighteen.
  return nthBirthday <= today;
}

/**
 * The whole of what the rest of the product asks about somebody's age.
 *
 * It takes the user rather than the string so that no caller outside
 * `packages/db` and `apps/api` ever needs to hold a date of birth in a variable —
 * the value that is never passed around is the value that never ends up in a log
 * line or a response body.
 */
export function isAdult(user: { readonly dateOfBirth: string | null }, clock: ClockPort): boolean {
  return isAtLeastYearsOld(user.dateOfBirth, clock);
}

/**
 * A `ClockPort` that answers with ONE instant, however many times it is asked.
 *
 * The rules above take a port because the spec says the age rule receives time
 * through `ClockPort` — but a caller that holds a single instant for a whole
 * request must not be forced to hand over a live clock to get an answer, which is
 * how `toCurrentUser` came to read the wall clock a third time inside a request
 * that had already decided what "now" was.
 *
 * So the boundary is here, named, and the property it carries is in its type: every
 * call returns the same millisecond. `AuthService` reads its port once per request
 * and passes the result through this.
 */
export function fixedAt(instant: Date): ClockPort {
  return { now: () => new Date(instant.getTime()) };
}
