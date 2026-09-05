import {
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_ME_PATH,
  DATE_OF_BIRTH_FIELD,
  currentUserSchema,
} from '@stuwith/contracts';
import { InMemoryRateLimitAdapter } from '@stuwith/db';
import { FixedClock, fixedAt, isAdult, type ClockPort } from '@stuwith/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, createAuthHarness, type AuthHarness } from './__testing__/auth-harness';

/**
 * "Một request, một lần đọc phiên và một instant thời gian" — the spec's frozen
 * boundary — executed on the two endpoints Story 1.5's refactor actually changed.
 *
 * ## Why this file exists, and why the property was UNTESTABLE before it
 *
 * `SessionAuthenticator` was extracted so that authenticating a caller and asking
 * anything else about them answer about the same millisecond. `MoneyGateGuard`'s
 * version of that property is pinned in `money-gate.guard.test.ts`, which builds
 * its own clock. The two `AuthService` sites were not: reverting both of them to a
 * fresh `const now = this.clock.now()` left every api example green.
 *
 * The reason is not that the property does not matter — it is that
 * `createAuthHarness` built its own `FixedClock` and exposed no seam to replace
 * it. Against a clock that never moves, code that reads it once and code that
 * reads it three times are indistinguishable. So the seam came first
 * (`HarnessOptions.clock`), and this is what it is for.
 *
 * ## How a moving clock is made to discriminate
 *
 * {@link SteppingClock} is fixed while the login happens — a login legitimately
 * reads the clock several times — and then, on `start()`, begins returning
 * `BASE + n days` on its nth read. Each endpoint below is then given an input that
 * lands EXACTLY on the boundary between the first read and the second, so one
 * reading and two readings produce different, observable answers rather than
 * differing by something no assertion could see.
 *
 * The rate limiter is given its own fixed clock. The default in-memory limiter is
 * built on the harness clock, and its reads would otherwise be interleaved with
 * the ones under test — a count that changes whenever a rate-limit rule is added.
 */

/** Midnight, so "the next read is tomorrow" is a clean calendar step. */
const BASE = new Date('2026-09-05T00:00:00.000Z');
const DAY_MS = 86_400_000;

/**
 * A clock that lies still until it is told to move, then moves a day per read.
 *
 * A day, not a millisecond, because the questions being asked are about CALENDAR
 * days: `parseDateOfBirth` refuses a day after `now`, and `isAdult` compares UTC
 * days. A step smaller than a day would be a clock that moves and changes no
 * answer, which is the same blindness this file exists to remove.
 */
class SteppingClock implements ClockPort {
  private stepping = false;
  /** Every instant handed out since `start()`. */
  readonly reads: Date[] = [];

  now(): Date {
    if (!this.stepping) {
      return new Date(BASE.getTime());
    }
    const at = new Date(BASE.getTime() + this.reads.length * DAY_MS);
    this.reads.push(at);
    return at;
  }

  /** Begin stepping, and start counting from zero. */
  start(): void {
    this.reads.length = 0;
    this.stepping = true;
  }

  stop(): void {
    this.stepping = false;
  }
}

let harness: AuthHarness;
let clock: SteppingClock;

beforeAll(async () => {
  clock = new SteppingClock();
  harness = await createAuthHarness({
    clock,
    // Its own clock, so the limiter's reads are not counted as the endpoint's.
    rateLimitPort: new InMemoryRateLimitAdapter(new FixedClock(BASE)),
    // The clock steps a DAY per read, so an hour-long session would expire between
    // two requests and every example below would be a 401 about nothing.
    sessionTtlSeconds: 30 * 86_400,
    refreshTtlSeconds: 60 * 86_400,
  });
});

afterAll(async () => {
  await harness.close();
});

async function signIn(subject: string): Promise<CookieJar> {
  clock.stop();
  const { jar, callback } = await harness.login('google', {
    subject,
    email: `${subject}@example.test`,
    name: 'Một người dùng',
  });
  expect(callback.status).toBe(302);
  return jar;
}

