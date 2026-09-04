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
import { countdownLabel } from '../dang-nhap/countdown-text';

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
  | { readonly kind: 'unavailable' }
  /** Signed in, nothing declared: the one state where the form is offered. */
  | { readonly kind: 'needs-declaration'; readonly user: CurrentUser }
  /** Already declared. The form must NOT be offered — there is no way to change it. */
  | { readonly kind: 'declared'; readonly user: CurrentUser };

/**
 * Which state a PROFILE puts this screen in, once one has been read.
 *
 * `isProfileCompleted` rather than `user.profile_completed` directly: the field
 * is optional in the contract, so it has three states while the screen has two,
 * and the shared helper is what makes "absent reads as not completed" one rule
 * instead of one per caller.
 */
export function screenStateFor(user: CurrentUser): DateOfBirthScreenState {
  return isProfileCompleted(user)
    ? { kind: 'declared', user }
    : { kind: 'needs-declaration', user };
}

/**
 * Which state a `/v1/auth/me` ANSWER puts this screen in — status included.
 *
 * Only a `401` means "signed out". Everything else that is not a usable 200 is
 * `unavailable`, and the distinction is not pedantry: `/v1/auth/me` is rate
 * limited, so a `429` is a real answer this screen receives, and treating it as
 * signed-out would show "you need to log in first" to somebody who already is —
 * then send them to a login page where every click costs another attempt.
 *
 * Status `0` is the convention for "nothing came back at all", which the page
 * passes from its `catch`. It lands on `unavailable`, which is the honest answer.
 */
export function profileLoadStateFor(
  status: number,
  user: CurrentUser | null,
): DateOfBirthScreenState {
  if (status === 200 && user !== null) {
    return screenStateFor(user);
  }
  return status === 401 ? { kind: 'signed-out' } : { kind: 'unavailable' };
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
 * What the date picker offers, which is a convenience and never a control.
 *
 * `min` comes from the contract's own plausibility floor and needs no clock.
 * `max` is today as the browser sees it — good enough to stop the picker offering
 * tomorrow, and deliberately not load-bearing: the value is judged by
 * {@link dateOfBirthSubmission} and then again by `apps/api`. An unusable clock
 * simply produces no `max` rather than a bound nobody can satisfy.
 */
export function dateOfBirthInputBounds(today: Date): {
  readonly min: string;
  readonly max: string | undefined;
} {
  const min = `${String(MIN_DATE_OF_BIRTH_YEAR).padStart(4, '0')}-01-01`;
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) {
    return { min, max: undefined };
  }
  const month = String(today.getUTCMonth() + 1).padStart(2, '0');
  const day = String(today.getUTCDate()).padStart(2, '0');
  return { min, max: `${String(today.getUTCFullYear()).padStart(4, '0')}-${month}-${day}` };
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
  | { readonly kind: 'declared' }
  | { readonly kind: 'message'; readonly notice: DeclarationNotice };

const notice = (message: string, retryAfterSeconds: number | null = null): DeclarationOutcome => ({
  kind: 'message',
  notice: { message, retryAfterSeconds },
});

export function declarationOutcomeFor(
  status: number,
  retryAfterHeader: string | null = null,
): DeclarationOutcome {
  switch (status) {
    case 200:
      return { kind: 'declared' };
    case 409:
      // Already set — by another tab, by a double submit, or by an earlier visit.
      // The goal state, reached by somebody else's request.
      return { kind: 'declared' };
    case 400:
      return notice(DATE_OF_BIRTH_INVALID_MESSAGE);
    case 401:
      // The session died between loading this page and submitting it. The seam
      // has already tried a refresh and raised the dialog; this sentence is what
      // is left on the screen underneath it.
      return notice(SESSION_LOST_MESSAGE);
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
      return notice(TRY_AGAIN_MESSAGE);
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
 * What `unavailable` says. It does NOT say "log in": the person may well be
 * signed in, and sending them to the login page is what turns a rate limit into a
 * longer one.
 */
export const PROFILE_UNAVAILABLE_MESSAGE =
  'Chưa đọc được hồ sơ của bạn. Hãy thử lại sau ít phút.';

/**
 * The way OUT of `unavailable`, which used to be a dead end.
 *
 * The branch rendered one `<p role="status">` and nothing else, so the only way
 * forward was for the person to work out that a page reload might help. A button
 * that re-reads `/v1/auth/me` is the whole of what was missing, and it is the same
 * call the page already makes on mount.
 */
export const PROFILE_RETRY_LABEL = 'Thử lại';

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

/** The label and helper text, in one place so the two cannot drift apart. */
export const DATE_OF_BIRTH_LABEL = 'Ngày sinh của bạn';
export const DATE_OF_BIRTH_HINT = 'Chỉ khai một lần. Muốn đổi thì cần liên hệ hỗ trợ.';
export const DATE_OF_BIRTH_SUBMIT = 'Lưu ngày sinh';
export const DECLARED_HEADING = 'Bạn đã khai ngày sinh';

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
  today,
  onRetry,
  onSubmit,
}: {
  readonly state: DateOfBirthScreenState;
  /** A message from the last attempt, with its wait, or `null`. */
  readonly notice: DeclarationNotice | null;
  readonly submitting: boolean;
  /**
   * Today, for the picker's `max` only — never for a verdict.
   *
   * Injected rather than read here for the reason `SignInCountdown` takes a
   * clock: a component that reads the wall clock cannot be rendered at a chosen
   * instant, so its output cannot be asserted in a project with no DOM.
   */
  readonly today: Date;
  /**
   * Re-read the profile. REQUIRED, because the `unavailable` branch renders the
   * button and a branch that renders a button with no handler is the dead end
   * this parameter exists to remove.
   */
  readonly onRetry: () => void;
  /**
   * REQUIRED, even though `renderToStaticMarkup` never calls it.
   *
   * The `<form>` is rendered HERE rather than in `page.tsx`, because whether
   * there is a form at all is one of this component's four decisions — and a page
   * that wrapped the panel in its own form would nest one inside another in the
   * "already declared" and "signed out" branches, which is invalid HTML and which
   * nothing in a DOM-less project would notice. Making the handler required is
   * what stops the page keeping the markup and losing the submit.
   */
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const waitLabel = declarationWaitLabel(current);
  const bounds = dateOfBirthInputBounds(today);

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
          <p role="status">{PROFILE_UNAVAILABLE_MESSAGE}</p>
          {/*
            The way forward, which this branch used to lack entirely. Without it
            the only move left is a page reload the person has to think of.
          */}
          <button type="button" onClick={onRetry}>
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

            `required`, `min` and `max` are the same kind of help: they stop a
            picker offering tomorrow or the year 1200, and they prove nothing —
            three layers behind this one refuse those anyway.

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
            max={bounds.max}
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

function exhausted(state: never): never {
  throw new Error(`unhandled date-of-birth screen state: ${JSON.stringify(state)}`);
}
