import {
  CREATE_ROOM_PATHNAME,
  isRoomId,
  roomPathname,
  roomTokenRefusalReason,
  roomTokenResponseSchema,
  type CurrentUser,
  type RoomTokenResponse,
} from '@stuwith/contracts';
import type { RefObject } from 'react';
import { SignInCountdown } from '../../dang-nhap/countdown';
import { type MessageKey } from '../../i18n/messages';
import { useT } from '../../i18n/use-t';
import { PROFILE_RETRY_KEY, unavailableMessageKey, type ProfileLoadOutcome } from '../../profile-load';
import { RATE_LIMITED_STATUS, SESSION_EXPIRED_STATUS, returnPathFor } from '../../session-expiry';
import { SignInProviderLinks } from '../../sign-in-links';
import {
  FACE_MODES,
  RoomShell,
  type AudioIntent,
  type FaceMode,
  type RoomDecision,
} from './room-shell';

/**
 * Everything the pre-join screen DECIDES, kept out of `page.tsx`.
 *
 * The reason is the one every screen in this app records (`AGENTS.md` §6): the
 * `web` Vitest project has no DOM, so a component with state, an effect, a
 * `window` read or — new here — a `MediaStream` cannot be executed by anything in
 * the repository. `page.tsx` keeps `useState`, the effects, the `getUserMedia`
 * calls and the `AnalyserNode`; everything below is a pure function or an
 * effect-free component `renderToStaticMarkup` runs under plain Node, and the
 * pattern is `tao-phong/create-room-form.tsx`.
 *
 * ## The one property that is a property of the STATE MACHINE
 *
 * `RoomShell` renders from exactly one branch of {@link PreJoinPanel} — the
 * `admitted` state — and {@link preJoinStateFor} produces `admitted` from exactly
 * one input: a `RoomDecision`, which the page only ever builds from a `201` after
 * "Vào phòng" was pressed ({@link joinOutcomeFor}, {@link roomDecisionFor}). There
 * is no second route, no query parameter and no reload that lands past the
 * decision, because nothing else constructs the value the shell needs. A guard on a
 * separate pre-join URL would be an `if` a later story could forget; this cannot be
 * forgotten because it is not a check.
 *
 * ## What this file does NOT do
 *
 * It never touches a track. Stopping the camera when "Ẩn mặt" is chosen, and
 * asking for it again ONLY when the person presses "Để nguyên", are the page's
 * handlers — and they are handlers rather than effects so that no system event
 * (a re-render, a network recovery, a device change) can ever turn the camera back
 * on. That rule is Epic 2's "hệ thống không bao giờ tự đảo ngược quyết định ẩn
 * mặt", and it is kept by construction rather than by a flag.
 */

/* -------------------------------------------------------------------------- *
 * Devices
 * -------------------------------------------------------------------------- */

/**
 * What the two `getUserMedia` requests told us, as one word.
 *
 * - `granted` — camera and microphone both open;
 * - `blocked` — the browser refused (`NotAllowedError`), so the help block and
 *   the two exits are shown;
 * - `no-camera` — no camera, microphone open: "Ẩn mặt" is the only face mode;
 * - `no-mic` — no microphone at all: the person can still enter and use chat;
 * - `unreadable` — a device exists and could not be opened (`NotReadableError`,
 *   `AbortError`, …): the general sentence, and the listen-only exit.
 */
export type DeviceState = 'granted' | 'blocked' | 'no-camera' | 'no-mic' | 'unreadable';

/**
 * Which request is being judged: both devices at once, the audio-only retry on the
 * way in, or the video-only request "Để nguyên" makes after "Ẩn mặt" stopped the
 * camera. The third is the only time video is asked for alone, and it is a press.
 */
export type MediaStage = 'both' | 'audio-only' | 'video-only';

/** The constraints each stage sends. */
export function mediaConstraintsFor(stage: MediaStage): MediaStreamConstraints {
  switch (stage) {
    case 'both':
      return { video: true, audio: true };
    case 'audio-only':
      return { audio: true };
    case 'video-only':
      return { video: true };
    default:
      return exhausted(stage);
  }
}

