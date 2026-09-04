import {
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  MIN_DATE_OF_BIRTH_YEAR,
  RATE_LIMITED_MESSAGE,
  SIGN_IN_PATHNAME,
  isProfileCompleted,
  parseDateOfBirth,
  parseSignInRetryAfterSeconds,
  type CurrentUser,
} from '@stuwith/contracts';
import type { FormEvent } from 'react';
import { SignInCountdown } from '../dang-nhap/countdown';
import { countdownLabel } from '../dang-nhap/countdown-text';
import {
  PROFILE_RETRY_LABEL,
  profileLoadOutcome,
  unavailableMessage,
  type ProfileLoadOutcome,
} from '../profile-load';

/**
 * Everything the date-of-birth screen DECIDES, kept out of `page.tsx`.
 *
 * The reason is the one recorded in `AGENTS.md`: the `web` Vitest project has no
 * DOM on purpose — no `jsdom`, no `happy-dom`, no `@testing-library/*`, and
 * adding one is an "Ask First" item — so a component with state, an effect or a
 * `window` read cannot be executed by anything in this repository. A decision
 * left in the page is a decision no test can run, and this screen's decisions are
 * the ones worth running: which of four states the person is in, whether the
 * value they typed is worth sending, and what a status code means.
 *
 * So `page.tsx` keeps `useState`, `useEffect` and the two calls through the seam,
 * and everything below is a pure function or an effect-free component that
 * `renderToStaticMarkup` can run under plain Node. The pattern is
 * `dang-nhap/sign-in-outcome.tsx`; this file follows it deliberately rather than
 * inventing a second shape.
 *
 * ## What this file does NOT decide
 *
 * Whether somebody is over 18. That rule lives in `packages/domain` and reaches
 * here as a boolean on `/v1/auth/me` — `apps/web` is a client with no business
 * rules in it (AD-13), and a second implementation of the age arithmetic in the
 * browser is how the screen and the API come to disagree about one person. There
 * is no age arithmetic in this package at all.
 *
 * What it does share with `apps/api` is the FORMAT rule, and it shares it by
 * calling the same `parseDateOfBirth` rather than by re-deriving it. That is what
 * lets the field say "that is not a date" without a round trip while remaining
 * incapable of accepting something the server would refuse.
 */

/** Where the five states of this screen come from, and what each one may render. */
export type DateOfBirthScreenState =
  /** `/v1/auth/me` has not answered yet. Nothing is claimed. */
  | { readonly kind: 'loading' }
  /** No session. The only useful thing here is a way to the login page. */
  | { readonly kind: 'signed-out' }
  /**
   * The profile could not be read, and NOT because nobody is signed in.
   *
   * Separate from `signed-out` because collapsing the two tells a rate-limited or
   * unlucky visitor to go and log in — which they cannot usefully do, and which
   * on the sign-in page spends another attempt and makes the wait longer. It is
   * the same defect Story 1.3 fixed on `/dang-nhap`, arriving through a different
   * screen.
   */
  | { readonly kind: 'unavailable'; readonly retryAfterSeconds: number | null }
  /** Signed in, nothing declared: the one state where the form is offered. */
  | { readonly kind: 'needs-declaration'; readonly user: CurrentUser }
  /**
   * Already declared. The form must NOT be offered — there is no way to change it.
   *
   * It carries no `user`, and that is deliberate rather than an omission: the
   * branch renders a heading and one sentence, neither of which says anything about
   * the person. Carrying a profile the markup never reads is what forced the page
   * to go and fetch one before it could show this screen — which is how a `409`
   * turned into a re-read that answered "not declared" and put the form back up.
   */
  | { readonly kind: 'declared' };

/**
 * Which state a PROFILE puts this screen in, once one has been read.
 *
 * `isProfileCompleted` rather than `user.profile_completed` directly: the field
 * is optional in the contract, so it has three states while the screen has two,
 * and the shared helper is what makes "absent reads as not completed" one rule
 * instead of one per caller.
 */
export function screenStateFor(user: CurrentUser): DateOfBirthScreenState {
  return isProfileCompleted(user) ? { kind: 'declared' } : { kind: 'needs-declaration', user };
}

