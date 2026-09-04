'use client';

import { useEffect, useRef, useState } from 'react';
import {
  countdownDeadline,
  countdownViewAt,
  nextCountdownInstant,
  nextTickDelayMs,
  type CountdownClock,
} from './countdown-text';

/**
 * The clock beside "bạn đã thử quá nhiều lần".
 *
 * ## It keeps running under `prefers-reduced-motion`
 *
 * There is deliberately no `matchMedia`, no motion query and no CSS animation
 * anywhere near it. That is the implementation of the epic-context rule "dưới
 * `prefers-reduced-motion` tắt mọi chuyển động trang trí **nhưng đồng hồ đếm
 * ngược vẫn cập nhật** vì đó là thông tin, không phải hiệu ứng": a number saying
 * how long is left answers the person's only question, and withholding it because
 * they asked for less motion leaves them staring at a wall.
 *
 * ## The clock is a prop, so the rendered output can be checked at two instants
 *
 * `renderToStaticMarkup` runs the component body and `useState` initialisers but
 * never `useEffect`. Every earlier attempt at testing this component therefore
 * verified nothing about the screen: first by grepping this file's source, then by
 * testing the schedule in isolation. Injecting `clock` closes the part that CAN be
 * closed without a DOM — the body's own arithmetic and markup are now rendered at
 * a chosen instant and asserted, so a wrong deadline, a wrong label, a missing
 * `aria-live` or a broken restart-on-new-`seconds` all fail.
 *
 * What remains unverifiable in a project with no DOM is that React *invokes* the
 * effect at all; `sign-in-outcome.test.tsx` names that residual next to the tests
 * that bound it.
 */
export function SignInCountdown({
  seconds,
  clock = Date,
  onFinished,
}: {
  readonly seconds: number;
  /** Injected only by tests. Production passes `Date`. */
  readonly clock?: CountdownClock;
  /** Told once the wait is over, so the page can offer the login links again. */
  readonly onFinished?: () => void;
}) {
  const [deadline, setDeadline] = useState(() => countdownDeadline(clock.now(), seconds));
  const [now, setNow] = useState(() => clock.now());

  /**
   * The callback is held in a ref, and is NOT a dependency of the tick effect.
   *
   * `page.tsx` passes a fresh inline closure on every render, so listing it would
   * re-run the effect — clearing and re-arming the timeout — every time the parent
   * re-rendered. A parent that re-renders faster than the tick delay then stalls
   * the clock completely: the timeout is cancelled before it can ever fire.
   */
  const finished = useRef(onFinished);
  finished.current = onFinished;

  /**
   * A second lock, with a different countdown, has to restart the clock.
   *
   * Without this the deadline is fixed at mount and a new `seconds` never reaches
   * the screen — the person is shown a finished countdown for a wait that has just
   * begun.
   */
  useEffect(() => {
    const started = clock.now();
    setDeadline(countdownDeadline(started, seconds));
    setNow(started);
  }, [seconds, clock]);

  useEffect(() => {
    const delay = nextTickDelayMs(deadline, now);
    if (delay === null) {
      // Nothing left to count. An interval left running here would keep waking a
      // tab up for ever on a page somebody walked away from. The page is told, so
      // the four provider links — hidden while the wait ran, or they would spend
      // another attempt each — come back.
      finished.current?.();
      return undefined;
    }
    // `nextCountdownInstant` is what guarantees progress: if the timer fires when
    // the wall clock has not visibly moved, an identical `now` makes React bail
    // out of the update, the effect never re-runs, and the clock freezes.
    const timer = setTimeout(() => setNow((current) => nextCountdownInstant(current, clock)), delay);
    return () => clearTimeout(timer);
  }, [deadline, now, clock]);

  const view = countdownViewAt(deadline, now);

  /**
   * Announced twice and no more: once when it appears, once when it ends.
   *
   * A live region whose text changes every second makes a screen reader read a new
   * sentence every second, which is unusable. Hiding the number for the whole wait
   * was the other extreme, and it withheld the one actionable fact the acceptance
   * criterion promises — somebody was told they were locked out and never told for
   * how long. So the FIRST frame is announced (it carries the full duration), every
   * tick after it is `aria-hidden`, and the end is announced again.
   */
  const announced = view.done || now === deadline - seconds * 1_000;

  return (
    <p role="status" aria-live="polite">
      {announced ? view.message : <span aria-hidden="true">{view.message}</span>}
    </p>
  );
}
