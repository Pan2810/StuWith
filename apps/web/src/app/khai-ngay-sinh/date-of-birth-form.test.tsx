import {
  AGE_VOCABULARY,
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  MIN_DATE_OF_BIRTH_YEAR,
  RATE_LIMITED_MESSAGE,
  SIGN_IN_PATHNAME,
  type CurrentUser,
} from '@stuwith/contracts';
import { countdownLabel } from '../dang-nhap/countdown-text';
import { PROFILE_RETRY_LABEL, PROFILE_UNAVAILABLE_MESSAGE } from '../profile-load';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BACK_TO_ACCOUNT_LINK,
  DATE_OF_BIRTH_ERROR_ID,
  DATE_OF_BIRTH_HINT,
  DATE_OF_BIRTH_HINT_ID,
  DATE_OF_BIRTH_LABEL,
  DATE_OF_BIRTH_SUBMIT,
  DECLARED_HEADING,
  DateOfBirthPanel,
  REQUEST_NOT_SENT_MESSAGE,
  SESSION_LOST_MESSAGE,
  TRY_AGAIN_MESSAGE,
  dateOfBirthDescribedBy,
  dateOfBirthInputBounds,
  dateOfBirthRequestBody,
  dateOfBirthSubmission,
  declarationOutcomeFor,
  profileLoadStateFor,
  screenStateFor,
  type DateOfBirthScreenState,
} from './date-of-birth-form';

/**
 * The web half of Story 1.4's matrix, executed.
 *
 * These render for real: `renderToStaticMarkup` is `react-dom`, already a
 * dependency, and needs no DOM environment — so the assertions are about actual
 * output HTML rather than about a value on its way to a renderer. The residual
 * this cannot cover is the same one `sign-in-outcome.test.tsx` names: that React
 * INVOKES the page's effect at all. Everything the effect decides is in a
 * function below.
 */
function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: '019200f0-0000-7000-8000-000000000001',
    display_name: 'An Nguyen',
    avatar_url: null,
    role: 'user',
    ...overrides,
  };
}

/**
 * The panel, with a message or without one.
 *
 * There is no clock to inject any more: the picker's `max` is gone, so nothing this
 * component renders depends on what day it is. See `dateOfBirthInputBounds`.
 */
function render(state: DateOfBirthScreenState, message: string | null = null): string {
  return renderToStaticMarkup(
    <DateOfBirthPanel
      state={state}
      notice={message === null ? null : { message, retryAfterSeconds: null }}
      submitting={false}
      onRetry={() => undefined}
      onWaitFinished={() => undefined}
      onSubmit={() => undefined}
    />,
  );
}

/** `unavailable` with no wait, which is what every branch except a 429 produces. */
const unreadable = { kind: 'unavailable', retryAfterSeconds: null } as const;

describe('screenStateFor — what a profile means once one has been read', () => {
  it('offers the form to a profile that has not declared', () => {
    expect(screenStateFor(user({ profile_completed: false })).kind).toBe('needs-declaration');
  });

  it('shows the confirmation to a profile that has', () => {
    expect(screenStateFor(user({ profile_completed: true })).kind).toBe('declared');
  });

  it('treats an ABSENT flag as not declared, which is the fail-closed reading', () => {
    // The field is optional in the contract, so it has three states while this
    // screen has two. Reading silence as "already done" would leave somebody
    // permanently unable to finish the step.
    expect(screenStateFor(user()).kind).toBe('needs-declaration');
  });

  it('does not consult the age flag at all', () => {
    // Completion and adulthood are different facts. A seventeen-year-old who has
    // declared is DONE with this screen, and showing them the form again would
    // ask for a value that can no longer be written.
    expect(screenStateFor(user({ profile_completed: true, is_over_18: false })).kind).toBe(
      'declared',
    );
  });
});

