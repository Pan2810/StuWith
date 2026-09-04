import {
  RATE_LIMITED_MESSAGE,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  isSignInOutcome,
  parseSignInRetryAfterSeconds,
  type SignInOutcome,
} from '@stuwith/contracts';
import { SignInCountdown } from './countdown';

/**
 * How the last sign-in attempt is turned into something a person reads.
 *
 * It lives beside the page rather than inside it for one reason: this is the
 * whole of the XSS-adjacent surface — a value the visitor controls arriving in a
 * URL and deciding what appears on screen — and a `'use client'` page whose only
 * entry point is an effect that reads `window` cannot be executed by a test
 * without a DOM environment. None is installed (no `jsdom`, no `happy-dom`, no
 * `@testing-library/*`), and adding one is an "Ask First" item.
 *
 * So everything that decides anything lives here, as pure functions and one
 * component with no effects, no state and no `window` — all of which run under
 * plain Node, the component included, because `renderToStaticMarkup` needs no
 * DOM. `page.tsx` is left holding `setOutcome(...)` and `replaceState(...)` and
 * nothing else. `sign-in-outcome.test.tsx` executes the rest.
 */

/**
 * Everything an outcome shows, in one place per outcome.
 *
 * One record rather than two parallel `Record<SignInOutcome, …>` maps: a third
 * outcome is one fact, and splitting it across two declarations is how a code
 * ends up with a sentence and no role, or a role and no sentence.
 *
 * The sentences are the acceptance criteria's, word for word, and this is the
 * only place either exists. It is also the only place a code from the URL becomes
 * text: what is rendered is always one of these constants, never the value that
 * arrived, so there is nothing for `?ket-qua=<script>…` to reflect even before
 * {@link isSignInOutcome} refuses it.
 *
 * Cancelling is NOT an error and the markup is what says so — not a colour.
 * `status` is announced politely and carries no alarm; `alert` interrupts.
 * Styling is Story 1.6's, but colour must never be the only channel carrying the
 * difference, so the distinction has to exist before there is anything to paint.
 *
 * Full i18n is Story 1.6; Vietnamese is the default locale and these are its
 * strings.
 */
export const OUTCOME_NOTICES: Record<
  SignInOutcome,
  {
    readonly message: string;
    readonly role: 'status' | 'alert';
    /** Whether a `?giay=` value means anything for this outcome. Only one does. */
    readonly showsCountdown: boolean;
  }
> = {
  'that-bai': {
    message: 'Không đăng nhập được. Thử lại hoặc chọn cách khác.',
    role: 'alert',
    showsCountdown: false,
  },
  'da-huy': {
    message: 'Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới.',
    role: 'status',
    showsCountdown: false,
  },
  /**
   * Story 1.3 part 2. The sentence says what happened and what to do, and nothing
   * a person probing the login could calibrate against: not whether the lock is by
   * address or by account, not the threshold, not how many attempts were left.
   *
   * `status` rather than `alert`. Being asked to wait is not an error the person
   * made, and `alert` interrupts whatever a screen reader was saying to announce
   * it. The countdown beside it carries the only number in the story.
   */
  'bi-khoa': {
    message: RATE_LIMITED_MESSAGE,
    role: 'status',
    showsCountdown: true,
  },
};

export interface ResolvedSignInOutcome {
  /** `null` for both "no parameter" and "a parameter we do not recognise". */
  readonly outcome: SignInOutcome | null;
  /**
   * The countdown, or `null` when there is no usable one.
   *
   * `null` means "show the lock message with no clock", never "show something
   * plausible". This value arrives in a URL a stranger can write and send, so
   * `?giay=abc`, `?giay=-5` and `?giay=99999999` all land here, and the last one
   * would otherwise put "thử lại sau 1157 ngày" in front of somebody who is not
   * locked out of anything.
   */
  readonly retryAfterSeconds: number | null;
  /**
   * Whether EITHER parameter was there at all — the signal to rewrite the address
   * bar. It is deliberately independent of `outcome`: an unrecognised value must
   * be stripped too, or it survives a refresh for no reason. A stray `?giay=` with
   * no outcome beside it is stripped for the same reason.
   */
  readonly present: boolean;
  /** What the query string should be once both parameters are gone, without `?`. */
  readonly remainingSearch: string;
}

