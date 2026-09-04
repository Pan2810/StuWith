import { describe, expect, it } from 'vitest';
import { FixedClock } from '../ports/clock-port';
import { ADULT_AGE_YEARS, isAdult, isAtLeastYearsOld, isProfileComplete } from './date-of-birth';

/**
 * The age rule, executed. No database, no clock of its own — the whole point of
 * AD-1 is that this file runs in milliseconds under plain Node, and the `domain`
 * Vitest project has no setup file that could reach a DB or the network even if
 * somebody wanted one to.
 *
 * Every example fixes the instant explicitly. A test that read the wall clock
 * would pass today and fail on somebody's birthday months later, long after the
 * change that broke it.
 */
const at = (instant: string): FixedClock => new FixedClock(new Date(instant));

/** Midday, so nothing here can accidentally depend on the time of day. */
const TODAY = at('2026-09-04T12:00:00.000Z');

describe('isProfileComplete — NULL is the only "not declared yet"', () => {
  it('says a profile with no date of birth is incomplete', () => {
    expect(isProfileComplete({ dateOfBirth: null })).toBe(false);
  });

  it('says a profile with one is complete, whatever the age', () => {
    // Completeness is not adulthood. A fourteen-year-old has finished the step.
    expect(isProfileComplete({ dateOfBirth: '2012-01-01' })).toBe(true);
    expect(isProfileComplete({ dateOfBirth: '1999-04-02' })).toBe(true);
  });

  /**
   * The fail-OPEN hole this function used to have, pinned from the direction it
   * actually arrives from.
   *
   * `!== null` reads `undefined` as "declared", and `undefined` is what a `users`
   * row carries the moment `selectUserColumns` loses its `AS date_of_birth` alias
   * — a one-word edit in `packages/db` that no type can see, because the row
   * object comes from a driver rather than from `tsc`. Reading that as complete
   * sends somebody past the only screen that could fix it, permanently, since the
   * endpoint refuses a second write.
   *
   * The cast is the point of the test: this value is not supposed to be
   * expressible, and the defect was that it happened anyway.
   */
  it.each([
    ['an absent value', undefined],
    ['an empty string', ''],
    ['a day that does not exist', '2026-02-30'],
    ['an ISO instant', '1999-04-02T00:00:00.000Z'],
    ['an unpadded date', '1999-4-2'],
    ['a number', 19_990_402],
    ['a Date object', new Date('1999-04-02T00:00:00.000Z')],
  ])('reads %s as NOT declared, which is the fail-closed direction', (_label, stored) => {
    expect(isProfileComplete({ dateOfBirth: stored as string | null })).toBe(false);
  });
});

describe('isAdult — the birthday boundary', () => {
  /**
   * The two rows of the story matrix that decide whether the whole rule is right.
   * Everything else about this function is arithmetic around them.
   */
  it('is true on the eighteenth birthday itself', () => {
    expect(isAdult({ dateOfBirth: '2008-09-04' }, TODAY)).toBe(true);
  });

  it('is false the day before the eighteenth birthday', () => {
    expect(isAdult({ dateOfBirth: '2008-09-05' }, TODAY)).toBe(false);
  });

  it('is true for somebody comfortably older', () => {
    expect(isAdult({ dateOfBirth: '1987-12-31' }, TODAY)).toBe(true);
  });

  it('is false for somebody comfortably younger', () => {
    expect(isAdult({ dateOfBirth: '2015-06-01' }, TODAY)).toBe(false);
  });

  it('holds at both ends of the same UTC day, so the boundary is the day', () => {
    // If the comparison were on instants rather than calendar days, one of these
    // two would disagree with the other.
    expect(isAdult({ dateOfBirth: '2008-09-04' }, at('2026-09-04T00:00:00.000Z'))).toBe(true);
    expect(isAdult({ dateOfBirth: '2008-09-04' }, at('2026-09-04T23:59:59.999Z'))).toBe(true);
    expect(isAdult({ dateOfBirth: '2008-09-05' }, at('2026-09-04T00:00:00.000Z'))).toBe(false);
    expect(isAdult({ dateOfBirth: '2008-09-05' }, at('2026-09-04T23:59:59.999Z'))).toBe(false);
  });
});

