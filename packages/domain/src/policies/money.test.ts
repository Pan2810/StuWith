import { describe, expect, it } from 'vitest';
import { FixedClock } from '../ports/clock-port';
import { ADULT_AGE_YEARS, fixedAt, isAdult } from './date-of-birth';
import * as moneyPolicy from './money';
import { canReceiveMoney } from './money';

/**
 * The money gate, executed. AC1: "có `canReceiveMoney(user)` trả `false` với tài
 * khoản dưới 18, và nó không import gì từ hạ tầng và test được không cần DB".
 *
 * The second half of that criterion is enforced by where this file sits rather
 * than by anything written in it: the `domain` Vitest project runs `environment:
 * 'node'` with `setupFiles: []`, and `packages/domain/tsconfig.json` references
 * only `packages/contracts`, so an import of a driver, a client or a Node builtin
 * would not resolve. There is nothing to assert; there is only somewhere the file
 * can be.
 *
 * Every example fixes the instant. A test that read the wall clock would pass
 * today and fail on somebody's birthday months later, long after the change that
 * broke it.
 *
 * ## The instant this file calls "today", stated because it is not the only one
 *
 * **`2026-09-05`.** `money-gate.guard.test.ts` uses the same day; the flow test and
 * `logging.test.ts` run on `createAuthHarness`, whose clock is fixed a day EARLIER
 * at `2026-09-04`. So a boundary date means different things in different files —
 * `2008-09-05` is an adult here (eighteen exactly today) and is the too-young
 * example over there. Neither is wrong; reading one file's dates into another is.
 * Each file says which day it is standing on, in its header, for that reason.
 */
const at = (instant: string): FixedClock => new FixedClock(new Date(instant));

/** Midday on 2026-09-05, so nothing here can accidentally depend on the time of day. */
const TODAY = at('2026-09-05T12:00:00.000Z');

describe('canReceiveMoney — the Matrix rows that belong to the domain', () => {
  it('lets an adult receive money', () => {
    // Turned 18 in 2017 and then some.
    expect(canReceiveMoney({ dateOfBirth: '1999-04-02' }, TODAY)).toBe(true);
  });

  it('refuses somebody whose eighteenth birthday has not arrived', () => {
    // 2008-09-06 turns 18 on 2026-09-06, which is tomorrow.
    expect(canReceiveMoney({ dateOfBirth: '2008-09-06' }, TODAY)).toBe(false);
  });

  it('allows them on the DAY of the eighteenth birthday, not the day after', () => {
    // The boundary the whole rule turns on: `<=`, not `<`. Getting this wrong is
    // invisible for 364 days a year and wrong for exactly one person a day.
    expect(canReceiveMoney({ dateOfBirth: '2008-09-05' }, TODAY)).toBe(true);
  });

  it.each([
    ['NULL — nobody has declared anything yet', null],
    ['an absent value, which a mis-aliased SQL column produces', undefined],
    ['an empty string', ''],
    ['a day that does not exist', '2026-02-30'],
    ['an ISO instant rather than a day', '1999-04-02T00:00:00.000Z'],
  ])('fails CLOSED for %s', (_label, stored) => {
    /**
     * The `undefined` row needs a cast, and this is why it is not the shape
     * `config-cast-ban.test.ts` forbids.
     *
     * That rule is about `ApiEnv`: a cast there skips the whole of
     * `packages/config`'s validation, so the test claims to stand in for a
     * production configuration while running none of the rules that make one. Here
     * nothing is skipped — `canReceiveMoney` runs in full, and the cast exists
     * because the parameter type says `string | null` while the RUNTIME state
     * `undefined` is real: `readStoredDateOfBirth`'s docblock records how a
     * mis-aliased `to_char(...)` column produces exactly that with every type still
     * satisfied, and asking `!== null` there is the fail-OPEN reading.
     *
     * The alternative is widening `canReceiveMoney` — and `isAdult`, and
     * `readStoredDateOfBirth` — to accept `unknown`, which is a domain API change
     * this story does not own. `date-of-birth.test.ts` carries the identical cast
     * for the identical reason.
     *
     * "We do not know" is not "old enough". A gate protecting minors that reads
     * its own ignorance as permission is not a gate.
     */
    expect(canReceiveMoney({ dateOfBirth: stored as string | null }, TODAY)).toBe(false);
  });

  it('refuses a leap-day birthday until the 1st of March', () => {
    /**
     * `Date.UTC(2044, 1, 29)` in a non-leap year rolls forward to the 1st of March,
     * so somebody born on a leap day turns eighteen on 1 March rather than on 28
     * February. `date-of-birth.test.ts` pins that for `isAdult`; this pins that the
     * money gate inherits it rather than acquiring its own answer.
     *
     * The direction is the conservative one, which is the point: the gate never
     * makes anybody an adult a day early.
     */
    const leapling = { dateOfBirth: '2008-02-29' };
    expect(canReceiveMoney(leapling, at('2026-02-28T12:00:00.000Z'))).toBe(false);
    expect(canReceiveMoney(leapling, at('2026-03-01T12:00:00.000Z'))).toBe(true);
    // And 2026 really is a non-leap year, so the row above is the case it claims.
    expect(new Date(Date.UTC(2026, 1, 29)).getUTCDate()).toBe(1);
  });

  it.each([
    ['a year below the plausibility floor', '1899-12-31'],
    ['a day after today', '2026-09-06'],
  ])('fails CLOSED for the `unusable` state: %s', (_label, stored) => {
    // These two ARE calendar days, and both are old enough by naive arithmetic —
    // `1899-12-31` most of all. `readStoredDateOfBirth` calls them unusable, and
    // the gate has to answer about the outcome rather than about the digits.
    expect(canReceiveMoney({ dateOfBirth: stored }, TODAY)).toBe(false);
  });

  it('refuses everybody when the clock itself is broken', () => {
    // A process whose clock has gone wrong must not start handing out permission
    // to take money. `parseDateOfBirth` refuses an unusable `today`, so this lands
    // on `unusable` and concludes nothing.
    const broken = { now: () => new Date('not-a-date') };
    expect(canReceiveMoney({ dateOfBirth: '1980-01-01' }, broken)).toBe(false);
  });

  it('answers about UTC, which is the LATE direction for Vietnam', () => {
    // 23:00 UTC on the 5th is 06:00 on the 6th in UTC+7. Somebody who turns 18 on
    // the 6th local time is still refused here — the gate errs late, never early.
    expect(canReceiveMoney({ dateOfBirth: '2008-09-06' }, at('2026-09-05T23:00:00.000Z'))).toBe(
      false,
    );
  });
});

