import {
  CREATE_ROOM_FIELDS,
  MAX_ROOM_DESCRIPTION_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  ROOM_TOPICS,
  ROOM_VISIBILITIES,
  SIGN_IN_PATHNAME,
  parseCreateRoomRequest,
  parseSignInRetryAfterSeconds,
  type CreateRoomRequest,
  type CurrentUser,
  type Room,
  type RoomTopic,
  type RoomVisibility,
} from '@stuwith/contracts';
import type { FormEvent } from 'react';
import { SignInCountdown } from '../dang-nhap/countdown';
import { type MessageKey } from '../i18n/messages';
import { useT } from '../i18n/use-t';
import {
  PROFILE_RETRY_KEY,
  profileLoadOutcome,
  unavailableMessageKey,
  type ProfileLoadOutcome,
} from '../profile-load';

/**
 * Everything the create-room screen DECIDES, kept out of `page.tsx`.
 *
 * The reason is the one recorded in `AGENTS.md` §6: the `web` Vitest project has no
 * DOM on purpose — no `jsdom`, no `happy-dom`, no `@testing-library/*`, and adding
 * one is an "Ask First" item — so a component with state, an effect or a `window`
 * read cannot be executed by anything in this repository. A decision left in the
 * page is a decision no test can run.
 *
 * So `page.tsx` keeps `useState`, `useEffect` and the two calls through the seam,
 * and everything below is a pure function or an effect-free component that
 * `renderToStaticMarkup` can run under plain Node. The pattern is
 * `khai-ngay-sinh/date-of-birth-form.tsx`; this file follows it deliberately rather
 * than inventing a second shape for the same problem.
 *
 * ## What this file does NOT decide
 *
 * The participant cap. It arrives on the created `Room` as a number the server
 * resolved from the owner's plan, and this screen renders it. There is no plan
 * arithmetic in `apps/web` at all — a second copy of `PLAN_PARTICIPANT_LIMITS` in
 * the browser is how the screen and the API come to disagree about one room, and
 * the number the person is shown must be the number that was stored.
 *
 * What it DOES share with `apps/api` is the shape rule, and it shares it by calling
 * the same `parseCreateRoomRequest` rather than by re-deriving it. That is what
 * lets the form refuse a blank name without a round trip while remaining incapable
 * of accepting something the server would refuse.
 */

/** The five states of this screen, and what each one may render. */
export type CreateRoomScreenState =
  /** `/v1/auth/me` has not answered yet. Nothing is claimed. */
  | { readonly kind: 'loading' }
  /** No session. The only useful thing here is a way to the login page. */
  | { readonly kind: 'signed-out' }
  /**
   * The profile could not be read, and NOT because nobody is signed in.
   *
   * Separate from `signed-out` for the reason `/khai-ngay-sinh` records: collapsing
   * the two tells a rate-limited or unlucky visitor to go and log in — which they
   * cannot usefully do, and which on the sign-in page spends another attempt and
   * makes the wait longer.
   */
  | { readonly kind: 'unavailable'; readonly retryAfterSeconds: number | null }
  /** Signed in: the one state where the form is offered. */
  | { readonly kind: 'ready' }
  /**
   * The room exists. It carries the room, because the confirmation names it and
   * states the capacity — both of which are the SERVER's answer rather than
   * anything this screen worked out.
   */
  | { readonly kind: 'created'; readonly room: Room };

/**
 * Which state a `/v1/auth/me` ANSWER puts this screen in.
 *
 * The reading itself is `profileLoadOutcome` in `../profile-load`, shared with the
 * two screens that already ask the question — they used to decide it separately and
 * disagreed about the one case that matters. What is left here is the mapping onto
 * THIS screen's states.
 *
 * A profile lands on `ready` whatever its flags say. `profile_completed` is not
 * consulted: this story does not gate room creation on the date-of-birth
 * declaration, and inventing that gate here would put a rule in a component that no
 * endpoint enforces — so somebody would be refused by a screen and accepted by the
 * API.
 */
export function createRoomStateFor(
  status: number,
  user: CurrentUser | null,
  retryAfterHeader: string | null,
): CreateRoomScreenState {
  return screenStateFromOutcome(profileLoadOutcome(status, user, retryAfterHeader));
}