describe('profileLoadStateFor — only a 401 means "signed out"', () => {
  it('reads a 200 with a profile as that profile', () => {
    expect(profileLoadStateFor(200, user({ profile_completed: true }), null).kind).toBe('declared');
    expect(profileLoadStateFor(200, user({ profile_completed: false }), null).kind).toBe(
      'needs-declaration',
    );
  });

  it('reads a 401 as signed out', () => {
    expect(profileLoadStateFor(401, null, null).kind).toBe('signed-out');
  });

  it.each([[429], [500], [502], [503], [0]])(
    'reads %i as "could not read the profile", NOT as signed out',
    (status) => {
      // `/v1/auth/me` is rate limited, so a 429 is a real answer this screen gets.
      // Calling it "signed out" sends somebody who IS signed in to a login page
      // where every click spends another attempt and lengthens the wait — the
      // same defect Story 1.3 fixed on /dang-nhap, arriving through another door.
      expect(profileLoadStateFor(status, null, null).kind).toBe('unavailable');
    },
  );

  it('does not trust a 200 that carried no profile', () => {
    expect(profileLoadStateFor(200, null, null).kind).toBe('unavailable');
  });

  /**
   * M4 — the load branch used to throw the `Retry-After` header away.
   *
   * The submit branch read it and the load branch did not, so the one answer
   * `unavailable` was invented for — a rate-limited `/v1/auth/me` — reached a screen
   * that could not say how long, above a retry button that called straight back into
   * the limit and made the wait longer.
   */
  it('carries the wait through on a 429, which is the answer this state exists for', () => {
    expect(profileLoadStateFor(429, null, '45')).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: 45,
    });
  });

  it('shows no clock when the header is missing or nonsense', () => {
    // The same parser the sign-in page runs a URL parameter through, so a header
    // this product did not write cannot put a number on the screen either.
    for (const header of [null, '', 'soon', '-5', '0', '99999999', ' 30 ']) {
      expect(profileLoadStateFor(429, null, header)).toEqual({
        kind: 'unavailable',
        retryAfterSeconds: null,
      });
    }
  });

  it('reads a wait only from a 429, never from any other refusal', () => {
    // A `Retry-After` on a 503 is a server hint about itself, not a rate-limit
    // budget this product understands; showing it as "bạn đã thử quá nhiều lần"
    // would be an accusation nobody earned.
    for (const status of [0, 500, 502, 503]) {
      expect(profileLoadStateFor(status, null, '45')).toEqual({
        kind: 'unavailable',
        retryAfterSeconds: null,
      });
    }
  });
});

