import { RATE_LIMITED_MESSAGE, SIGN_IN_OUTCOMES, type SignInOutcome } from '@stuwith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SignInCountdown } from './countdown';
import {
  COUNTDOWN_DONE_MESSAGE,
  countdownDeadline,
  countdownLabel,
  countdownViewAt,
  nextCountdownInstant,
  nextTickDelayMs,
  type CountdownClock,
} from './countdown-text';
import {
  MAX_OPTIONS_HIDDEN_SECONDS,
  OUTCOME_NOTICES,
  SignInPanel,
  nextLocationAfterOutcome,
  resolveSignInOutcome,
  signInNoticeFromMe,
  signInOptionsVisible,
  type SignInNotice,
} from './sign-in-outcome';

/**
 * Rows 8 and 9 of the story's I/O matrix — "a made-up outcome code" and "a
 * malicious one" — are claims about what the PAGE renders, and until this file
 * existed nothing executed that path at all. `contracts.test.ts` pins that
 * `isSignInOutcome` rejects an unknown string; nothing pinned that the login page
 * asks it. Replacing the guard with a cast would have left every other test green
 * while making both rows false.
 *
 * These render for real: `renderToStaticMarkup` is `react-dom`, already a
 * dependency, and needs no DOM environment — so the assertions are about actual
 * output HTML rather than about a value on its way to a renderer.
 */
function renderPanel(notice: SignInNotice | null, canSignIn = true): string {
  return renderToStaticMarkup(
    <SignInPanel notice={notice} canSignIn={canSignIn} loading={false} apiBaseUrl="" />,
  );
}

/**
 * Just the notice half, for the assertions that pin exact markup.
 *
 * The panel now renders the login links too — they are one decision and used to be
 * two deletable ones — so the sentence assertions look at everything before the
 * `<nav>`.
 */
function render(notice: SignInNotice | null, canSignIn = true): string {
  const html = renderPanel(notice, canSignIn);
  const nav = html.indexOf('<nav>');
  return nav === -1 ? html : html.slice(0, nav);
}

function noticeFor(outcome: SignInOutcome, retryAfterSeconds: number | null = null): SignInNotice {
  return { outcome, retryAfterSeconds };
}

/**
 * EXACTLY what the page does on load: one call to `nextLocationAfterOutcome`, and
 * its `notice` handed straight to the component.
 *
 * The composition is one exported function and one required prop, and both halves
 * of that matter. The previous version of this helper did the composition itself —
 * read the change, then passed `change.retryAfterSeconds` into a separate optional
 * prop — so deleting that prop from `page.tsx` typechecked, rendered a lock
 * message with no clock, and left every test here green.
 */
function renderLoadFor(search: string): string {
  return render(
    nextLocationAfterOutcome({ search, pathname: '/dang-nhap', hash: '' }).notice,
  );
}

describe('the sentences on the screen are the ones the AC specifies', () => {
  it('renders AC1 verbatim, in the voice of an error', () => {
    expect(renderLoadFor('?ket-qua=that-bai')).toBe(
      '<p role="alert">Không đăng nhập được. Thử lại hoặc chọn cách khác.</p>',
    );
  });

  it('renders AC2 verbatim, and NOT as an error', () => {
    const html = renderLoadFor('?ket-qua=da-huy');

    // `status` rather than `alert`: the person changed their mind, and the page
    // must not present that as something going wrong. Colour is not the channel —
    // there is no colour here yet, and there must not need to be.
    expect(html).toBe(
      '<p role="status">Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới.</p>',
    );
    expect(html).not.toContain('alert');
  });

  it.each([...SIGN_IN_OUTCOMES])('says something for the declared code %s', (outcome) => {
    // Guards against the opposite failure: an outcome added to the contract with
    // no sentence behind it, which renders an empty box instead of an explanation.
    expect(render(noticeFor(outcome)).length).toBeGreaterThan(0);
  });
});

