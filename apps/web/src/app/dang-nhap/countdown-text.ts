/**
 * Every decision the countdown makes, with no React in the file.
 *
 * It is its own module for two reasons.
 *
 * The first is testability. The `web` Vitest project has no DOM environment (no
 * `jsdom`, no `happy-dom`, no `@testing-library/*`, and adding one is an
 * "Ask First" item), so a component with state and a timer cannot be executed by
 * any test in this repo. That was very nearly fatal to this feature: the first
 * version verified the clock by `readFileSync`-ing `countdown.tsx` and grepping it
 * for `setTimeout`. `renderToStaticMarkup` never runs effects, so only the first
 * frame was ever rendered — change the tick to a no-op, or the delay to a minute,
 * and the clock froze with every test green. A source grep is not a test of
 * behaviour. Everything below is, and `sign-in-outcome.test.tsx` drives it over
 * simulated time.
 *
 * The second is the dependency graph. `sign-in-outcome.tsx` renders
 * `SignInCountdown`, so `countdown.tsx` must not import back from it — that is a
 * cycle, and `dependency-cruiser`'s `no-circular` rule fails the build for it.
 * Both files depend on this one instead.
 *
 * ## Why a DEADLINE and not a decrementing counter
 *
 * The obvious model is "subtract one every second". It drifts: each render armed a
 * fresh 1000ms timeout, so the displayed number fell behind real time by the cost
 * of every render — and in a background tab, where browsers throttle timers to
 * once a minute, it crawls. Somebody would come back to a tab that still says
 * "thử lại sau 240 giây" fifteen minutes after the lock expired, and every retry
 * would succeed while the page insisted they wait. An absolute deadline plus the
 * wall clock cannot drift: a throttled tab simply catches up on its next tick.
 */

/**
 * The clock the countdown reads, as the smallest interface that will do.
 *
 * `Date` satisfies it in production. A test supplies its own, which is the only
 * way the component's rendered output can be asserted at two different instants in
 * a project with no DOM — `renderToStaticMarkup` runs the body and the `useState`
 * initialisers, so a chosen `now` reaches the screen.
 */
export interface CountdownClock {
  now(): number;
}

/**
 * The next instant to render at — strictly later than the current one.
 *
 * `setNow(clock.now())` alone is not enough. If the timer fires when the wall
 * clock has not visibly moved (a coarse timer, a busy thread, a clock that was
 * stepped backwards), React sees identical state, bails out of the update, and the
 * effect that would have armed the next timer never re-runs. The clock then
 * freezes for ever on a page telling somebody to wait.
 */
export function nextCountdownInstant(current: number, clock: CountdownClock): number {
  const observed = clock.now();
  return observed > current ? observed : current + 1;
}

/** The instant the wait ends, from when it started and how long it is. */
export function countdownDeadline(startedAtMs: number, seconds: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(seconds)) {
    return 0;
  }
  return startedAtMs + Math.max(0, Math.floor(seconds)) * 1_000;
}

export interface CountdownView {
  /** Whole seconds left, never negative. */
  readonly secondsRemaining: number;
  /** The sentence to put on screen right now. */
  readonly message: string;
  readonly done: boolean;
}

/**
 * What the clock says at a given instant.
 *
 * Rounded UP, so the last partial second is still shown as one: telling somebody
 * "0 giây" while the lock is still live invites the retry that gets refused.
 */
export function countdownViewAt(deadlineMs: number, nowMs: number): CountdownView {
  const remainingMs = deadlineMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { secondsRemaining: 0, message: COUNTDOWN_DONE_MESSAGE, done: true };
  }
  const secondsRemaining = Math.ceil(remainingMs / 1_000);
  return { secondsRemaining, message: countdownLabel(secondsRemaining), done: false };
}

/**
 * How long until the number on screen would change — or `null` when the wait is
 * over and there is nothing left to schedule.
 *
 * Aligned to the deadline rather than to "one second from now", which is what
 * keeps the displayed value and the real remaining time from separating over a
 * long lock. `null` is also what stops an interval waking a tab up for ever on a
 * page somebody left open.
 */
export function nextTickDelayMs(deadlineMs: number, nowMs: number): number | null {
  const remainingMs = deadlineMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return null;
  }
  const untilBoundary = remainingMs % 1_000;
  return untilBoundary === 0 ? 1_000 : untilBoundary;
}

/** Vietnamese is the default locale; full i18n is Story 1.6. */
export function countdownLabel(seconds: number): string {
  return `Thử lại sau ${seconds} giây.`;
}

/**
 * What the live region says when the wait is over — the one sentence a screen
 * reader is meant to hear from this component. See `countdown.tsx` for why it is
 * the only announcement rather than one per second.
 */
export const COUNTDOWN_DONE_MESSAGE = 'Bạn có thể thử lại ngay bây giờ.';