describe('dateOfBirthSubmission — nothing unusable is ever sent', () => {
  it('passes a good value through unchanged', () => {
    const submission = dateOfBirthSubmission('1999-04-02');
    expect(submission).toEqual({ kind: 'send', value: '1999-04-02' });
  });

  /**
   * One example per class, not a sweep. The exhaustive sweep over each family is
   * in `packages/contracts/src/auth.test.ts`, and duplicating it here would be a
   * second list to keep in step. What matters HERE is that the screen asks that
   * shared parser at all rather than writing a regex of its own — which is why
   * every example below is one the server would also refuse.
   */
  it.each([
    ['an empty field', ''],
    ['a day that does not exist', '2026-02-30'],
    ['the wrong shape', '02/04/1999'],
    ['an ISO instant', '1999-04-02T00:00:00.000Z'],
    ['an implausible year', '0001-01-01'],
    // `Blob`, and the label says `Blob`. It used to say "a File, which is what
    // FormData.get returns for a file input" over a `new Blob()` — which is not a
    // `File`, so the label described a case the example did not cover. What both
    // have in common is the only thing this assertion is about: `FormData.get` can
    // return something that is not a string, and the parser is total over `unknown`.
    ['a Blob, which is the shape FormData.get returns for a file input', new Blob()],
    ['null, which is what FormData.get returns for a missing field', null],
  ])('refuses %s with the same sentence the server would have sent', (_label, raw) => {
    const submission = dateOfBirthSubmission(raw);
    expect(submission.kind).toBe('invalid');
    expect(submission.kind === 'invalid' && submission.message).toBe(
      DATE_OF_BIRTH_INVALID_MESSAGE,
    );
  });

  /**
   * "In the future" is the one part of the format rule that needs a clock, and this
   * screen deliberately does not answer it.
   *
   * It used to call `dateOfBirthSubmission(raw, new Date())` — the BROWSER's clock.
   * A machine whose date is wrong then refused a perfectly good date of birth on
   * the spot, with the exact sentence a real refusal carries, and the request never
   * reached the server to be judged by the `ClockPort` that is authoritative. The
   * person had no way to tell the two apart and no way through.
   *
   * So the client check is a strict SUPERSET of the server's: it never accepts what
   * the server would refuse, and it never refuses what the server would accept. A
   * future date travels, and `apps/api` answers 400 with the same sentence —
   * `auth.flow.test.ts` runs exactly that over real HTTP.
   */
  it('lets a future date travel rather than refusing it on the browser clock', () => {
    expect(dateOfBirthSubmission('2999-01-01')).toEqual({ kind: 'send', value: '2999-01-01' });
  });

  it('still refuses everything the format rule decides without a clock', () => {
    // The superset is not "accept anything": shape, real-day and the year floor all
    // still apply here, which is what saves the round trip in the ordinary case.
    expect(dateOfBirthSubmission('2999-02-30').kind).toBe('invalid');
    expect(dateOfBirthSubmission('1899-12-31').kind).toBe('invalid');
  });
});

describe('dateOfBirthInputBounds — a floor the server agrees with, and no ceiling', () => {
  it('offers nothing before the contract floor', () => {
    expect(dateOfBirthInputBounds()).toEqual({ min: '1900-01-01' });
    expect(dateOfBirthInputBounds().min.startsWith(String(MIN_DATE_OF_BIRTH_YEAR))).toBe(true);
  });

  /**
   * M1 — the `max` is gone, and the reason is that the comment beside it was false.
   *
   * It called itself "a convenience and never a control" while being built from the
   * BROWSER's `new Date()`. `max` on an `<input type="date">` is enforced by the
   * browser through constraint validation, before any script of ours runs — so a
   * machine with a wrong clock refused the submit itself, with the browser's own
   * message, and the request never reached the `ClockPort` that is authoritative.
   *
   * That is precisely the failure `NO_FUTURE_CHECK` exists to prevent, re-entered
   * through an HTML attribute. The two now agree: this screen does not answer "is
   * this in the future" at all, in JavaScript or in markup.
   */
  it('puts no upper bound on the rendered input, so no browser clock can refuse a submit', () => {
    const html = render({ kind: 'needs-declaration', user: user() });
    expect(html).toContain('min="1900-01-01"');
    expect(html).not.toContain('max=');
  });

  it('is the same answer whatever day it is, because it reads no clock', () => {
    // The property that makes the paragraph above true rather than aspirational: a
    // function with no clock in it cannot be made to refuse anybody by a wrong one.
    expect(dateOfBirthInputBounds()).toEqual(dateOfBirthInputBounds());
    expect(JSON.stringify(dateOfBirthInputBounds())).not.toContain('max');
  });
});

describe('dateOfBirthRequestBody — the field name is written once', () => {
  it('sends the contract field name and nothing else', () => {
    expect(JSON.parse(dateOfBirthRequestBody('1999-04-02'))).toEqual({
      [DATE_OF_BIRTH_FIELD]: '1999-04-02',
    });
  });
});

