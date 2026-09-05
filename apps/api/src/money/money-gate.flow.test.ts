import {
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_ME_PATH,
  AGE_VOCABULARY,
  DATE_OF_BIRTH_FIELD,
  MONEY_IN_FORBIDDEN_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  errorEnvelopeSchema,
} from '@stuwith/contracts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CookieJar,
  createAuthHarness,
  type AuthHarness,
} from '../auth/__testing__/auth-harness';
import {
  MONEY_FIXTURE_IN_PATH,
  MONEY_FIXTURE_OPEN_PATH,
  MoneyFixtureController,
} from './__testing__/money-fixture.controller';

/**
 * AC3 and AC2, driven through a real NestJS + Fastify process over real HTTP.
 *
 * > Given một endpoint được đánh dấu là hành vi có tiền đi vào, when tài khoản
 * > dưới 18 gọi nó, then bị chặn ở tầng API với envelope chuẩn, kể cả khi gọi
 * > thẳng API.
 *
 * "Kể cả khi gọi thẳng API" is why this file exists rather than a unit test:
 * `fetch` here is not a browser, has no `apps/web` in front of it and hides no
 * button. What refuses it is the guard, in the server, on the wire.
 *
 * The endpoint under test is {@link MoneyFixtureController} — a fixture mounted
 * through `AppModule`'s test-only controller seam. Epic 3 owns the real money
 * endpoints; this story owns the mechanism, and the mechanism is only demonstrated
 * by a route that was written the way a new one will be.
 */

/**
 * Block comments and whole-line `//` comments removed, anchored — the same
 * spelling `config-cast-ban.test.ts` uses, and the anchor is the point there: an
 * unanchored line-comment rule eats everything after `//` in a URL and makes the
 * offending line disappear.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ 	]*\/\/.*$/gm, '');
}

let harness: AuthHarness;

/**
 * The harness clock is fixed at **2026-09-04**, so these two are stable for ever.
 *
 * A day EARLIER than the day `money.test.ts` and `money-gate.guard.test.ts` stand
 * on, which is why `2008-09-05` is the too-young example here and the
 * exact-eighteenth-birthday adult there. The clock belongs to `createAuthHarness`;
 * changing it moves every date in this file and in `logging.test.ts`.
 */
const ADULT_BIRTHDAY = '2008-09-04';
const DAY_TOO_YOUNG = '2008-09-05';

beforeAll(async () => {
  harness = await createAuthHarness({ controllers: [MoneyFixtureController] });
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  MoneyFixtureController.reset();
});

/** A signed-in browser whose profile carries `dateOfBirth`, or none at all. */
async function signedIn(
  subject: string,
  dateOfBirth: string | null,
): Promise<{ jar: CookieJar; userId: string }> {
  const { jar, callback } = await harness.login('google', {
    subject,
    email: `${subject}@example.test`,
    name: 'Một người dùng',
  });
  expect(callback.status).toBe(302);
  if (dateOfBirth !== null) {
    const declared = await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [DATE_OF_BIRTH_FIELD]: dateOfBirth }),
    });
    expect(declared.status).toBe(200);
  }
  const me = (await (await harness.request(AUTH_ME_PATH, { jar })).json()) as { id: string };
  return { jar, userId: me.id };
}

const callMoneyIn = (jar?: CookieJar): Promise<Response> =>
  harness.request(MONEY_FIXTURE_IN_PATH, {
    method: 'POST',
    ...(jar === undefined ? {} : { jar }),
  });

