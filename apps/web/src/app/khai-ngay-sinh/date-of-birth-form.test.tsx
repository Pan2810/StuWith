import {
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  SIGN_IN_PATHNAME,
  type CurrentUser,
} from '@stuwith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DATE_OF_BIRTH_HINT,
  DATE_OF_BIRTH_LABEL,
  DATE_OF_BIRTH_SUBMIT,
  DECLARED_HEADING,
  DateOfBirthPanel,
  PROFILE_UNAVAILABLE_MESSAGE,
  SESSION_LOST_MESSAGE,
  TRY_AGAIN_MESSAGE,
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
const TODAY = new Date('2026-09-04T09:00:00.000Z');

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: '019200f0-0000-7000-8000-000000000001',
    display_name: 'An Nguyen',
    avatar_url: null,
    role: 'user',
    ...overrides,
  };
}

function render(state: DateOfBirthScreenState, notice: string | null = null): string {
  return renderToStaticMarkup(
    <DateOfBirthPanel
      state={state}
      notice={notice}
      submitting={false}
      inputName={DATE_OF_BIRTH_FIELD}
      onSubmit={() => undefined}
    />,
  );
}

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
    expect(profileLoadStateFor(200, user({ profile_completed: true })).kind).toBe('declared');
    expect(profileLoadStateFor(200, user({ profile_completed: false })).kind).toBe(
      'needs-declaration',
    );
  });

  it('reads a 401 as signed out', () => {
    expect(profileLoadStateFor(401, null).kind).toBe('signed-out');
  });

  it.each([[429], [500], [502], [503], [0]])(
    'reads %i as "could not read the profile", NOT as signed out',
    (status) => {
      // `/v1/auth/me` is rate limited, so a 429 is a real answer this screen gets.
      // Calling it "signed out" sends somebody who IS signed in to a login page
      // where every click spends another attempt and lengthens the wait — the
      // same defect Story 1.3 fixed on /dang-nhap, arriving through another door.
      expect(profileLoadStateFor(status, null).kind).toBe('unavailable');
    },
  );

  it('does not trust a 200 that carried no profile', () => {
    expect(profileLoadStateFor(200, null).kind).toBe('unavailable');
  });
});

describe('dateOfBirthSubmission — nothing unusable is ever sent', () => {
  it('passes a good value through unchanged', () => {
    const submission = dateOfBirthSubmission('1999-04-02', TODAY);
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
    ['a future date', '2026-09-05'],
    ['an implausible year', '0001-01-01'],
    ['a File, which is what FormData.get returns for a file input', new Blob()],
    ['null, which is what FormData.get returns for a missing field', null],
  ])('refuses %s with the same sentence the server would have sent', (_label, raw) => {
    const submission = dateOfBirthSubmission(raw, TODAY);
    expect(submission.kind).toBe('invalid');
    expect(submission.kind === 'invalid' && submission.message).toBe(
      DATE_OF_BIRTH_INVALID_MESSAGE,
    );
  });

  it('judges "in the future" against the instant it is given, not the wall clock', () => {
    expect(dateOfBirthSubmission('2026-09-05', TODAY).kind).toBe('invalid');
    expect(
      dateOfBirthSubmission('2026-09-05', new Date('2026-09-06T00:00:00.000Z')).kind,
    ).toBe('send');
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
  it('treats 200 as declared', () => {
    expect(declarationOutcomeFor(200).kind).toBe('declared');
  });

  it('treats 409 as declared too, because the profile HAS a date of birth', () => {
    // Two tabs, or a double tap. The state this page exists to reach was reached
    // by somebody else's request, and showing an error would strand a person on a
    // screen whose job is done.
    expect(declarationOutcomeFor(409).kind).toBe('declared');
  });

  it('shows the same refusal sentence for a 400 as the field does locally', () => {
    expect(declarationOutcomeFor(400)).toEqual({
      kind: 'message',
      message: DATE_OF_BIRTH_INVALID_MESSAGE,
    });
  });

  it('says the session ended for a 401', () => {
    expect(declarationOutcomeFor(401)).toEqual({
      kind: 'message',
      message: SESSION_LOST_MESSAGE,
    });
  });

  it.each([[0], [429], [500], [502], [418]])(
    'defaults %i to "we do not know that it worked", never to declared',
    (status) => {
      // The dangerous default is the other one: telling somebody their profile is
      // complete on the strength of a 502 means they never come back to finish it.
      expect(declarationOutcomeFor(status)).toEqual({
        kind: 'message',
        message: TRY_AGAIN_MESSAGE,
      });
    },
  );

  it('never says anything technical', () => {
    for (const status of [0, 400, 401, 429, 500, 502]) {
      const outcome = declarationOutcomeFor(status);
      if (outcome.kind !== 'message') continue;
      for (const leak of [String(status), 'HTTP', 'server', 'API', 'fetch']) {
        expect(outcome.message).not.toContain(leak);
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
    const html = render({ kind: 'unavailable' });

    expect(html).toContain(PROFILE_UNAVAILABLE_MESSAGE);
    // No login link: the person may well be signed in already, and a click there
    // is what turns a rate limit into a longer one.
    expect(html).not.toContain(`href="${SIGN_IN_PATHNAME}"`);
    expect(html).not.toContain('<form');
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
    const html = render({ kind: 'declared', user: user({ profile_completed: true }) });

    expect(html).toContain(DECLARED_HEADING);
    expect(html).toContain(DATE_OF_BIRTH_ALREADY_SET_MESSAGE);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain(DATE_OF_BIRTH_SUBMIT);
  });
});

describe('the screen never renders a date of birth or an age', () => {
  /**
   * The PII row of the matrix, on the client side. The API cannot send a date of
   * birth — `currentUserSchema` has no field for one — so this is about the other
   * half: that the screen does not put one on the page from anything it holds.
   */
  it('shows no date and no age on the confirmation', () => {
    const html = render({
      kind: 'declared',
      user: user({ profile_completed: true, is_over_18: true }),
    });

    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toContain('18');
    expect(html).not.toContain('tuổi');
  });

  it('shows no age on the form either', () => {
    const html = render({ kind: 'needs-declaration', user: user() });
    // Naming the threshold on the form tells somebody who is under it exactly
    // which year to type instead.
    expect(html).not.toContain('18');
    expect(html).not.toContain('tuổi');
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
    const html = render(
      { kind: 'declared', user: user({ profile_completed: true }) },
      DATE_OF_BIRTH_INVALID_MESSAGE,
    );
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
        inputName={DATE_OF_BIRTH_FIELD}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('disabled');
  });
});