describe('declarationOutcomeFor — what the endpoint said', () => {
  it('treats 200 as the write this request made', () => {
    expect(declarationOutcomeFor(200, null).kind).toBe('written');
  });

  /**
   * A 409 is NOT the same outcome as a 200, and folding the two together was a
   * defect rather than tidiness.
   *
   * Both mean "the profile has a date of birth", so both end this screen's job. What
   * differs is what the page may do next: a 200 carries the new projection in its
   * body, a 409 carries no value at all (deliberately). While they shared a kind,
   * the page fell back to re-reading `/v1/auth/me` after a 409 — which answers "not
   * declared" for exactly the profile whose stored value this product no longer
   * accepts, so the form came back, the submit was refused again, and round it went.
   */
  it('treats 409 as ALREADY declared, which is a different answer from 200', () => {
    expect(declarationOutcomeFor(409, null).kind).toBe('already-declared');
    expect(declarationOutcomeFor(409, null).kind).not.toBe(declarationOutcomeFor(200, null).kind);
  });

  it('shows the same refusal sentence for a 400 as the field does locally', () => {
    expect(declarationOutcomeFor(400, null)).toEqual({
      kind: 'message',
      notice: { message: DATE_OF_BIRTH_INVALID_MESSAGE, retryAfterSeconds: null },
    });
  });

  it('says the session ended for a 401', () => {
    expect(declarationOutcomeFor(401, null)).toEqual({
      kind: 'message',
      notice: { message: SESSION_LOST_MESSAGE, retryAfterSeconds: null },
    });
  });

  /**
   * The answers Fastify gives BEFORE this product's handler is asked anything.
   *
   * A missing or wrong `content-type` is a 415 and an over-sized body is a 413, and
   * both are permanent: the same request will be refused the same way for ever. They
   * fell into `default`, which says "hãy thử lại sau ít phút" — the one thing that is
   * certainly untrue about them, and an invitation to keep pressing a button that
   * cannot work.
   */
  it.each([[413], [415]])('says a %i cannot be retried into working', (status) => {
    expect(declarationOutcomeFor(status, null)).toEqual({
      kind: 'message',
      notice: { message: REQUEST_NOT_SENT_MESSAGE, retryAfterSeconds: null },
    });
    expect(REQUEST_NOT_SENT_MESSAGE).not.toContain('ít phút');
  });

  /**
   * The route carries `@RateLimited('auth_date_of_birth')` on a `json` channel, so
   * a `429` with a `Retry-After` header is an answer this screen really receives.
   * It used to fall into `default` and read "thử lại sau ít phút" — vaguer than the
   * truth, and an invitation to keep tapping when every tap costs another attempt.
   */
  describe('a 429 is a real answer here, not an unrecognised one', () => {
    it('says what /dang-nhap says, with the wait the header carried', () => {
      expect(declarationOutcomeFor(429, '30')).toEqual({
        kind: 'message',
        notice: { message: RATE_LIMITED_MESSAGE, retryAfterSeconds: 30 },
      });
    });

    it('shows the message with no clock when the header is missing or nonsense', () => {
      // Same parser the login page runs the URL parameter through, so a header this
      // product did not write cannot put a number on the screen either.
      for (const header of [null, 'abc', '-5', '0', '99999999', ' 30 ']) {
        expect(declarationOutcomeFor(429, header)).toEqual({
          kind: 'message',
          notice: { message: RATE_LIMITED_MESSAGE, retryAfterSeconds: null },
        });
      }
    });

    it('renders the wait beside the message, so the number reaches the screen', () => {
      const html = renderToStaticMarkup(
        <DateOfBirthPanel
          state={{ kind: 'needs-declaration', user: user() }}
          notice={{ message: RATE_LIMITED_MESSAGE, retryAfterSeconds: 30 }}
          submitting={false}
          onRetry={() => undefined}
          onWaitFinished={() => undefined}
          onSubmit={() => undefined}
        />,
      );

      expect(html).toContain(RATE_LIMITED_MESSAGE);
      expect(html).toContain(countdownLabel(30));
    });
  });

  it.each([[0], [500], [502], [418]])(
    'defaults %i to "we do not know that it worked", never to declared',
    (status) => {
      // The dangerous default is the other one: telling somebody their profile is
      // complete on the strength of a 502 means they never come back to finish it.
      expect(declarationOutcomeFor(status, null)).toEqual({
        kind: 'message',
        notice: { message: TRY_AGAIN_MESSAGE, retryAfterSeconds: null },
      });
    },
  );

  it('never says anything technical', () => {
    for (const status of [0, 400, 401, 415, 429, 500, 502]) {
      const outcome = declarationOutcomeFor(status, null);
      if (outcome.kind !== 'message') continue;
      for (const leak of [String(status), 'HTTP', 'server', 'API', 'fetch']) {
        expect(outcome.notice.message).not.toContain(leak);
      }
    }
  });
});