/**
 * The error names the two families of refusal go by.
 *
 * `NotAllowedError` is the standard name; `PermissionDeniedError` is what an
 * older Chromium spelled it; `SecurityError` is "this page is not allowed to ask"
 * (an insecure context, a `Permissions-Policy`), which for the person is the same
 * wall with the same way round it. `NotFoundError` and its old spelling say "no
 * such device"; `OverconstrainedError` with `video: true` can only mean the same.
 */
const BLOCKED_ERRORS: ReadonlySet<string> = new Set([
  'NotAllowedError',
  'PermissionDeniedError',
  'SecurityError',
]);
const MISSING_DEVICE_ERRORS: ReadonlySet<string> = new Set([
  'NotFoundError',
  'DevicesNotFoundError',
  'OverconstrainedError',
]);

/**
 * The state one `getUserMedia` answer puts the screen in, given which request it
 * answered. `null` is success.
 *
 * `no-camera` is answered TWICE and means two things, and that is deliberate: on
 * `both` it is provisional ("the camera is missing; ask for audio alone and see"),
 * on `audio-only` it is final ("audio opened, so the camera really is the only
 * thing missing"). {@link retriesAudioOnly} is the one place the two are told
 * apart, so the page never inspects an error name itself.
 *
 * `video-only` is judged with the microphone ALREADY open, so its answers are
 * narrower: success is `granted` again; a refusal is `blocked` (a permission
 * revoked between two presses shows the help block, not "no camera"); anything
 * else — missing, busy, unplugged — is `no-camera`, because the microphone that is
 * open must not be reported as unreadable.
 */
export function deviceStateFor(errorName: string | null, stage: MediaStage): DeviceState {
  if (errorName === null) {
    return stage === 'audio-only' ? 'no-camera' : 'granted';
  }
  if (BLOCKED_ERRORS.has(errorName)) {
    return 'blocked';
  }
  if (stage === 'video-only') {
    return 'no-camera';
  }
  if (MISSING_DEVICE_ERRORS.has(errorName)) {
    return stage === 'both' ? 'no-camera' : 'no-mic';
  }
  return 'unreadable';
}

/** Whether a `both` answer of `no-camera` should be followed by an audio-only request. */
export function retriesAudioOnly(state: DeviceState, stage: MediaStage): boolean {
  return state === 'no-camera' && stage === 'both';
}

/**
 * The RMS of one buffer of 8-bit time-domain samples, as a level from 0 to 1.
 *
 * `getByteTimeDomainData` centres silence on 128, so the deviation is measured
 * from there. Pure over the buffer so the number a frame produces can be pinned:
 * silence is `0`, a full-scale square wave is `1`, and a wrong centre — 0, or 127
 * — would put silence at a level the screen reads as "Nghe rõ".
 */
export function micLevelFromSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centred = ((samples[i] ?? 128) - 128) / 128;
    sum += centred * centred;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/**
 * Where "Chưa nghe thấy" turns into "Nghe rõ".
 *
 * A level, not a colour: the meter's fill is the second channel, the sentence is
 * the first (WCAG 1.4.1), and the same threshold feeds both so they cannot
 * disagree. The number is the RMS of a quiet room on a laptop microphone with a
 * small margin above it.
 */
export const MIC_AUDIBLE_LEVEL = 0.04;

export function micLevelLabelKeyFor(level: number): MessageKey {
  return level >= MIC_AUDIBLE_LEVEL ? 'preJoin.micLoud' : 'preJoin.micQuiet';
}

/** The level as `aria-valuenow` and as a width: an integer percentage, clamped. */
export function micLevelPercent(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.round(Math.min(1, Math.max(0, level)) * 100);
}

/* -------------------------------------------------------------------------- *
 * Browser family, for the permission help
 * -------------------------------------------------------------------------- */

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';

/**
 * Which browser's menu the three steps should describe.
 *
 * Order is the whole function: Edge's UA contains `Chrome/` and `Safari/`, Chrome's
 * contains `Safari/`, so the tests run from the most specific token to the least.
 * `CriOS`/`FxiOS`/`EdgiOS` are the iOS shells, which are all WebKit underneath —
 * the permission lives in iOS Settings, so they get the Safari steps.
 */