/**
 * Which state a `/v1/auth/me` ANSWER puts this screen in.
 *
 * The reading itself is `profileLoadOutcome` in `../profile-load`, shared with
 * `/dang-nhap` — the two screens used to decide this separately and disagreed about
 * the one case that matters. What is left here is the mapping from that outcome onto
 * THIS screen's states, which is the part that really is local.
 *
 * `retryAfterHeader` has no default, and that is the point of it: the wait is the
 * only actionable thing in a `429`, and while the parameter did not exist at all
 * this branch silently dropped it — the one screen that knew a rate limit is not a
 * login problem still could not say how long, and its retry button called straight
 * back into the limit.
 */
export function profileLoadStateFor(
  status: number,
  user: CurrentUser | null,
  retryAfterHeader: string | null,
): DateOfBirthScreenState {
  return screenStateFromOutcome(profileLoadOutcome(status, user, retryAfterHeader));
}

/** The mapping, exported so the shared outcome and this screen's states are both testable. */
export function screenStateFromOutcome(outcome: ProfileLoadOutcome): DateOfBirthScreenState {
  switch (outcome.kind) {
    case 'profile':
      return screenStateFor(outcome.user);
    case 'signed-out':
      return { kind: 'signed-out' };
    case 'unavailable':
      return { kind: 'unavailable', retryAfterSeconds: outcome.retryAfterSeconds };
    default:
      return exhausted(outcome);
  }
}

/**
 * What to do with what the person typed, decided before anything is sent.
 *
 * `invalid` is not an error state the screen shouts about — it is the field
 * refusing to send something the server would refuse anyway, and it carries the
 * SAME sentence the server would have answered with (both come from
 * `packages/contracts`), so the person cannot get two different explanations for
 * one mistake depending on whether the network was involved.
 *
 * `today` is a parameter for the same reason it is one in `parseDateOfBirth`: a
 * decision that reads the wall clock cannot be rendered at a chosen instant, and
 * "is this in the future" is the one part of the format rule that moves.
 */
export type DateOfBirthSubmission =
  | { readonly kind: 'send'; readonly value: string }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * The instant this screen asks the shared parser about, and it is deliberately
 * NOT the browser's idea of now.
 *
 * `parseDateOfBirth` refuses a day after `today`, and that half of the rule needs
 * a trustworthy clock. The browser's is not one: a machine whose date is wrong —
 * a dead CMOS battery, a deliberately shifted clock, a phone that has not synced —
 * would refuse a perfectly good date of birth ON THE SPOT, with the exact sentence
 * a real refusal carries, and the request would never reach the server to be
 * judged by the `ClockPort` that is authoritative. The person would have no way to
 * tell the two apart and no way through.
 *
 * So the client asks the same rule with the one instant that cannot make the
 * answer wrong. Everything the format rule decides without a clock — the shape,
 * whether the string names a real day, the year floor — still applies here and
 * still saves a round trip. "Is this in the future" is left to `apps/api`, which
 * refuses it with the same sentence, from a clock this product controls.
 *
 * The client check is therefore a strict SUPERSET of what the server accepts,
 * which is the only safe direction for a pre-flight: it can never accept something
 * the server would refuse, and it can never refuse something the server would
 * accept.
 */
const NO_FUTURE_CHECK = new Date(8_640_000_000_000_000);

export function dateOfBirthSubmission(raw: unknown): DateOfBirthSubmission {
  const parsed = parseDateOfBirth(raw, NO_FUTURE_CHECK);
  return parsed === null
    ? { kind: 'invalid', message: DATE_OF_BIRTH_INVALID_MESSAGE }
    : { kind: 'send', value: parsed };
}