describe('isAdult — leap years, counted as days rather than as durations', () => {
  /**
   * The family a "milliseconds divided by 365.25 days" implementation gets wrong.
   * Across eighteen years the drift is several days, which is enough to move the
   * boundary — silently, and only for people born near the end of February.
   */
  it('counts the leap days in between correctly', () => {
    // 2008-03-01 + 18 years is 2026-03-01, whatever the leap days did in between.
    expect(isAdult({ dateOfBirth: '2008-03-01' }, at('2026-02-28T12:00:00.000Z'))).toBe(false);
    expect(isAdult({ dateOfBirth: '2008-03-01' }, at('2026-03-01T00:00:00.000Z'))).toBe(true);
  });

  it('makes a leap-day birthday an adult on the 1st of March, never on the 28th', () => {
    // 2026 is not a leap year, so there is no 29th of February to turn 18 on. The
    // rule rolls FORWARD, which is the conservative direction: this function never
    // makes anybody an adult a day early.
    expect(isAdult({ dateOfBirth: '2008-02-29' }, at('2026-02-28T23:59:59.999Z'))).toBe(false);
    expect(isAdult({ dateOfBirth: '2008-02-29' }, at('2026-03-01T00:00:00.000Z'))).toBe(true);
  });

  it('rolls a leap-day birthday forward at the adult threshold, because 18 can never land on one', () => {
    // Arithmetic, not an example: a leap year plus 18 is 2 away from a multiple of
    // 4, so the eighteenth birthday of somebody born on the 29th of February is
    // NEVER in a leap year. There is no version of this product where the "real
    // 29th" case exists at the adult threshold — the test that claimed to cover it
    // was covering the rolled case twice, once through a date that is not a day.
    expect((2004 + ADULT_AGE_YEARS) % 4).toBe(2);
    expect(isAdult({ dateOfBirth: '2004-02-29' }, at('2022-02-28T23:59:59.999Z'))).toBe(false);
    expect(isAdult({ dateOfBirth: '2004-02-29' }, at('2022-03-01T00:00:00.000Z'))).toBe(true);
  });

  it('uses the real 29th when the threshold is a multiple of four, so nothing rolls', () => {
    // The case the name above promises, built where it can actually exist: 2004 +
    // 20 = 2024, which IS a leap year, so the birthday is the 29th itself and the
    // boundary must be that day rather than the 1st of March.
    expect(isAtLeastYearsOld('2004-02-29', at('2024-02-28T23:59:59.999Z'), 20)).toBe(false);
    expect(isAtLeastYearsOld('2004-02-29', at('2024-02-29T00:00:00.000Z'), 20)).toBe(true);
    // And it did not simply become true a day early somewhere: the 28th is the
    // last day of not-yet, in a year that has a 29th to be exact about.
    expect(isAtLeastYearsOld('2004-02-29', at('2024-03-01T00:00:00.000Z'), 20)).toBe(true);
  });
});

describe('isAdult — UTC is the one calendar, and it errs late', () => {
  /**
   * The decision written down in the spec: a person at UTC+7 whose local date is
   * already their birthday is still not eighteen until the UTC day turns. Seven
   * hours late, never early. This is what "two places must not each pick a zone"
   * looks like as a test.
   */
  it('is still false at 06:00 UTC+7 local time on the birthday, which is 23:00 UTC the day before', () => {
    expect(isAdult({ dateOfBirth: '2008-09-05' }, at('2026-09-04T23:00:00.000Z'))).toBe(false);
  });

  it('turns true when the UTC day turns, not when the local one did', () => {
    expect(isAdult({ dateOfBirth: '2008-09-05' }, at('2026-09-05T00:00:00.000Z'))).toBe(true);
  });
});

describe('isAdult — everything unknown fails closed', () => {
  it('refuses a profile with no date of birth', () => {
    expect(isAdult({ dateOfBirth: null }, TODAY)).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['a day that does not exist', '2000-02-30'],
    ['an ISO instant that slipped past a looser writer', '2000-01-01T00:00:00Z'],
    ['an unpadded date', '2000-1-1'],
    ['a date in the future', '2027-01-01'],
    ['a year before the plausibility floor', '1899-12-31'],
  ])('refuses %s rather than reinterpreting it', (_label, stored) => {
    expect(isAdult({ dateOfBirth: stored }, TODAY)).toBe(false);
  });

  it('refuses when the clock itself is broken', () => {
    // A process whose clock has gone wrong must not start letting minors through.
    const broken = { now: () => new Date('not-a-date') };
    expect(isAdult({ dateOfBirth: '1980-01-01' }, broken)).toBe(false);
  });
});

describe('the threshold is a named constant, and the arithmetic is not special to it', () => {
  it('is eighteen', () => {
    expect(ADULT_AGE_YEARS).toBe(18);
  });

  it('works for another number, so the boundary is arithmetic and not a hard-coded year', () => {
    expect(isAtLeastYearsOld('2013-09-04', TODAY, 13)).toBe(true);
    expect(isAtLeastYearsOld('2013-09-05', TODAY, 13)).toBe(false);
  });

  it('defaults to the adult threshold when no number is given', () => {
    expect(isAtLeastYearsOld('2008-09-04', TODAY)).toBe(
      isAtLeastYearsOld('2008-09-04', TODAY, ADULT_AGE_YEARS),
    );
  });
});

describe('nothing here reads the wall clock', () => {
  /**
   * The property AD-1 is really about. Two different `FixedClock`s over the same
   * date of birth have to give two different answers, and if this ever stops being
   * true it means somebody reached for `new Date()` inside the policy — at which
   * point the rule is no longer testable at a chosen instant and the two processes
   * can disagree about what day it is.
   */
  it('gives two answers for one date of birth at two instants', () => {
    const dateOfBirth = '2008-09-05';
    expect(isAdult({ dateOfBirth }, at('2026-09-04T12:00:00.000Z'))).toBe(false);
    expect(isAdult({ dateOfBirth }, at('2026-09-05T12:00:00.000Z'))).toBe(true);
  });
});