describe('the panel renders one screen per state, and only one', () => {
  it('claims nothing while the session is still being checked', () => {
    const html = render({ kind: 'loading' });
    expect(html).not.toContain(DATE_OF_BIRTH_SUBMIT);
    expect(html).not.toContain(DECLARED_HEADING);
  });

  it('does not tell an unreadable profile to go and log in', () => {
    const html = render(unreadable);

    expect(html).toContain(PROFILE_UNAVAILABLE_MESSAGE);
    // No login link: the person may well be signed in already, and a click there
    // is what turns a rate limit into a longer one.
    expect(html).not.toContain(`href="${SIGN_IN_PATHNAME}"`);
    expect(html).not.toContain('<form');
  });

  /**
   * M4, on the screen rather than in the decision: a rate-limited load says how
   * long, and the only button on the branch waits for it.
   */
  it('says how long to wait, and disables the retry until it is over', () => {
    const html = render({ kind: 'unavailable', retryAfterSeconds: 45 });

    expect(html).toContain(RATE_LIMITED_MESSAGE);
    expect(html).toContain(countdownLabel(45));
    expect(html).toContain('disabled');
    // And it is not the vague sentence: this branch knows more than "sau ít phút".
    expect(html).not.toContain(PROFILE_UNAVAILABLE_MESSAGE);
  });

  it('leaves the retry usable when there is no wait to observe', () => {
    // Without this, "disabled" above could be satisfied by a branch that disables
    // the button always — which is the dead end, not the fix for it.
    const html = render(unreadable);

    expect(html).toContain(PROFILE_RETRY_LABEL);
    expect(html).not.toContain('disabled');
  });

  it('offers a way to the login page, not a form, when signed out', () => {
    const html = render({ kind: 'signed-out' });
    // The route comes from the contract, so a rename cannot leave this behind.
    expect(html).toContain(`href="${SIGN_IN_PATHNAME}"`);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
  });

  it('renders a labelled field under the contract name when a declaration is needed', () => {
    const html = render({ kind: 'needs-declaration', user: user() });

    expect(html).toContain(DATE_OF_BIRTH_LABEL);
    expect(html).toContain(`name="${DATE_OF_BIRTH_FIELD}"`);
    // The label has to point at the field, or a screen reader announces neither.
    expect(html).toContain('for="ngay-sinh"');
    expect(html).toContain('id="ngay-sinh"');
    expect(html).toContain(DATE_OF_BIRTH_SUBMIT);
  });

  it('says the declaration happens once, on the screen and not only in a docblock', () => {
    // The one-write rule is the thing a person most needs to know BEFORE they
    // type, because there is no way to correct it afterwards.
    expect(render({ kind: 'needs-declaration', user: user() })).toContain(DATE_OF_BIRTH_HINT);
  });

  it('offers NO form once the declaration is made', () => {
    // The row that matters: there is no endpoint that would accept a second
    // value, so a form here is a button that can only ever produce a refusal.
    const html = render({ kind: 'declared' });

    expect(html).toContain(DECLARED_HEADING);
    expect(html).toContain(DATE_OF_BIRTH_ALREADY_SET_MESSAGE);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain(DATE_OF_BIRTH_SUBMIT);
  });

  it('offers a way ONWARD from the terminal branch, which used to have none', () => {
    // It was the only state on this screen with nothing at all to click: a sentence,
    // and then the person had to invent their own next move. The account view is the
    // login route, which renders the signed-in panel and the sign-out button.
    const html = render({ kind: 'declared' });

    expect(html).toContain(`href="${SIGN_IN_PATHNAME}"`);
    expect(html).toContain(BACK_TO_ACCOUNT_LINK);
  });

  it('promises no support channel, because there is not one', () => {
    // `deferred-work.md` records that the flow this sentence used to name does not
    // exist: no inbox, no operator tool, no role that can write the column twice.
    // Sending somebody to look for it costs them the search and finds nothing.
    for (const html of [
      render({ kind: 'declared' }),
      render({ kind: 'needs-declaration', user: user() }),
    ]) {
      expect(html).not.toContain('hỗ trợ');
    }
  });
});