describe('the notice appears only where it can be acted on', () => {
  /**
   * A signed-in visitor can reach `/dang-nhap?ket-qua=da-huy` from a stale link
   * or the back button. "Chọn lại cách đăng nhập bên dưới" above a signed-in view
   * with no login buttons under it is an instruction nobody can follow.
   */
  it.each([...SIGN_IN_OUTCOMES])('renders nothing for %s when signing in is not offered', (o) => {
    expect(render(noticeFor(o), false)).toBe('');
  });

  it('still renders when signing in IS offered', () => {
    expect(render(noticeFor('that-bai'), true)).not.toBe('');
  });
});

describe('Matrix row: a made-up outcome code', () => {
  it.each([
    ['a code nobody declared', '?ket-qua=khong-co-that'],
    ['an empty value', '?ket-qua='],
    ['a near miss', '?ket-qua=that-bai-roi'],
    ['different casing', '?ket-qua=That-Bai'],
    ['the parameter repeated with junk first', '?ket-qua=nonsense&ket-qua=that-bai'],
  ])('renders no message at all for %s', (_label, search) => {
    // Not "renders a fallback message" — nothing. A visit with a junk parameter
    // has to look exactly like an ordinary visit.
    expect(renderLoadFor(search)).toBe('');
  });

  it('renders nothing when there is no parameter, which is the ordinary visit', () => {
    expect(renderLoadFor('')).toBe('');
    expect(resolveSignInOutcome('').present).toBe(false);
  });
});

describe('Matrix row: a malicious outcome code', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '%3Cscript%3Ealert(1)%3C/script%3E',
    '"><img src=x onerror=alert(1)>',
    'javascript:alert(document.cookie)',
    'that-bai"><script>alert(1)</script>',
  ];

  it.each(payloads)('never reaches the screen: %s', (payload) => {
    const html = renderLoadFor(`?ket-qua=${encodeURIComponent(payload)}`);

    // The closed enum stops it before rendering, so the strong assertion is that
    // there is no output at all — stronger than "the output was escaped", which
    // is what a test would settle for if the value were being reflected.
    expect(html).toBe('');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('onerror');
  });

  it.each(payloads)('resolves to no outcome rather than to a cast: %s', (payload) => {
    expect(resolveSignInOutcome(`?ket-qua=${encodeURIComponent(payload)}`).outcome).toBeNull();
  });

  it('does not reflect the raw value anywhere in the output', () => {
    const payload = '<script>alert("stuwith")</script>';
    const html = renderLoadFor(`?ket-qua=${encodeURIComponent(payload)}`);

    expect(html).not.toContain('stuwith');
    expect(html).not.toContain(payload);
    // Escaped forms too — an escaped reflection is still a reflection, and the
    // next person to add `dangerouslySetInnerHTML` inherits it.
    expect(html).not.toContain('&lt;script&gt;');
  });

  it('never lets a payload into the URL the page writes back', () => {
    // `nextUrl` goes straight into `history.replaceState`, so it is a second
    // surface the value could survive on even after the message is suppressed.
    const change = nextLocationAfterOutcome({
      search: '?ket-qua=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      pathname: '/dang-nhap',
      hash: '',
    });

    expect(change.nextUrl).toBe('/dang-nhap');
    expect(change.notice).toBeNull();
  });
});

/**
 * The page's whole effect, minus the two browser calls. Read and rewrite come
 * back from ONE call, which is what makes "rewrite before read" — the reorder
 * that would make AC1 and AC2 invisible to every real user — unexpressible in
 * `page.tsx`.
 */