export function browserFamilyFor(userAgent: string): BrowserFamily {
  if (/\b(?:CriOS|FxiOS|EdgiOS)\//.test(userAgent)) {
    return 'safari';
  }
  if (/\bEdg(?:e|A)?\//.test(userAgent)) {
    return 'edge';
  }
  if (/\bFirefox\//.test(userAgent)) {
    return 'firefox';
  }
  // No word boundary before `Chrome`: a headless Chromium spells itself
  // `HeadlessChrome/`, and it is the same menu.
  if (/Chrom(?:e|ium)\//.test(userAgent)) {
    return 'chrome';
  }
  if (/\bSafari\//.test(userAgent) && /\bVersion\//.test(userAgent)) {
    return 'safari';
  }
  return 'other';
}

/** The three steps, in order, as keys. Typed so a missing step is a `tsc` error. */
export function permissionHelpKeysFor(family: BrowserFamily): readonly MessageKey[] {
  return [`preJoin.help.${family}.1`, `preJoin.help.${family}.2`, `preJoin.help.${family}.3`];
}

/* -------------------------------------------------------------------------- *
 * Face mode
 * -------------------------------------------------------------------------- */

/**
 * Which modes the group may offer, given the devices.
 *
 * `filter` is never available: it is rendered so the group has Story 2.7's shape,
 * and refused here so nothing can select it. `show` needs a camera. `hide` is
 * always available — it is the floor every other mode falls back to, and the one
 * that must not depend on anything that can be missing.
 */
export function faceModeAvailable(device: DeviceState | null, mode: FaceMode): boolean {
  switch (mode) {
    case 'filter':
      return false;
    case 'show':
      return device === 'granted';
    case 'hide':
      return true;
    default:
      return exhausted(mode);
  }
}

/**
 * The mode that is actually in force, given what was chosen and what exists.
 *
 * A person who chose "Để nguyên" and then lost the camera to a refusal is hiding
 * their face whether they like it or not; the group shows that rather than a
 * checked option that means nothing. The other direction never happens here: a
 * chosen `hide` is never turned into `show` by any input.
 */
export function effectiveFaceModeFor(device: DeviceState | null, chosen: FaceMode): FaceMode {
  return faceModeAvailable(device, chosen) ? chosen : 'hide';
}

/** The sentence beside the group, and whether it is a warning or a reassurance. */
export interface PresenceNotice {
  readonly messageKey: MessageKey;
  readonly tone: 'warn' | 'ok';
}

/**
 * Warn for a visible face, reassure for a hidden one — and the warn tone is the
 * point, not decoration: it sits beside the DEFAULT, which is where the decision
 * `EXPERIENCE.md` Flow 1 is built around actually happens.
 */
export function presenceNoticeFor(faceMode: FaceMode): PresenceNotice {
  return faceMode === 'hide'
    ? { messageKey: 'preJoin.hideNotice', tone: 'ok' }
    : { messageKey: 'preJoin.showNotice', tone: 'warn' };
}

/**
 * The letters on the avatar: first letter of the first and last word, tone marks
 * stripped, upper-cased, at most two.
 *
 * Diacritics come off by decomposition (`NFD` puts each mark in its own code point,
 * which the combining-mark range U+0300 to U+036F then removes); d with a stroke (U+0111) is the one letter that is not
 * a base plus a mark, so it is mapped by hand. "Trâm Anh" is `TA`, "đặng" is `D`,
 * and a name with nothing usable in it is `?` rather than an empty tile.
 */
export function avatarInitialsFor(displayName: string): string {
  const words = displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return '?';
  }
  // The first CODE POINT, not the first UTF-16 unit: a letter outside the BMP
  // would otherwise render half a surrogate pair as a broken glyph.
  const firstLetterOf = (word: string | undefined): string => [...(word ?? '')][0] ?? '';
  const first = firstLetterOf(words[0]);
  const last = words.length > 1 ? firstLetterOf(words[words.length - 1]) : '';
  return `${first}${last}`.toUpperCase();
}

/* -------------------------------------------------------------------------- *
 * Joining
 * -------------------------------------------------------------------------- */

/** What "Vào phòng" sends the room — the choice, resolved against the devices. */
export interface JoinRequest {
  readonly faceMode: FaceMode;
  readonly audio: AudioIntent;
}