/** The mapping, exported so the shared outcome and this screen's states are both testable. */
export function screenStateFromOutcome(outcome: ProfileLoadOutcome): CreateRoomScreenState {
  switch (outcome.kind) {
    case 'profile':
      return { kind: 'ready' };
    case 'signed-out':
      return { kind: 'signed-out' };
    case 'unavailable':
      return { kind: 'unavailable', retryAfterSeconds: outcome.retryAfterSeconds };
    default:
      return exhausted(outcome);
  }
}

/**
 * What to do with what the person filled in, decided before anything is sent.
 *
 * `invalid` is not an error state the screen shouts about — it is the form refusing
 * to send something the server would refuse anyway, and it carries the SAME sentence
 * the server would have answered with (both come from `packages/contracts`), so the
 * person cannot get two different explanations for one mistake depending on whether
 * the network was involved.
 */
export type CreateRoomSubmission =
  | { readonly kind: 'send'; readonly value: CreateRoomRequest }
  | { readonly kind: 'invalid'; readonly messageKey: MessageKey };

export const CREATE_ROOM_INVALID_KEY: MessageKey = 'error.createRoomInvalid';

/**
 * The shared judge, applied to whatever the form produced.
 *
 * Deliberately the SAME function `apps/api` runs, not a client-side approximation
 * of it: the pre-flight is then a strict mirror rather than a second opinion, so it
 * can never accept something the server would refuse and can never refuse something
 * the server would accept. `parseCreateRoomRequest` is total over `unknown`, which
 * is what lets a form that produced `null` for a field (an unchosen radio group)
 * land here instead of throwing.
 */
export function createRoomSubmission(raw: unknown): CreateRoomSubmission {
  const parsed = parseCreateRoomRequest(raw);
  return parsed === null
    ? { kind: 'invalid', messageKey: CREATE_ROOM_INVALID_KEY }
    : { kind: 'send', value: parsed };
}

/**
 * The same judgement, over a submitted form, with the FIELD NAMES supplied here.
 *
 * The page hands in "how to read one field" and nothing else. That is what keeps
 * the four names in ONE module — the one that also writes them onto the inputs
 * below — rather than split across a writer and a reader that have to agree with
 * nothing holding them together. `DATE_OF_BIRTH_FIELD`'s docblock records what the
 * split cost when there was only one name; there are four here.
 *
 * `read` returns `unknown` because `FormData.get` returns a `File` for a file input
 * and `null` for a name nothing was submitted under. Both reach
 * `parseCreateRoomRequest`, which refuses them.
 */
export function createRoomSubmissionFrom(read: (field: string) => unknown): CreateRoomSubmission {
  return createRoomSubmission({
    [CREATE_ROOM_FIELDS.name]: read(CREATE_ROOM_FIELDS.name),
    [CREATE_ROOM_FIELDS.description]: read(CREATE_ROOM_FIELDS.description),
    [CREATE_ROOM_FIELDS.topic]: read(CREATE_ROOM_FIELDS.topic),
    [CREATE_ROOM_FIELDS.visibility]: read(CREATE_ROOM_FIELDS.visibility),
  });
}

/**
 * The request body, built in one place so a field name cannot be typed twice.
 *
 * It serialises the PARSED value rather than the raw form, which is what carries
 * the trim across: `parseCreateRoomRequest` trims before it measures, so the name
 * that is sent is the name that was judged.
 */
export function createRoomRequestBody(value: CreateRoomRequest): string {
  return JSON.stringify(value);
}

/**
 * A message on the screen, and the wait that belongs to it.
 *
 * One value rather than two, for the reason `DeclarationNotice` gives about itself:
 * a "please wait" sentence and the number of seconds are one fact, and while they
 * were two pieces of state either could be dropped and leave a lock message with no
 * clock in it.
 */
export interface CreateRoomNotice {
  /** WHICH sentence, not the sentence — the decision below has no locale. */
  readonly messageKey: MessageKey;
  /** `null` means "no clock", never "zero". */
  readonly retryAfterSeconds: number | null;
}

export type CreateRoomOutcome =
  /** `201`: the room exists, and the body carries it. */
  | { readonly kind: 'created' }
  | { readonly kind: 'message'; readonly notice: CreateRoomNotice };

const notice = (messageKey: MessageKey, retryAfterSeconds: number | null): CreateRoomOutcome => ({
  kind: 'message',
  notice: { messageKey, retryAfterSeconds },
});