/**
 * What the date picker offers: a floor, and deliberately no ceiling.
 *
 * ## Why there is no `max` any more
 *
 * There was one, built from the browser's own `new Date()`, with a comment calling
 * it "a convenience and never a control". That comment was not true of HTML. `max`
 * on an `<input type="date">` is enforced by the BROWSER through constraint
 * validation, before any script of ours runs: a machine whose clock is wrong — a
 * dead CMOS battery, a phone that has not synced, a deliberately shifted date —
 * refuses the submit itself, with the browser's own message, and nothing in this
 * product ever sees the attempt.
 *
 * That is exactly the failure {@link NO_FUTURE_CHECK} exists to prevent: this
 * screen deliberately does NOT ask "is this in the future", because the browser's
 * clock is not one this product controls, and the answer belongs to the `ClockPort`
 * in `apps/api`. Keeping a `max` derived from the same untrusted clock put the
 * check back in the one place it cannot be argued with.
 *
 * The trade, stated rather than hidden: a native picker will now happily offer
 * tomorrow. Somebody who chooses it gets one round trip and the same sentence they
 * would have got anyway, from a clock this product does control — which is a worse
 * five hundred milliseconds and a better answer.
 *
 * `min` stays. It comes from the contract's own plausibility floor, needs no clock,
 * and the browser enforcing it can only ever agree with what `apps/api` would say.
 */
export function dateOfBirthInputBounds(): { readonly min: string } {
  return { min: `${String(MIN_DATE_OF_BIRTH_YEAR).padStart(4, '0')}-01-01` };
}

/** The request body, built in one place so the field name cannot be typed twice. */
export function dateOfBirthRequestBody(value: string): string {
  return JSON.stringify({ [DATE_OF_BIRTH_FIELD]: value });
}

/**
 * What the endpoint's answer means to this screen.
 *
 * Every branch is named, and the `default` is deliberately the cautious one: an
 * unrecognised status is "we do not know that it worked", never "it worked". The
 * opposite default would tell somebody their profile is complete on the strength
 * of a 502.
 *
 * `409` is a success from the screen's point of view even though it is a refusal
 * from the server's: the profile HAS a date of birth, which is the state this
 * page exists to reach. Showing an error for it would leave somebody stuck on a
 * screen whose job is already done — which is what happens if two tabs are open,
 * or if a submit is double-tapped.
 */
/**
 * A message on the screen, and the wait that belongs to it.
 *
 * One value rather than two, for the reason `SignInNotice` gives about itself: a
 * "please wait" sentence and the number of seconds are one fact, and while they
 * were two pieces of state either could be dropped and leave a lock message with
 * no clock in it.
 */
export interface DeclarationNotice {
  readonly message: string;
  /** `null` means "no clock", never "zero". */
  readonly retryAfterSeconds: number | null;
}

export type DeclarationOutcome =
  /** `200`: this request did the write, and its body carries the new profile. */
  | { readonly kind: 'written' }
  /**
   * `409`: the profile already had one — another tab, a double tap, an earlier
   * visit, or a value that predates this screen.
   *
   * It is a SEPARATE kind from `written`, and folding the two together was a real
   * defect rather than tidiness. The page reads the new profile out of the `200`
   * body; a `409` has no such body (it names no value, deliberately), so the page
   * fell back to re-reading `/v1/auth/me`. That re-read answers "not declared" for
   * exactly the profile whose stored value this product no longer accepts — so the
   * form came back, the submit was refused again, and the person went round for
   * ever. Named apart, the page can put this screen straight into its terminal
   * state without asking anybody anything.
   */
  | { readonly kind: 'already-declared' }
  | { readonly kind: 'message'; readonly notice: DeclarationNotice };

const notice = (message: string, retryAfterSeconds: number | null): DeclarationOutcome => ({
  kind: 'message',
  notice: { message, retryAfterSeconds },
});

/**
 * `retryAfterHeader` is REQUIRED, and the missing default is the whole point.
 *
 * It used to be `= null`. Dropping the argument at the call site therefore
 * typechecked, every example here passed one so nothing went red, and the screen
 * shipped a rate-limit message with no number in it — the exact defect Story 1.3
 * fixed on `/dang-nhap`, re-entered through a parameter default. `onSubmit` and
 * `onRetry` on the panel below are required for the same reason; this is the same
 * rule applied to a function.
 */