/**
 * Remove one parameter from a query string and leave every other character of it
 * exactly as it was.
 *
 * The obvious implementation is `URLSearchParams.delete` then `.toString()`, and
 * it is wrong here: that re-serialises the WHOLE query, so `?a` comes back as
 * `a=`, `%20` comes back as `+`, and any escaping the original author chose is
 * replaced with the one `URLSearchParams` prefers. The page then writes that
 * through `history.replaceState`, silently rewriting parameters it does not own
 * and may not understand. Splitting on `&` and dropping whole segments touches
 * only the segment being removed.
 */
function stripQueryParam(search: string, name: string): { present: boolean; remaining: string } {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw.length === 0) {
    return { present: false, remaining: '' };
  }

  const kept: string[] = [];
  let present = false;
  for (const segment of raw.split('&')) {
    const separator = segment.indexOf('=');
    const key = separator === -1 ? segment : segment.slice(0, separator);
    if (decodeQueryKey(key) === name) {
      // Every occurrence, not just the first: a repeated key left half behind
      // would come back on the next read.
      present = true;
      continue;
    }
    kept.push(segment);
  }
  return { present, remaining: kept.join('&') };
}

/** `+` means a space in a query string, and a malformed `%` escape must not throw. */
function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

/**
 * Read the outcome out of a query string, and say what should be left behind.
 *
 * A value that is not in the closed enum is dropped in silence. It is something a
 * stranger can put in a link and send to somebody, so the page has to look
 * exactly like an ordinary visit: no message, and nothing from the URL rendered.
 */
export function resolveSignInOutcome(search: string): ResolvedSignInOutcome {
  // Reading through `URLSearchParams` and rewriting through `stripQueryParam` is
  // deliberate: decoding a value is exactly what the former is for, and rewriting
  // a string you do not own is exactly what it is bad at.
  const params = new URLSearchParams(search);
  const raw = params.get(SIGN_IN_OUTCOME_QUERY_PARAM);
  const outcome = raw !== null && isSignInOutcome(raw) ? raw : null;

  // Both parameters come off, in one pass each, and BOTH count as "present".
  // Leaving `giay` behind because the outcome beside it was junk would put a
  // number back on the screen the moment anything re-read the URL.
  const withoutOutcome = stripQueryParam(search, SIGN_IN_OUTCOME_QUERY_PARAM);
  const withoutSeconds = stripQueryParam(
    withoutOutcome.remaining,
    SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  );

  return {
    outcome,
    // The seconds mean nothing without an outcome that uses them. Reading them
    // anyway would let `?giay=30` alone put a countdown on an ordinary visit.
    retryAfterSeconds:
      outcome !== null && OUTCOME_NOTICES[outcome].showsCountdown
        ? parseSignInRetryAfterSeconds(params.get(SIGN_IN_RETRY_AFTER_QUERY_PARAM))
        : null,
    present: withoutOutcome.present || withoutSeconds.present,
    remainingSearch: withoutSeconds.remaining,
  };
}

/** The parts of `window.location` this decision needs. */
export interface PageLocation {
  readonly search: string;
  readonly pathname: string;
  readonly hash: string;
}

/**
 * Everything the notice needs, as one value.
 *
 * The outcome and its countdown travel together from the URL to the screen, so
 * they are one object rather than two parallel pieces of state that a careless
 * edit can separate. `null` retryAfterSeconds means "no clock", never "zero".
 */
export interface SignInNotice {
  readonly outcome: SignInOutcome;
  readonly retryAfterSeconds: number | null;
}

export interface OutcomeLocationChange {
  /** `null` for "nothing to show", which covers an unrecognised code too. */
  readonly notice: SignInNotice | null;
  /**
   * The URL the address bar should carry from now on, or `null` when there was no
   * outcome parameter and therefore nothing to rewrite.
   */
  readonly nextUrl: string | null;
}