/**
 * The three sentences that belong to this screen alone and cross no boundary, so
 * their keys live here rather than in `packages/contracts`.
 *
 * None says anything technical: no status code, no endpoint, no "the server
 * returned". A number from an HTTP specification is neither what happened nor what
 * to do next.
 */
export const SESSION_LOST_KEY: MessageKey = 'createRoom.sessionLost';
export const TRY_AGAIN_KEY: MessageKey = 'createRoom.tryAgain';
export const REQUEST_NOT_SENT_KEY: MessageKey = 'createRoom.requestNotSent';

/**
 * What the endpoint's answer means to this screen.
 *
 * `retryAfterHeader` is REQUIRED and has no default, for the reason
 * `declarationOutcomeFor` records: while it was `= null` there, dropping the
 * argument at the call site typechecked, every example passed one so nothing went
 * red, and the screen shipped a rate-limit message with no number in it.
 *
 * Every branch is named and the `default` is the cautious one: an unrecognised
 * status is "we do not know that it worked", never "it worked". The opposite
 * default would tell somebody their room exists on the strength of a 502, and send
 * them looking for it.
 */
export function createRoomOutcomeFor(
  status: number,
  retryAfterHeader: string | null,
): CreateRoomOutcome {
  switch (status) {
    case 201:
      return { kind: 'created' };
    case 400:
      // The same sentence the pre-flight shows, so one mistake has one explanation
      // whether or not the network was involved.
      return notice(CREATE_ROOM_INVALID_KEY, null);
    case 401:
      // The session died between loading this page and submitting it. The seam has
      // already tried a refresh and raised the dialog; this is what is left on the
      // screen underneath it.
      return notice(SESSION_LOST_KEY, null);
    case 413:
    case 415:
      /**
       * Fastify answers these before any handler of ours is asked, and they are
       * PERMANENT: the same request is refused the same way for ever. Letting them
       * fall into `default` would say "try again in a few minutes", which is the one
       * thing that is certainly false about them and an invitation to keep tapping a
       * button that cannot work.
       */
      return notice(REQUEST_NOT_SENT_KEY, null);
    case 429:
      /**
       * This route carries no `@RateLimited(...)` today — `RATE_LIMIT_ACTIONS` has
       * no name for creating a room and adding one is an "Ask First" item, which
       * `deferred-work.md` records. The branch is here anyway because a `429` can
       * still arrive from an edge or a proxy in front of the API, and the
       * alternative default says "try again in a few minutes" beside a wait nobody
       * told the person about. It costs one case and it is the right sentence the
       * day the limit does land.
       */
      return notice('error.rateLimited', parseSignInRetryAfterSeconds(retryAfterHeader));
    default:
      return notice(TRY_AGAIN_KEY, null);
  }
}

/**
 * Whether the last attempt left a wait that has to run down before another one.
 *
 * It is the ONE reading of that fact, and both things that depend on it — the clock
 * and the submit button's `disabled` — are derived from this call rather than from
 * two separate comparisons. That is not tidiness: the screen shipped with the two
 * halves disagreeing. A `429` drew the remaining seconds as a STATIC sentence
 * appended to the message (`createRoomWaitLabel`, deleted with this change) beside a
 * button that stayed live, so the number never moved and the person could keep
 * pressing send throughout the lockout — each press spending another attempt and, on
 * a limiter that counts refusals, lengthening the wait they were being shown. The
 * `unavailable` branch had already got this right with a real {@link SignInCountdown}
 * and a disabled button; this is the same arrangement, on the branch that has a form.
 */
export function createRoomIsWaiting(current: CreateRoomNotice | null): boolean {
  return current !== null && current.retryAfterSeconds !== null;
}

/**
 * Wire topic -> label key.
 *
 * A `Record<RoomTopic, MessageKey>`, so a seventh topic added to
 * `packages/contracts` is a `pnpm typecheck` failure here rather than a raw
 * `snake_case` identifier on somebody's screen — the same mechanism
 * `ROLE_MESSAGE_KEYS` uses for roles, and for the same reason: a wire enum is not a
 * label in any language.
 */
const TOPIC_MESSAGE_KEYS: Readonly<Record<RoomTopic, MessageKey>> = {
  ngoai_ngu: 'createRoom.topicNgoaiNgu',
  khoa_hoc_tu_nhien: 'createRoom.topicKhoaHocTuNhien',
  khoa_hoc_xa_hoi: 'createRoom.topicKhoaHocXaHoi',
  lap_trinh_cong_nghe: 'createRoom.topicLapTrinhCongNghe',
  on_thi: 'createRoom.topicOnThi',
  khac: 'createRoom.topicKhac',
};