describe('what the address bar says afterwards', () => {
  it('reports the notice AND the rewritten URL from the same call', () => {
    const change = nextLocationAfterOutcome({
      search: '?ket-qua=that-bai',
      pathname: '/dang-nhap',
      hash: '',
    });

    expect(change.notice?.outcome).toBe('that-bai');
    expect(change.nextUrl).toBe('/dang-nhap');
  });

  it('leaves the URL alone when there is no outcome parameter', () => {
    const change = nextLocationAfterOutcome({
      search: '?ref=email',
      pathname: '/dang-nhap',
      hash: '#top',
    });

    // `null` and not "the same string": the page must not call `replaceState` at
    // all for an ordinary visit.
    expect(change.nextUrl).toBeNull();
    expect(change.notice).toBeNull();
  });

  it('keeps the path and the fragment', () => {
    expect(
      nextLocationAfterOutcome({
        search: '?ket-qua=da-huy&ref=email',
        pathname: '/dang-nhap',
        hash: '#chon-provider',
      }).nextUrl,
    ).toBe('/dang-nhap?ref=email#chon-provider');
  });

  it('strips an unrecognised value too, not just a valid one', () => {
    const resolved = resolveSignInOutcome('?ket-qua=<script>alert(1)</script>');

    expect(resolved.present).toBe(true);
    expect(resolved.outcome).toBeNull();
    expect(resolved.remainingSearch).toBe('');
  });

  it('shows nothing on the re-read, which is what a refresh becomes', () => {
    const first = nextLocationAfterOutcome({
      search: '?ket-qua=that-bai&ref=email',
      pathname: '/dang-nhap',
      hash: '',
    });
    expect(render(first.notice)).not.toBe('');

    // Exactly what the browser would hand back after `history.replaceState`.
    const second = nextLocationAfterOutcome({
      search: '?ref=email',
      pathname: '/dang-nhap',
      hash: '',
    });
    expect(second.nextUrl).toBeNull();
    expect(render(second.notice)).toBe('');
  });
});

/**
 * The query string belongs to whoever wrote it, not to this page. Re-serialising
 * it through `URLSearchParams.toString()` quietly rewrites escaping, collapses a
 * valueless key into `key=`, and turns `%20` into `+` — changes the page then
 * commits to the address bar on somebody else's behalf.
 */
describe('every other parameter survives byte for byte', () => {
  it.each([
    ['a percent escape', '?q=a%20b&ket-qua=that-bai', 'q=a%20b'],
    ['a valueless key', '?debug&ket-qua=that-bai', 'debug'],
    ['a literal plus', '?q=a+b&ket-qua=that-bai', 'q=a+b'],
    ['an encoded ampersand', '?q=a%26b&ket-qua=da-huy', 'q=a%26b'],
    ['order and position', '?ref=email&ket-qua=da-huy&lang=vi', 'ref=email&lang=vi'],
    ['the parameter last', '?a=1&b=2&ket-qua=that-bai', 'a=1&b=2'],
    ['the parameter first', '?ket-qua=that-bai&a=1&b=2', 'a=1&b=2'],
    ['a repeated outcome key', '?ket-qua=that-bai&a=1&ket-qua=da-huy', 'a=1'],
    ['a key that merely starts the same', '?ket-qua-cu=1&ket-qua=that-bai', 'ket-qua-cu=1'],
  ])('%s', (_label, search, expected) => {
    expect(resolveSignInOutcome(search).remainingSearch).toBe(expected);
  });

  it('survives a malformed escape rather than throwing', () => {
    // `decodeURIComponent('%zz')` throws. A stray escape in a link somebody sent
    // must not take the login page down with it.
    expect(resolveSignInOutcome('?bad=%zz&ket-qua=that-bai').remainingSearch).toBe('bad=%zz');
  });
});

/* ------------------------------------------------------------------------- *
 * Story 1.3 part 2 — the locked outcome and its countdown
 * ------------------------------------------------------------------------- */

