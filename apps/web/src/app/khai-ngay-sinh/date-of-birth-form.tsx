import {
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  SIGN_IN_PATHNAME,
  isProfileCompleted,
  parseDateOfBirth,
  type CurrentUser,
} from '@stuwith/contracts';
import type { FormEvent } from 'react';

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

export function dateOfBirthSubmission(raw: unknown, today: Date): DateOfBirthSubmission {
  const parsed = parseDateOfBirth(raw, today);
  return parsed === null
    ? { kind: 'invalid', message: DATE_OF_BIRTH_INVALID_MESSAGE }
    : { kind: 'send', value: parsed };
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
export type DeclarationOutcome =
  | { readonly kind: 'declared' }
  | { readonly kind: 'message'; readonly message: string };

export function declarationOutcomeFor(status: number): DeclarationOutcome {
  switch (status) {
    case 200:
      return { kind: 'declared' };
    case 409:
      // Already set — by another tab, by a double submit, or by an earlier visit.
      // The goal state, reached by somebody else's request.
      return { kind: 'declared' };
    case 400:
      return { kind: 'message', message: DATE_OF_BIRTH_INVALID_MESSAGE };
    case 401:
      // The session died between loading this page and submitting it. The seam
      // has already tried a refresh and raised the dialog; this sentence is what
      // is left on the screen underneath it.
      return { kind: 'message', message: SESSION_LOST_MESSAGE };
    default:
      return { kind: 'message', message: TRY_AGAIN_MESSAGE };
  }
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
  notice,
  submitting,
  inputName,
  onSubmit,
}: {
  readonly state: DateOfBirthScreenState;
  /** A message from the last attempt, or `null`. */
  readonly notice: string | null;
  readonly submitting: boolean;
  /** The form field's name, so `page.tsx` reads back what this rendered. */
  readonly inputName: string;
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
  if (state.kind === 'loading') {
    return <p>Đang kiểm tra phiên…</p>;
  }

  if (state.kind === 'unavailable') {
    // `status`, not `alert`: nothing is wrong with what the person did, and
    // nothing here is urgent enough to interrupt a screen reader mid-sentence.
    return <p role="status">{PROFILE_UNAVAILABLE_MESSAGE}</p>;
  }

  if (state.kind === 'signed-out') {
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
  }

  if (state.kind === 'declared') {
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
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="ngay-sinh">{DATE_OF_BIRTH_LABEL}</label>
      {/*
        `type="date"` so a browser offers its own picker and produces the one
        format the contract accepts — `YYYY-MM-DD` is exactly what a date input's
        value is. It is a convenience and never a control: `dateOfBirthSubmission`
        judges whatever comes out, because a `type="date"` input is a text field
        to anything that is not a browser.

        `required` for the same reason: it helps a person, it proves nothing.
      */}
      <input id="ngay-sinh" name={inputName} type="date" required />
      <p id="ngay-sinh-hint">{DATE_OF_BIRTH_HINT}</p>
      {notice === null ? null : <p role="alert">{notice}</p>}
      <button type="submit" disabled={submitting}>
        {DATE_OF_BIRTH_SUBMIT}
      </button>
    </form>
  );
}