describe('AC3: a NEW endpoint is protected by the mark and by nothing else', () => {
  it('contains no age rule of its own — asserted by reading the file, not by trusting it', () => {
    /**
     * "có test chứng minh endpoint mẫu được bảo vệ mà không viết thêm dòng luật
     * tuổi nào".
     *
     * The other examples in this file show the endpoint IS protected. This one
     * shows what it cost, and it is the half a reviewer cannot check by eye a year
     * from now: a `if (!isAdult(...))` added to the fixture would leave every
     * other example green while quietly making the story's central claim false.
     *
     * Comments are STRIPPED first, the same way `tests/gates/config-cast-ban.test.ts`
     * strips them: that file's docblock explains what must not be in it, and a rule
     * that cannot survive being described is a rule nobody can document. What is
     * scanned is the code.
     */
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = stripComments(
      readFileSync(path.join(here, '__testing__', 'money-fixture.controller.ts'), 'utf8'),
    );

    for (const forbidden of [
      'canReceiveMoney',
      'isAdult',
      'isAtLeastYearsOld',
      'ADULT_AGE_YEARS',
      'dateOfBirth',
      'date_of_birth',
    ]) {
      expect(source).not.toContain(forbidden);
    }

    /**
     * The age vocabulary, ANCHORED — the same discipline `logging.test.ts` applies
     * to its date fragments, and for the same reason.
     *
     * `AGE_VOCABULARY` contains the bare string `'18'`. Matched as a substring it
     * is not a rule about age at all: `@HttpCode(418)`, a port, a `/v1/18` route
     * segment or a UUID would each turn this story's flagship assertion red for a
     * reason that has nothing to do with anybody's age, and the person who met that
     * failure would weaken the assertion rather than the example. A numeric term is
     * therefore required to stand alone, digit-wise; the word terms are matched
     * case-insensitively as written.
     */
    for (const word of AGE_VOCABULARY) {
      if (/^\d+$/.test(word)) {
        expect(source).not.toMatch(new RegExp(`(?<![0-9])${word}(?![0-9])`));
      } else {
        // No escaping: every non-numeric term in the vocabulary is Vietnamese
        // words and spaces, with no regex metacharacter in any of them. The
        // example below holds that, so a term added later that needs escaping
        // fails loudly here instead of silently matching something else.
        expect(source.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
    // And the mark itself is there, so the scan above is not vacuously true of a
    // file that gates nothing.
    expect(source).toContain('@MoneyIn()');
  });

  it('the anchored scan can still fail, and the vocabulary is still plain words', () => {
    /**
     * Two properties the loop above depends on and neither of which it states.
     *
     * The anchor was added because `'18'` matched inside `418` and inside a port
     * number. An anchor that no longer matched a real standalone `18` would make
     * the flagship assertion pass for ever — so the anchor is exercised in both
     * directions here rather than trusted.
     */
    const anchored = new RegExp('(?<![0-9])18(?![0-9])');
    expect('@HttpCode(418)').not.toMatch(anchored);
    expect('const port = 51988;').not.toMatch(anchored);
    expect('if (age < 18) refuse();').toMatch(anchored);

    // And the non-numeric half is matched literally, so a term carrying a regex
    // metacharacter would be compared as text it never appears as.
    for (const word of AGE_VOCABULARY.filter((entry) => !/^\d+$/.test(entry))) {
      expect(word).toMatch(/^[^.*+?^${}()|[\]\\]+$/);
    }
  });

  it('serves an adult, and hands the handler the caller the GATE resolved', async () => {
    const { jar, userId } = await signedIn('adult-through-the-gate', ADULT_BIRTHDAY);

    const response = await callMoneyIn(jar);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { userId: string; at: string };
    // The same person `/v1/auth/me` reports — one session read, one answer.
    expect(body.userId).toBe(userId);
    expect(body.at).toBe(harness.clock.now().toISOString());
    expect(MoneyFixtureController.reached).toEqual(['receive']);
  });
});

describe('AC2: the block happens at the API layer', () => {
  it('refuses somebody whose eighteenth birthday has not arrived, and the handler never runs', async () => {
    const { jar } = await signedIn('too-young-for-the-gate', DAY_TOO_YOUNG);

    const response = await callMoneyIn(jar);
    expect(response.status).toBe(403);

    // Not merely "a 403 came back": the handler is what would have moved money.
    expect(MoneyFixtureController.reached).toEqual([]);
  });

  it('answers with the standard envelope and the existing `forbidden` code', async () => {
    const { jar } = await signedIn('envelope-shape', DAY_TOO_YOUNG);

    const envelope = errorEnvelopeSchema.parse(await (await callMoneyIn(jar)).json());
    expect(envelope.error.code).toBe('forbidden');
    expect(envelope.error.message).toBe(MONEY_IN_FORBIDDEN_MESSAGE);
    expect(envelope.error.details).toBeUndefined();
  });

  it('never lets an age, a date or a date of birth out of the process', async () => {
    const { jar } = await signedIn('nothing-leaks', DAY_TOO_YOUNG);

    const raw = await (await callMoneyIn(jar)).text();
    for (const word of AGE_VOCABULARY) {
      expect(raw.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(raw).not.toContain(DAY_TOO_YOUNG);
    expect(raw).not.toContain('2008');
  });

  it('refuses a profile that has not declared a date of birth at all — 403, not 400', async () => {
    // Fail closed. "Nobody has answered yet" is not a validation problem the caller
    // can fix by resending, and it is certainly not permission.
    const { jar } = await signedIn('never-declared', null);

    const response = await callMoneyIn(jar);
    expect(response.status).toBe(403);
    expect(MoneyFixtureController.reached).toEqual([]);
  });
});

describe('Matrix: 401 comes first, and it is the ordinary 401', () => {
  it('answers 401 for a request with no session at all', async () => {
    const response = await callMoneyIn();
    expect(response.status).toBe(401);

    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('unauthenticated');
    // Byte for byte what `/v1/auth/me` answers: a caller that could tell the two
    // apart would have learnt something about a person nobody has identified.
    expect(envelope.error.message).toBe(UNAUTHENTICATED_MESSAGE);
    expect(MoneyFixtureController.reached).toEqual([]);
  });

  it('is indistinguishable from the 401 `/v1/auth/me` gives the same browser', async () => {
    const anonymous = new CookieJar();
    const fromMe = await harness.request(AUTH_ME_PATH, { jar: anonymous });
    const fromGate = await callMoneyIn(anonymous);

    expect(fromMe.status).toBe(fromGate.status);
    expect(await fromMe.json()).toEqual(await fromGate.json());
  });

  it('answers 401 rather than 403 for a session cookie that means nothing', async () => {
    const forged = new CookieJar();
    forged.set('stuwith_session', 'a-token-nobody-ever-issued');

    expect((await callMoneyIn(forged)).status).toBe(401);
  });
});

describe('AC4: routes that are not marked do not change behaviour', () => {
  it('serves the UNMARKED route on the same controller to a person the gate would refuse', async () => {
    // The READ half of a money controller. Refusing it would tell somebody they
    // may not look at their own Số dư, which is not what the rule says.
    const { jar } = await signedIn('unmarked-route-for-a-minor', DAY_TOO_YOUNG);

    const response = await harness.request(MONEY_FIXTURE_OPEN_PATH, { jar });
    expect(response.status).toBe(200);
    expect(MoneyFixtureController.reached).toEqual(['balance']);
  });

  it('serves the UNMARKED route with no session and no cookie whatsoever', async () => {
    // The branch every route in the product takes today. It must not acquire an
    // authentication requirement just because a guard was registered globally.
    const response = await harness.request(MONEY_FIXTURE_OPEN_PATH);
    expect(response.status).toBe(200);
    expect(MoneyFixtureController.reached).toEqual(['balance']);
  });

  it('leaves `/healthz` and the whole login flow exactly as they were', async () => {
    // A smoke check against the two shapes the rest of the suite covers in depth:
    // a public route with no session, and the authenticated route that answers for
    // a profile the money gate would refuse.
    expect((await harness.request('/healthz')).status).toBe(200);

    const { jar } = await signedIn('login-flow-unchanged', DAY_TOO_YOUNG);
    const me = await harness.request(AUTH_ME_PATH, { jar });
    expect(me.status).toBe(200);
    expect((await me.json()) as { is_over_18: boolean }).toMatchObject({ is_over_18: false });
  });
});
