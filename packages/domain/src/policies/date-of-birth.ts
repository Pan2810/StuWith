import { parseDateOfBirth } from '@stuwith/contracts';
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
 * profile is complete exactly when it has a date of birth, and
 * {@link isProfileComplete} is that sentence written once.
 *
 * ## Everything here fails CLOSED
 *
 * An absent date of birth, an unparseable one, a broken clock: every one of them
 * answers "not an adult". The alternative — treating "we do not know" as "old
 * enough" — is a control that protects minors reading its own ignorance as
 * permission.
 */

/**
 * The threshold, as a business constant rather than a knob.
 *
 * Deliberately NOT an environment variable. Eighteen is the age the product's
 * legal posture is built on, not something an operator tunes per deployment, and
 * a `MIN_ADULT_AGE` in `.env` would drag `packages/config` into the one package
 * that is allowed to depend on nothing (AD-1). It is a parameter of the function
 * below only so a test can prove the arithmetic on a second value.
 */
export const ADULT_AGE_YEARS = 18;

/** A profile is complete exactly when it carries a date of birth. Nothing else. */
export function isProfileComplete(user: { readonly dateOfBirth: string | null }): boolean {
  return user.dateOfBirth !== null;
}

/**
 * Whether somebody born on `dateOfBirth` has had their `years`-th birthday, as of
 * the clock's current UTC calendar day.
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
 *
 * ## Why it re-parses
 *
 * `parseDateOfBirth` is the one rule (AD-13), and a stored value that no longer
 * satisfies it — a hand-edited row, a column that changed type — must not be
 * silently reinterpreted here by a second, looser reading. It answers `false`
 * instead, which is the fail-closed direction.
 */
export function isAtLeastYearsOld(
  dateOfBirth: string | null,
  clock: ClockPort,
  years: number = ADULT_AGE_YEARS,
): boolean {
  if (dateOfBirth === null) {
    return false;
  }
  const now = clock.now();
  const declared = parseDateOfBirth(dateOfBirth, now);
  if (declared === null) {
    return false;
  }

  const birthYear = Number(declared.slice(0, 4));
  const birthMonth = Number(declared.slice(5, 7));
  const birthDay = Number(declared.slice(8, 10));

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