describe('the locked outcome', () => {
  it('says what happened and what to do, and nothing technical', () => {
    const html = renderLoadFor('?ket-qua=bi-khoa');

    expect(html).toContain(RATE_LIMITED_MESSAGE);
    // `status`, not `alert`: being asked to wait is not an error the person made,
    // and `alert` interrupts whatever a screen reader was in the middle of.
    expect(html).toContain('role="status"');
    expect(html).not.toContain('alert');
  });

  it('reads its sentence from the contract, so both processes say the same thing', () => {
    // `apps/api` puts this exact string in the `rate_limited` envelope. It lived
    // in two packages, each pinned by its own literal, until one was edited alone.
    expect(OUTCOME_NOTICES['bi-khoa'].message).toBe(RATE_LIMITED_MESSAGE);
  });

  it('renders the frozen sentence and nothing of its own', () => {
    // What that sentence may contain is decided once, in `contracts.test.ts`,
    // beside the constant. This file used to keep its own copy of the rules, as
    // did two files in apps/api — so a word added to one left the others blind.
    expect(renderLoadFor('?ket-qua=bi-khoa')).toContain(RATE_LIMITED_MESSAGE);
  });

  it('shows a real countdown when the URL carries a usable one', () => {
    const html = renderLoadFor('?ket-qua=bi-khoa&giay=30');

    expect(html).toContain(countdownLabel(30));
    expect(html).toContain('aria-live="polite"');
  });

  it('shows the message with NO clock when there is no seconds parameter', () => {
    const html = renderLoadFor('?ket-qua=bi-khoa');

    expect(html).toContain(RATE_LIMITED_MESSAGE);
    expect(html).not.toContain('Thử lại sau');
  });
});

describe('Matrix row: a made-up number of seconds', () => {
  it.each([
    ['not a number', '?ket-qua=bi-khoa&giay=abc'],
    ['negative', '?ket-qua=bi-khoa&giay=-5'],
    ['absurdly large', '?ket-qua=bi-khoa&giay=99999999'],
    ['zero, which would invite an instant retry', '?ket-qua=bi-khoa&giay=0'],
    ['empty', '?ket-qua=bi-khoa&giay='],
    ['fractional', '?ket-qua=bi-khoa&giay=1.5'],
    ['padded with spaces', '?ket-qua=bi-khoa&giay=%20120%20'],
    ['hexadecimal', '?ket-qua=bi-khoa&giay=0x10'],
    ['exponential', '?ket-qua=bi-khoa&giay=1e3'],
    ['a leading zero', '?ket-qua=bi-khoa&giay=030'],
    ['a script payload', '?ket-qua=bi-khoa&giay=%3Cscript%3E'],
  ])('shows the lock message with no clock for %s', (_label, search) => {
    const html = renderLoadFor(search);

    // The message still appears — the person IS locked out. What is dropped is
    // the nonsense number, rather than being rendered as "thử lại sau 1157 ngày".
    expect(html).toContain(RATE_LIMITED_MESSAGE);
    expect(html).not.toContain('Thử lại sau');
  });

  it.each(['abc', '-5', '99999999', '0', '', '1.5', ' 12 ', '0x10', '1e3', '030'])(
    'resolves %s to no countdown at all',
    (raw) => {
      expect(
        resolveSignInOutcome(`?ket-qua=bi-khoa&giay=${encodeURIComponent(raw)}`)
          .retryAfterSeconds,
      ).toBeNull();
    },
  );

  it.each(['1', '30', '900', '86400'])('accepts %s, which is a real countdown', (raw) => {
    expect(resolveSignInOutcome(`?ket-qua=bi-khoa&giay=${raw}`).retryAfterSeconds).toBe(
      Number(raw),
    );
  });

  it('ignores a countdown attached to an outcome that has no clock', () => {
    // `?ket-qua=da-huy&giay=600` is a link a stranger can send. Cancelling has
    // nothing to count down to, and a clock beside it would be an invention.
    expect(resolveSignInOutcome('?ket-qua=da-huy&giay=600').retryAfterSeconds).toBeNull();
    expect(renderLoadFor('?ket-qua=da-huy&giay=600')).not.toContain('Thử lại sau');
  });

  it('ignores a countdown with no outcome beside it', () => {
    expect(resolveSignInOutcome('?giay=600').retryAfterSeconds).toBeNull();
    expect(renderLoadFor('?giay=600')).toBe('');
  });
});

