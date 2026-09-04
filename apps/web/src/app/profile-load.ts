import {
  RATE_LIMITED_MESSAGE,
  parseSignInRetryAfterSeconds,
  type CurrentUser,
} from '@stuwith/contracts';
// Imported, not re-declared. `429` written in a second module is a second chance to
// write `492`, and the seam already names it for the refresh leg.
import { RATE_LIMITED_STATUS, SESSION_EXPIRED_STATUS } from './session-expiry';

/**
 * What an answer from `GET /v1/auth/me` MEANS, decided once for every screen that
 * asks the question.
 *
 * ## Why this is shared rather than written per screen
 *
 * It was written twice, and the two copies disagreed in the way that matters.
 * `/khai-ngay-sinh` had a five-state reading with a long argument attached: only a
 * `401` means "signed out", everything else that is not a usable `200` is
 * `unavailable`, because `/v1/auth/me` is rate limited and telling a rate-limited
 * visitor to go and log in sends them to a page where every click makes the wait
 * longer. `/dang-nhap` mapped a `200` carrying a body it could not parse to
 * `signed-out` — so somebody who WAS signed in got four login links, and signing in
 * again could not help, because the body still would not parse. A loop with no exit,
 * produced by the exact reasoning the other screen had already rejected in writing.
 *
 * One decision, one module. A third screen that reads `/me` gets the same reading
 * without anybody having to remember the argument.
 *
 * ## Why `unavailable` carries the wait
 *
 * `429` is the case `unavailable` was invented for, and the seconds are the only
 * actionable fact in it. The declaration screen used to drop the header on this
 * path — `profileLoadStateFor(429, null)` never saw it — so the one screen that
 * knew to say "this is not a login problem" still could not say how long, and its
 * retry button called straight back into the limit. Reading the header is what
 * makes the button something other than a way to make the wait longer.
 */
export type ProfileLoadOutcome =
  /** A usable profile came back. */
  | { readonly kind: 'profile'; readonly user: CurrentUser }
  /** `401`, and only `401`: nobody is signed in. */
  | { readonly kind: 'signed-out' }
  /**
   * The profile could not be read, and NOT because nobody is signed in.
   *
   * `retryAfterSeconds` is `null` for every reason except a rate limit that told us
   * how long — never `0`, and never a guess.
   */
  | { readonly kind: 'unavailable'; readonly retryAfterSeconds: number | null };

/**
 * Status `0` is the convention both callers use for "nothing came back at all",
 * passed from their `catch`. It lands on `unavailable`, which is the honest answer:
 * there is no status to interpret, so nothing about the session is known.
 *
 * `user` is the already-parsed body, or `null` — parsing is the caller's job because
 * only the caller can await it. A `200` whose body is not a `CurrentUser` is not a
 * profile this product can act on, so it lands on `unavailable` rather than on a
 * guess in either direction.
 */
export function profileLoadOutcome(
  status: number,
  user: CurrentUser | null,
  retryAfterHeader: string | null,
): ProfileLoadOutcome {
  if (status === 200 && user !== null) {
    return { kind: 'profile', user };
  }
  if (status === SESSION_EXPIRED_STATUS) {
    return { kind: 'signed-out' };
  }
  return {
    kind: 'unavailable',
    // The same parser the sign-in header and the URL parameter go through, so a
    // header this product did not write cannot put a nonsense number on a screen.
    retryAfterSeconds:
      status === RATE_LIMITED_STATUS ? parseSignInRetryAfterSeconds(retryAfterHeader) : null,
  };
}

/**
 * What `unavailable` says when there is no wait to report.
 *
 * It does NOT say "log in": the person may well be signed in, and sending them to
 * the login page is what turns a rate limit into a longer one. When there IS a wait,
 * {@link RATE_LIMITED_MESSAGE} is shown instead — it is the sentence both processes
 * already share for exactly this, and it is the one the countdown belongs beside.
 */
export const PROFILE_UNAVAILABLE_MESSAGE = 'Chưa đọc được hồ sơ của bạn. Hãy thử lại sau ít phút.';

/** The way OUT of `unavailable`: re-read `/v1/auth/me`. */
export const PROFILE_RETRY_LABEL = 'Thử lại';

/**
 * The sentence that belongs to an `unavailable`, and the wait beside it.
 *
 * One function rather than a condition in each screen's JSX: "which sentence" and
 * "is there a clock" are one decision, and a screen that got the first right and the
 * second wrong would say "hãy thử lại sau ít phút" to somebody it was about to make
 * wait forty-five seconds.
 */
export function unavailableMessage(retryAfterSeconds: number | null): string {
  return retryAfterSeconds === null ? PROFILE_UNAVAILABLE_MESSAGE : RATE_LIMITED_MESSAGE;
}
