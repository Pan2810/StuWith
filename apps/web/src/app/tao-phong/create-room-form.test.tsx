import {
  CREATE_ROOM_FIELDS,
  CREATE_ROOM_INVALID_MESSAGE,
  MAX_ROOM_DESCRIPTION_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  PLAN_PARTICIPANT_LIMITS,
  RATE_LIMITED_MESSAGE,
  ROOM_TOPICS,
  ROOM_VISIBILITIES,
  SIGN_IN_PATHNAME,
  type CurrentUser,
  type Room,
} from '@stuwith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { countdownLabel } from '../dang-nhap/countdown-text';
import { LOCALES, type Locale } from '../i18n/locale';
import { VI_TRANSLATE, translatorFor, type MessageKey } from '../i18n/messages';
import { I18nProvider } from '../i18n/use-t';
import { PROFILE_RETRY_KEY, PROFILE_UNAVAILABLE_KEY } from '../profile-load';
import {
  CREATED_HEADING_KEY,
  CREATE_ANOTHER_KEY,
  CREATE_ROOM_ERROR_ID,
  CREATE_ROOM_HEADING_KEY,
  CREATE_ROOM_INVALID_KEY,
  CREATE_ROOM_SUBMIT_KEY,
  CreateRoomPanel,
  REQUEST_NOT_SENT_KEY,
  ROOM_DESCRIPTION_HINT_ID,
  ROOM_DESCRIPTION_INPUT_ID,
  ROOM_NAME_HINT_ID,
  ROOM_NAME_INPUT_ID,
  SESSION_LOST_KEY,
  TRY_AGAIN_KEY,
  createRoomDescribedBy,
  createRoomNameInvalid,
  createRoomOutcomeFor,
  createRoomRequestBody,
  createRoomStateFor,
  createRoomSubmission,
  createRoomSubmissionFrom,
  createRoomIsWaiting,
  screenStateFromOutcome,
  type CreateRoomScreenState,
} from './create-room-form';

/**
 * The web half of Story 2.1's matrix, executed.
 *
 * These render for real: `renderToStaticMarkup` is `react-dom`, already a
 * dependency, and needs no DOM environment — so the assertions are about actual
 * output HTML rather than about a value on its way to a renderer. The residual this
 * cannot cover is the one `date-of-birth-form.test.tsx` names: that React INVOKES
 * the page's effect at all, and that a submitted form reaches the API. Those are
 * `tests/e2e/web/tao-phong.spec.ts`, in a browser.
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

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: '019200f1-0000-7000-8000-000000000001',
    owner_user_id: '019200f0-0000-7000-8000-000000000001',
    name: 'Lop toi',
    description: '',
    topic: 'on_thi',
    visibility: 'public',
    max_participants: PLAN_PARTICIPANT_LIMITS.study_buddy,
    status: 'open',
    created_at: '2026-09-07T09:00:00.000Z',
    updated_at: '2026-09-07T09:00:00.000Z',
    ...overrides,
  };
}

/** The panel, with a message or without one, in Vietnamese by default. */
function render(state: CreateRoomScreenState, messageKey: MessageKey | null = null): string {
  return renderToStaticMarkup(
    <CreateRoomPanel
      state={state}
      notice={messageKey === null ? null : { messageKey, retryAfterSeconds: null }}
      submitting={false}
      onRetry={() => undefined}
      onWaitFinished={() => undefined}
      onSubmitWaitFinished={() => undefined}
      onSubmit={() => undefined}
      onCreateAnother={() => undefined}
    />,
  );
}

/** The same panel inside a locale, for the two-language assertions. */
function renderIn(locale: Locale, state: CreateRoomScreenState): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale}>
      <CreateRoomPanel
        state={state}
        notice={null}
        submitting={false}
        onRetry={() => undefined}
        onWaitFinished={() => undefined}
        onSubmitWaitFinished={() => undefined}
        onSubmit={() => undefined}
        onCreateAnother={() => undefined}
      />
    </I18nProvider>,
  );
}

/** A form whose fields answer from a plain object, standing in for `FormData.get`. */
const reader =
  (values: Record<string, unknown>) =>
  (field: string): unknown =>
    field in values ? values[field] : null;

