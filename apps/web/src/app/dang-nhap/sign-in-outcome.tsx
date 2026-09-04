import {
  SIGN_IN_OUTCOME_QUERY_PARAM,
  isSignInOutcome,
  type SignInOutcome,
} from '@stuwith/contracts';

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
  { readonly message: string; readonly role: 'status' | 'alert' }
> = {
  'that-bai': {
    message: 'Không đăng nhập được. Thử lại hoặc chọn cách khác.',
    role: 'alert',
  },
  'da-huy': {
    message: 'Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới.',
    role: 'status',
  },
};

export interface ResolvedSignInOutcome {
  /** `null` for both "no parameter" and "a parameter we do not recognise". */
  readonly outcome: SignInOutcome | null;
  /**
   * Whether the parameter was there at all — the signal to rewrite the address
   * bar. It is deliberately independent of `outcome`: an unrecognised value must
   * be stripped too, or it survives a refresh for no reason.
   */
  readonly present: boolean;
  /** What the query string should be once the parameter is gone, without `?`. */
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
  const raw = new URLSearchParams(search).get(SIGN_IN_OUTCOME_QUERY_PARAM);
  const stripped = stripQueryParam(search, SIGN_IN_OUTCOME_QUERY_PARAM);

  return {
    outcome: raw !== null && isSignInOutcome(raw) ? raw : null,
    present: stripped.present,
    remainingSearch: stripped.remaining,
  };
}

/** The parts of `window.location` this decision needs. */
export interface PageLocation {
  readonly search: string;
  readonly pathname: string;
  readonly hash: string;
}

export interface OutcomeLocationChange {
  readonly outcome: SignInOutcome | null;
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
    return { outcome: null, nextUrl: null };
  }

  const query = resolved.remainingSearch;
  return {
    outcome: resolved.outcome,
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
export function SignInOutcomeNotice({
  outcome,
  canSignIn,
}: {
  readonly outcome: SignInOutcome | null;
  readonly canSignIn: boolean;
}) {
  if (outcome === null || !canSignIn) {
    return null;
  }
  const notice = OUTCOME_NOTICES[outcome];
  return <p role={notice.role}>{notice.message}</p>;
}