describe('it is a PROJECTION of isAdult, not a second rule', () => {
  /**
   * The property that keeps this file from becoming the thing it was written to
   * prevent: a second age rule on one column.
   *
   * Asserting equality across the whole interesting range is stronger than
   * asserting the two agree on a handful of examples, because the failure mode
   * being guarded against is somebody "optimising" `canReceiveMoney` into its own
   * arithmetic — which would agree on the obvious cases and diverge on the ones
   * `date-of-birth.ts` already paid for.
   */
  const stored: ReadonlyArray<string | null> = [
    null,
    '',
    'not-a-date',
    '1899-12-31',
    '1900-01-01',
    '1980-01-01',
    '2008-09-04',
    '2008-09-05',
    '2008-09-06',
    '2026-02-29',
    '2026-09-05',
    '2026-09-06',
    '2044-02-29',
  ];

  it.each(stored)('agrees with isAdult for %s', (dateOfBirth) => {
    expect(canReceiveMoney({ dateOfBirth }, TODAY)).toBe(isAdult({ dateOfBirth }, TODAY));
  });

  it('moves with the threshold rather than holding one of its own', () => {
    // `ADULT_AGE_YEARS` is a business constant, not an env knob. If this file ever
    // stops reading through `isAdult`, this is the example that notices: eighteen
    // years and one day before `TODAY` is an adult, eighteen years less a day is
    // not, and both answers come out of the SAME constant the age rule uses.
    expect(ADULT_AGE_YEARS).toBe(18);
    expect(canReceiveMoney({ dateOfBirth: '2008-09-05' }, TODAY)).toBe(true);
    expect(canReceiveMoney({ dateOfBirth: '2008-09-06' }, TODAY)).toBe(false);
  });

  it('exports the rule and NOTHING that decides an outbound question', () => {
    /**
     * The file's docblock says nothing here may grow a second export that decides
     * an outbound question — that spending coins, and coins the SYSTEM grants, are
     * untouched by the age rule. That is checkable, so it is checked.
     *
     * A `canSpendMoney` keyed on age added here would silently make this
     * repository's most careful rule mean the opposite of what it says, and it
     * would look exactly like the function above it in review.
     */
    expect(Object.keys(moneyPolicy).sort()).toEqual(['canReceiveMoney']);
  });

  it('answers about ONE instant when handed a fixed clock', () => {
    // How `apps/api` calls it: the request reads the clock once and wraps it, so a
    // request straddling midnight cannot answer two questions about two days.
    const instant = new Date('2026-09-05T23:59:59.999Z');
    const clock = fixedAt(instant);
    expect(canReceiveMoney({ dateOfBirth: '2008-09-05' }, clock)).toBe(true);
    expect(canReceiveMoney({ dateOfBirth: '2008-09-06' }, clock)).toBe(false);
  });
});
