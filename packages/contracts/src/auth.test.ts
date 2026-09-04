import { describe, expect, it } from 'vitest';
import {
  AGE_VOCABULARY,
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_ME_PATH,
  AUTH_REFRESH_PATH,
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  DATE_OF_BIRTH_PATHNAME,
  MAX_SIGN_IN_RETURN_PATH_LENGTH,
  MIN_DATE_OF_BIRTH_YEAR,
  MONEY_IN_FORBIDDEN_MESSAGE,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_PATHNAME,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  SIGN_IN_RETURN_PATH_QUERY_PARAM,
  UNAUTHENTICATED_MESSAGE,
  currentUserSchema,
  isCalendarDate,
  isOver18,
  isProfileCompleted,
  parseCurrentUser,
  parseDateOfBirth,
  parseInternalReturnPath,
} from './auth';

/**
 * The return-path validator, tested by CLASS rather than by example.
 *
 * This repository has a scar about exactly that. The trusted-proxy list went
 * through four review rounds and every one of them patched the specific token it
 * had been shown while the family behind it stayed open — nine probe addresses
 * that turned out to be a sample, a one-bit floor that let two `/1`s cover the
 * whole internet. `AGENTS.md` records it at length. A validator standing in front
 * of an open redirect in the login flow is the same kind of control, so the tests
 * below are organised around the WAYS a string can stop being an internal path,
 * and each way is swept over several spellings including ones no report has named.
 */

describe('parseInternalReturnPath — what an internal path is', () => {
  it.each([
    ['the root', '/'],
    ['a single segment', '/dang-nhap'],
    ['a nested path', '/phong-hoc/abc-123'],
    ['a path with a query', '/phong-hoc/abc?tab=chat'],
    ['a query with several parameters', '/a?x=1&y=2'],
    ['unreserved punctuation', '/a-b_c.d~e/f'],
    ['a dot inside a segment rather than as one', '/report.v2/latest'],
    ['a doubled slash that is not at the start', '/a//b'],
    ['a `..` inside the QUERY, where it cannot normalise anything', '/a?next=../b'],
    ['a `//` inside the QUERY, where it cannot change the origin', '/a?next=//evil.com'],
  ])('accepts %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBe(raw);
  });

  it('returns the string unchanged, never a rewritten one', () => {
    // A validator that normalises is a validator with two answers: the one it
    // checked and the one it returned. Returning the input verbatim means the
    // thing that was judged is the thing that gets signed.
    const raw = '/phong-hoc/abc?tab=chat&x=1';
    expect(parseInternalReturnPath(raw)).toBe(raw);
  });
});