/** The same table for visibility, and it exists for the same reason. */
const VISIBILITY_MESSAGE_KEYS: Readonly<Record<RoomVisibility, MessageKey>> = {
  public: 'createRoom.visibilityPublic',
  private: 'createRoom.visibilityPrivate',
};

/** The ids that wire each field to its hint and to the form's error, for a screen reader. */
export const ROOM_NAME_INPUT_ID = 'ten-phong';
export const ROOM_NAME_HINT_ID = 'ten-phong-hint';
export const ROOM_DESCRIPTION_INPUT_ID = 'mo-ta-phong';
export const ROOM_DESCRIPTION_HINT_ID = 'mo-ta-phong-hint';
export const CREATE_ROOM_ERROR_ID = 'tao-phong-loi';

/**
 * What `aria-describedby` must say on the name field, given whether there is a
 * message.
 *
 * A pure function because it is the part that is easy to get wrong and impossible
 * to see: the hint has to stay described even while an error is showing, or the
 * person hears the complaint and loses the instruction that would fix it.
 */
export function createRoomDescribedBy(hasNotice: boolean): string {
  return hasNotice ? `${ROOM_NAME_HINT_ID} ${CREATE_ROOM_ERROR_ID}` : ROOM_NAME_HINT_ID;
}

/**
 * Whether the NAME FIELD is what a notice is complaining about.
 *
 * `aria-invalid` is a claim about one control, not a mood the form is in. It read
 * `current === null ? undefined : true`, so a dead session, a 502 and a rate limit
 * all marked the name input invalid — and a screen reader then tells somebody to
 * fix a field that is perfectly fine, with no way to discover that it is not the
 * problem. WCAG 2.1 AA (3.3.1) wants the error identified; identifying the WRONG
 * one is worse than identifying none.
 *
 * `CREATE_ROOM_INVALID_KEY` is the only notice about the body: it is what the
 * pre-flight raises and what a `400` maps to. `aria-describedby` deliberately
 * does NOT use this — the error region stays described for every notice, because
 * the sentence is worth hearing whatever it is about.
 */
export function createRoomNameInvalid(current: CreateRoomNotice | null): boolean {
  return current !== null && current.messageKey === CREATE_ROOM_INVALID_KEY;
}

export const CREATE_ROOM_HEADING_KEY: MessageKey = 'createRoom.heading';
export const CREATE_ROOM_SUBMIT_KEY: MessageKey = 'createRoom.submit';
export const CREATED_HEADING_KEY: MessageKey = 'createRoom.createdHeading';
export const CREATE_ANOTHER_KEY: MessageKey = 'createRoom.createAnother';

/**
 * The whole screen below the heading, as ONE effect-free component.
 *
 * One component rather than a form plus a separately-rendered confirmation, for the
 * reason `DateOfBirthPanel` gives about itself: two pieces that must agree are two
 * pieces either of which can be deleted with a full green run. "The room exists"
 * and "here is a form to create one" are the same decision, and rendering the form
 * beside the confirmation is the exact bug this shape makes unexpressible.
 *
 * No `'use client'`, no state, no effect, no `window` — so it runs under
 * `renderToStaticMarkup` and the assertions are about real output HTML.
 */