/**
 * The choice as it will actually be honoured.
 *
 * A face is only shown when a camera opened and `show` was chosen; a microphone
 * only travels when one opened. Every refused or missing device becomes
 * `listen-only`, which is the exit the epic promises: nobody is ever stuck on
 * pre-join because of a device.
 */
export function joinRequestFor(state: {
  readonly device: DeviceState;
  readonly faceMode: FaceMode;
}): JoinRequest {
  const faceMode = effectiveFaceModeFor(state.device, state.faceMode);
  switch (state.device) {
    case 'granted':
    case 'no-camera':
      return { faceMode, audio: 'mic' };
    case 'blocked':
    case 'no-mic':
    case 'unreadable':
      return { faceMode, audio: 'listen-only' };
    default:
      return exhausted(state.device);
  }
}

/** The label on the join button: the plain one, or the listen-only exit. */
export function joinLabelKeyFor(device: DeviceState): MessageKey {
  return joinRequestFor({ device, faceMode: 'hide' }).audio === 'mic'
    ? 'preJoin.join'
    : 'preJoin.joinListenOnly';
}

export type JoinOutcome =
  /** `201`, with a body the contract accepts. The only way into the room. */
  | { readonly kind: 'admitted'; readonly token: RoomTokenResponse }
  | {
      readonly kind: 'refused';
      readonly messageKey: MessageKey;
      /** A "Thử lại" button keeps the decision and the tracks; `false` is a wall with a way out. */
      readonly retryable: boolean;
      /** For 403 and 404: the person cannot enter THIS room, so offer a way to make one. */
      readonly offersCreateRoom: boolean;
    };

const refused = (
  messageKey: MessageKey,
  retryable: boolean,
  offersCreateRoom = false,
): JoinOutcome => ({ kind: 'refused', messageKey, retryable, offersCreateRoom });

/**
 * What the token endpoint's answer means to this screen.
 *
 * The `409` branch is why `roomTokenRefusalReason` exists: two refusals share one
 * code, and the sentence is display text this client never compares. A `409`
 * whose body carries no recognised reason gets the general sentence rather than a
 * guess. The `default` is the cautious one — an unrecognised status is "we do not
 * know that it worked", with a retry, never "it worked".
 */
export function joinOutcomeFor(status: number, body: unknown): JoinOutcome {
  switch (status) {
    case 201: {
      const parsed = roomTokenResponseSchema.safeParse(body);
      // A 201 whose body will not parse is not an admission this screen can act
      // on. Same direction as `createRoomOutcomeFor`: never claim success.
      return parsed.success
        ? { kind: 'admitted', token: parsed.data }
        : refused('preJoin.joinTryAgain', true);
    }
    case SESSION_EXPIRED_STATUS:
      // The seam has already tried a renewal and raised the dialog; this is what
      // is left on the screen underneath it.
      return refused('preJoin.sessionLost', false);
    case 403:
      return refused('error.roomForbidden', false, true);
    case 404:
      return refused('error.roomNotFound', false, true);
    case 409: {
      const reason = roomTokenRefusalReason(body);
      if (reason === 'room_full') {
        return refused('error.roomFull', false, true);
      }
      if (reason === 'room_closed') {
        return refused('error.roomClosed', false, true);
      }
      return refused('preJoin.joinFailed', false, true);
    }
    case RATE_LIMITED_STATUS:
      // No `@RateLimited` on this route today; an edge in front of the API may
      // still answer one, and it is a wait rather than a wall.
      return refused('error.rateLimited', true);
    default:
      return refused('preJoin.joinTryAgain', true);
  }
}

/**
 * Whether the admission that came back is for the room the URL names.
 *
 * `apps/api` folds the path parameter to lower case before it becomes a LiveKit
 * room name, so the comparison does the same; a body naming another room is not
 * an admission this screen may act on.
 */
export function admissionMatchesRoom(roomId: string, token: RoomTokenResponse): boolean {
  return token.room_id.toLowerCase() === roomId.toLowerCase();
}

/**
 * The decision the shell receives, built from the request as it stands at the
 * moment of the `201` and from the body that came back.
 *
 * `roomId` is the WIRE's `room_id`, not the URL's: the token names the room it
 * opens, and that is the spelling Story 2.4 hands to LiveKit.
 */