describe('POST /v1/auth/date-of-birth answers about ONE instant', () => {
  it('judges the submitted day against the instant the SESSION was resolved at', async () => {
    const jar = await signIn('one-instant-declaration');

    /**
     * Tomorrow, relative to the FIRST read of the clock in this request.
     *
     * With one reading, `now` is `BASE` and this day is in the future, so
     * `parseDateOfBirth` refuses it — 400, nothing written. With two readings the
     * second is `BASE + 1 day`, the same string is "today", and the declaration is
     * ACCEPTED and stamped. That is not a cosmetic difference: the column is
     * written once and no endpoint can repair it, so a request that straddles a
     * midnight would permanently store a date the product would have refused a
     * millisecond earlier.
     */
    const tomorrow = new Date(BASE.getTime() + DAY_MS).toISOString().slice(0, 10);

    clock.start();
    const response = await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [DATE_OF_BIRTH_FIELD]: tomorrow }),
    });

    expect(response.status).toBe(400);
    // And the clock really did move under it, so the 400 above is the endpoint
    // holding one instant rather than the clock failing to advance.
    expect(clock.reads.length).toBeGreaterThan(0);
    expect(clock.reads[0]?.getTime()).toBe(BASE.getTime());
  });

  it('reads the clock exactly once for the whole request', async () => {
    // The direct form of the same property. It is brittle on purpose: a second
    // read added later is a second instant, and this is the example that says so
    // before the behavioural one above happens to still pass by luck.
    const jar = await signIn('one-instant-read-count');

    clock.start();
    await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [DATE_OF_BIRTH_FIELD]: '1999-04-02' }),
    });

    expect(clock.reads.length).toBe(1);
  });
});

describe('GET /v1/auth/me answers about ONE instant', () => {
  it('computes the age flags from the instant the session was resolved at', async () => {
    const jar = await signIn('one-instant-me');

    /**
     * A date of birth whose eighteenth birthday is TOMORROW.
     *
     * With one reading the answer is `is_over_18: false`. With two, the second
     * reading is a day later, the eighteenth birthday has arrived, and `/me`
     * reports `true` — an endpoint telling a seventeen-year-old they are eighteen
     * because two lines of one request disagreed about what day it was. The money
     * gate reads the same rule, so this is the shape of the failure that matters.
     */
    const eighteenTomorrow = new Date(BASE.getTime() + DAY_MS);
    eighteenTomorrow.setUTCFullYear(eighteenTomorrow.getUTCFullYear() - 18);
    const dateOfBirth = eighteenTomorrow.toISOString().slice(0, 10);

    clock.stop();
    const declared = await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [DATE_OF_BIRTH_FIELD]: dateOfBirth }),
    });
    expect(declared.status).toBe(200);

    clock.start();
    const me = currentUserSchema.parse(await (await harness.request(AUTH_ME_PATH, { jar })).json());

    expect(me.profile_completed).toBe(true);
    expect(me.is_over_18).toBe(false);
    expect(clock.reads.length).toBe(1);

    /**
     * And the boundary is REAL, not a safely-chosen date that would have answered
     * `false` either way.
     *
     * The clock's very next read is the day this person turns eighteen, judged by
     * the same domain rule `/me` used. So a second reading inside that one request
     * would have answered `true`, and this example would have caught it.
     */
    expect(isAdult({ dateOfBirth }, fixedAt(clock.now()))).toBe(true);
  });

  it('takes one read per request, not one per question asked inside it', async () => {
    // A plain adult date, so the day the clock steps changes no answer and the
    // only thing this example is measuring is the COUNT.
    const jar = await signIn('one-instant-me-twice');
    clock.stop();
    await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [DATE_OF_BIRTH_FIELD]: '1999-04-02' }),
    });

    clock.start();
    for (const _ of [0, 1, 2]) {
      const me = currentUserSchema.parse(
        await (await harness.request(AUTH_ME_PATH, { jar })).json(),
      );
      expect(me.is_over_18).toBe(true);
    }

    // Three requests, three reads. Not six, and not nine.
    expect(clock.reads.length).toBe(3);
  });
});