export function CreateRoomPanel({
  state,
  notice: current,
  submitting,
  onRetry,
  onWaitFinished,
  onSubmitWaitFinished,
  onSubmit,
  onCreateAnother,
}: {
  readonly state: CreateRoomScreenState;
  /** A message from the last attempt, with its wait, or `null`. */
  readonly notice: CreateRoomNotice | null;
  readonly submitting: boolean;
  /**
   * Re-read the profile. REQUIRED, because the `unavailable` branch renders the
   * button and a branch that renders a button with no handler is the dead end this
   * parameter exists to remove.
   */
  readonly onRetry: () => void;
  /**
   * Told when a rate-limit wait ends, so the retry button becomes usable again.
   * REQUIRED for the reason `onWaitFinished` is on the declaration panel: while it
   * was optional, forgetting it shipped a screen whose countdown reached zero and
   * left the only button on it disabled for ever.
   */
  readonly onWaitFinished: () => void;
  /**
   * Told when a wait that arrived WITH THE FORM ON SCREEN ends, so the send button
   * becomes usable again.
   *
   * A second callback rather than {@link onWaitFinished}, and the two are not
   * interchangeable: `onWaitFinished` moves the screen state, which is the right
   * move on the `unavailable` branch and the wrong one here — the form would vanish
   * mid-typing and take whatever had been entered with it. This one clears the
   * notice's clock and leaves everything else alone.
   */
  readonly onSubmitWaitFinished: () => void;
  /**
   * REQUIRED, even though `renderToStaticMarkup` never calls it. The `<form>` is
   * rendered HERE rather than in `page.tsx`, because whether there is a form at all
   * is one of this component's five decisions — and a page that wrapped the panel in
   * its own form would nest one inside another on the branches that render no form
   * of their own, which is invalid HTML that nothing in a DOM-less project notices.
   */
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Back to an empty form. REQUIRED for the same reason `onRetry` is. */
  readonly onCreateAnother: () => void;
}) {
  const t = useT();
  const waiting = createRoomIsWaiting(current);

  switch (state.kind) {
    case 'loading':
      // `status`, like the other two non-form branches, so a screen reader is told
      // about the state this screen starts in and not only about the ones after it.
      return (
        <p className="meta" role="status">
          {t('signIn.checkingSession')}
        </p>
      );

    case 'unavailable':
      // `status`, not `alert`: nothing is wrong with what the person did, and
      // nothing here is urgent enough to interrupt a screen reader mid-sentence.
      return (
        <>
          <p className="notice" role="status">
            {t(unavailableMessageKey(state.retryAfterSeconds))}
          </p>
          {state.retryAfterSeconds === null ? null : (
            <SignInCountdown seconds={state.retryAfterSeconds} onFinished={onWaitFinished} />
          )}
          <button
            type="button"
            className="button-secondary"
            disabled={state.retryAfterSeconds !== null}
            onClick={onRetry}
          >
            {t(PROFILE_RETRY_KEY)}
          </button>
        </>
      );

    case 'signed-out':
      return (
        <>
          <p className="notice" role="status">
            {t('createRoom.signedOut')}
          </p>
          {/* The route comes from `packages/contracts`, never from a literal — the
              rule `routes.test.ts` enforces over every `*_PATHNAME`. */}
          <a className="button-primary" href={SIGN_IN_PATHNAME}>
            {t('createRoom.toSignIn')}
          </a>
        </>
      );

    case 'created':
      return (
        <section className="card">
          <h2>{t(CREATED_HEADING_KEY)}</h2>
          {/* The name the SERVER stored, not the one that was typed: it was trimmed
              on the way through, and showing the submitted spelling would tell
              somebody their room is called something it is not. */}
          <p>{t('createRoom.createdName', { name: state.room.name })}</p>
          {/*
            The capacity, as the server resolved it from the plan. There is no plan
            arithmetic in this package — a second copy of the limits in the browser
            is how the screen and the API come to disagree about one room.

            `t.plural` rather than a sentence with a number appended: English needs
            two categories, Vietnamese has one, and `Intl.PluralRules` is what
            chooses between them.
          */}
          <p className="meta numeric">
            {t.plural('createRoom.capacity', state.room.max_participants, {
              count: state.room.max_participants,
            })}
          </p>
          {/* A way ONWARD, so this terminal state is not a dead end with a sentence
              in it. There is no room screen to link to yet (Story 2.3 owns pre-join),
              so the honest next move is another room. */}
          <button type="button" className="button-secondary" onClick={onCreateAnother}>
            {t(CREATE_ANOTHER_KEY)}
          </button>
        </section>
      );

    case 'ready':
      return (
        <form className="card" onSubmit={onSubmit}>
          <label className="form-label" htmlFor={ROOM_NAME_INPUT_ID}>
            {t('createRoom.nameLabel')}
          </label>
          {/*
            `maxLength` and `required` are help, not control: three layers behind
            this one refuse an over-long or blank name anyway (the shared parser, the
            adapter assert, the CHECK constraint). What they buy is that the browser
            stops somebody typing 400 characters they will then be told to delete.

            `name` is `CREATE_ROOM_FIELDS.name` directly, not a prop. The page reads
            the submitted form back through `createRoomSubmissionFrom`, which names
            the same constants — so the writer and the reader cannot disagree.
          */}
          <input
            className="field"
            id={ROOM_NAME_INPUT_ID}
            name={CREATE_ROOM_FIELDS.name}
            type="text"
            required
            maxLength={MAX_ROOM_NAME_LENGTH}
            aria-describedby={createRoomDescribedBy(current !== null)}
            // Only when the notice is ABOUT this field. "Unavailable" and "signed
            // out" never render this input at all; a 429, a 502 or a dead session
            // do, and none of them is a complaint about the name.
            aria-invalid={createRoomNameInvalid(current) ? true : undefined}
          />
          <p className="meta" id={ROOM_NAME_HINT_ID}>
            {t('createRoom.nameHint')}
          </p>

          <label className="form-label" htmlFor={ROOM_DESCRIPTION_INPUT_ID}>
            {t('createRoom.descriptionLabel')}
          </label>
          {/* Not `required`: an empty description is a legal room, and the column
              is `NOT NULL DEFAULT ''` for the same reason — "no description" and
              "an empty description" are one fact. */}
          <textarea
            className="field field-multiline"
            id={ROOM_DESCRIPTION_INPUT_ID}
            name={CREATE_ROOM_FIELDS.description}
            rows={3}
            maxLength={MAX_ROOM_DESCRIPTION_LENGTH}
            aria-describedby={ROOM_DESCRIPTION_HINT_ID}
          />
          <p className="meta" id={ROOM_DESCRIPTION_HINT_ID}>
            {t('createRoom.descriptionHint')}
          </p>

          {/*
            A `fieldset` with a `legend`, not a heading with radios under it. The
            legend is what a screen reader announces with every option in the group,
            and it is the only markup that says "these six belong together" — which
            is also `EXPERIENCE.md`'s rule for the face-mode group in Story 2.7.

            Each option's `<label>` WRAPS its input, so the association needs no id
            at all — six ids that have to stay unique is six chances to repeat one,
            and a duplicate id points two labels at one control in silence.
          */}
          <fieldset className="field-group">
            <legend className="form-label">{t('createRoom.topicLegend')}</legend>
            <div className="choice-list">
              {ROOM_TOPICS.map((topic) => (
                <label className="choice" key={topic}>
                  <input type="radio" name={CREATE_ROOM_FIELDS.topic} value={topic} required />
                  <span>{t(TOPIC_MESSAGE_KEYS[topic])}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="field-group">
            <legend className="form-label">{t('createRoom.visibilityLegend')}</legend>
            <div className="choice-list">
              {ROOM_VISIBILITIES.map((visibility) => (
                <label className="choice" key={visibility}>
                  <input
                    type="radio"
                    name={CREATE_ROOM_FIELDS.visibility}
                    value={visibility}
                    required
                  />
                  <span>{t(VISIBILITY_MESSAGE_KEYS[visibility])}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {current === null ? null : (
            <p className="notice notice-alert" id={CREATE_ROOM_ERROR_ID} role="alert">
              {t(current.messageKey)}
            </p>
          )}
          {/*
            The clock is a RUNNING one, in its own element, exactly as on the
            `unavailable` branch. Appending `countdownLabel(...)` to the sentence
            above — which is what this used to do — produces a number that is correct
            for one instant and then sits there: `renderToStaticMarkup` cannot tell
            the difference, and neither can a reader, which is how it survived a
            round of review.
          */}
          {current === null || current.retryAfterSeconds === null ? null : (
            <SignInCountdown
              seconds={current.retryAfterSeconds}
              onFinished={onSubmitWaitFinished}
            />
          )}

          {/*
            `waiting` as well as `submitting`. A live send button under a countdown
            is an invitation to spend attempts during a lockout, and on a limiter
            that counts refusals each one makes the wait on screen longer — the
            `Retry-After` defect of Epic 1, arriving through a different screen.
          */}
          <button type="submit" className="button-primary" disabled={submitting || waiting}>
            {t(CREATE_ROOM_SUBMIT_KEY)}
          </button>
        </form>
      );

    default:
      /**
       * A sixth state has to be given a branch, and the compiler is what says so.
       * Without this the form would be the fall-through — including for a state
       * meaning "the room already exists", which would offer to create it again.
       */
      return exhausted(state);
  }
}

/**
 * The compiler's way of insisting that a new case gets a branch, used by both
 * switches in this file. The message names no particular union because it serves
 * two; what matters at runtime is the value, which is printed.
 */
function exhausted(value: never): never {
  throw new Error(`unhandled create-room case: ${JSON.stringify(value)}`);
}