export function declarationOutcomeFor(
  status: number,
  retryAfterHeader: string | null,
): DeclarationOutcome {
  switch (status) {
    case 200:
      return { kind: 'written' };
    case 409:
      return { kind: 'already-declared' };
    case 400:
      return notice(DATE_OF_BIRTH_INVALID_MESSAGE, null);
    case 413:
    case 415:
      /**
       * Fastify answers these before any parser or handler of ours is asked, and
       * they are PERMANENT: the same request will be refused the same way for ever.
       * They fell into `default`, which says "hãy thử lại sau ít phút" — the one
       * thing that is certainly false about them, and an invitation to keep tapping
       * a button that cannot work.
       *
       * A reload is the honest suggestion: the only way this happens is a client
       * that no longer matches the server, so fetching the page again is the one
       * action that could change the outcome.
       */
      return notice(REQUEST_NOT_SENT_MESSAGE, null);
    case 401:
      // The session died between loading this page and submitting it. The seam
      // has already tried a refresh and raised the dialog; this sentence is what
      // is left on the screen underneath it.
      return notice(SESSION_LOST_MESSAGE, null);
    case 429:
      /**
       * The route carries `@RateLimited('auth_date_of_birth')` on a `json`
       * channel, so `429` with a `Retry-After` header is an answer this screen
       * really receives — it was falling into `default` and reading "thử lại sau
       * ít phút", which is both vaguer than the truth and an invitation to keep
       * tapping, and every tap costs another attempt.
       *
       * Same sentence and same parser as `/dang-nhap`: `RATE_LIMITED_MESSAGE`
       * crosses the process boundary from `packages/contracts`, and
       * `parseSignInRetryAfterSeconds` is what stops a header this product did not
       * write putting a nonsense number on the screen.
       */
      return notice(RATE_LIMITED_MESSAGE, parseSignInRetryAfterSeconds(retryAfterHeader));
    default:
      return notice(TRY_AGAIN_MESSAGE, null);
  }
}

/** The countdown sentence beside a notice, or `null` when there is no clock. */
export function declarationWaitLabel(current: DeclarationNotice | null): string | null {
  return current === null || current.retryAfterSeconds === null
    ? null
    : countdownLabel(current.retryAfterSeconds);
}

/**
 * The two sentences that belong to this screen alone and cross no boundary, so
 * they live here rather than in `packages/contracts`.
 *
 * Neither says anything technical: no status code, no endpoint, no "the server
 * returned". The acceptance criterion is that a person is told what happened and
 * what to do next, and a number from an HTTP specification is neither.
 *
 * Vietnamese is the default locale; full i18n is Story 1.6.
 */
export const SESSION_LOST_MESSAGE = 'Phiên đăng nhập đã kết thúc. Hãy đăng nhập lại rồi thử lại.';
export const TRY_AGAIN_MESSAGE = 'Chưa lưu được. Hãy thử lại sau ít phút.';

/**
 * What a PERMANENT refusal says — and it deliberately does not say "in a few
 * minutes", because waiting changes nothing about it.
 */
export const REQUEST_NOT_SENT_MESSAGE = 'Không gửi được yêu cầu này. Hãy tải lại trang rồi thử lại.';

/** The ids that wire the field to its hint and its error, for a screen reader. */
export const DATE_OF_BIRTH_INPUT_ID = 'ngay-sinh';
export const DATE_OF_BIRTH_HINT_ID = 'ngay-sinh-hint';
export const DATE_OF_BIRTH_ERROR_ID = 'ngay-sinh-loi';

/**
 * What `aria-describedby` must say, given whether there is a message.
 *
 * A pure function because it is the part that is easy to get wrong and impossible
 * to see: the hint has to stay described even while an error is showing, or the
 * person hears the complaint and loses the instruction that would fix it.
 */
export function dateOfBirthDescribedBy(hasNotice: boolean): string {
  return hasNotice
    ? `${DATE_OF_BIRTH_HINT_ID} ${DATE_OF_BIRTH_ERROR_ID}`
    : DATE_OF_BIRTH_HINT_ID;
}