export function roomDecisionFor(request: JoinRequest, token: RoomTokenResponse): RoomDecision {
  return {
    roomId: token.room_id,
    faceMode: request.faceMode,
    audio: request.audio,
    token: token.token,
    url: token.url,
    expiresAt: token.expires_at,
  };
}

/** Where the join is, between presses. `admitted` is NOT here: it is a screen state. */
export type JoinPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requesting' }
  | {
      readonly kind: 'refused';
      readonly messageKey: MessageKey;
      readonly retryable: boolean;
      readonly offersCreateRoom: boolean;
    };

/* -------------------------------------------------------------------------- *
 * Screen state
 * -------------------------------------------------------------------------- */

/**
 * The `[roomId]` segment, judged by the contract's own predicate.
 *
 * `null` for anything that is not a room id — and the page calls NO endpoint for
 * a `null`: the not-found sentence is shown without a round trip, which is the
 * matrix row "roomId sai định dạng → không gọi API".
 */
export function roomIdFrom(param: unknown): string | null {
  return isRoomId(param) ? param : null;
}

export type PreJoinScreenState =
  /** The URL does not name a room. Nothing is asked of anybody. */
  | { readonly kind: 'invalid-room' }
  /** `/v1/auth/me` has not answered yet. */
  | { readonly kind: 'loading' }
  /** No session: sign in, and come back to this room. */
  | { readonly kind: 'signed-out'; readonly roomId: string }
  /** The profile could not be read, and not because nobody is signed in. */
  | { readonly kind: 'unavailable'; readonly retryAfterSeconds: number | null }
  /** Signed in. `device` is `null` while the browser is still being asked. */
  | { readonly kind: 'pre-join'; readonly user: CurrentUser; readonly device: DeviceState | null }
  /** A `201` came back after "Vào phòng". The only state the shell renders from. */
  | { readonly kind: 'admitted'; readonly decision: RoomDecision };

/**
 * The screen's state from its four inputs, in the order that decides.
 *
 * `admitted` wins over everything once a decision exists — but a decision can
 * only exist if a profile and a device state existed first, because the join
 * button is only rendered on the `pre-join` branch. The page never sets it from
 * anywhere else, and {@link PreJoinPanel} renders {@link RoomShell} from this
 * branch alone; `pre-join.test.tsx` holds both halves.
 */
export function preJoinStateFor(
  roomId: string | null,
  profile: ProfileLoadOutcome | null,
  device: DeviceState | null,
  admitted: RoomDecision | null,
): PreJoinScreenState {
  if (roomId === null) {
    return { kind: 'invalid-room' };
  }
  if (admitted !== null) {
    return { kind: 'admitted', decision: admitted };
  }
  if (profile === null) {
    return { kind: 'loading' };
  }
  switch (profile.kind) {
    case 'profile':
      return { kind: 'pre-join', user: profile.user, device };
    case 'signed-out':
      return { kind: 'signed-out', roomId };
    case 'unavailable':
      return { kind: 'unavailable', retryAfterSeconds: profile.retryAfterSeconds };
    default:
      return exhausted(profile);
  }
}

/* -------------------------------------------------------------------------- *
 * The panel
 * -------------------------------------------------------------------------- */

/** The `name` the three radios share, so arrow keys move between them. */
export const FACE_MODE_FIELD = 'che-do-khuon-mat';
export const FACE_MODE_LEGEND_ID = 'che-do-khuon-mat-nhan';
export const PRESENCE_NOTICE_ID = 'che-do-khuon-mat-ghi-chu';
export const PREVIEW_VIDEO_ID = 'xem-truoc';
export const MIC_METER_ID = 'muc-mic';
export const JOIN_ERROR_ID = 'vao-phong-loi';
export const PRE_JOIN_HEADING_KEY: MessageKey = 'preJoin.heading';

const FACE_MODE_KEYS: Readonly<Record<FaceMode, MessageKey>> = {
  show: 'preJoin.modeShow',
  hide: 'preJoin.modeHide',
  filter: 'preJoin.modeFilter',
};