describe('the screen never renders a date of birth or an age', () => {
  /**
   * The PII row of the matrix, on the client side. The API cannot send a date of
   * birth — `currentUserSchema` has no field for one — so this is about the other
   * half: that the screen does not put one on the page from anything it holds.
   */
  it('shows no date and no age on the confirmation', () => {
    const html = render({ kind: 'declared' });

    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    for (const word of AGE_VOCABULARY) {
      expect(html, `the confirmation must not mention "${word}"`).not.toContain(word);
    }
  });

  it('shows no age on the form either', () => {
    // Naming the threshold on the form tells somebody who is under it exactly which
    // year to type instead. The form DOES carry `min` for the picker, so the rule is
    // over age vocabulary rather than over every digit on the page.
    //
    // `AGE_VOCABULARY` comes from `packages/contracts` — it used to be copied here
    // with two words missing, so this screen could have said "dưới 18" or "trưởng
    // thành" while the contract suite claimed the whole vocabulary was covered.
    const html = render({ kind: 'needs-declaration', user: user() });
    for (const word of AGE_VOCABULARY) {
      expect(html, `the form must not mention "${word}"`).not.toContain(word);
    }
  });
});

describe('a notice is shown where it belongs and nowhere else', () => {
  it('renders the refusal beside the field, as an alert', () => {
    const html = render({ kind: 'needs-declaration', user: user() }, DATE_OF_BIRTH_INVALID_MESSAGE);
    expect(html).toContain('role="alert"');
    expect(html).toContain(DATE_OF_BIRTH_INVALID_MESSAGE);
  });

  it('renders nothing when there is no notice', () => {
    expect(render({ kind: 'needs-declaration', user: user() })).not.toContain('role="alert"');
  });

  it('does not carry a stale notice onto the confirmation screen', () => {
    // Once the declaration is made, a refusal from a previous attempt is telling
    // somebody about a problem that no longer exists.
    const html = render({ kind: 'declared' }, DATE_OF_BIRTH_INVALID_MESSAGE);
    expect(html).not.toContain(DATE_OF_BIRTH_INVALID_MESSAGE);
  });
});