/**
 * The label and helper text, in one place so the two cannot drift apart.
 *
 * The hint no longer says "liên hệ hỗ trợ", for the reason
 * `DATE_OF_BIRTH_ALREADY_SET_MESSAGE` gives about itself: there is no support
 * channel, no operator tool and no role that can write this column twice, so
 * naming one before the field is even filled in promises a queue that does not
 * exist. It states the consequence instead, which is the part that is true and the
 * part somebody needs before they type.
 */
export const DATE_OF_BIRTH_LABEL = 'Ngày sinh của bạn';
export const DATE_OF_BIRTH_HINT = 'Chỉ khai một lần, và sau đó không tự đổi lại được.';
export const DATE_OF_BIRTH_SUBMIT = 'Lưu ngày sinh';
export const DECLARED_HEADING = 'Bạn đã khai ngày sinh';

/** Where the terminal branch sends somebody who has nothing left to do here. */
export const BACK_TO_ACCOUNT_LINK = 'Về trang tài khoản';

/**
 * The whole screen below the heading, as ONE effect-free component.
 *
 * One component rather than a form plus a separately-rendered notice, for the
 * reason `SignInPanel` gives about itself: two pieces that must agree are two
 * pieces either of which can be deleted with a full green run. "Already declared"
 * and "here is a form to declare" are the same decision, and rendering the form
 * beside the confirmation is the exact bug this shape makes unexpressible.
 *
 * No `'use client'`, no state, no effect, no `window` — so it runs under
 * `renderToStaticMarkup` and the assertions are about real output HTML.
 */