const VALID_FORM = {
  [CREATE_ROOM_FIELDS.name]: 'Ôn thi cuối kỳ',
  [CREATE_ROOM_FIELDS.description]: 'Học nhóm buổi tối.',
  [CREATE_ROOM_FIELDS.topic]: 'on_thi',
  [CREATE_ROOM_FIELDS.visibility]: 'public',
};

describe('createRoomStateFor — what an answer from /v1/auth/me means here', () => {
  it('offers the form to anybody with a readable profile', () => {
    expect(createRoomStateFor(200, user(), null).kind).toBe('ready');
  });

  it('does NOT gate on the declaration flags, because no endpoint does', () => {
    // A rule enforced by a screen and by nothing else refuses somebody the API
    // would have accepted, and the person has no way to find out which is right.
    expect(createRoomStateFor(200, user({ profile_completed: false }), null).kind).toBe('ready');
    expect(createRoomStateFor(200, user({ is_over_18: false }), null).kind).toBe('ready');
  });

  it('treats a 401, and only a 401, as signed out', () => {
    expect(createRoomStateFor(401, null, null).kind).toBe('signed-out');
  });

  it.each([0, 429, 500, 503, 200])(
    'treats %d without a usable profile as unavailable, never as signed out',
    (status) => {
      // Telling a rate-limited or unlucky visitor to go and log in sends them to a
      // page where every click makes the wait longer — the defect Story 1.3 fixed
      // on `/dang-nhap`, arriving through a third screen.
      expect(createRoomStateFor(status, null, null).kind).toBe('unavailable');
    },
  );

  it('carries the wait out of a 429, and only out of a 429', () => {
    expect(createRoomStateFor(429, null, '45')).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: 45,
    });
    expect(createRoomStateFor(500, null, '45')).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: null,
    });
  });

  it('refuses a nonsense Retry-After rather than putting it on the screen', () => {
    // The header travels from a server; the value is judged by the same parser the
    // sign-in countdown uses, so no header can put "thử lại sau 1157 ngày" on screen.
    expect(createRoomStateFor(429, null, '99999999')).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: null,
    });
  });

  it('maps every outcome the shared reader can produce', () => {
    // The mapping in isolation, so the shared reading and this screen's states are
    // both testable rather than only their composition.
    expect(screenStateFromOutcome({ kind: 'profile', user: user() }).kind).toBe('ready');
    expect(screenStateFromOutcome({ kind: 'signed-out' }).kind).toBe('signed-out');
    expect(screenStateFromOutcome({ kind: 'unavailable', retryAfterSeconds: 3 })).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: 3,
    });
  });
});