describe('the submit button is disabled while a declaration is in flight', () => {
  it('disables it, so a double tap does not spend the one write twice', () => {
    // A courtesy, not the control: the real one is the conditional UPDATE in the
    // adapter. But without it, the second tap gets a 409 and a person who did
    // nothing wrong sees a refusal.
    const html = renderToStaticMarkup(
      <DateOfBirthPanel
        state={{ kind: 'needs-declaration', user: user() }}
        notice={null}
        submitting
        onRetry={() => undefined}
        onWaitFinished={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('disabled');
  });
});

/**
 * The wiring a screen reader needs, and the way out of `unavailable`.
 *
 * None of it is decoration. An input whose hint and whose error are on the page
 * but not attached to it is an input that reads as bare, and a branch that offers
 * one sentence and no control is a dead end somebody has to guess their way out
 * of (a page reload, which nothing tells them to try).
 */
describe('the field is wired up for somebody who cannot see it', () => {
  it('describes the field with the hint, always', () => {
    const html = render({ kind: 'needs-declaration', user: user() });
    expect(html).toContain(`aria-describedby="${DATE_OF_BIRTH_HINT_ID}"`);
    expect(html).toContain(`id="${DATE_OF_BIRTH_HINT_ID}"`);
  });

  it('adds the error to the description WITHOUT dropping the hint', () => {
    // Replacing rather than adding is the tempting shape and the wrong one: the
    // person hears the complaint and loses the instruction that would fix it.
    expect(dateOfBirthDescribedBy(true)).toBe(`${DATE_OF_BIRTH_HINT_ID} ${DATE_OF_BIRTH_ERROR_ID}`);
    expect(dateOfBirthDescribedBy(false)).toBe(DATE_OF_BIRTH_HINT_ID);

    const html = render({ kind: 'needs-declaration', user: user() }, DATE_OF_BIRTH_INVALID_MESSAGE);
    expect(html).toContain(
      `aria-describedby="${DATE_OF_BIRTH_HINT_ID} ${DATE_OF_BIRTH_ERROR_ID}"`,
    );
    expect(html).toContain(`id="${DATE_OF_BIRTH_ERROR_ID}"`);
  });

  it('marks the field invalid only while a message is on screen', () => {
    expect(render({ kind: 'needs-declaration', user: user() })).not.toContain('aria-invalid');
    expect(
      render({ kind: 'needs-declaration', user: user() }, DATE_OF_BIRTH_INVALID_MESSAGE),
    ).toContain('aria-invalid="true"');
  });

  it('announces the loading branch, like the other two that claim nothing', () => {
    // It was the only state of this screen a screen reader was never told about.
    expect(render({ kind: 'loading' })).toContain('role="status"');
  });

  it('offers a way out of "we could not read your profile"', () => {
    const html = render(unreadable);
    expect(html).toContain(PROFILE_RETRY_LABEL);
    expect(html).toContain('<button');
    // And it is still not a login prompt: this person may well be signed in.
    expect(html).not.toContain(SIGN_IN_PATHNAME);
  });
});

/**
 * M1 — the form field's name is written in ONE place.
 *
 * `page.tsx` used to pass `inputName={DATE_OF_BIRTH_FIELD}` and read the submitted
 * form back with the same constant: two halves, two files, nothing holding them
 * equal. Passing `inputName="ngay-sinh"` — an easy mistake, since the `id` and the
 * `htmlFor` are already that string — broke the screen permanently, every submit
 * answering "Ngày sinh chưa hợp lệ", with every test green because this file
 * supplied the prop itself.
 */
describe('the field name cannot drift between where it is written and where it is read', () => {
  it('renders the contract field name, with no prop able to say otherwise', () => {
    const html = render({ kind: 'needs-declaration', user: user() });
    expect(html).toContain(`name="${DATE_OF_BIRTH_FIELD}"`);
  });

  it('is the same name the request body carries', () => {
    // The two halves the page puts together: what the form is named, and what the
    // body is keyed on. One constant, so they cannot disagree.
    expect(Object.keys(JSON.parse(dateOfBirthRequestBody('1999-04-02')))).toEqual([
      DATE_OF_BIRTH_FIELD,
    ]);
  });

  it('is the name a FormData built from the rendered markup would answer to', () => {
    // The end-to-end shape of the round trip, without a DOM: the markup declares
    // this name, and `page.tsx` reads `FormData.get(DATE_OF_BIRTH_FIELD)`. Both
    // sides now come from the constant, so this asserts the one that is rendered.
    const html = render({ kind: 'needs-declaration', user: user() });
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual([DATE_OF_BIRTH_FIELD]);
  });
});