export function DateOfBirthPanel({
  state,
  notice: current,
  submitting,
  onRetry,
  onWaitFinished,
  onSubmit,
}: {
  readonly state: DateOfBirthScreenState;
  /** A message from the last attempt, with its wait, or `null`. */
  readonly notice: DeclarationNotice | null;
  readonly submitting: boolean;
  /**
   * Re-read the profile. REQUIRED, because the `unavailable` branch renders the
   * button and a branch that renders a button with no handler is the dead end
   * this parameter exists to remove.
   */
  readonly onRetry: () => void;
  /**
   * Told when a rate-limit wait ends, so the retry button becomes usable again.
   *
   * REQUIRED for the same reason `SignInPanel.onCountdownFinished` is: while it was
   * optional, forgetting it typechecked and shipped a screen whose countdown
   * reached zero and left the only button on it disabled for ever — the person is
   * told to wait, waits, and is then given nothing to press.
   */
  readonly onWaitFinished: () => void;
  /**
   * REQUIRED, even though `renderToStaticMarkup` never calls it.
   *
   * The `<form>` is rendered HERE rather than in `page.tsx`, because whether
   * there is a form at all is one of this component's five decisions — and a page
   * that wrapped the panel in its own form would nest one inside another in the
   * "already declared" and "signed out" branches, which is invalid HTML and which
   * nothing in a DOM-less project would notice. Making the handler required is
   * what stops the page keeping the markup and losing the submit.
   */
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const waitLabel = declarationWaitLabel(current);
  const bounds = dateOfBirthInputBounds();

  switch (state.kind) {
    case 'loading':
      // `status` like the other two non-form branches. It was the only one without
      // it, so a screen reader was told about every state of this screen except
      // the one it starts in.
      return <p role="status">Đang kiểm tra phiên…</p>;

    case 'unavailable':
      // `status`, not `alert`: nothing is wrong with what the person did, and
      // nothing here is urgent enough to interrupt a screen reader mid-sentence.
      return (
        <>
          <p role="status">{unavailableMessage(state.retryAfterSeconds)}</p>
          {/*
            The wait, when the server told us one. Without it this branch said "thử
            lại sau ít phút" and offered a button that called straight back into the
            limit — every press making the wait longer, which is the loop the whole
            `unavailable` state exists to break.

            The LIVE countdown rather than a static label, because the button beside
            it is disabled until the clock runs out: a number that never moves next
            to a control that never re-enables is a dead end with a decoration on it.
          */}
          {state.retryAfterSeconds === null ? null : (
            <SignInCountdown seconds={state.retryAfterSeconds} onFinished={onWaitFinished} />
          )}
          <button
            type="button"
            disabled={state.retryAfterSeconds !== null}
            onClick={onRetry}
          >
            {PROFILE_RETRY_LABEL}
          </button>
        </>
      );

    case 'signed-out':
      return (
        <>
          <p role="status">Bạn cần đăng nhập trước khi khai ngày sinh.</p>
          {/*
            A plain link to the login page, and the route comes from
            `packages/contracts` rather than from a literal — the same rule that put
            `SIGN_IN_PATHNAME` there in the first place.
          */}
          <a href={SIGN_IN_PATHNAME}>Tới trang đăng nhập</a>
        </>
      );

    case 'declared':
      return (
        <section>
          <h2>{DECLARED_HEADING}</h2>
          {/*
            What is NOT here is the point: not the date, not the age, not a field to
            change it. The screen confirms that the step is done and offers no way
            to redo it, because there is no endpoint that would accept one.
          */}
          <p>{DATE_OF_BIRTH_ALREADY_SET_MESSAGE}</p>
          {/*
            And a way ONWARD, which this branch used to lack entirely.

            It was the only terminal state on the screen with nothing to click: no
            link, no sign-out, nothing but a sentence — so somebody who arrived here
            (including anybody sent here by a 409) had to invent their own next move.
            The account view is `/dang-nhap`, which renders the signed-in panel with
            the sign-out button in it, and the route comes from `packages/contracts`
            for the same reason every other route on this screen does.
          */}
          <a href={SIGN_IN_PATHNAME}>{BACK_TO_ACCOUNT_LINK}</a>
        </section>
      );

    case 'needs-declaration':
      return (
        <form onSubmit={onSubmit}>
          <label htmlFor={DATE_OF_BIRTH_INPUT_ID}>{DATE_OF_BIRTH_LABEL}</label>
          {/*
            `type="date"` so a browser offers its own picker and produces the one
            format the contract accepts — `YYYY-MM-DD` is exactly what a date
            input's value is. It is a convenience and never a control:
            `dateOfBirthSubmission` judges whatever comes out, because a
            `type="date"` input is a text field to anything that is not a browser.

            `required` and `min` are the same kind of help: they stop a picker
            offering the year 1200, and they prove nothing — three layers behind
            this one refuse that anyway. There is deliberately no `max`; see
            `dateOfBirthInputBounds` for why a ceiling built from the browser's
            clock is a control rather than a convenience.

            `name` is `DATE_OF_BIRTH_FIELD` directly, not a prop. It used to be
            passed in by `page.tsx`, which then read the submitted form back with
            the constant — two halves that had to agree with nothing holding them
            together, and every test still green if they stopped. Read here, the
            disagreement is not expressible.
          */}
          <input
            id={DATE_OF_BIRTH_INPUT_ID}
            name={DATE_OF_BIRTH_FIELD}
            type="date"
            required
            min={bounds.min}
            aria-describedby={dateOfBirthDescribedBy(current !== null)}
            // Only while a message is on screen, and it is the field's own state:
            // "unavailable" and "signed out" never render this input at all.
            aria-invalid={current === null ? undefined : true}
          />
          <p id={DATE_OF_BIRTH_HINT_ID}>{DATE_OF_BIRTH_HINT}</p>
          {current === null ? null : (
            <p id={DATE_OF_BIRTH_ERROR_ID} role="alert">
              {current.message}
              {waitLabel === null ? null : ` ${waitLabel}`}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {DATE_OF_BIRTH_SUBMIT}
          </button>
        </form>
      );

    default:
      /**
       * A sixth state has to be given a branch, and the compiler is what says so.
       *
       * Before this, the form was the fall-through: any state nobody had thought
       * about rendered the declaration form — including, for a state meaning
       * "already declared", a field for a value that can no longer be written.
       * `never` turns adding a state without a branch into a typecheck error.
       */
      return exhausted(state);
  }
}

/**
 * The compiler's way of insisting that a new case gets a branch, used by both
 * switches in this file.
 *
 * The message names no particular union, because it serves two: a state this screen
 * renders and an outcome the shared reader can produce. What matters at runtime is
 * the value, which is printed.
 */
function exhausted(value: never): never {
  throw new Error(`unhandled date-of-birth case: ${JSON.stringify(value)}`);
}