describe('createRoomSubmission — the pre-flight, and it is the SERVER’s rule', () => {
  it('sends a complete form', () => {
    const submission = createRoomSubmissionFrom(reader(VALID_FORM));
    expect(submission.kind).toBe('send');
    expect(submission.kind === 'send' && submission.value.topic).toBe('on_thi');
  });

  it('trims the name, so what is shown afterwards is what was stored', () => {
    const submission = createRoomSubmissionFrom(
      reader({ ...VALID_FORM, [CREATE_ROOM_FIELDS.name]: '   Lớp tối   ' }),
    );
    expect(submission.kind === 'send' && submission.value.name).toBe('Lớp tối');
  });

  const REFUSED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a blank name', { ...VALID_FORM, [CREATE_ROOM_FIELDS.name]: '   ' }],
    ['an empty name', { ...VALID_FORM, [CREATE_ROOM_FIELDS.name]: '' }],
    [
      'a name past the ceiling',
      { ...VALID_FORM, [CREATE_ROOM_FIELDS.name]: 'x'.repeat(MAX_ROOM_NAME_LENGTH + 1) },
    ],
    [
      'a description past the ceiling',
      {
        ...VALID_FORM,
        [CREATE_ROOM_FIELDS.description]: 'x'.repeat(MAX_ROOM_DESCRIPTION_LENGTH + 1),
      },
    ],
    ['a topic nobody declared', { ...VALID_FORM, [CREATE_ROOM_FIELDS.topic]: 'xyz' }],
    ['a visibility nobody declared', { ...VALID_FORM, [CREATE_ROOM_FIELDS.visibility]: 'secret' }],
    // An unchosen radio group is what `FormData.get` answers `null` for, which is
    // the shape the reader above reproduces. Without a total parser this is where
    // the page would throw instead of showing a message.
    ['an unchosen topic', { ...VALID_FORM, [CREATE_ROOM_FIELDS.topic]: null }],
    ['an unchosen visibility', { ...VALID_FORM, [CREATE_ROOM_FIELDS.visibility]: null }],
    ['an empty form', {}],
  ];

  it.each(REFUSED)('refuses %s with the shared sentence', (_label, values) => {
    const submission = createRoomSubmissionFrom(reader(values));
    expect(submission.kind).toBe('invalid');
    expect(submission.kind === 'invalid' && submission.messageKey).toBe(CREATE_ROOM_INVALID_KEY);
    // The SAME sentence `apps/api` answers with, so one mistake has one explanation
    // whether or not the network was involved. Imported from the contract, never
    // retyped.
    expect(VI_TRANSLATE(CREATE_ROOM_INVALID_KEY)).toBe(CREATE_ROOM_INVALID_MESSAGE);
  });

  it('accepts a name and a description exactly at the ceiling', () => {
    // The other side of the boundary. Testing only the refusal leaves an off-by-one
    // invisible, and an off-by-one here refuses a room the API would have created.
    const submission = createRoomSubmissionFrom(
      reader({
        ...VALID_FORM,
        [CREATE_ROOM_FIELDS.name]: 'x'.repeat(MAX_ROOM_NAME_LENGTH),
        [CREATE_ROOM_FIELDS.description]: 'y'.repeat(MAX_ROOM_DESCRIPTION_LENGTH),
      }),
    );
    expect(submission.kind).toBe('send');
  });

  it.each([...ROOM_TOPICS])('accepts the topic %s', (topic) => {
    expect(createRoomSubmissionFrom(reader({ ...VALID_FORM, topic })).kind).toBe('send');
  });

  it.each([...ROOM_VISIBILITIES])('accepts the visibility %s', (visibility) => {
    expect(createRoomSubmissionFrom(reader({ ...VALID_FORM, visibility })).kind).toBe('send');
  });

  it.each([null, undefined, 42, 'a room', [], true])(
    'refuses the non-object body %s without throwing',
    (raw) => {
      // The page never sends one of these, but the parser is shared with `apps/api`
      // and totality is what keeps a malformed body a message rather than a crash.
      expect(createRoomSubmission(raw).kind).toBe('invalid');
    },
  );

  it('builds the request body out of the PARSED value, so the trim survives', () => {
    const submission = createRoomSubmissionFrom(
      reader({ ...VALID_FORM, [CREATE_ROOM_FIELDS.name]: '  Lớp tối  ' }),
    );
    if (submission.kind !== 'send') throw new Error('expected a sendable submission');

    const body = JSON.parse(createRoomRequestBody(submission.value)) as Record<string, unknown>;

    expect(body[CREATE_ROOM_FIELDS.name]).toBe('Lớp tối');
    // And the cap is NOT in it. The field does not exist in the contract, so there
    // is no spelling of this body that could influence the room's capacity.
    expect(Object.keys(body).sort()).toEqual(
      [
        CREATE_ROOM_FIELDS.name,
        CREATE_ROOM_FIELDS.description,
        CREATE_ROOM_FIELDS.topic,
        CREATE_ROOM_FIELDS.visibility,
      ].sort(),
    );
    expect(Object.keys(body)).not.toContain('max_participants');
  });
});

