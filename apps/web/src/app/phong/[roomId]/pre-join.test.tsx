import {
  CREATE_ROOM_PATHNAME,
  ROOM_ADMISSION_FORBIDDEN_MESSAGE,
  ROOM_CLOSED_MESSAGE,
  ROOM_FULL_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
  makeError,
  type CurrentUser,
  type RoomTokenResponse,
} from '@stuwith/contracts';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale } from '../../i18n/locale';
import { VI_TRANSLATE, translatorFor } from '../../i18n/messages';
import { I18nProvider } from '../../i18n/use-t';
import {
  FACE_MODE_FIELD,
  JOIN_ERROR_ID,
  MIC_AUDIBLE_LEVEL,
  MIC_METER_ID,
  PREVIEW_VIDEO_ID,
  PreJoinPanel,
  admissionMatchesRoom,
  avatarInitialsFor,
  browserFamilyFor,
  deviceStateFor,
  effectiveFaceModeFor,
  faceModeAvailable,
  joinLabelKeyFor,
  joinOutcomeFor,
  joinRequestFor,
  mediaConstraintsFor,
  micLevelFromSamples,
  micLevelLabelKeyFor,
  micLevelPercent,
  permissionHelpKeysFor,
  preJoinStateFor,
  presenceNoticeFor,
  retriesAudioOnly,
  roomDecisionFor,
  roomIdFrom,
  type BrowserFamily,
  type DeviceState,
  type JoinPhase,
  type PreJoinScreenState,
} from './pre-join';
import { DEFAULT_FACE_MODE, FACE_MODES, RoomShell, type RoomDecision } from './room-shell';

/**
 * The web half of Story 2.3's matrix, executed.
 *
 * Every decision is a pure function and every screen is `renderToStaticMarkup`
 * output, so what is asserted is real HTML rather than a value on its way to a
 * renderer. What this file cannot cover is stated once: that React runs the
 * page's effects, that `getUserMedia` is asked, that a track's `readyState`
 * becomes `ended`, and that no `RTCPeerConnection` is ever constructed. Those are
 * `tests/e2e/web/phong.spec.ts`, in a real Chromium with fake devices.
 */

const ROOM_ID = '019200f1-0000-7000-8000-000000000001';

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: '019200f0-0000-7000-8000-000000000001',
    display_name: 'Trâm Anh',
    avatar_url: null,
    role: 'user',
    profile_completed: true,
    is_over_18: true,
    ...overrides,
  };
}

function token(): RoomTokenResponse {
  return {
    token: 'eyJ.abc.def',
    url: 'wss://livekit.example.vn',
    expires_at: '2026-09-13T09:02:00.000Z',
    room_id: ROOM_ID,
  };
}

function decision(overrides: Partial<RoomDecision> = {}): RoomDecision {
  return {
    roomId: ROOM_ID,
    faceMode: 'hide',
    audio: 'mic',
    token: 'eyJ.abc.def',
    url: 'wss://livekit.example.vn',
    expiresAt: '2026-09-13T09:02:00.000Z',
    ...overrides,
  };
}

const IDLE: JoinPhase = { kind: 'idle' };

function render(
  state: PreJoinScreenState,
  options: {
    readonly faceMode?: (typeof FACE_MODES)[number];
    readonly micLevel?: number;
    readonly join?: JoinPhase;
    readonly retryingDevices?: boolean;
    readonly browserFamily?: BrowserFamily;
    readonly locale?: Locale;
  } = {},
): string {
  const panel = (
    <PreJoinPanel
      state={state}
      faceMode={options.faceMode ?? DEFAULT_FACE_MODE}
      micLevel={options.micLevel ?? 0}
      videoRef={createRef<HTMLVideoElement | null>()}
      join={options.join ?? IDLE}
      retryingDevices={options.retryingDevices ?? false}
      browserFamily={options.browserFamily ?? 'chrome'}
      apiBaseUrl="http://api.test"
      onFaceModeChange={() => undefined}
      onRetryDevices={() => undefined}
      onJoin={() => undefined}
      onRetryProfile={() => undefined}
      onWaitFinished={() => undefined}
    />
  );
  return renderToStaticMarkup(
    options.locale === undefined ? panel : <I18nProvider locale={options.locale}>{panel}</I18nProvider>,
  );
}

const preJoin = (device: DeviceState | null): PreJoinScreenState => ({
  kind: 'pre-join',
  user: user(),
  device,
});