describe('parseInternalReturnPath — the class of things carrying an origin', () => {
  it.each([
    ['an absolute https URL', 'https://evil.com/x'],
    ['an absolute http URL', 'http://evil.com/x'],
    ['a scheme with no slashes', 'https:evil.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>x</script>'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with a path', '//evil.com/x'],
    ['three slashes', '///evil.com'],
    ['backslash after the slash', '/\\evil.com'],
    ['two backslashes', '\\\\evil.com'],
    ['a backslash anywhere at all', '/a\\b'],
    ['userinfo punctuation', '/@evil.com'],
    ['a colon anywhere at all', '/a:b'],
    ['an absolute URL hidden behind a leading slash and a colon', '/https://evil.com'],
    ['no leading slash at all', 'dang-nhap'],
    ['a relative path', './dang-nhap'],
    ['a parent-relative path', '../dang-nhap'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of encoded spellings', () => {
  /**
   * There is no decoding step in the validator, on purpose, so this whole family
   * is refused by ONE rule (`%` is not an allowed character) rather than by a
   * decoder that has to agree with whatever decodes the value later. Two readings
   * of one string that can disagree is the round-three failure of the proxy list,
   * and it is not repeated here.
   */
  it.each([
    ['encoded protocol-relative', '/%2F%2Fevil.com'],
    ['lowercase encoded protocol-relative', '/%2f%2fevil.com'],
    ['encoded backslash', '/%5Cevil.com'],
    ['double-encoded slash', '/%252F%252Fevil.com'],
    ['encoded parent segment', '/%2E%2E/x'],
    ['an encoded newline, which would split a Location header', '/a%0D%0ASet-Cookie:%20x=y'],
    ['an encoded NUL', '/a%00b'],
    ['an ordinary, harmless escape — refused too, and that is the trade', '/tim-kiem?q=%C3%A1'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of normalisation surprises', () => {
  it.each([
    ['a bare parent segment', '/../x'],
    ['a parent segment in the middle', '/a/../../etc'],
    ['a trailing parent segment', '/a/..'],
    ['a bare current segment', '/./x'],
    ['a current segment in the middle', '/a/./b'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of bytes that are not path characters', () => {
  it.each([
    ['a carriage return and newline', '/a\r\nSet-Cookie: x=y'],
    ['a bare newline', '/a\nb'],
    ['a tab', '/a\tb'],
    // Written as an ESCAPE and never as a literal byte: a raw NUL makes git
    // classify the whole file as binary, which is how the central fixture of
    // the login stories once became a file nobody could review or grep.
    ['a NUL', '/a\u0000b'],
    ['a space', '/a b'],
    ['a leading space, so trimming is not silently assumed', ' /a'],
    ['a trailing space', '/a '],
    ['angle brackets', '/a<script>'],
    ['a quote', "/a'b"],
    ['a fragment, which the server never sees anyway', '/a#b'],
    ['a percent on its own', '/a%b'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of things that are not strings', () => {
  it('drops the empty string', () => {
    expect(parseInternalReturnPath('')).toBeNull();
  });

  it.each([null, undefined, 0, 1, {}, [], ['/a'], true, false])('drops %s', (raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — length', () => {
  it('accepts a path exactly at the ceiling', () => {
    const raw = `/${'a'.repeat(MAX_SIGN_IN_RETURN_PATH_LENGTH - 1)}`;
    expect(raw.length).toBe(MAX_SIGN_IN_RETURN_PATH_LENGTH);
    expect(parseInternalReturnPath(raw)).toBe(raw);
  });

  it('drops a path one character over it', () => {
    // The bound exists because this value rides in a cookie on every /v1/auth
    // request until the handshake ends, and a browser sending a large enough
    // Cookie header is answered with a 431 instead of a login page.
    const raw = `/${'a'.repeat(MAX_SIGN_IN_RETURN_PATH_LENGTH)}`;
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('the three sign-in query parameters are distinct', () => {
  /**
   * They travel on the same URL family and two of them already ride back
   * together. A copy-paste that gave two of them the same name would make one
   * silently unreadable, and nothing else in the system would notice.
   */
  it('has three different names', () => {
    const names = [
      SIGN_IN_OUTCOME_QUERY_PARAM,
      SIGN_IN_RETRY_AFTER_QUERY_PARAM,
      SIGN_IN_RETURN_PATH_QUERY_PARAM,
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it('names the return path in Vietnamese, like the two beside it', () => {
    expect(SIGN_IN_RETURN_PATH_QUERY_PARAM).toBe('quay-ve');
  });
});

/**
 * The date-of-birth parser, tested by CLASS for the same reason
 * `parseInternalReturnPath` is.
 *
 * The failure this guards against is not a wrong example, it is a whole family
 * left open: a parser that accepts `2026-02-30` because February was never in the
 * example list, or accepts `1999-04-02T00:00:00Z` because nothing tried a time
 * component. Each `describe` below is one family, swept over spellings nobody has
 * reported — which is the shape the trusted-proxy list needed four rounds to
 * learn (`AGENTS.md`).
 *
 * `TODAY` is fixed, and every future/past example is written relative to it. A
 * test that asked the wall clock would start failing on one particular calendar
 * day, which is the worst kind of flake because it arrives long after the change
 * that caused it.
 */
const TODAY = new Date('2026-09-04T09:00:00.000Z');

describe('parseDateOfBirth — what a date of birth is', () => {
  it.each([
    ['an ordinary day', '1999-04-02'],
    ['the first of a month', '2000-01-01'],
    ['the last of a 31-day month', '1987-12-31'],
    ['a real leap day', '2004-02-29'],
    ['the floor year itself', `${MIN_DATE_OF_BIRTH_YEAR}-01-01`],
    ['today, for somebody born this morning', '2026-09-04'],
  ])('accepts %s and returns it unchanged', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBe(raw);
  });
});

describe('parseDateOfBirth — the class of things that are not strings', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 19_990_402],
    ['a Date, which is the tempting one', new Date('1999-04-02T00:00:00.000Z')],
    ['an array of parts', [1999, 4, 2]],
    ['an object with the parts on it', { year: 1999, month: 4, day: 2 }],
    ['a boolean', true],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });
});

describe('parseDateOfBirth — the class of wrong shapes', () => {
  it.each([
    ['an empty string', ''],
    ['unpadded parts', '1999-4-2'],
    ['a two-digit year', '99-04-02'],
    ['a five-digit year', '19999-04-02'],
    ['slashes', '1999/04/02'],
    ['the parts reversed', '02-04-1999'],
    ['a trailing separator', '1999-04-02-'],
    ['a leading separator', '-1999-04-02'],
    ['a plus sign on the year', '+1999-04-02'],
    ['a year and month only', '1999-04'],
    ['non-ASCII digits, which the pattern must not match', '１９９９-０４-０２'],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });
});

describe('parseDateOfBirth — the class of surrounding whitespace', () => {
  /**
   * `Number()` accepts `  12  ` and that leniency is exactly what
   * `parseSignInRetryAfterSeconds` was written to refuse. The same rule applies
   * here: a value this product wrote has no whitespace in it, and trimming one
   * that does means storing a value nobody typed.
   */
  it.each([
    ['a leading space', ' 1999-04-02'],
    ['a trailing space', '1999-04-02 '],
    ['spaces on both sides', '  1999-04-02  '],
    ['a leading newline', '\n1999-04-02'],
    ['a trailing newline', '1999-04-02\n'],
    ['a tab inside', '1999-\t04-02'],
    ['a non-breaking space', ' 1999-04-02'],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });
});

describe('parseDateOfBirth — the class of days that do not exist', () => {
  /**
   * The family `new Date(raw)` gets wrong. Several of these parse there and roll
   * silently into the next month, so a person born on no day at all would be
   * stored as somebody born a day or two later.
   */
  it.each([
    ['the 30th of February', '2026-02-30'],
    ['the 29th of a non-leap February', '2025-02-29'],
    ['the 29th of a century non-leap year', '1900-02-29'],
    ['the 31st of April', '1999-04-31'],
    ['the 31st of June', '1999-06-31'],
    ['the 31st of September', '1999-09-31'],
    ['the 31st of November', '1999-11-31'],
    ['day zero', '1999-04-00'],
    ['the 32nd', '1999-04-32'],
    ['month zero', '1999-00-02'],
    ['the 13th month', '1999-13-02'],
    ['the 99th month', '1999-99-02'],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });

  it('accepts the leap days that ARE days, so the rule is not "refuse February"', () => {
    expect(parseDateOfBirth('2000-02-29', TODAY)).toBe('2000-02-29');
    expect(parseDateOfBirth('1996-02-29', TODAY)).toBe('1996-02-29');
  });
});

describe('parseDateOfBirth — the class of times and time zones', () => {
  /**
   * The whole reason the pattern is anchored. Several of these are values a
   * client library produces by default — `toISOString()` is the obvious one — and
   * accepting any of them means the stored day depends on which zone the string
   * was written in, which is the "two readings of one value" class this repo has
   * already paid for once.
   */
  it.each([
    ['a full ISO instant', '1999-04-02T00:00:00.000Z'],
    ['an ISO instant with no milliseconds', '1999-04-02T00:00:00Z'],
    ['a bare T separator', '1999-04-02T'],
    ['a space separator and a time', '1999-04-02 00:00:00'],
    ['a positive offset', '1999-04-02+07:00'],
    ['a trailing Z', '1999-04-02Z'],
    ['a time with no date-time separator', '1999-04-0212:00'],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });
});

describe('parseDateOfBirth — the class of implausible years', () => {
  it.each([
    ['the year one', '0001-01-01'],
    ['the year zero', '0000-01-01'],
    ['a year inside the Date.UTC 0-99 remapping band', '0099-12-31'],
    ['the year before the floor', `${MIN_DATE_OF_BIRTH_YEAR - 1}-12-31`],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });
});

describe('parseDateOfBirth — the class of days that have not happened', () => {
  it.each([
    ['tomorrow', '2026-09-05'],
    ['next month', '2026-10-04'],
    ['next year', '2027-09-04'],
    ['a year far enough out to look like a typo', '9999-12-31'],
  ])('refuses %s', (_label, raw) => {
    expect(parseDateOfBirth(raw, TODAY)).toBeNull();
  });

  it('draws the line at the calendar day, not at the instant', () => {
    // Late in the UTC day: "now" is 23:59 and the comparison is still on calendar
    // days, so today is in and tomorrow is out by exactly one day either way.
    const lateToday = new Date('2026-09-04T23:59:59.999Z');
    expect(parseDateOfBirth('2026-09-04', lateToday)).toBe('2026-09-04');
    expect(parseDateOfBirth('2026-09-05', lateToday)).toBeNull();
  });
});

describe('parseDateOfBirth — the reference instant is a parameter, not the wall clock', () => {
  it('refuses an unusable `today` rather than falling back to the real one', () => {
    // A caller that lost its clock must not get a silently different rule. `null`
    // sends it down the "cannot decide" path, which refuses the write.
    expect(parseDateOfBirth('1999-04-02', new Date('not-a-date'))).toBeNull();
    expect(parseDateOfBirth('1999-04-02', undefined as unknown as Date)).toBeNull();
  });

  it('gives a different answer for the same string at two instants', () => {
    // The proof there is no hidden `new Date()`: the same string is the future at
    // one instant and the past at the other, and only the parameter changed.
    expect(parseDateOfBirth('2026-09-05', TODAY)).toBeNull();
    expect(parseDateOfBirth('2026-09-05', new Date('2026-09-06T00:00:00.000Z'))).toBe(
      '2026-09-05',
    );
  });
});

describe('isCalendarDate is the shape rule the adapters share', () => {
  /**
   * `packages/db` validates with this one and NOT with `parseDateOfBirth`: an
   * adapter has no clock, so "is this a day" is the most it can honestly decide.
   * Plausibility and the future check belong to the caller that does have one.
   */
  it('accepts a day the year floor would refuse', () => {
    expect(isCalendarDate('1000-01-01')).toBe(true);
    expect(parseDateOfBirth('1000-01-01', TODAY)).toBeNull();
  });

  it('refuses the same non-days the full parser does', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('1999-4-2')).toBe(false);
    expect(isCalendarDate('1999-04-02T00:00:00Z')).toBe(false);
    expect(isCalendarDate(new Date())).toBe(false);
  });
});

describe('the current-user flags fail closed when absent', () => {
  /**
   * The third state an optional boolean has. A client reading an older
   * deployment's answer must not conclude "over 18" from silence — that is a
   * control which protects minors reading its own absence as permission.
   */
  it('reads an absent flag as false', () => {
    expect(isProfileCompleted({})).toBe(false);
    expect(isOver18({})).toBe(false);
  });

  it('reads an explicit false as false and a true as true', () => {
    expect(isProfileCompleted({ profile_completed: false })).toBe(false);
    expect(isProfileCompleted({ profile_completed: true })).toBe(true);
    expect(isOver18({ is_over_18: false })).toBe(false);
    expect(isOver18({ is_over_18: true })).toBe(true);
  });

  it('keeps the two flags independent — completed does not mean adult', () => {
    expect(isProfileCompleted({ profile_completed: true, is_over_18: false })).toBe(true);
    expect(isOver18({ profile_completed: true, is_over_18: false })).toBe(false);
  });
});

describe('currentUserSchema still refuses to carry a date of birth', () => {
  /**
   * The invariant the whole story rests on, pinned where it cannot be quietly
   * undone: `apps/api` builds its `/me` body by parsing THROUGH this schema, so a
   * strict object is what makes "adding a column cannot publish it" true. If this
   * ever fails, the projection has stopped stripping unknown keys.
   */
  it('drops a date of birth handed to it, rather than passing it through', () => {
    const parsed = currentUserSchema.parse({
      id: '019200f0-0000-7000-8000-000000000001',
      display_name: 'An Nguyen',
      avatar_url: null,
      role: 'user',
      profile_completed: true,
      is_over_18: true,
      date_of_birth: '1999-04-02',
    });

    expect(JSON.stringify(parsed)).not.toContain('1999-04-02');
    expect(Object.keys(parsed)).not.toContain('date_of_birth');
  });

  /**
   * The client half of the same invariant, and the one that was missing.
   *
   * `apps/web` used to write `(await response.json()) as CurrentUser` on both
   * screens: the API parses the projection on the way OUT so that adding a column
   * cannot publish it, and then the client believed any 200 body at all. A cast
   * is not a check, and the field it matters most for is `is_over_18` — a client
   * that reads a string there is a control protecting minors reading whatever it
   * was handed.
   */
  describe('parseCurrentUser — a 200 body is judged, never cast', () => {
    const valid = {
      id: '019200f0-0000-7000-8000-000000000001',
      display_name: 'An Nguyen',
      avatar_url: null,
      role: 'user',
      profile_completed: true,
      is_over_18: true,
    };

    it('returns the profile for a body that IS one', () => {
      expect(parseCurrentUser(valid)).toEqual(valid);
    });

    it('strips a date of birth even here, so a client cannot hold one either', () => {
      const parsed = parseCurrentUser({ ...valid, date_of_birth: '1999-04-02' });
      expect(JSON.stringify(parsed)).not.toContain('1999-04-02');
    });

    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['an empty object', {}],
      ['a 204 body read as JSON', undefined],
      ['a role outside the closed set', { ...valid, role: 'superuser' }],
      ['an id that is not a uuid', { ...valid, id: 'me' }],
      ['a flag that is a string rather than a boolean', { ...valid, is_over_18: 'yes' }],
      ['an error envelope, which is what a refused call actually returns', {
        error: { code: 'unauthenticated', message: 'no' },
      }],
    ])('returns null for %s rather than a profile-shaped lie', (_label, body) => {
      expect(parseCurrentUser(body)).toBeNull();
    });

    it('never throws, whatever it is handed', () => {
      // Same contract as every other parser in this file: `null` is the answer, an
      // exception is not — a screen that crashes on a bad body tells nobody
      // anything.
      for (const body of [Number.NaN, [], () => undefined, new Date(), Symbol('x')]) {
        expect(() => parseCurrentUser(body)).not.toThrow();
      }
    });
  });

  it('accepts the Story 1.2 shape unchanged, so the new fields are compatible', () => {
    const parsed = currentUserSchema.safeParse({
      id: '019200f0-0000-7000-8000-000000000001',
      display_name: 'An Nguyen',
      avatar_url: null,
      role: 'user',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('the two Story 1.4 paths are distinct and go to different places', () => {
  it('keeps the web route and the API route apart', () => {
    expect(DATE_OF_BIRTH_PATHNAME).not.toBe(AUTH_DATE_OF_BIRTH_PATH);
    // The web route is a page a person lands on; the API route is under /v1.
    expect(DATE_OF_BIRTH_PATHNAME.startsWith('/v1')).toBe(false);
    expect(AUTH_DATE_OF_BIRTH_PATH.startsWith('/v1/')).toBe(true);
  });

  it('does not collide with the sign-in page', () => {
    expect(DATE_OF_BIRTH_PATHNAME).not.toBe(SIGN_IN_PATHNAME);
  });

  it('names every /v1/auth route this product calls, so none is left as a literal', () => {
    // `AUTH_ME_PATH` was the last one written out by hand — in two screens, in
    // `openapi.ts` and in the contract suite — so renaming the route meant finding
    // four strings that nothing connects. The three are distinct, and each is a
    // `/v1` path rather than a page.
    const routes = [AUTH_ME_PATH, AUTH_REFRESH_PATH, AUTH_DATE_OF_BIRTH_PATH];
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes) {
      expect(route.startsWith('/v1/auth/')).toBe(true);
    }
  });

  /**
   * The threshold is not the visitor's business, and a sentence carrying it tells
   * somebody who was refused exactly which year to type instead.
   *
   * The rule is over AGE VOCABULARY rather than over two raw substrings. `/18/`
   * and `/tuổi/i` were both too narrow — "trên 18", "đủ tuổi", "vị thành niên" all
   * passed — and, wherever the same check was applied to a whole response body
   * rather than to a constant, too wide: an id or a date containing those two
   * digits went red for no reason.
   *
   * The list is EXPORTED from `auth.ts` rather than written here. It was written
   * twice — nine words here, seven in `apps/web`'s form test, with `'dưới 18'` and
   * `'trưởng thành'` missing from the web copy — so a screen could have said either
   * of them while this suite claimed the whole vocabulary was covered. Two lists
   * about one rule are two lists that drift.
   */
  it('is a shared list, so no screen can be checked against a shorter one', () => {
    expect(AGE_VOCABULARY.length).toBeGreaterThanOrEqual(9);
    expect(AGE_VOCABULARY).toContain('dưới 18');
    expect(AGE_VOCABULARY).toContain('trưởng thành');
  });

  /**
   * Story 1.5 adds the third message the rule has to hold, and it is the one with
   * the most to give away: the money gate refuses somebody FOR their age, so the
   * refusal is the natural place for a helpful sentence to explain exactly which
   * side of the threshold they fell on — which is free calibration for anybody who
   * would rather be on the other side, and the only way back across that line is
   * to lie about a value written exactly once.
   */
  it.each(AGE_VOCABULARY)('says nothing about "%s" in any of the three messages', (word) => {
    for (const message of [
      DATE_OF_BIRTH_INVALID_MESSAGE,
      DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
      MONEY_IN_FORBIDDEN_MESSAGE,
    ]) {
      expect(message.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('still says something, so the rule above is not passing on empty strings', () => {
    // Every "must not contain" needs a positive counterpart; three empty constants
    // would satisfy the whole block above perfectly.
    expect(DATE_OF_BIRTH_INVALID_MESSAGE.length).toBeGreaterThan(20);
    expect(DATE_OF_BIRTH_ALREADY_SET_MESSAGE.length).toBeGreaterThan(20);
    expect(MONEY_IN_FORBIDDEN_MESSAGE.length).toBeGreaterThan(20);
  });

  it('names the direction it refuses, so it cannot be read as a suspension', () => {
    // "Nhận coin từ người dùng khác" is the whole scope of the gate. Spending
    // coins and coins the SYSTEM grants are untouched, and a sentence that said
    // only "không được phép" would read as an account-wide refusal.
    expect(MONEY_IN_FORBIDDEN_MESSAGE).toContain('nhận coin');
  });

  it('keeps ONE sentence behind every unauthenticated envelope', () => {
    // `/v1/auth/me` and the money gate both answer 401 with this. A caller that
    // could tell the two apart would have been told something about a person the
    // system has not identified.
    expect(UNAUTHENTICATED_MESSAGE.length).toBeGreaterThan(20);
    for (const word of AGE_VOCABULARY) {
      expect(UNAUTHENTICATED_MESSAGE.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