describe('createRoomOutcomeFor — what a status means to this screen', () => {
  it('treats 201, and only 201, as created', () => {
    expect(createRoomOutcomeFor(201, null).kind).toBe('created');
    for (const status of [200, 202, 204, 400, 401, 500]) {
      expect(createRoomOutcomeFor(status, null).kind, `${status} must not read as created`).toBe(
        'message',
      );
    }
  });

  it.each([
    [400, CREATE_ROOM_INVALID_KEY],
    [401, SESSION_LOST_KEY],
    [413, REQUEST_NOT_SENT_KEY],
    [415, REQUEST_NOT_SENT_KEY],
    [500, TRY_AGAIN_KEY],
    [502, TRY_AGAIN_KEY],
    [0, TRY_AGAIN_KEY],
  ])('maps %d onto %s', (status, key) => {
    const outcome = createRoomOutcomeFor(status, null);
    expect(outcome.kind === 'message' && outcome.notice.messageKey).toBe(key);
  });

  it('reads the wait out of a 429 and says the shared sentence', () => {
    const outcome = createRoomOutcomeFor(429, '30');
    expect(outcome.kind === 'message' && outcome.notice.messageKey).toBe('error.rateLimited');
    expect(outcome.kind === 'message' && outcome.notice.retryAfterSeconds).toBe(30);
    expect(VI_TRANSLATE('error.rateLimited')).toBe(RATE_LIMITED_MESSAGE);
  });

  it('says nothing about a wait when the header is missing or nonsense', () => {
    // `null` means "no clock", never "zero" — a countdown that has already finished
    // invites an immediate retry.
    for (const header of [null, '', '0', 'soon', '99999999']) {
      const outcome = createRoomOutcomeFor(429, header);
      expect(outcome.kind === 'message' && outcome.notice.retryAfterSeconds).toBeNull();
    }
  });

  it('never says anything technical', () => {
    // No status code, no endpoint, no "the server returned". A number from an HTTP
    // specification is neither what happened nor what to do next.
    for (const status of [400, 401, 413, 429, 500, 502]) {
      const outcome = createRoomOutcomeFor(status, '30');
      if (outcome.kind !== 'message') continue;
      for (const locale of LOCALES) {
        const sentence = translatorFor(locale)(outcome.notice.messageKey);
        expect(sentence).not.toContain(String(status));
        expect(sentence.toLowerCase()).not.toContain('http');
        expect(sentence).not.toContain('/v1');
      }
    }
  });

  it('is waiting only when the last attempt left a clock', () => {
    expect(createRoomIsWaiting(null)).toBe(false);
    expect(createRoomIsWaiting({ messageKey: TRY_AGAIN_KEY, retryAfterSeconds: null })).toBe(false);
    // Zero is a clock, not the absence of one: `null` means "no wait" and `0` means
    // "a wait that is over", and collapsing them here would leave the button
    // disabled for ever on the second reading.
    expect(createRoomIsWaiting({ messageKey: 'error.rateLimited', retryAfterSeconds: 0 })).toBe(true);
    expect(createRoomIsWaiting({ messageKey: 'error.rateLimited', retryAfterSeconds: 30 })).toBe(
      true,
    );
  });
});

describe('a wait that arrives with the form on screen stops the form', () => {
  /**
   * The defect this covers shipped and survived a review round: a `429` on submit
   * drew the remaining seconds as a static sentence beside a send button that stayed
   * live, so the number never moved and every press during the lockout spent another
   * attempt. Three assertions, because the three halves fail independently — the
   * clock can be live while the button is live, and the button can be disabled with
   * no clock beside it to say why.
   */
  const rateLimited = (retryAfterSeconds: number | null) =>
    renderToStaticMarkup(
      <CreateRoomPanel
        state={{ kind: 'ready' }}
        notice={{ messageKey: 'error.rateLimited', retryAfterSeconds }}
        submitting={false}
        onRetry={() => undefined}
        onWaitFinished={() => undefined}
        onSubmitWaitFinished={() => undefined}
        onSubmit={() => undefined}
        onCreateAnother={() => undefined}
      />,
    );

  it('disables the send button while the clock runs', () => {
    expect(rateLimited(30)).toContain('disabled=""');
  });

  it('renders a RUNNING countdown, not a sentence with a number in it', () => {
    // `notice-countdown` is `SignInCountdown`'s own element — the one with the
    // `useEffect` that re-renders every second. The old arrangement appended
    // `countdownLabel(...)` to the message and produced identical text inside the
    // `notice-alert` paragraph, which is why nothing could see the difference.
    const html = rateLimited(30);

    expect(html).toContain('notice-countdown');
    expect(html).toContain(countdownLabel(30, VI_TRANSLATE));
    expect(
      html.slice(html.indexOf('notice-alert'), html.indexOf('notice-countdown')),
    ).not.toContain(countdownLabel(30, VI_TRANSLATE));
  });

  it('leaves the button live for a message that carries no wait', () => {
    // The other direction. A button disabled by every notice would satisfy the first
    // example perfectly and lock somebody out of their own form after one typo.
    const html = renderToStaticMarkup(
      <CreateRoomPanel
        state={{ kind: 'ready' }}
        notice={{ messageKey: TRY_AGAIN_KEY, retryAfterSeconds: null }}
        submitting={false}
        onRetry={() => undefined}
        onWaitFinished={() => undefined}
        onSubmitWaitFinished={() => undefined}
        onSubmit={() => undefined}
        onCreateAnother={() => undefined}
      />,
    );

    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('notice-countdown');
  });
});