/**
 * The whole screen, as ONE effect-free component.
 *
 * One component rather than a pre-join panel plus a separately mounted shell, for
 * the reason `CreateRoomPanel` gives: "the person is in the room" and "here is the
 * screen to decide with" are one decision, and rendering both is the exact bug
 * this shape makes unexpressible.
 *
 * Everything that needs a browser arrives as a prop: the `<video>` ref the page
 * attaches a stream to, the microphone level the analyser produced, the browser
 * family read off `navigator.userAgent`, and the handlers. Nothing here reads
 * `window`.
 */
export function PreJoinPanel({
  state,
  faceMode,
  micLevel,
  videoRef,
  join,
  retryingDevices = false,
  browserFamily,
  apiBaseUrl,
  onFaceModeChange,
  onRetryDevices,
  onJoin,
  onRetryProfile,
  onWaitFinished,
}: {
  readonly state: PreJoinScreenState;
  /** The CHOSEN mode. What is in force is `effectiveFaceModeFor(device, faceMode)`. */
  readonly faceMode: FaceMode;
  /** 0 to 1, from the analyser; `0` while there is no audio track. */
  readonly micLevel: number;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly join: JoinPhase;
  /**
   * "Thử lại quyền" has been pressed and the browser has not answered yet. The
   * help block STAYS while it is true — the previous answer is still the truth
   * until a new one arrives — and the button is disabled so a second press cannot
   * open a second prompt.
   */
  readonly retryingDevices?: boolean;
  readonly browserFamily: BrowserFamily;
  /** For the sign-in links on the signed-out branch. From the provider, never `process.env`. */
  readonly apiBaseUrl: string;
  /**
   * REQUIRED, every one of them: a branch that renders a button with no handler
   * is the dead end these parameters exist to remove.
   */
  readonly onFaceModeChange: (mode: FaceMode) => void;
  /** "Thử lại quyền": ask `getUserMedia` again. The ONLY thing that re-asks after a refusal. */
  readonly onRetryDevices: () => void;
  readonly onJoin: () => void;
  readonly onRetryProfile: () => void;
  readonly onWaitFinished: () => void;
}) {
  const t = useT();

  switch (state.kind) {
    case 'invalid-room':
      return (
        <>
          <h1>{t(PRE_JOIN_HEADING_KEY)}</h1>
          <p className="notice" role="status">
            {t('error.roomNotFound')}
          </p>
          <a className="button-secondary" href={CREATE_ROOM_PATHNAME}>
            {t('preJoin.toCreateRoom')}
          </a>
        </>
      );

    case 'loading':
      return (
        <>
          <h1>{t(PRE_JOIN_HEADING_KEY)}</h1>
          <p className="meta" role="status">
            {t('preJoin.checkingSession')}
          </p>
        </>
      );

    case 'unavailable':
      return (
        <>
          <h1>{t(PRE_JOIN_HEADING_KEY)}</h1>
          <p className="notice" role="status">
            {t(unavailableMessageKey(state.retryAfterSeconds))}
          </p>
          {state.retryAfterSeconds === null ? null : (
            <SignInCountdown seconds={state.retryAfterSeconds} onFinished={onWaitFinished} />
          )}
          <button
            type="button"
            className="button-secondary"
            disabled={state.retryAfterSeconds !== null}
            onClick={onRetryProfile}
          >
            {t(PROFILE_RETRY_KEY)}
          </button>
        </>
      );

    case 'signed-out':
      return (
        <>
          <h1>{t(PRE_JOIN_HEADING_KEY)}</h1>
          <p className="notice" role="status">
            {t('preJoin.signedOut')}
          </p>
          {/*
            The provider links THEMSELVES, carrying this room as the return path,
            rather than a link to the login page: the return path only survives on
            the `/start` leg, where `apps/api` signs it into the OAuth state. A
            `/dang-nhap?quay-ve=` link would be a parameter nothing reads.
            `returnPathFor` is the same judge the seam uses, so an unusable path is
            never put in a URL.
          */}
          <nav className="card">
            <p>{t('preJoin.signInHint')}</p>
            <SignInProviderLinks
              apiBaseUrl={apiBaseUrl}
              returnPath={returnPathFor({ pathname: roomPathname(state.roomId), search: '' })}
            />
          </nav>
        </>
      );

    case 'admitted':
      /**
       * The ONLY line that renders the shell. `preJoinStateFor` is the only
       * producer of this branch, and a `RoomDecision` is the only thing it accepts.
       */
      return <RoomShell decision={state.decision} />;

    case 'pre-join':
      return (
        <PreJoinBody
          user={state.user}
          device={state.device}
          faceMode={faceMode}
          micLevel={micLevel}
          videoRef={videoRef}
          join={join}
          retryingDevices={retryingDevices}
          browserFamily={browserFamily}
          onFaceModeChange={onFaceModeChange}
          onRetryDevices={onRetryDevices}
          onJoin={onJoin}
        />
      );

    default:
      return exhausted(state);
  }
}