describe('both parameters come off the address bar', () => {
  it('strips the outcome AND the seconds, keeping everything else', () => {
    const change = nextLocationAfterOutcome({
      search: '?ref=email&ket-qua=bi-khoa&giay=30&lang=vi',
      pathname: '/dang-nhap',
      hash: '',
    });

    expect(change.notice).toEqual({ outcome: 'bi-khoa', retryAfterSeconds: 30 });
    // Leaving `giay` behind means F5 restarts a countdown that has already run.
    expect(change.nextUrl).toBe('/dang-nhap?ref=email&lang=vi');
  });

  it('strips a stray seconds parameter even with no outcome to go with it', () => {
    const resolved = resolveSignInOutcome('?giay=30');

    expect(resolved.present).toBe(true);
    expect(resolved.remainingSearch).toBe('');
  });

  it('strips an unusable seconds value rather than leaving it to be re-read', () => {
    expect(resolveSignInOutcome('?ket-qua=bi-khoa&giay=abc').remainingSearch).toBe('');
  });
});

/**
 * Matrix rows: "đếm ngược là thật" and "đếm ngược khi giảm chuyển động".
 *
 * The countdown is driven by a DEADLINE and the wall clock, which is what makes it
 * testable here at all: simulated `now` values walk the same path a real browser
 * walks, in a project with no DOM. The previous version was "verified" by grepping
 * `countdown.tsx` for the string `setTimeout` — which would have passed with a
 * frozen clock, a 60-second delay, or a tick that returned its own input.
 */
describe('the countdown actually counts', () => {
  const START = 1_000_000;

  it('starts at the number it was given', () => {
    const deadline = countdownDeadline(START, 30);
    expect(countdownViewAt(deadline, START).secondsRemaining).toBe(30);
  });

  it('reaches zero by stepping through its own schedule, one tick at a time', () => {
    const deadline = countdownDeadline(START, 3);
    const seen: number[] = [];

    // Exactly the loop `countdown.tsx` runs: ask when the next tick is due, move
    // the clock there, read the view. If the schedule ever stopped advancing, this
    // would spin and the guard below would fail rather than the suite hanging.
    let now = START;
    for (let step = 0; step < 10; step += 1) {
      seen.push(countdownViewAt(deadline, now).secondsRemaining);
      const delay = nextTickDelayMs(deadline, now);
      if (delay === null) {
        break;
      }
      now += delay;
    }

    expect(seen).toEqual([3, 2, 1, 0]);
    expect(countdownViewAt(deadline, now).done).toBe(true);
    expect(countdownViewAt(deadline, now).message).toBe(COUNTDOWN_DONE_MESSAGE);
  });

  it('invites a retry once the wait is over, rather than showing "0 giây"', () => {
    const deadline = countdownDeadline(START, 5);
    const view = countdownViewAt(deadline, START + 5_000);

    expect(view.done).toBe(true);
    expect(view.message).toBe(COUNTDOWN_DONE_MESSAGE);
  });

  it('rounds a partial second UP, so the last one is still shown', () => {
    const deadline = countdownDeadline(START, 5);
    // 4.5s left must read as 5, not 4: "0 giây" while the lock is still live
    // invites the retry that gets refused.
    expect(countdownViewAt(deadline, START + 500).secondsRemaining).toBe(5);
    expect(countdownViewAt(deadline, START + 4_999).secondsRemaining).toBe(1);
  });

  it('does not drift when a tab was throttled and the clock jumped', () => {
    // A background tab is woken minutes late. Reading the wall clock means it
    // catches up; decrementing a counter would have it insisting on a wait that
    // ended long ago, while every retry succeeded.
    const deadline = countdownDeadline(START, 300);
    expect(countdownViewAt(deadline, START + 299_000).secondsRemaining).toBe(1);
    expect(countdownViewAt(deadline, START + 600_000).done).toBe(true);
  });

  it('stops scheduling once there is nothing left to count', () => {
    const deadline = countdownDeadline(START, 2);
    expect(nextTickDelayMs(deadline, START + 2_000)).toBeNull();
    expect(nextTickDelayMs(deadline, START + 99_000)).toBeNull();
  });

  it('aligns each tick to the deadline rather than to "one second from now"', () => {
    const deadline = countdownDeadline(START, 10);
    // 400ms into the second: the next change is 600ms away, not 1000ms. Arming a
    // flat 1000ms is what made the display fall behind real time.
    expect(nextTickDelayMs(deadline, START + 400)).toBe(600);
    expect(nextTickDelayMs(deadline, START)).toBe(1_000);
  });

  it('survives a value that is not a finite number', () => {
    expect(countdownViewAt(countdownDeadline(START, Number.NaN), START).done).toBe(true);
    expect(countdownViewAt(Number.NaN, START).done).toBe(true);
    expect(nextTickDelayMs(Number.NaN, START)).toBeNull();
  });
});