/**
 * The whole of what the page's effect decides: what to show, and what the address
 * bar should say afterwards.
 *
 * Both halves are returned together on purpose. Read and rewrite are one step —
 * doing the rewrite first would erase the value before anything read it, and the
 * message would never appear. As two statements in an effect that is what a
 * careless reorder does, silently and with every test still green; as one
 * function it is not expressible.
 *
 * Leaving the parameter in place is the other failure: F5 would show "Không đăng
 * nhập được" to somebody who has not retried anything, a message that is simply
 * lying about the present.
 */
export function nextLocationAfterOutcome(location: PageLocation): OutcomeLocationChange {
  const resolved = resolveSignInOutcome(location.search);
  if (!resolved.present) {
    return { notice: null, nextUrl: null };
  }

  const query = resolved.remainingSearch;
  return {
    notice:
      resolved.outcome === null
        ? null
        : { outcome: resolved.outcome, retryAfterSeconds: resolved.retryAfterSeconds },
    nextUrl: `${location.pathname}${query.length > 0 ? `?${query}` : ''}${location.hash}`,
  };
}

/**
 * Renders nothing unless there is an outcome this app declared itself AND the
 * person can act on it.
 *
 * `canSignIn` is the second condition and it is not decoration: a visitor who is
 * already signed in can land on `/dang-nhap?ket-qua=da-huy` from a stale link or
 * a back button, and "Chọn lại cách đăng nhập bên dưới" above a signed-in view
 * with no login buttons under it is an instruction that cannot be followed.
 */
/**
 * Whether to offer the four provider links.
 *
 * They used to be shown whenever `/v1/auth/me` answered 401 — which a rate-limited
 * `429` also produces. So a locked-out visitor read "hãy chờ một lát" directly
 * above four buttons, and each click spent another `auth_start` attempt and
 * bounced them straight back with a longer wait. The notice and the links have to
 * agree about whether signing in is possible right now.
 *
 * A pure function rather than a condition inside the page, because it is a
 * decision and this project cannot execute the page.
 */
export function signInOptionsVisible(notice: SignInNotice | null, canSignIn: boolean): boolean {
  if (!canSignIn) {
    return false;
  }
  if (notice === null) {
    return true;
  }
  // Only while there is a countdown to wait out. Once it reaches zero the page
  // clears the notice and the links come back — see `page.tsx`.
  return !(OUTCOME_NOTICES[notice.outcome].showsCountdown && notice.retryAfterSeconds !== null);
}

export function SignInOutcomeNotice({
  notice,
  canSignIn,
  onCountdownFinished,
}: {
  /**
   * ONE prop carrying both halves, and that is the point of its shape.
   *
   * The countdown used to be a second, optional prop with a `null` default. So
   * deleting `retryAfterSeconds={…}` from `page.tsx` typechecked, rendered a lock
   * message with no clock, and left every test green — because the test built the
   * props itself and never rendered the page. The acceptance criterion "đếm ngược
   * thật bằng giây" would have shipped as a sentence with no number. Folded into
   * one required prop, that edit is a compile error.
   */
  readonly notice: SignInNotice | null;
  readonly canSignIn: boolean;
  /** Forwarded to the clock, so the page can offer the login links again. */
  readonly onCountdownFinished?: () => void;
}) {
  if (notice === null || !canSignIn) {
    return null;
  }
  const presentation = OUTCOME_NOTICES[notice.outcome];
  // Only one outcome has anything to count, and a number that arrived beside any
  // other one is ignored rather than rendered somewhere it makes no sense.
  const seconds = presentation.showsCountdown ? notice.retryAfterSeconds : null;

  return (
    <>
      <p role={presentation.role}>{presentation.message}</p>
      {seconds === null ? null : (
        <SignInCountdown seconds={seconds} onFinished={onCountdownFinished} />
      )}
    </>
  );
}