/**
 * The signed-in screen: preview, group, microphone, and the way in.
 *
 * Split from the switch above only for length; it is just as effect-free.
 */
function PreJoinBody({
  user,
  device,
  faceMode,
  micLevel,
  videoRef,
  join,
  retryingDevices,
  browserFamily,
  onFaceModeChange,
  onRetryDevices,
  onJoin,
}: {
  readonly user: CurrentUser;
  readonly device: DeviceState | null;
  readonly faceMode: FaceMode;
  readonly micLevel: number;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly join: JoinPhase;
  readonly retryingDevices: boolean;
  readonly browserFamily: BrowserFamily;
  readonly onFaceModeChange: (mode: FaceMode) => void;
  readonly onRetryDevices: () => void;
  readonly onJoin: () => void;
}) {
  const t = useT();
  const effective = effectiveFaceModeFor(device, faceMode);
  const notice = presenceNoticeFor(effective);
  const joining = join.kind === 'requesting';

  return (
    <>
      <h1>{t(PRE_JOIN_HEADING_KEY)}</h1>
      <p className="meta">{t('preJoin.subheading')}</p>

      {device === null ? (
        <p className="meta" role="status">
          {t('preJoin.requestingDevices')}
        </p>
      ) : null}

      {device === 'blocked' ? (
        /*
          The help block, in the browser's own words, and NEVER a dead end: both
          exits are here. "Thử lại quyền" is the one thing that asks the browser
          again; "Vào phòng chỉ để nghe" asks for a token with `listen-only`.
        */
        <section className="permission-help" aria-labelledby="quyen-bi-chan">
          <h2 id="quyen-bi-chan">{t('preJoin.blockedHeading')}</h2>
          <p>{t('preJoin.blockedIntro')}</p>
          <ol>
            {permissionHelpKeysFor(browserFamily).map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
          <div className="pre-join-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={retryingDevices}
              onClick={onRetryDevices}
            >
              {t('preJoin.retryPermission')}
            </button>
          </div>
          {retryingDevices ? (
            <p className="meta" role="status">
              {t('preJoin.requestingDevices')}
            </p>
          ) : null}
        </section>
      ) : null}

      {device === 'unreadable' ? (
        <p className="notice notice-alert" role="alert">
          {t('preJoin.unreadable')}
        </p>
      ) : null}

      {device === 'no-mic' ? (
        <p className="notice" role="status">
          {t('preJoin.noMic')}
        </p>
      ) : null}

      {device === 'granted' || device === 'no-camera' ? (
        <>
          {/*
            The preview. A `<video>` ONLY while a face is shown; on "Ẩn mặt" the
            element is gone from the DOM, not hidden, so there is nothing a stray
            style could reveal — and the page has already stopped the track.
          */}
          <div className="preview">
            <span className="preview-label">
              {t(effective === 'hide' ? 'preJoin.previewLabelHide' : 'preJoin.previewLabelShow')}
            </span>
            {effective === 'hide' ? (
              <div className="avatar-letter" role="img" aria-label={t('preJoin.avatarLabel')}>
                {avatarInitialsFor(user.display_name)}
              </div>
            ) : (
              <video
                id={PREVIEW_VIDEO_ID}
                className="preview-video"
                ref={videoRef}
                aria-label={t('preJoin.previewVideoLabel')}
                autoPlay
                muted
                playsInline
              />
            )}
          </div>
          <p className="meta">
            {t(effective === 'hide' ? 'preJoin.previewNoteHide' : 'preJoin.previewNoteShow')}
          </p>

          {device === 'no-camera' ? (
            <p className="notice" role="status">
              {t('preJoin.noCamera')}
            </p>
          ) : null}

          {/*
            One radio group with a group label, not three buttons: the legend is
            what a screen reader announces with every option, and native radios are
            what make the arrow keys work without a line of script. `role` and
            `aria-checked` are written out as well as implied, because the spec
            names them and a reader of the markup should see the claim.

            The whole group is disabled while the token is being asked for: the
            decision the shell receives is read at the moment of the 201, and a
            change of mind during the round trip would otherwise be a change the
            person made and the room never heard.
          */}
          <fieldset
            className="field-group"
            role="radiogroup"
            aria-labelledby={FACE_MODE_LEGEND_ID}
            aria-describedby={PRESENCE_NOTICE_ID}
            disabled={joining}
          >
            <legend className="form-label" id={FACE_MODE_LEGEND_ID}>
              {t('preJoin.modeLegend')}
            </legend>
            <div className="choice-list">
              {FACE_MODES.map((mode) => {
                const available = faceModeAvailable(device, mode);
                const checked = effective === mode;
                return (
                  <label className="choice" key={mode}>
                    <input
                      type="radio"
                      role="radio"
                      name={FACE_MODE_FIELD}
                      value={mode}
                      checked={checked}
                      aria-checked={checked}
                      disabled={!available || joining}
                      onChange={() => onFaceModeChange(mode)}
                    />
                    <span>{t(FACE_MODE_KEYS[mode])}</span>
                    {mode === 'filter' ? (
                      <span className="meta">{t('preJoin.comingSoon')}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/*
            `status` in both tones: nothing has gone wrong. The tone is a class AND
            a different sentence, so colour is never the only channel.
          */}
          <p
            className={notice.tone === 'warn' ? 'notice notice-alert' : 'notice notice-ok'}
            id={PRESENCE_NOTICE_ID}
            role="status"
          >
            {t(notice.messageKey)}
          </p>

          <section className="card" aria-labelledby="thu-mic">
            <h2 id="thu-mic">{t('preJoin.micHeading')}</h2>
            <MicLevelMeter level={micLevel} />
          </section>
        </>
      ) : null}

      {device === 'blocked' || device === 'unreadable' ? (
        <p className="meta">{t('preJoin.listenOnlyNote')}</p>
      ) : null}

      <p className="meta">{t('preJoin.notRecorded')}</p>

      {device === null ? null : (
        <div className="pre-join-actions">
          <button
            type="button"
            className="button-primary"
            disabled={joining}
            onClick={onJoin}
          >
            {t(joinLabelKeyFor(device))}
          </button>
        </div>
      )}

      {joining ? (
        <p className="meta" role="status">
          {t('preJoin.joining')}
        </p>
      ) : null}

      {join.kind === 'refused' ? (
        <>
          <p className="notice notice-alert" id={JOIN_ERROR_ID} role="alert">
            {t(join.messageKey)}
          </p>
          <div className="pre-join-actions">
            {join.retryable ? (
              <button type="button" className="button-secondary" onClick={onJoin}>
                {t('preJoin.retryJoin')}
              </button>
            ) : null}
            {join.offersCreateRoom ? (
              <a className="button-secondary" href={CREATE_ROOM_PATHNAME}>
                {t('preJoin.toCreateRoom')}
              </a>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * The microphone level, as a `meter` WITH words.
 *
 * `role="meter"` with `aria-valuetext` carrying the same sentence the eye reads
 * beside it, so a screen reader hears "Nghe rõ" rather than "43". The fill is the
 * second channel and is never the only one.
 */
export function MicLevelMeter({ level }: { readonly level: number }) {
  const t = useT();
  const percent = micLevelPercent(level);
  const label = t(micLevelLabelKeyFor(level));

  return (
    <div className="mic-level">
      <div
        className="mic-level-track"
        id={MIC_METER_ID}
        role="meter"
        aria-label={t('preJoin.micMeterLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
      >
        <span className="mic-level-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="meta">{label}</span>
    </div>
  );
}

/**
 * The compiler's way of insisting that a new case gets a branch, used by every
 * switch in this file.
 */
function exhausted(value: never): never {
  throw new Error(`unhandled pre-join case: ${JSON.stringify(value)}`);
}