/**
 * The seam between the schedule and the SCREEN.
 *
 * `renderToStaticMarkup` runs the component body and the `useState` initialisers
 * but never `useEffect`, so for two rounds this component's rendered output was
 * never asserted at all — first "verified" by grepping its source, then by testing
 * the schedule in isolation. Injecting the clock closes what can be closed: the
 * body's arithmetic, its markup and its aria decisions are rendered at a chosen
 * instant and checked.
 *
 * **Residual, stated rather than hidden:** nothing here proves React *invokes* the
 * tick effect, because that needs a DOM and this project has none by decision
 * (`jsdom`, `happy-dom` and `@testing-library/*` are all absent; adding one is an
 * "Ask First" item). Emptying the `setTimeout` callback in `countdown.tsx` would
 * still pass. What that mutation can no longer do is hide: the schedule
 * (`nextTickDelayMs`, `nextCountdownInstant`) and the rendering
 * (`countdownViewAt` through the real component) are both pinned, so the untested
 * gap is three lines long and named here.
 */
function clockAt(instants: readonly number[]): CountdownClock {
  let index = 0;
  return {
    now: () => instants[Math.min(index++, instants.length - 1)] ?? 0,
  };
}

function renderCountdown(seconds: number, clock: CountdownClock): string {
  return renderToStaticMarkup(<SignInCountdown seconds={seconds} clock={clock} />);
}

describe('the countdown component renders the schedule it was given', () => {
  const T0 = 1_000_000;

  it('shows the full duration on its first frame', () => {
    // deadline = T0 + 60s, now = T0.
    expect(renderCountdown(60, clockAt([T0, T0]))).toContain(countdownLabel(60));
  });

  it('shows a SMALLER number when the clock has moved on', () => {
    // Same deadline (taken at T0), a later `now`. This is the assertion the whole
    // acceptance criterion rests on, and until the clock was injectable there was
    // no way to make it from this project.
    const later = renderCountdown(60, clockAt([T0, T0 + 45_000]));

    expect(later).toContain(countdownLabel(15));
    expect(later).not.toContain(countdownLabel(60));
  });

  it('invites a retry once the deadline has passed', () => {
    const finished = renderCountdown(60, clockAt([T0, T0 + 60_000]));

    expect(finished).toContain(COUNTDOWN_DONE_MESSAGE);
    expect(finished).not.toContain('Thử lại sau');
  });

  it('derives the deadline from the clock, so a new duration is a new deadline', () => {
    // Two mounts at the same instant with different `seconds` must differ; if the
    // deadline were a constant, or captured from something other than the clock,
    // these would agree.
    expect(renderCountdown(30, clockAt([T0, T0]))).toContain(countdownLabel(30));
    expect(renderCountdown(900, clockAt([T0, T0]))).toContain(countdownLabel(900));
  });

  it('is a polite live region, never an alert', () => {
    const html = renderCountdown(60, clockAt([T0, T0]));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('alert');
  });

  /**
   * The number is the one actionable fact the acceptance criterion promises, and
   * for a round it was inside `aria-hidden="true"` for the entire wait — so a
   * screen-reader user was told they were locked out and never told for how long.
   */
  it('ANNOUNCES the duration on the first frame', () => {
    const html = renderCountdown(60, clockAt([T0, T0]));

    expect(html).toContain(countdownLabel(60));
    expect(html).not.toContain('aria-hidden');
  });

  it('hides the per-second updates, which would otherwise be read aloud every second', () => {
    const html = renderCountdown(60, clockAt([T0, T0 + 45_000]));

    expect(html).toContain('aria-hidden="true"');
  });

  it('announces the end, so the wait finishing is heard', () => {
    const html = renderCountdown(60, clockAt([T0, T0 + 60_000]));

    expect(html).toContain(COUNTDOWN_DONE_MESSAGE);
    expect(html).not.toContain('aria-hidden');
  });
});