describe('CreateRoomPanel — what each state actually renders', () => {
  it('offers the form, with a name field, a description field and both groups', () => {
    const html = render({ kind: 'ready' });

    expect(html).toContain('<form');
    expect(html).toContain(`id="${ROOM_NAME_INPUT_ID}"`);
    expect(html).toContain(`id="${ROOM_DESCRIPTION_INPUT_ID}"`);
    expect(html).toContain('<textarea');
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
  });

  it('gives every input a label that points at it', () => {
    // The acceptance criterion, as a property of the markup: "mọi ô nhập có nhãn
    // liên kết". The two text fields are labelled by `for`/`id`; the eight radios
    // are labelled by being INSIDE their `<label>`, which needs no id at all — and
    // eight ids that must stay unique is eight chances to repeat one.
    const html = render({ kind: 'ready' });

    expect(html).toContain(`for="${ROOM_NAME_INPUT_ID}"`);
    expect(html).toContain(`for="${ROOM_DESCRIPTION_INPUT_ID}"`);

    const radios = html.match(/<input type="radio"/g) ?? [];
    expect(radios.length).toBe(ROOM_TOPICS.length + ROOM_VISIBILITIES.length);
    // Every radio sits inside a `<label class="choice">`, so none of them is a
    // control with no accessible name.
    const wrapped = html.match(/<label class="choice"><input type="radio"/g) ?? [];
    expect(wrapped.length).toBe(radios.length);
  });

  it('renders one radio per declared topic and per declared visibility, by CODE', () => {
    const html = render({ kind: 'ready' });
    for (const topic of ROOM_TOPICS) {
      expect(html, `${topic} must be offered`).toContain(`value="${topic}"`);
    }
    for (const visibility of ROOM_VISIBILITIES) {
      expect(html, `${visibility} must be offered`).toContain(`value="${visibility}"`);
    }
  });

  it('never shows a wire code as a LABEL, in either language', () => {
    // `ROOM_TOPICS` is a `snake_case` enum two processes agree on, not a word in any
    // language. The codes are in the `value` attributes above and must not be the
    // text a person reads — the `org_admin` defect Story 2.0 fixed for roles.
    for (const locale of LOCALES) {
      const html = renderIn(locale, { kind: 'ready' });
      const text = html.replace(/<[^>]*>/g, ' ');
      for (const topic of ROOM_TOPICS) {
        expect(text, `${topic} leaked into the text in ${locale}`).not.toContain(topic);
      }
    }
  });

  it('labels every topic differently, so no two options read the same', () => {
    for (const locale of LOCALES) {
      const t = translatorFor(locale);
      const labels = ROOM_TOPICS.map((topic) =>
        t(`createRoom.topic${topicKeySuffix(topic)}` as MessageKey),
      );
      expect(new Set(labels).size, `two topics share a label in ${locale}`).toBe(labels.length);
    }
  });

  it('does not offer the form once the room exists', () => {
    // "The room exists" and "here is a form to create one" are the same decision.
    // Rendering both is the bug the single-component shape makes unexpressible.
    const html = render({ kind: 'created', room: room({ name: 'Lop toi' }) });

    expect(html).not.toContain('<form');
    expect(html).toContain('Lop toi');
    expect(html).toContain(VI_TRANSLATE(CREATED_HEADING_KEY));
    expect(html).toContain(VI_TRANSLATE(CREATE_ANOTHER_KEY));
  });

  it('states the capacity the SERVER stored, not one it worked out', () => {
    // There is no plan arithmetic in `apps/web`. A Campus room says 45 because the
    // body said 45.
    const html = render({ kind: 'created', room: room({ max_participants: 45 }) });
    expect(html).toContain('45');
    expect(html).not.toContain('campus');
  });

  it('uses the right plural for the capacity in each language', () => {
    // The product's second plural, and the first that is not a countdown.
    // Vietnamese has one category and English has two; `Intl.PluralRules` chooses.
    const oneEn = renderIn('en', { kind: 'created', room: room({ max_participants: 1 }) });
    const manyEn = renderIn('en', { kind: 'created', room: room({ max_participants: 45 }) });

    expect(oneEn).toContain(translatorFor('en').plural('createRoom.capacity', 1, { count: 1 }));
    expect(manyEn).toContain(translatorFor('en').plural('createRoom.capacity', 45, { count: 45 }));
    expect(oneEn).not.toBe(manyEn);
  });

  it('escapes a room name that looks like markup', () => {
    // The name comes back from the API and originated with a person. React escapes
    // it; this is the assertion that says so, because the day somebody reaches for
    // `dangerouslySetInnerHTML` here nothing else would notice.
    const html = render({ kind: 'created', room: room({ name: '<script>alert(1)</script>' }) });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('sends a signed-out visitor to the login page, through the contract constant', () => {
    const html = render({ kind: 'signed-out' });
    expect(html).toContain(`href="${SIGN_IN_PATHNAME}"`);
    expect(html).not.toContain('<form');
  });

  it('says "we are checking" while it does not know', () => {
    const html = render({ kind: 'loading' });
    expect(html).toContain('role="status"');
    expect(html).toContain(VI_TRANSLATE('signIn.checkingSession'));
    expect(html).not.toContain('<form');
  });

  it('offers a retry when the profile could not be read, and no login link', () => {
    const html = render({ kind: 'unavailable', retryAfterSeconds: null });
    expect(html).toContain(VI_TRANSLATE(PROFILE_UNAVAILABLE_KEY));
    expect(html).toContain(VI_TRANSLATE(PROFILE_RETRY_KEY));
    expect(html).not.toContain(`href="${SIGN_IN_PATHNAME}"`);
  });

  it('disables the retry button while a rate-limit wait is running', () => {
    // The loop this state exists to break: a button that calls straight back into
    // the limit makes the wait longer with every press.
    const html = render({ kind: 'unavailable', retryAfterSeconds: 30 });
    expect(html).toContain('disabled');
  });

  it('marks the name field invalid and describes the error, only while there is one', () => {
    const clean = render({ kind: 'ready' });
    const failed = render({ kind: 'ready' }, CREATE_ROOM_INVALID_KEY);

    expect(clean).not.toContain('aria-invalid');
    expect(failed).toContain('aria-invalid="true"');
    expect(failed).toContain(`id="${CREATE_ROOM_ERROR_ID}"`);
    expect(failed).toContain('role="alert"');
  });

  it('keeps the hint described even while an error is showing', () => {
    // Otherwise the person hears the complaint and loses the instruction that would
    // fix it.
    expect(createRoomDescribedBy(false)).toBe(ROOM_NAME_HINT_ID);
    expect(createRoomDescribedBy(true)).toBe(`${ROOM_NAME_HINT_ID} ${CREATE_ROOM_ERROR_ID}`);
    expect(render({ kind: 'ready' }, CREATE_ROOM_INVALID_KEY)).toContain(
      `aria-describedby="${ROOM_NAME_HINT_ID} ${CREATE_ROOM_ERROR_ID}"`,
    );
  });

  it('keeps the description field described by its own hint', () => {
    expect(render({ kind: 'ready' })).toContain(`aria-describedby="${ROOM_DESCRIPTION_HINT_ID}"`);
  });

  it('holds the submit button while a request is in flight', () => {
    const html = renderToStaticMarkup(
      <CreateRoomPanel
        state={{ kind: 'ready' }}
        notice={null}
        submitting
        onRetry={() => undefined}
        onWaitFinished={() => undefined}
        onSubmitWaitFinished={() => undefined}
        onSubmit={() => undefined}
        onCreateAnother={() => undefined}
      />,
    );
    expect(html).toContain('disabled');
  });
});

describe('both locales say something, and say something different', () => {
  const STATES: ReadonlyArray<readonly [string, CreateRoomScreenState]> = [
    ['loading', { kind: 'loading' }],
    ['signed-out', { kind: 'signed-out' }],
    ['unavailable', { kind: 'unavailable', retryAfterSeconds: null }],
    ['ready', { kind: 'ready' }],
    ['created', { kind: 'created', room: room() }],
  ];

  it.each(STATES)('%s renders in every locale', (_label, state) => {
    for (const locale of LOCALES) {
      const html = renderIn(locale, state);
      expect(html.length, `${locale} rendered nothing`).toBeGreaterThan(0);
      // A raw catalogue key on the screen is what a missing translation looks like
      // in a system that falls back instead of failing. This one fails at `tsc`, and
      // this is the assertion that says the fallback did not quietly come back.
      expect(html).not.toContain('createRoom.');
    }
  });

  it('renders the heading and the submit label differently in the two languages', () => {
    // Not just "non-empty": a catalogue row copied without being translated is a
    // whole page that reads Vietnamese under an English `<html lang="en">`.
    for (const key of [CREATE_ROOM_HEADING_KEY, CREATE_ROOM_SUBMIT_KEY, CREATED_HEADING_KEY]) {
      expect(translatorFor('vi')(key)).not.toBe(translatorFor('en')(key));
    }
  });
});

/** `ngoai_ngu` -> `NgoaiNgu`, the suffix convention the catalogue keys use. */
function topicKeySuffix(topic: string): string {
  return topic
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/**
 * `aria-invalid` is a claim about ONE control.
 *
 * It read `current === null ? undefined : true`, so a dead session, a 502 and a
 * rate limit all marked the name input invalid. A screen reader then sends somebody
 * to fix a field that is fine, with nothing on the page to tell them otherwise —
 * WCAG 2.1 AA 3.3.1 asks for the error to be IDENTIFIED, and identifying the wrong
 * control is worse than identifying none.
 */
describe('createRoomNameInvalid — which notices are about the name field', () => {
  it('is false when there is no notice at all', () => {
    expect(createRoomNameInvalid(null)).toBe(false);
  });

  it('is true for the one notice that judges the body', () => {
    // Raised by the pre-flight and by a 400, and they are the same sentence on
    // purpose: one mistake gets one explanation whether or not the network helped.
    expect(createRoomNameInvalid({ messageKey: CREATE_ROOM_INVALID_KEY, retryAfterSeconds: null }))
      .toBe(true);
  });

  it.each([
    ['a dead session', SESSION_LOST_KEY],
    ['a server that failed', TRY_AGAIN_KEY],
    ['a request that was never sent', REQUEST_NOT_SENT_KEY],
    ['a rate limit', 'error.rateLimited' as MessageKey],
  ])('is false for %s', (_label, messageKey) => {
    expect(createRoomNameInvalid({ messageKey, retryAfterSeconds: null })).toBe(false);
  });
});

describe('the name input marks itself invalid only when it is the problem', () => {
  it('marks it invalid while the body is what was refused', () => {
    expect(render({ kind: 'ready' }, CREATE_ROOM_INVALID_KEY)).toContain('aria-invalid="true"');
  });

  it.each([SESSION_LOST_KEY, TRY_AGAIN_KEY, REQUEST_NOT_SENT_KEY])(
    'leaves it unmarked for %s',
    (messageKey) => {
      expect(render({ kind: 'ready' }, messageKey)).not.toContain('aria-invalid');
    },
  );

  it('still describes the error region for a notice that is not about the field', () => {
    // The two attributes answer different questions, and this is the line between
    // them: the sentence is worth hearing whatever it is about, so it stays
    // described — while the field stops claiming to be the thing that is wrong.
    const html = render({ kind: 'ready' }, SESSION_LOST_KEY);

    expect(html).toContain(createRoomDescribedBy(true));
    expect(html).not.toContain('aria-invalid');
  });
});