/** The `<input type="radio">` tag for one mode, whatever order React wrote its attributes in. */
function radio(html: string, value: string): string {
  const tag = (html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []).find((each) =>
    each.includes(`value="${value}"`),
  );
  expect(tag, `no radio for ${value}`).toBeDefined();
  return tag ?? '';
}

/* -------------------------------------------------------------------------- *
 * Devices
 * -------------------------------------------------------------------------- */

describe('deviceStateFor — one word per getUserMedia answer', () => {
  it('reads success on the first request as granted, and on the audio retry as no-camera', () => {
    expect(deviceStateFor(null, 'both')).toBe('granted');
    expect(deviceStateFor(null, 'audio-only')).toBe('no-camera');
    // The camera coming back after "Ẩn mặt": granted again.
    expect(deviceStateFor(null, 'video-only')).toBe('granted');
  });

  it.each(['NotAllowedError', 'PermissionDeniedError', 'SecurityError'])(
    'reads %s as blocked, whichever request it answered',
    (name) => {
      expect(deviceStateFor(name, 'both')).toBe('blocked');
      expect(deviceStateFor(name, 'audio-only')).toBe('blocked');
      // A permission revoked between two presses is the help block, not "no camera".
      expect(deviceStateFor(name, 'video-only')).toBe('blocked');
    },
  );

  it.each(['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'])(
    'reads %s as no-camera first, and as no-mic once audio alone is refused',
    (name) => {
      // The matrix rows "không có camera, có mic" and "không có mic", as the two
      // halves of one loop.
      const first = deviceStateFor(name, 'both');
      expect(first).toBe('no-camera');
      expect(retriesAudioOnly(first, 'both')).toBe(true);
      expect(deviceStateFor(name, 'audio-only')).toBe('no-mic');
      expect(retriesAudioOnly('no-mic', 'audio-only')).toBe(false);
      // And a FINAL no-camera — audio opened — is not retried again.
      expect(retriesAudioOnly('no-camera', 'audio-only')).toBe(false);
    },
  );

  it.each(['NotReadableError', 'AbortError', 'TypeError', 'UnknownError'])(
    'reads %s as unreadable — the general sentence, not the help block',
    (name) => {
      expect(deviceStateFor(name, 'both')).toBe('unreadable');
    },
  );

  it.each(['NotFoundError', 'NotReadableError', 'AbortError', 'UnknownError'])(
    'reads %s on the video-only re-request as no-camera — the microphone that is open is never called unreadable',
    (name) => {
      expect(deviceStateFor(name, 'video-only')).toBe('no-camera');
      expect(retriesAudioOnly('no-camera', 'video-only')).toBe(false);
    },
  );

  it('sends video and audio first, audio alone on the retry, and video alone only on a press', () => {
    expect(mediaConstraintsFor('both')).toEqual({ video: true, audio: true });
    expect(mediaConstraintsFor('audio-only')).toEqual({ audio: true });
    expect(mediaConstraintsFor('video-only')).toEqual({ video: true });
  });
});