describe('nextCountdownInstant always moves forward', () => {
  it('uses the wall clock when it has advanced', () => {
    expect(nextCountdownInstant(1_000, { now: () => 2_000 })).toBe(2_000);
  });

  it.each([
    ['the clock has not moved', 1_000],
    ['the clock went backwards', 500],
  ])('steps forward anyway when %s', (_label, observed) => {
    // An identical value makes React bail out of the update, so the effect never
    // re-runs and the clock freezes for ever on a page telling somebody to wait.
    expect(nextCountdownInstant(1_000, { now: () => observed })).toBeGreaterThan(1_000);
  });
});

/**
 * The lock message used to sit directly above the four provider links, because
 * they were shown whenever `/v1/auth/me` answered 401 — which a rate-limited `429`
 * also produces. Every click spent another `auth_start` attempt and bounced the
 * person back with a longer wait.
 */
describe('the login options and the lock notice agree with each other', () => {
  it('hides the providers while a countdown is running', () => {
    expect(signInOptionsVisible({ outcome: 'bi-khoa', retryAfterSeconds: 30 }, true)).toBe(false);
  });

  it('shows them again once there is no countdown left to wait out', () => {
    // `page.tsx` clears the notice when the clock finishes, which lands here.
    expect(signInOptionsVisible(null, true)).toBe(true);
  });

  it('shows them for a lock with no usable countdown, rather than trapping anybody', () => {
    // `?ket-qua=bi-khoa` with a made-up `?giay=`: there is no clock to wait for,
    // so hiding the only way forward would leave the page with nothing on it.
    expect(signInOptionsVisible({ outcome: 'bi-khoa', retryAfterSeconds: null }, true)).toBe(true);
  });

  it.each(['that-bai', 'da-huy'] as const)('shows them for %s', (outcome) => {
    expect(signInOptionsVisible({ outcome, retryAfterSeconds: null }, true)).toBe(true);
  });

  it('hides them for a visitor who is already signed in', () => {
    expect(signInOptionsVisible(null, false)).toBe(false);
    expect(signInOptionsVisible({ outcome: 'that-bai', retryAfterSeconds: null }, false)).toBe(
      false,
    );
  });
});

/**
 * A stranger can put anything in the URL, including a very long wait.
 *
 * The countdown may SHOW up to a day, because that number came from a real
 * `Retry-After` and a long lock is a real thing. Hiding the only way to sign in is
 * different: `?ket-qua=bi-khoa&giay=86400` sent to somebody who is not
 * rate-limited at all would leave them with a page that has no login links for a
 * day. So the two bounds are deliberately not the same one.
 */