describe('the microphone level', () => {
  it('reads silence as 0 and a full-scale square wave as 1, centred on 128', () => {
    expect(micLevelFromSamples(new Uint8Array(64).fill(128))).toBe(0);
    const square = new Uint8Array(64).map((_, i) => (i % 2 === 0 ? 0 : 255));
    expect(micLevelFromSamples(square)).toBeCloseTo(1, 1);
    expect(micLevelFromSamples([])).toBe(0);
  });

  it('turns a level into a sentence at ONE threshold, and into a clamped percentage', () => {
    expect(micLevelLabelKeyFor(0)).toBe('preJoin.micQuiet');
    expect(micLevelLabelKeyFor(MIC_AUDIBLE_LEVEL - 0.001)).toBe('preJoin.micQuiet');
    expect(micLevelLabelKeyFor(MIC_AUDIBLE_LEVEL)).toBe('preJoin.micLoud');
    expect(micLevelPercent(0.435)).toBe(44);
    expect(micLevelPercent(-1)).toBe(0);
    expect(micLevelPercent(7)).toBe(100);
    expect(micLevelPercent(Number.NaN)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Browser family
 * -------------------------------------------------------------------------- */

describe('browserFamilyFor — from the most specific token to the least', () => {
  const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const EDGE = `${CHROME} Edg/128.0.0.0`;
  const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
  const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
  const CHROME_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1';

  const HEADLESS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36';
  const CHROMIUM =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/128.0.0.0 Safari/537.36';
  const EDGE_LEGACY =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041';
  const EDGE_ANDROID =
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.0.0';
  const FIREFOX_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15';
  const EDGE_IOS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/128.0.0.0 Mobile/15E148 Safari/605.1.15';

  it.each([
    [CHROME, 'chrome'],
    [HEADLESS, 'chrome'],
    [CHROMIUM, 'chrome'],
    [EDGE, 'edge'],
    [EDGE_LEGACY, 'edge'],
    [EDGE_ANDROID, 'edge'],
    [FIREFOX, 'firefox'],
    [SAFARI, 'safari'],
    [CHROME_IOS, 'safari'],
    [FIREFOX_IOS, 'safari'],
    [EDGE_IOS, 'safari'],
    ['curl/8.0', 'other'],
    ['', 'other'],
  ] as const)('%s → %s', (userAgent, family) => {
    expect(browserFamilyFor(userAgent)).toBe(family);
  });

  it('has three steps for every family, each a distinct catalogue key', () => {
    for (const family of ['chrome', 'edge', 'firefox', 'safari', 'other'] as const) {
      const keys = permissionHelpKeysFor(family);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3);
      for (const key of keys) {
        expect(VI_TRANSLATE(key).length).toBeGreaterThan(0);
        expect(translatorFor('en')(key)).not.toBe(VI_TRANSLATE(key));
      }
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Face mode
 * -------------------------------------------------------------------------- */

describe('face modes — three in the group, two selectable, one with a camera', () => {
  it('never offers Filter, offers Để nguyên only with a camera, and always offers Ẩn mặt', () => {
    for (const device of ['granted', 'blocked', 'no-camera', 'no-mic', 'unreadable', null] as const) {
      expect(faceModeAvailable(device, 'filter')).toBe(false);
      expect(faceModeAvailable(device, 'hide')).toBe(true);
      expect(faceModeAvailable(device, 'show')).toBe(device === 'granted');
    }
  });

  it('defaults to Để nguyên, which is a decision the spec keeps as Ask First', () => {
    expect(DEFAULT_FACE_MODE).toBe('show');
    expect(FACE_MODES).toEqual(['show', 'hide', 'filter']);
  });

  it('turns a chosen Để nguyên into Ẩn mặt when there is no camera, and NEVER the reverse', () => {
    expect(effectiveFaceModeFor('no-camera', 'show')).toBe('hide');
    expect(effectiveFaceModeFor('blocked', 'show')).toBe('hide');
    expect(effectiveFaceModeFor('granted', 'show')).toBe('show');
    for (const device of ['granted', 'blocked', 'no-camera', 'no-mic', 'unreadable', null] as const) {
      expect(effectiveFaceModeFor(device, 'hide')).toBe('hide');
    }
  });

  it('warns beside a shown face and reassures beside a hidden one', () => {
    expect(presenceNoticeFor('show')).toEqual({ messageKey: 'preJoin.showNotice', tone: 'warn' });
    expect(presenceNoticeFor('hide')).toEqual({ messageKey: 'preJoin.hideNotice', tone: 'ok' });
    expect(VI_TRANSLATE('preJoin.showNotice')).toContain('Khuôn mặt bạn sẽ hiện với mọi người trong phòng');
    expect(VI_TRANSLATE('preJoin.hideNotice')).toContain('Không ai trong phòng thấy khuôn mặt bạn, kể cả host');
  });
});

describe('avatarInitialsFor — at most two letters, marks stripped, upper-cased', () => {
  it.each([
    ['Trâm Anh', 'TA'],
    ['trâm', 'T'],
    ['Nguyễn Phúc Ánh', 'NA'],
    ['đặng', 'D'],
    ['Đặng Văn Đức', 'DD'],
    ['  Lê   Thị  ', 'LT'],
    ['Người dùng thử', 'NT'],
    ['@#$', '?'],
    ['', '?'],
  ])('%s → %s', (name, initials) => {
    expect(avatarInitialsFor(name)).toBe(initials);
    expect(avatarInitialsFor(name).length).toBeLessThanOrEqual(2);
    // No diacritic survives, in either spelling.
    expect(/[À-ỹ̀-ͯ]/.test(avatarInitialsFor(name))).toBe(false);
  });

  it('takes whole code points, so a letter outside the BMP is never cut into a lone surrogate', () => {
    // U+1D49C MATHEMATICAL SCRIPT CAPITAL A and U+1D49E ... CAPITAL C: two UTF-16
    // units each. `charAt(0)` would return half of one.
    const initials = avatarInitialsFor('\u{1D49C}nh \u{1D49E}\u{1D4C1}');
    expect([...initials]).toHaveLength(2);
    expect(initials).toBe('\u{1D49C}\u{1D49E}');
    // Well-formed: every high surrogate is followed by a low one and vice versa.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(initials)).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Joining
 * -------------------------------------------------------------------------- */

describe('joinRequestFor — the choice as it will be honoured', () => {
  it('sends the chosen face with the microphone when everything opened', () => {
    expect(joinRequestFor({ device: 'granted', faceMode: 'show' })).toEqual({
      faceMode: 'show',
      audio: 'mic',
    });
    expect(joinRequestFor({ device: 'granted', faceMode: 'hide' })).toEqual({
      faceMode: 'hide',
      audio: 'mic',
    });
  });

  it('hides the face and keeps the microphone with no camera', () => {
    expect(joinRequestFor({ device: 'no-camera', faceMode: 'show' })).toEqual({
      faceMode: 'hide',
      audio: 'mic',
    });
  });

  it.each(['blocked', 'no-mic', 'unreadable'] as const)(
    '%s is listen-only with a hidden face — the exit, never a wall',
    (device) => {
      expect(joinRequestFor({ device, faceMode: 'show' })).toEqual({
        faceMode: 'hide',
        audio: 'listen-only',
      });
      expect(joinLabelKeyFor(device)).toBe('preJoin.joinListenOnly');
    },
  );

  it('labels the button plainly when the microphone travels', () => {
    expect(joinLabelKeyFor('granted')).toBe('preJoin.join');
    expect(joinLabelKeyFor('no-camera')).toBe('preJoin.join');
  });

  it('builds the decision the shell receives from the request and the wire body — the room id is the WIRE\'s', () => {
    expect(roomDecisionFor({ faceMode: 'hide', audio: 'listen-only' }, token())).toEqual({
      roomId: ROOM_ID,
      faceMode: 'hide',
      audio: 'listen-only',
      token: 'eyJ.abc.def',
      url: 'wss://livekit.example.vn',
      expiresAt: '2026-09-13T09:02:00.000Z',
    });
  });

  it('accepts an admission only for the room the URL names, spelling folded like apps/api folds it', () => {
    expect(admissionMatchesRoom(ROOM_ID, token())).toBe(true);
    expect(admissionMatchesRoom(ROOM_ID.toUpperCase(), token())).toBe(true);
    expect(
      admissionMatchesRoom(ROOM_ID, { ...token(), room_id: '019200f1-0000-7000-8000-000000000002' }),
    ).toBe(false);
  });
});

describe('joinOutcomeFor — every row of the matrix, by status and by reason', () => {
  it('is admitted on a 201 whose body the contract accepts, and on nothing else', () => {
    expect(joinOutcomeFor(201, token())).toEqual({ kind: 'admitted', token: token() });
    // A 201 with an unusable body is not an admission — retry, never claim success.
    expect(joinOutcomeFor(201, { token: '' })).toEqual({
      kind: 'refused',
      messageKey: 'preJoin.joinTryAgain',
      retryable: true,
      offersCreateRoom: false,
    });
    // A 200 is NOT a 201: the route answers 201 and nothing else means "in".
    expect(joinOutcomeFor(200, token()).kind).toBe('refused');
  });

  it('tells 403 from 404, both without a retry and both with a way to create a room', () => {
    expect(joinOutcomeFor(403, makeError('forbidden', ROOM_ADMISSION_FORBIDDEN_MESSAGE))).toEqual({
      kind: 'refused',
      messageKey: 'error.roomForbidden',
      retryable: false,
      offersCreateRoom: true,
    });
    expect(joinOutcomeFor(404, makeError('not_found', ROOM_NOT_FOUND_MESSAGE))).toEqual({
      kind: 'refused',
      messageKey: 'error.roomNotFound',
      retryable: false,
      offersCreateRoom: true,
    });
  });

  it('tells the two 409s apart by details.reason, and NOT by the sentence', () => {
    const full = makeError('conflict', ROOM_FULL_MESSAGE, { reason: 'room_full' });
    const closed = makeError('conflict', ROOM_CLOSED_MESSAGE, { reason: 'room_closed' });
    expect(joinOutcomeFor(409, full)).toMatchObject({ messageKey: 'error.roomFull', retryable: false });
    expect(joinOutcomeFor(409, closed)).toMatchObject({
      messageKey: 'error.roomClosed',
      retryable: false,
    });
    // The reason wins even when the sentence says the other thing: the client
    // reads the field, never the wording.
    const swapped = makeError('conflict', ROOM_FULL_MESSAGE, { reason: 'room_closed' });
    expect(joinOutcomeFor(409, swapped)).toMatchObject({ messageKey: 'error.roomClosed' });
  });

  it('shows the general sentence for a 409 with no recognised reason — the Story 2.2 body', () => {
    expect(joinOutcomeFor(409, makeError('conflict', ROOM_FULL_MESSAGE))).toEqual({
      kind: 'refused',
      messageKey: 'preJoin.joinFailed',
      retryable: false,
      offersCreateRoom: true,
    });
    expect(joinOutcomeFor(409, null)).toMatchObject({ messageKey: 'preJoin.joinFailed' });
    expect(joinOutcomeFor(409, makeError('conflict', 'x', { reason: 'room_on_fire' }))).toMatchObject({
      messageKey: 'preJoin.joinFailed',
    });
  });

  it('keeps the decision and offers a retry on no answer and on a 5xx', () => {
    for (const status of [0, 500, 502, 503]) {
      expect(joinOutcomeFor(status, null)).toEqual({
        kind: 'refused',
        messageKey: 'preJoin.joinTryAgain',
        retryable: true,
        offersCreateRoom: false,
      });
    }
  });

  it('reads a 401 as the session having ended underneath the dialog the seam raised', () => {
    expect(joinOutcomeFor(401, null)).toMatchObject({
      messageKey: 'preJoin.sessionLost',
      retryable: false,
    });
  });

  it('reads a 429 as a wait with a retry, not a wall — an edge may answer one though the route is not limited', () => {
    expect(joinOutcomeFor(429, null)).toEqual({
      kind: 'refused',
      messageKey: 'error.rateLimited',
      retryable: true,
      offersCreateRoom: false,
    });
  });
});

/* -------------------------------------------------------------------------- *
 * Screen state
 * -------------------------------------------------------------------------- */

describe('preJoinStateFor — the state machine', () => {
  it('refuses a malformed room id before anything is asked of anybody', () => {
    expect(roomIdFrom('abc')).toBeNull();
    expect(roomIdFrom(undefined)).toBeNull();
    expect(roomIdFrom(ROOM_ID)).toBe(ROOM_ID);
    expect(preJoinStateFor(null, null, null, null)).toEqual({ kind: 'invalid-room' });
    // Even with everything else present: the id decides first.
    expect(preJoinStateFor(null, { kind: 'profile', user: user() }, 'granted', decision())).toEqual({
      kind: 'invalid-room',
    });
  });

  it('is loading until the profile answers, then follows the profile', () => {
    expect(preJoinStateFor(ROOM_ID, null, null, null)).toEqual({ kind: 'loading' });
    expect(preJoinStateFor(ROOM_ID, { kind: 'signed-out' }, null, null)).toEqual({
      kind: 'signed-out',
      roomId: ROOM_ID,
    });
    expect(
      preJoinStateFor(ROOM_ID, { kind: 'unavailable', retryAfterSeconds: 30 }, null, null),
    ).toEqual({ kind: 'unavailable', retryAfterSeconds: 30 });
    expect(preJoinStateFor(ROOM_ID, { kind: 'profile', user: user() }, null, null)).toEqual({
      kind: 'pre-join',
      user: user(),
      device: null,
    });
    expect(preJoinStateFor(ROOM_ID, { kind: 'profile', user: user() }, 'blocked', null)).toEqual({
      kind: 'pre-join',
      user: user(),
      device: 'blocked',
    });
  });

  it('is admitted from a decision and from NOTHING else', () => {
    expect(preJoinStateFor(ROOM_ID, { kind: 'profile', user: user() }, 'granted', decision())).toEqual(
      { kind: 'admitted', decision: decision() },
    );
    // No decision, whatever else is true: never admitted.
    expect(preJoinStateFor(ROOM_ID, { kind: 'profile', user: user() }, 'granted', null).kind).toBe(
      'pre-join',
    );
  });
});

/* -------------------------------------------------------------------------- *
 * The panel, as HTML
 * -------------------------------------------------------------------------- */

describe('PreJoinPanel — the shell renders from admitted and from nowhere else', () => {
  const SHELL_HEADING = VI_TRANSLATE('room.heading');

  it('renders the shell for admitted, with the decision restated and no token in the markup', () => {
    const html = render({ kind: 'admitted', decision: decision({ audio: 'listen-only' }) });

    expect(html).toContain(SHELL_HEADING);
    expect(html).toContain(VI_TRANSLATE('room.faceHide'));
    expect(html).toContain(VI_TRANSLATE('room.audioListenOnly'));
    expect(html).toContain(VI_TRANSLATE('room.notRecorded'));
    // The token is in memory, never in the page.
    expect(html).not.toContain('eyJ.abc.def');
    expect(html).not.toContain('livekit.example.vn');
    // And no pre-join furniture survives beside it.
    expect(html).not.toContain(`name="${FACE_MODE_FIELD}"`);
    expect(html).not.toContain('<video');
  });

  it.each([
    ['invalid-room', { kind: 'invalid-room' } as const],
    ['loading', { kind: 'loading' } as const],
    ['signed-out', { kind: 'signed-out', roomId: ROOM_ID } as const],
    ['unavailable', { kind: 'unavailable', retryAfterSeconds: null } as const],
    ['pre-join, devices pending', preJoin(null)],
    ['pre-join, granted', preJoin('granted')],
    ['pre-join, blocked', preJoin('blocked')],
    ['pre-join, no camera', preJoin('no-camera')],
    ['pre-join, no mic', preJoin('no-mic')],
    ['pre-join, unreadable', preJoin('unreadable')],
  ])('never renders the shell for %s', (_label, state) => {
    /**
     * The mutation this pins: rendering `<RoomShell>` from any other branch — or
     * unconditionally above the switch — puts the room heading into one of these
     * and goes red here.
     */
    expect(render(state)).not.toContain(SHELL_HEADING);
  });

  it('the shell itself says what was decided and nothing it must not', () => {
    const html = renderToStaticMarkup(<RoomShell decision={decision({ faceMode: 'show' })} />);
    expect(html).toContain(VI_TRANSLATE('room.faceShow'));
    expect(html).toContain(VI_TRANSLATE('room.audioMic'));
    expect(html).not.toContain('eyJ.abc.def');
  });
});

describe('PreJoinPanel — the signed-in screen', () => {
  it('shows a <video>, the group with Để nguyên checked, the warn sentence, the meter and the promise', () => {
    const html = render(preJoin('granted'));

    expect(html).toContain(`id="${PREVIEW_VIDEO_ID}"`);
    expect(html).toContain('<video');
    // The preview has a NAME: a screen reader hears what the box is, and that
    // only its owner sees it.
    expect(html).toMatch(new RegExp(`<video[^>]*aria-label="${VI_TRANSLATE('preJoin.previewVideoLabel')}"`));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain(VI_TRANSLATE('preJoin.modeLegend'));
    // Default: Để nguyên, checked; the notice beside it is the warning.
    expect(radio(html, 'show')).toContain('checked=""');
    expect(radio(html, 'show')).toContain('aria-checked="true"');
    expect(radio(html, 'hide')).toContain('aria-checked="false"');
    expect(radio(html, 'hide')).not.toContain('checked=""');
    expect(html).toContain('notice notice-alert');
    expect(html).toContain(VI_TRANSLATE('preJoin.showNotice'));
    // The meter, with words.
    expect(html).toContain(`id="${MIC_METER_ID}"`);
    expect(html).toContain('role="meter"');
    expect(html).toContain(VI_TRANSLATE('preJoin.micQuiet'));
    expect(html).toContain(VI_TRANSLATE('preJoin.notRecorded'));
    expect(html).toContain(VI_TRANSLATE('preJoin.join'));
    // No avatar while the face is shown.
    expect(html).not.toContain('avatar-letter');
  });

  it('gives every radio role="radio", aria-checked and one shared name, so arrow keys move between them', () => {
    const html = render(preJoin('granted'));
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    for (const radio of radios) {
      expect(radio).toContain('role="radio"');
      expect(radio).toMatch(/aria-checked="(true|false)"/);
      expect(radio).toContain(`name="${FACE_MODE_FIELD}"`);
    }
  });

  it('renders Filter disabled with "Sắp có", so it cannot be chosen', () => {
    const html = render(preJoin('granted'));
    expect(radio(html, 'filter')).toContain('disabled=""');
    expect(radio(html, 'filter')).toContain('aria-checked="false"');
    expect(radio(html, 'show')).not.toContain('disabled=""');
    expect(radio(html, 'hide')).not.toContain('disabled=""');
    expect(html).toContain(VI_TRANSLATE('preJoin.comingSoon'));
  });

  it('on Ẩn mặt drops the <video> from the markup and shows the initials with the ok sentence', () => {
    const html = render(preJoin('granted'), { faceMode: 'hide' });

    expect(html).not.toContain('<video');
    expect(html).toContain('avatar-letter');
    expect(html).toContain('>TA<');
    expect(radio(html, 'hide')).toContain('checked=""');
    expect(radio(html, 'show')).not.toContain('checked=""');
    expect(html).toContain('notice notice-ok');
    expect(html).toContain(VI_TRANSLATE('preJoin.hideNotice'));
    expect(html).not.toContain(VI_TRANSLATE('preJoin.showNotice'));
  });

  it('with no camera disables Để nguyên, checks Ẩn mặt, keeps the meter and the plain join label', () => {
    const html = render(preJoin('no-camera'));

    expect(radio(html, 'show')).toContain('disabled=""');
    expect(radio(html, 'hide')).toContain('checked=""');
    expect(radio(html, 'hide')).not.toContain('disabled=""');
    expect(html).toContain('avatar-letter');
    expect(html).not.toContain('<video');
    expect(html).toContain(VI_TRANSLATE('preJoin.noCamera'));
    expect(html).toContain(`id="${MIC_METER_ID}"`);
    expect(html).toContain(VI_TRANSLATE('preJoin.join'));
  });

  it('with no microphone says so and still offers a way in', () => {
    const html = render(preJoin('no-mic'));
    expect(html).toContain(VI_TRANSLATE('preJoin.noMic'));
    expect(html).toContain(VI_TRANSLATE('preJoin.joinListenOnly'));
    expect(html).not.toContain(`id="${MIC_METER_ID}"`);
    expect(html).not.toContain('<video');
  });

  it.each(['chrome', 'edge', 'firefox', 'safari', 'other'] as const)(
    'when blocked shows the three %s steps, "Thử lại quyền" and "Vào phòng chỉ để nghe"',
    (family) => {
      const html = render(preJoin('blocked'), { browserFamily: family });
      expect(html).toContain(VI_TRANSLATE('preJoin.blockedHeading'));
      for (const key of permissionHelpKeysFor(family)) {
        expect(html).toContain(VI_TRANSLATE(key));
      }
      expect(html).toContain(VI_TRANSLATE('preJoin.retryPermission'));
      expect(html).toContain(VI_TRANSLATE('preJoin.joinListenOnly'));
      expect(html).toContain(VI_TRANSLATE('preJoin.listenOnlyNote'));
      expect(html).not.toContain('<video');
    },
  );

  it('shows the general sentence and the listen-only exit for an unreadable device', () => {
    const html = render(preJoin('unreadable'));
    expect(html).toContain(VI_TRANSLATE('preJoin.unreadable'));
    expect(html).toContain(VI_TRANSLATE('preJoin.joinListenOnly'));
    expect(html).not.toContain(VI_TRANSLATE('preJoin.blockedHeading'));
  });

  it('while devices are being asked for, says so and offers no join yet', () => {
    const html = render(preJoin(null));
    expect(html).toContain(VI_TRANSLATE('preJoin.requestingDevices'));
    expect(html).not.toContain(VI_TRANSLATE('preJoin.join'));
    expect(html).not.toContain('<video');
  });

  it('reads the level into the meter and into the sentence, from one threshold', () => {
    const quiet = render(preJoin('granted'), { micLevel: 0 });
    expect(quiet).toContain('aria-valuenow="0"');
    expect(quiet).toContain(`aria-valuetext="${VI_TRANSLATE('preJoin.micQuiet')}"`);

    const loud = render(preJoin('granted'), { micLevel: 0.5 });
    expect(loud).toContain('aria-valuenow="50"');
    expect(loud).toContain(`aria-valuetext="${VI_TRANSLATE('preJoin.micLoud')}"`);
    expect(loud).toContain('width:50%');
  });

  it('disables the join button AND the whole group while the token is being asked for', () => {
    const html = render(preJoin('granted'), { join: { kind: 'requesting' } });
    expect(html).toMatch(/<button[^>]*class="button-primary"[^>]*disabled=""/);
    expect(html).toContain(VI_TRANSLATE('preJoin.joining'));
    // A change of mind during the round trip would be a change the room never
    // heard: every radio is disabled, and so is the fieldset around them.
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    for (const mode of FACE_MODES) {
      expect(radio(html, mode)).toContain('disabled=""');
    }
  });

  it('keeps the help block on the screen and disables "Thử lại quyền" while the browser is being asked again', () => {
    const html = render(preJoin('blocked'), { retryingDevices: true });
    expect(html).toContain(VI_TRANSLATE('preJoin.blockedHeading'));
    expect(html).toMatch(/<button[^>]*class="button-secondary"[^>]*disabled=""[^>]*>[^<]*Thử lại quyền/);
    expect(html).toContain(VI_TRANSLATE('preJoin.requestingDevices'));
    // Not retrying: the button is live and the waiting sentence is absent.
    const idle = render(preJoin('blocked'));
    expect(idle).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Thử lại quyền/);
    expect(idle).not.toContain(VI_TRANSLATE('preJoin.requestingDevices'));
  });

  it('renders a refusal as an alert, with a retry only when retryable and a link only when offered', () => {
    const retryable = render(preJoin('granted'), {
      join: { kind: 'refused', messageKey: 'preJoin.joinTryAgain', retryable: true, offersCreateRoom: false },
    });
    expect(retryable).toContain(`id="${JOIN_ERROR_ID}"`);
    expect(retryable).toContain('role="alert"');
    expect(retryable).toContain(VI_TRANSLATE('preJoin.joinTryAgain'));
    expect(retryable).toContain(VI_TRANSLATE('preJoin.retryJoin'));
    expect(retryable).not.toContain(`href="${CREATE_ROOM_PATHNAME}"`);
    // The decision and the preview are still there: a retry keeps both.
    expect(retryable).toContain('<video');

    const wall = render(preJoin('granted'), {
      join: { kind: 'refused', messageKey: 'error.roomFull', retryable: false, offersCreateRoom: true },
    });
    expect(wall).toContain(ROOM_FULL_MESSAGE);
    expect(wall).not.toContain(VI_TRANSLATE('preJoin.retryJoin'));
    expect(wall).toContain(`href="${CREATE_ROOM_PATHNAME}"`);
  });
});

describe('PreJoinPanel — the other branches', () => {
  it('for a malformed id shows the not-found sentence and a way to create a room', () => {
    const html = render({ kind: 'invalid-room' });
    expect(html).toContain(ROOM_NOT_FOUND_MESSAGE);
    expect(html).toContain(`href="${CREATE_ROOM_PATHNAME}"`);
    expect(html).not.toContain('<video');
  });

  it('for a signed-out visitor offers the provider links carrying THIS room as the return path', () => {
    const html = render({ kind: 'signed-out', roomId: ROOM_ID });
    expect(html).toContain(VI_TRANSLATE('preJoin.signedOut'));
    expect(html).toContain(`quay-ve=${encodeURIComponent(`/phong/${ROOM_ID}`)}`);
    expect(html).toContain('/v1/auth/google/start');
    expect(html).not.toContain('<video');
  });

  it('for an unavailable profile offers a retry, disabled while a wait runs', () => {
    expect(render({ kind: 'unavailable', retryAfterSeconds: null })).toMatch(
      /<button[^>]*class="button-secondary"(?![^>]*disabled)/,
    );
    expect(render({ kind: 'unavailable', retryAfterSeconds: 30 })).toMatch(
      /<button[^>]*class="button-secondary"[^>]*disabled=""/,
    );
  });
});

describe('both locales', () => {
  it.each(LOCALES)('renders the whole signed-in screen in %s with no key leaking through', (locale) => {
    const t = translatorFor(locale);
    for (const device of ['granted', 'blocked', 'no-camera', 'no-mic', 'unreadable'] as const) {
      const html = render(preJoin(device), { locale, browserFamily: 'firefox' });
      expect(html).toContain(t('preJoin.heading'));
      expect(html).toContain(t('preJoin.notRecorded'));
      expect(html).not.toMatch(/preJoin\.[a-zA-Z.0-9]+/);
    }
    const shell = render({ kind: 'admitted', decision: decision() }, { locale });
    expect(shell).toContain(t('room.heading'));
    expect(shell).not.toMatch(/room\.[a-zA-Z]+/);
  });

  it('says different things in the two languages, on the sentence that matters most', () => {
    const vi = render(preJoin('granted'), { locale: 'vi' });
    const en = render(preJoin('granted'), { locale: 'en' });
    expect(vi).toContain(VI_TRANSLATE('preJoin.showNotice'));
    expect(en).toContain(translatorFor('en')('preJoin.showNotice'));
    expect(en).not.toContain(VI_TRANSLATE('preJoin.showNotice'));
  });
});