describe('a made-up countdown cannot hide the login links for long', () => {
  it('hides them for a wait short enough to be a real lock', () => {
    expect(signInOptionsVisible({ outcome: 'bi-khoa', retryAfterSeconds: 60 }, true)).toBe(false);
    expect(
      signInOptionsVisible(
        { outcome: 'bi-khoa', retryAfterSeconds: MAX_OPTIONS_HIDDEN_SECONDS },
        true,
      ),
    ).toBe(false);
  });

  it.each([MAX_OPTIONS_HIDDEN_SECONDS + 1, 3_600, 86_400])(
    'shows them anyway for a wait of %s seconds',
    (seconds) => {
      // The person can try, and find out from the server whether they are really
      // blocked — which is the only source of truth a URL cannot forge.
      expect(signInOptionsVisible({ outcome: 'bi-khoa', retryAfterSeconds: seconds }, true)).toBe(
        true,
      );
    },
  );

  it('still shows the countdown itself for a long wait', () => {
    // Only the LINKS are capped. A genuine `Retry-After: 3600` should still be
    // readable, or the person is told to wait with no idea how long.
    const html = renderPanel({ outcome: 'bi-khoa', retryAfterSeconds: 3_600 }, true);

    expect(html).toContain(countdownLabel(3_600));
    expect(html).toContain('<nav>');
  });

  it('covers the default brute-force lock, so a real lock does hide them', () => {
    // `RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS` defaults to 900.
    expect(MAX_OPTIONS_HIDDEN_SECONDS).toBeGreaterThanOrEqual(900);
  });
});

/**
 * A 429 from `/v1/auth/me` used to reach the page as "signed out".
 *
 * `!response.ok` covered both, so a rate-limited visitor got an ordinary login page
 * with four links and no notice — and the first click spent an `auth_start` and
 * bounced them back with a longer wait. That is the loop the panel exists to break,
 * arriving through the one entry point it could not see.
 */
describe('a rate-limited /v1/auth/me is not "signed out"', () => {
  it('becomes the locked notice, with the wait the server sent', () => {
    expect(signInNoticeFromMe(429, '45')).toEqual({
      outcome: 'bi-khoa',
      retryAfterSeconds: 45,
    });
  });

  it('shows the message with no clock when the header is missing or nonsense', () => {
    // The same parser the URL parameter goes through, so a header this product did
    // not write cannot put a nonsense number on the screen either.
    for (const header of [null, '', 'soon', '-5', '99999999', '0', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      expect(signInNoticeFromMe(429, header)).toEqual({
        outcome: 'bi-khoa',
        retryAfterSeconds: null,
      });
    }
  });

  it.each([200, 204, 401, 403, 500, 502])('is nothing for status %s', (status) => {
    // Only 429. A 401 is an ordinary signed-out visitor and must still be offered
    // the login links.
    expect(signInNoticeFromMe(status, '45')).toBeNull();
  });

  it('hides the login links once that notice is showing', () => {
    const notice = signInNoticeFromMe(429, '45');

    expect(notice).not.toBeNull();
    expect(renderPanel(notice, true)).not.toContain('<nav>');
  });
});

describe('the panel is one decision, not two', () => {
  it('offers the login links on an ordinary signed-out visit', () => {
    const html = renderPanel(null, true);

    expect(html).toContain('<nav>');
    expect(html).toContain('/v1/auth/google/start');
  });

  it('offers none of them to a visitor who is already signed in', () => {
    expect(renderPanel(null, false)).not.toContain('<nav>');
  });

  it('never shows a wait message above links that would spend another attempt', () => {
    // The failure both halves exist to prevent, asserted on ONE render because
    // they are now one component: while they were two props of the page, either
    // could be deleted with a full green run.
    const html = renderPanel({ outcome: 'bi-khoa', retryAfterSeconds: 30 }, true);

    expect(html).toContain(RATE_LIMITED_MESSAGE);
    expect(html).not.toContain('<nav>');
    expect(html).not.toContain('/v1/auth/google/start');
  });

  it('builds the provider links from the configured API origin', () => {
    const html = renderToStaticMarkup(
      <SignInPanel notice={null} canSignIn loading={false} apiBaseUrl="https://api.example" />,
    );

    expect(html).toContain('https://api.example/v1/auth/google/start');
  });

  it('says the session is being checked while the answer is not known', () => {
    const html = renderToStaticMarkup(
      <SignInPanel notice={null} canSignIn={false} loading apiBaseUrl="" />,
    );

    expect(html).toContain('Đang kiểm tra phiên');
  });
});
