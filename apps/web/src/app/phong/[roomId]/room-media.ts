import { PIPELINE_FPS } from './frame-pipeline';
import type { MessageKey } from '../../i18n/messages';

/**
 * Every decision the room's media plane makes, as pure functions.
 *
 * ## Why this file has no React and no `livekit-client` value import
 *
 * The `web` Vitest project runs with `environment: 'node'` and no DOM
 * (`AGENTS.md` §6), so a module that touches `window` at import time cannot be
 * executed by a test at all. `livekit-client` is a browser SDK: importing it for
 * its enums would put the whole thing in this module's graph and take every
 * function below out of reach. So the SDK appears here only as a TYPE, and the
 * two enums whose values matter — `ConnectionState` and `DisconnectReason` — are
 * re-declared as the raw wire values they carry and mapped by
 * {@link roomConnectionStateFor} and {@link disconnectReasonKeyFor}. The shell is
 * where the SDK is loaded, and it is loaded dynamically for the same reason.
 *
 * ## Why it does not import `room-shell.tsx` either
 *
 * `room-shell.tsx` imports THIS file. `.dependency-cruiser.cjs` runs with
 * `tsPreCompilationDeps: true`, so a type-only import back would be an edge like
 * any other and `no-circular` would fail the build — the same trap
 * `room-shell.tsx`'s own docblock records about `pre-join.tsx`. {@link MediaDecision}
 * is therefore the HALF of the decision this file reads, declared structurally;
 * `RoomDecision` satisfies it without either file naming the other.
 */

/* -------------------------------------------------------------------------- *
 * Publishing
 * -------------------------------------------------------------------------- */

/**
 * What the microphone track is published with — spelled out, never inherited.
 *
 * Epic 2's context puts audio above video without exception, and the SDK's
 * defaults happen to agree today: `dtx` and `red` default to on for a mono track
 * and `AudioPresets.music` is the default preset. "Happens to agree" is the
 * problem. A default is a decision somebody else owns, it can change in a minor
 * release, and when Story 2.5 adds a video track the thing that must NOT yield is
 * this one — so it is declared here where a test can read it back.
 *
 * - `dtx` — the encoder stops sending during silence, which is most of a study
 *   room most of the time;
 * - `red` — each packet carries the previous one, so a single lost packet is not
 *   a gap in somebody's sentence. This is the half that pays for itself on the
 *   4G connection the epic is written for;
 * - `priority: 'high'` — the RTP sender's own priority, which is what the browser
 *   reads when it has to choose between two streams. The bitrate is the SDK's
 *   `AudioPresets.speech` value, written out rather than imported for the reason
 *   the docblock above gives.
 * - `forceStereo: false` — mono, because `dtx` and `red` are both mono-only in
 *   the SDK and a stereo capture would silently turn both of them off.
 */
export interface AudioPublishOptions {
  readonly dtx: true;
  readonly red: true;
  readonly forceStereo: false;
  readonly audioPreset: { readonly maxBitrate: number; readonly priority: 'high' };
}

export function audioPublishOptions(): AudioPublishOptions {
  return {
    dtx: true,
    red: true,
    forceStereo: false,
    audioPreset: { maxBitrate: 24_000, priority: 'high' },
  };
}

/**
 * What the CANVAS track is published with — spelled out, never inherited.
 *
 * Story 2.7. Every field is a decision this story owns rather than a default the
 * SDK happens to hold today:
 *
 * - `source: 'camera'` — LiveKit's own word for "a face", and the ONLY source the
 *   token's `canPublishSources` allows besides the microphone. Written as the raw
 *   wire value for the reason the file docblock gives: importing `Track.Source`
 *   would drag a browser SDK into this module's graph. `RoomShell` re-states it
 *   with the SDK's enum, whose runtime value is this same string.
 *
 *   **Nó KHÔNG cưỡng chế được luật (b).** LiveKit thấy track canvas và track
 *   camera là cùng một `camera` source, nên không có gì ở server phân biệt được
 *   khung hình đã xử lý với khung hình thô. Cái chặn là `frame-pipeline.ts` và
 *   phép đo ở `RTCRtpSender.track.id`;
 * - `simulcast: true` — **Story 2.5 QUYẾT ĐỊNH bật.** Đây là thứ làm bậc 1 và
 *   bậc 2 của thang có thật: nhiều lớp độ phân giải trên một track, để SFU tự hạ
 *   lớp khi đường lên hẹp thay vì để cả khung hình chết. Không có nó, giữa "hình
 *   đầy đủ" và "không có hình" chẳng còn nấc nào — mà đúng cái nấc ở giữa là thứ
 *   `epic-2-context.md` mua khi nói "buổi học không gãy khi mạng yếu".
 *
 *   `simulcast` được khai kiểu `boolean` chứ KHÔNG phải literal `true`, và đó là
 *   một ngoại lệ có chủ ý so với `dtx`/`red` ở {@link AudioPublishOptions} — hai
 *   khoá kia ghim literal chính vì muốn `false` là lỗi biên dịch. Ở đây thì
 *   ngược lại: probe ranh giới của story này tuyên bố "đặt `simulcast: false`
 *   rồi chạy lại thì khẳng định SDP đỏ", và một mutation không chạy được là một
 *   mutation không ai từng chạy. Thứ ghim giá trị này không phải kiểu mà là phép
 *   đo trên dây — `a=simulcast:send` cùng nhiều dòng `a=rid:` trong mô tả đã
 *   thương lượng (`tests/e2e/livekit/phong-media.spec.ts`);
 *
 *   Ở 640×480 (trần của `pipelineSizeFor`) `livekit-client` sinh ĐÚNG HAI lớp,
 *   rid `q` và `h`: `computeVideoEncodings` chỉ thêm lớp thứ ba khi cạnh dài
 *   ≥ 960. Nên phép đo nói "≥ 2 encoding", không nói "3";
 * - `degradationPreference: 'maintain-framerate'` — khi băng thông hẹp thì giữ
 *   nhịp và hạ độ phân giải. Một khuôn mặt giật là thứ khó đọc hơn một khuôn mặt
 *   mờ, và `epic-2-context.md` cho phép video tụt bậc;
 * - `videoEncoding` — bitrate và FPS ghim tường minh, `priority: 'low'`. Chữ
 *   `low` là nửa còn lại của `priority: 'high'` trên {@link audioPublishOptions}:
 *   khi trình duyệt phải chọn giữa hai luồng, epic đã nói thứ nào nhường.
 *
 * `maxFramerate` ĐỌC `PIPELINE_FPS` chứ không chép lại con số. Hai literal ở hai
 * tệp là hai thứ trôi khỏi nhau trong im lặng: canvas bắt 24 hình/giây trong khi
 * encoder được bảo 30 thì bitrate đã tính cho một nhịp không tồn tại, và không có
 * gì đỏ lên. Một nguồn, một con số.
 */
export interface VideoPublishOptions {
  readonly source: 'camera';
  readonly simulcast: boolean;
  readonly degradationPreference: 'maintain-framerate';
  readonly videoEncoding: {
    readonly maxBitrate: number;
    readonly maxFramerate: number;
    readonly priority: 'low';
  };
}

/**
 * The ceiling the canvas track is encoded at, in bits per second.
 *
 * 500 kbps for 640×480 at {@link PIPELINE_FPS}: enough for a face in a study room
 * and small enough to leave Opus its 24 kbps on the 4G connection `epic-2-context.md`
 * is written for. Named rather than inline so the test can pin the NUMBER — "greater
 * than zero" was the first spelling and it agrees with every value anybody could
 * typo, which is not what a docblock claiming an explicit decision may rest on.
 */
export const VIDEO_MAX_BITRATE = 500_000;

export function videoPublishOptions(): VideoPublishOptions {
  return {
    source: 'camera',
    simulcast: true,
    degradationPreference: 'maintain-framerate',
    videoEncoding: { maxBitrate: VIDEO_MAX_BITRATE, maxFramerate: PIPELINE_FPS, priority: 'low' },
  };
}

/**
 * The three modes, as the ONE list every other spelling is derived from.
 *
 * `FACE_MODES` in `room-shell.tsx` is this array — not a copy of it — so a fourth
 * mode cannot arrive on one side of the graph and not the other. It lives here
 * because this file is the one nothing imports back (see the docblock above).
 */
export const MEDIA_FACE_MODES = ['show', 'hide', 'filter'] as const;

/**
 * The half of a `RoomDecision` the media plane and the panel read.
 *
 * Declared here rather than imported, for the cycle the file docblock explains —
 * and the SHAPE is doing a second job: there is no `token` and no `url` on it, so
 * `RoomPanel`, which takes one of these, cannot render either even by mistake.
 * `RoomDecision` satisfies it structurally, and only `RoomShell` holds the whole
 * thing.
 */
export type MediaFaceMode = (typeof MEDIA_FACE_MODES)[number];

export interface MediaDecision {
  readonly faceMode: MediaFaceMode;
  readonly audio: 'mic' | 'listen-only';
}

/**
 * Whether a mode may open the camera at all — the ONE place that decides it.
 *
 * `filter` answers `false`, and that is not a placeholder: the ML pipeline is a
 * separate deliverable (`deferred-work.md`), so a room that opened a camera for
 * `filter` today would publish an UNFILTERED face under a label promising a
 * filter. Refusing here means the worst a half-built mode can do is show an
 * avatar.
 *
 * Every asynchronous step in `RoomShell` reads this through `faceModeRef`, never
 * through `decision.faceMode`: the decision is a snapshot of the moment pre-join
 * ended, and the group in the room can change the answer during any `await`.
 */
export function faceModeAllowsVideo(faceMode: MediaFaceMode): boolean {
  return faceMode === 'show';
}

/**
 * Whether a person may PUT the room in this mode — the structural half of the
 * panel disabling the radio.
 *
 * `filter` is refused here as well as in the markup, and that is the point rather
 * than a belt: `faceModeRef` is described as the one source of truth for the whole
 * video machine, so a mode that reaches it is a mode the machine will act on. A
 * defence that lives only in a `disabled` attribute is a defence that a second
 * caller — Story 2.6's popover, a keyboard path, a test — walks straight past.
 */
export function faceModeSelectable(faceMode: MediaFaceMode): boolean {
  return faceMode !== 'filter';
}

/**
 * The mode the room STARTS in, given whatever the admission carried.
 *
 * Pre-join cannot produce `filter` today, so this is a guard against a state the
 * product cannot currently reach — which is exactly when a guard is cheap. Without
 * it a `filter` admission renders a radio that is both checked and disabled, and
 * seeds the machine with a mode {@link faceModeAllowsVideo} will never satisfy.
 * `hide` is the floor every other mode falls back to.
 */
export function initialFaceModeFor(faceMode: MediaFaceMode): MediaFaceMode {
  return faceModeSelectable(faceMode) ? faceMode : 'hide';
}

/* -------------------------------------------------------------------------- *
 * What a camera refusal MEANS
 * -------------------------------------------------------------------------- */

/**
 * The error names the two families of refusal go by — the ONE declaration.
 *
 * `pre-join.tsx` owned these and the shell classified error names inline beside
 * it, which is two readings of one browser vocabulary: the shell's copy had no
 * `DevicesNotFoundError` (the spelling an older Chromium still uses) and no
 * `PermissionDeniedError`, so the same unplugged camera produced "no camera" on
 * one screen and "you refused" on the other. They live here because this is the
 * module both sides already import and nothing imports back.
 *
 * `NotAllowedError` is the standard name; `PermissionDeniedError` is what an older
 * Chromium spelled it; `SecurityError` is "this page is not allowed to ask" (an
 * insecure context, a `Permissions-Policy`), which for the person is the same wall
 * with the same way round it. `NotFoundError` and its old spelling say "no such
 * device"; `OverconstrainedError` with `video: true` can only mean the same.
 */
export const BLOCKED_DEVICE_ERRORS: ReadonlySet<string> = new Set([
  'NotAllowedError',
  'PermissionDeniedError',
  'SecurityError',
]);

export const MISSING_DEVICE_ERRORS: ReadonlySet<string> = new Set([
  'NotFoundError',
  'DevicesNotFoundError',
  'OverconstrainedError',
]);

/**
 * Which of three different things went wrong with a camera, as one word.
 *
 * The third word is why this function exists. `NotReadableError` and `AbortError`
 * mean the device is THERE and somebody else has it — another application, another
 * tab, the OS — and calling that a refusal tells a person to go and change a
 * permission setting that is already correct. `SecurityError` is genuinely a wall
 * (it lives in {@link BLOCKED_DEVICE_ERRORS}), so the split is not "standard names
 * versus the rest".
 */
export type CameraProblem = 'missing' | 'blocked' | 'busy';

export function cameraProblemFor(errorName: string): CameraProblem {
  if (MISSING_DEVICE_ERRORS.has(errorName)) {
    return 'missing';
  }
  return BLOCKED_DEVICE_ERRORS.has(errorName) ? 'blocked' : 'busy';
}

/**
 * The options `new Room(...)` is built with.
 *
 * `adaptiveStream` and `dynacast` are both about VIDEO layers, and Story 2.5 —
 * the ladder itself — is the story that owns them. Story 2.4 set both to `false`
 * because it published no video at all; Story 2.7 kept them `false` and recorded
 * the debt so that this story would DECIDE them rather than discover them. Here
 * is the decision, and it is a SPLIT rather than one answer for both:
 *
 * - **`dynacast: true` — bật.** Nó là nửa phía PHÁT của thang. Từ khi
 *   {@link videoPublishOptions} bật `simulcast`, một người đang publish nhiều
 *   lớp cùng lúc, và `dynacast` là thứ ngừng gửi những lớp không ai đăng ký.
 *   Đó là băng thông lấy lại được trên chính đường lên của người đang ngồi wifi
 *   yếu, mà không đụng một byte nào của đường audio — đúng hình dạng nhượng bộ
 *   mà `epic-2-context.md` cho phép. Ở Story 2.4/2.7 nó không có gì để tắt vì
 *   chỉ có một lớp; hôm nay nó có.
 * - **`adaptiveStream: false` — vẫn tắt, nhưng vì một lý do của story NÀY chứ
 *   không phải vì thừa kế.** Hai lý do, và lý do thứ hai mới là của thang:
 *   1. nó đo chính cái `<video>` đang hiển thị để co giãn hoặc tạm dừng một
 *      subscription, mà ô trong lưới là của Story 2.6 — chưa có ô ổn định để đo
 *      thì một subscription bị tạm dừng vì ô chưa kịp bố trí là một ô đen không
 *      giải thích được;
 *   2. nó làm phép đo của bậc 3 mất nghĩa. Bậc 3 khẳng định "không còn ô video ở
 *      đầu kia vì thang đã gỡ sender". Với `adaptiveStream` bật, một ô trống có
 *      thể là thang, mà cũng có thể là một phép đo kích thước phần tử — hai
 *      nguyên nhân cho một triệu chứng, và cái probe tưởng mình đang chứng minh
 *      thì không còn chứng minh nữa. Story 2.6 sở hữu việc bật nó, cùng lúc với
 *      cái ô mà nó đo.
 *
 * `publishDefaults` is present for `mic` and ABSENT for `listen-only`, and that
 * absence is the point rather than a saving: a listen-only room has nothing to
 * publish, so a set of publish defaults sitting there would describe a track that
 * must never exist.
 */
export interface MediaRoomOptions {
  readonly adaptiveStream: false;
  readonly dynacast: true;
  readonly stopLocalTrackOnUnpublish: true;
  readonly disconnectOnPageLeave: true;
  readonly publishDefaults?: AudioPublishOptions;
}

export function roomOptionsFor(decision: MediaDecision): MediaRoomOptions {
  const base = {
    adaptiveStream: false,
    dynacast: true,
    stopLocalTrackOnUnpublish: true,
    disconnectOnPageLeave: true,
  } as const;
  return decision.audio === 'mic' ? { ...base, publishDefaults: audioPublishOptions() } : base;
}

/* -------------------------------------------------------------------------- *
 * The token's clock
 * -------------------------------------------------------------------------- */

/**
 * Whether the admission has lapsed — `expires_at` from the wire, against a clock.
 *
 * `ROOM_TOKEN_TTL_SECONDS` is 120, and the SAME instant ends the token and the
 * reserved seat (`packages/contracts/src/rooms.ts`). Sitting on the shell past it
 * means holding a dead token against a seat somebody else can now take, so the
 * shell watches it and goes back to pre-join rather than connecting into a
 * refusal it cannot explain.
 *
 * An unparseable value answers `false`, deliberately. The body came through
 * `roomTokenResponseSchema`, so an unreadable instant is not a state the product
 * can reach; and if it ever did, refusing to enter a room over a clock we cannot
 * read would be a worse answer than letting LiveKit judge the token itself.
 */
export function tokenExpiredAt(expiresAt: string, now: number): boolean {
  const instant = Date.parse(expiresAt);
  return Number.isNaN(instant) ? false : instant <= now;
}

/* -------------------------------------------------------------------------- *
 * Where the join is
 * -------------------------------------------------------------------------- */

/**
 * `ConnectionState` from `livekit-client`, as the five strings it carries.
 *
 * A string enum is nominal in TypeScript, so `ConnectionState.Connected` is not
 * assignable to `'connected'` — which is exactly what makes this a function
 * rather than a cast. {@link roomConnectionStateFor} takes the raw value and
 * answers a word this file owns; a sixth state added by a future SDK lands on
 * `disconnected` instead of crashing a render.
 */
export type RoomConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'signalReconnecting';

const CONNECTION_STATES: ReadonlySet<string> = new Set<RoomConnectionState>([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'signalReconnecting',
]);

export function roomConnectionStateFor(raw: string): RoomConnectionState {
  return CONNECTION_STATES.has(raw) ? (raw as RoomConnectionState) : 'disconnected';
}

/**
 * Whether the room is UP — the one notion two different places need to agree on.
 *
 * {@link joinPhaseFor} uses it to decide that a lapsed token no longer matters,
 * and `RoomShell`'s expiry timer uses it to decide it must not tear anything down.
 * Written twice they drifted at once: the first spelling of `joinPhaseFor` left
 * `signalReconnecting` out, so a token that lapsed while the SDK was re-signalling
 * a live room reported `expired` and sent somebody back to pre-join out of a room
 * they were still in.
 */
export function isLiveConnection(state: RoomConnectionState): boolean {
  return state === 'connected' || state === 'reconnecting' || state === 'signalReconnecting';
}

/**
 * The six words the screen can be in, and the order they decide in.
 *
 * - `expired` wins over everything before the room is up, because it is the
 *   CAUSE: a token that lapsed while the handshake ran produces a refusal too,
 *   and reporting the refusal would send somebody to a retry that cannot work;
 * - `failed` is second — a refusal we did get, with a sentence and a way back;
 * - then the SDK's own state, which is the only thing that speaks once the room
 *   is really up. `expired` deliberately does NOT apply from `connected` on: the
 *   token buys the handshake, not the session, and a room that is up stays up.
 */
export type JoinPhase = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'expired' | 'left';

export function joinPhaseFor(
  connectionState: RoomConnectionState,
  error: MessageKey | null,
  expired: boolean,
): JoinPhase {
  if (expired && !isLiveConnection(connectionState)) {
    return 'expired';
  }
  if (error !== null) {
    return 'failed';
  }
  switch (connectionState) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'reconnecting':
    case 'signalReconnecting':
      return 'reconnecting';
    case 'disconnected':
      return 'left';
  }
}

/**
 * `DisconnectReason` from `@livekit/protocol`, as the numbers that matter here.
 *
 * `CLIENT_INITIATED` answers `null` — we are the client, "Rời phòng" was pressed
 * or the page went away, and announcing a disconnection somebody asked for reads
 * as a fault. `DUPLICATE_IDENTITY` is the one `deferred-work.md` predicted: the
 * token's `sub` IS the participant identity on LiveKit, so a second connection
 * under the same account evicts the first, and the person evicted has to be told
 * which of the two things happened. Everything else is one sentence and a way
 * back to pre-join; none of the remaining reasons is something a study room can
 * act on differently.
 */
export const DISCONNECT_CLIENT_INITIATED = 1;
export const DISCONNECT_DUPLICATE_IDENTITY = 2;

export function disconnectReasonKeyFor(reason: number | undefined): MessageKey | null {
  if (reason === DISCONNECT_CLIENT_INITIATED) {
    return null;
  }
  return reason === DISCONNECT_DUPLICATE_IDENTITY ? 'room.errorDuplicate' : 'room.errorDisconnected';
}

/* -------------------------------------------------------------------------- *
 * Thang suy giảm mạng bốn bậc — Story 2.5
 * -------------------------------------------------------------------------- */

/**
 * `ConnectionQuality` from `livekit-client`, as the five strings it carries.
 *
 * Re-declared for the reason the file docblock gives — importing the SDK's enum
 * would drag a browser module into this file's graph and take every function
 * below out of a DOM-less test's reach. The values are the enum's own
 * (`room/participant/Participant.d.ts:13-23`), and {@link connectionQualityFor}
 * is the one place a raw string becomes one of them: a sixth quality invented by
 * a future SDK lands on `unknown`, which {@link networkRungFor} reads as bậc 1.
 */
export type MediaConnectionQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

const CONNECTION_QUALITIES: ReadonlySet<string> = new Set<MediaConnectionQuality>([
  'excellent',
  'good',
  'poor',
  'lost',
  'unknown',
]);

export function connectionQualityFor(raw: string): MediaConnectionQuality {
  return CONNECTION_QUALITIES.has(raw) ? (raw as MediaConnectionQuality) : 'unknown';
}

/**
 * The four rungs, as the ONE list every other spelling is derived from.
 *
 * Numbers rather than words because the story, the spec's matrix and the screen
 * all say "bậc 1…4", and a second vocabulary (`healthy | degraded | …`) would be
 * a translation layer nobody asked for between a conversation and its code.
 */
export const NETWORK_RUNGS = [1, 2, 3, 4] as const;

export type NetworkRung = (typeof NETWORK_RUNGS)[number];

/**
 * Which rung the room is on, from the SDK's own two signals.
 *
 * **`ConnectionQuality` is the measurement; the connection STATE is the veto.**
 * The two say different things and both are needed: quality is LiveKit's own
 * estimate of the line, and it goes on reporting `excellent` for a moment after
 * the socket has actually gone. So a room that is re-signalling or reconnecting
 * is bậc 4 whatever the quality last said — that is the "mất kết nối thật" half
 * of the matrix row, and it is the half the container-stop probe drives.
 *
 * `unknown` is bậc 1, deliberately. It is what the SDK reports before it has
 * measured anything — every join passes through it — and answering a rung that
 * puts a warning chip on screen would mean greeting everybody with bad news
 * about a line nobody has looked at yet.
 *
 * `connecting` and `disconnected` are bậc 1 for a different reason: at those
 * phases {@link joinPhaseFor} owns the whole screen, and a ladder reading is a
 * second, quieter answer to a question already being answered loudly.
 */
export function networkRungFor(
  quality: MediaConnectionQuality,
  connectionState: RoomConnectionState,
): NetworkRung {
  if (connectionState === 'reconnecting' || connectionState === 'signalReconnecting') {
    return 4;
  }
  if (connectionState !== 'connected') {
    return 1;
  }
  switch (quality) {
    case 'lost':
      return 4;
    case 'poor':
      return 3;
    case 'good':
      return 2;
    case 'excellent':
    case 'unknown':
      return 1;
  }
}

/**
 * Whether a rung lets a picture be on the wire at all — and only bậc 3 says no.
 *
 * Bậc 4 answering `true` is the part that reads wrong and is right. "Lưới đóng
 * băng" is a FROZEN screen, not a teardown: at bậc 4 the SDK is in the middle of
 * its own resume, the publication is untouched, and a reconnect that succeeds
 * puts the same track back where it was with nobody having pressed anything.
 * Tearing video down there would mean a two-second blip costs somebody their
 * camera until they press a button — the ladder punishing a recovery it is
 * supposed to be riding out.
 *
 * Bậc 3 is the rung that decides. It takes the picture off **to save the sound**,
 * which is `epic-2-context.md`'s ranking made operational, and the decision is
 * LATCHED by the caller: `RoomShell` never clears it because the network got
 * better. See {@link offersCameraRestart} for the only way back.
 */
export function rungAllowsVideo(rung: NetworkRung): boolean {
  return rung !== 3;
}

/**
 * The network chip's sentence — and `null` at bậc 4 is the whole answer to
 * "chip chất lượng mạng và chip pha kết nối: hợp nhất hay đứng cạnh nhau?".
 *
 * **They stand SIDE BY SIDE, in one `role="status"` line, and they answer two
 * different questions.** The phase chip answers "am I in this room" — it is
 * {@link joinPhaseFor}'s, it has said "Đang ở trong phòng" since Story 2.4, and
 * merging the two would mean deleting that sentence from the connected state.
 * This chip answers "how good is the line", which the phase chip has never had a
 * word for.
 *
 * Two chips can contradict each other, and bậc 4 is the one rung where they
 * would: "Mất kết nối" beside "Đang nối lại…" is the same news twice, and beside
 * "Đang ở trong phòng" it is the same news denied. So bậc 4 renders NO network
 * chip. At that rung the phase chip already owns the state and the banner —
 * `role="alert"`, the loud channel — carries the rest, while the chip line stays
 * polite. That is also why this is a two-level chip rather than a four-level one:
 * bậc 1 and bậc 2 are both "the line is fine, nothing for you to do".
 */
export function rungChipKeyFor(rung: NetworkRung): MessageKey | null {
  switch (rung) {
    case 1:
    case 2:
      return 'room.networkOk';
    case 3:
      return 'room.networkWeak';
    case 4:
      return null;
  }
}

/**
 * The chip's class, and it is TOTAL over the rungs on purpose.
 *
 * A tone for bậc 4 exists even though {@link rungChipKeyFor} renders nothing
 * there: the two functions answer different questions, and a tone that went
 * `null` in sympathy would be one more place a future rung has to remember to
 * fill in. Colour is the SECOND channel here — the words are the first — because
 * the palette's green/terracotta pair is the hardest one for red-green colour
 * blindness and it is carrying the room's most important fact.
 *
 * The return type is the two class strings and nothing else. `string` would let a
 * typo — `'chip-statu warn'` — compile and ship an unstyled chip, and every other
 * decision in this file answers a closed type for exactly that reason.
 */
export type NetworkChipTone = 'chip-status ok' | 'chip-status warn';

export function rungChipToneFor(rung: NetworkRung): NetworkChipTone {
  switch (rung) {
    case 1:
    case 2:
      return 'chip-status ok';
    case 3:
    case 4:
      return 'chip-status warn';
  }
}

/**
 * The one-line banner, or `null` — and bậc 2 returning `null` is a DECISION.
 *
 * "Im lặng ở bậc 2 là tính năng." The video has quietly dropped a simulcast
 * layer, which is the ladder working, and telling somebody about it turns a
 * thing that is working into a thing that looks broken. The empty cell in the
 * spec's matrix is an assertion to test, not a gap to fill.
 *
 * `retryExhausted` is the bậc 4 clock having run out. Up to then the banner says
 * the room is still trying; after it, the sentence stops promising and the
 * screen offers the way back to pre-join instead. Going UP a rung is silent by
 * the same argument as bậc 2 — the chip changes and nothing announces itself.
 */
export function rungBannerKeyFor(rung: NetworkRung, retryExhausted: boolean): MessageKey | null {
  switch (rung) {
    case 1:
    case 2:
      return null;
    case 3:
      return 'room.networkWeakBanner';
    case 4:
      return retryExhausted ? 'room.networkGaveUp' : 'room.networkLostBanner';
  }
}

/**
 * Whether to OFFER turning the camera back on — the one exit from bậc 3.
 *
 * The rule `epic-2-context.md` states outright is that no system event ever puts
 * anybody back on "Để nguyên". The ladder obeys it by never restoring anything
 * itself: a rung that took the picture off latches, and this button is the only
 * thing that unlatches it. Three conditions, and each is a row of the matrix:
 *
 * - `wasOnBeforeDrop` — the picture really WAS on the wire when the ladder took
 *   it. Somebody who joined hidden, or whose camera had already failed, has
 *   nothing to restore and must not be offered a button that implies they lost
 *   something;
 * - the mode still allows video. This is the row "hồi phục khi người dùng đã tự
 *   bấm Ẩn mặt ở bậc 3": their press outranks the network's, so the offer
 *   disappears rather than inviting them to undo their own decision. It reads
 *   {@link faceModeAllowsVideo} rather than comparing to `'show'` so that there
 *   is one rule about which modes may open a camera, not two;
 * - the line is good enough to carry a picture again. At bậc 3 the button would
 *   publish into the very conditions the ladder just refused, and at bậc 4 there
 *   is no room to publish into — the offer belongs to a recovery, which is what
 *   bậc 1 and bậc 2 mean.
 */
export function offersCameraRestart(
  rung: NetworkRung,
  faceMode: MediaFaceMode,
  wasOnBeforeDrop: boolean,
): boolean {
  return wasOnBeforeDrop && faceModeAllowsVideo(faceMode) && rung < 3;
}

/**
 * How long the chip waits before it changes, read out of the design token.
 *
 * The number lives in `tokens.css` (`--motion-network-chip-debounce`) and is
 * held against `DESIGN.md` by `tests/gates/design-tokens.test.ts`. Retyping
 * `3000` here would make a third copy that no gate compares, so the shell reads
 * the computed custom property and hands the raw string to this function.
 *
 * **It must accept `3s` as well as `3000ms`, and that is measured rather than
 * defensive.** The token is authored as `3000ms`; the production CSS Next emits
 * minifies it to `3s` (read out of `apps/web/.next/static/chunks/*.css`). A
 * parser that only knew milliseconds would therefore work in development and
 * silently answer `3` — three milliseconds, a debounce that does nothing — in
 * the build that ships.
 *
 * An unreadable value answers the fallback rather than `0`. A chip with no
 * debounce flickers on every quality sample, which is the one failure this token
 * exists to prevent; a chip that waits three seconds when the stylesheet could
 * not be read is wrong in the direction nobody notices.
 *
 * **The fallback IS a second literal of the token's number, and it is not held
 * against `DESIGN.md` by anything.** Said plainly rather than left for a reader
 * to find: `tests/gates/design-tokens.test.ts` compares `tokens.css` with
 * `DESIGN.md`, and this constant is in neither, so raising the token to five
 * seconds would leave this saying three. What keeps that harmless is that the
 * two are not both in play — the product reads the stylesheet and reaches this
 * only where there is no stylesheet to read (a `getComputedStyle` that answers
 * `''`), and a fallback cannot be derived from a source that is missing. If this
 * number ever becomes reachable in a real browser, it has become a copy and
 * needs a gate.
 */
export const NETWORK_CHIP_DEBOUNCE_FALLBACK_MS = 3_000;

export function chipDebounceMsFor(raw: string): number {
  const text = raw.trim().toLowerCase();
  // `.5s` is a CSS time a minifier really produces — it is what `0.5s` becomes —
  // so the digits before the point are optional. The UNIT is not: a bare number
  // is not a CSS time, and reading one as milliseconds would be inventing a
  // meaning the stylesheet did not give.
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(text);
  if (match === null) {
    return NETWORK_CHIP_DEBOUNCE_FALLBACK_MS;
  }
  const value = Number(match[1]);
  const ms = match[2] === 's' ? value * 1000 : value;
  // `>= 0`, not `> 0`. An authored `0ms` is a legible instruction — "no debounce"
  // — and answering the fallback there would override a decision somebody made in
  // the stylesheet with one made here.
  return Number.isFinite(ms) && ms >= 0 ? ms : NETWORK_CHIP_DEBOUNCE_FALLBACK_MS;
}

/**
 * How long bậc 4 keeps saying "đang thử lại" before it stops promising.
 *
 * Thirty seconds is the spec's number. It is a UI clock and nothing else: it
 * does not cancel the SDK's own resume, which goes on for as long as the SDK
 * gives it — so a reconnect that lands at second forty still works, and what the
 * clock bought in the meantime is a screen that stopped claiming something it
 * could no longer promise, with a way out beside it.
 */
export const NETWORK_RETRY_SECONDS = 30;

/* -------------------------------------------------------------------------- *
 * Who is in the room
 * -------------------------------------------------------------------------- */

/**
 * The letters on an avatar: first letter of the first and last word, tone marks
 * stripped, upper-cased, at most two.
 *
 * Diacritics come off by decomposition (`NFD` puts each mark in its own code
 * point, which the combining-mark range U+0300 to U+036F then removes); d with a
 * stroke (U+0111) is the one letter that is not a base plus a mark, so it is
 * mapped by hand. A name with nothing usable in it is `?` rather than an empty
 * tile.
 *
 * It lives HERE rather than in `pre-join.tsx`, where Story 2.3 wrote it, because
 * the participant list needs it too and `pre-join.tsx` cannot be imported from
 * this side of the graph without a cycle. `pre-join.tsx` re-exports it, so the
 * name it was tested under still resolves.
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

/**
 * The letters for somebody who arrived with no name at all — taken off the TAIL
 * of their identity, and the end is the whole point.
 *
 * {@link avatarInitialsFor} is built for a NAME: it splits on spaces and takes the
 * first letter of the first and last word. An identity is a uuidv7, which has no
 * spaces and whose leading characters are a millisecond timestamp — so every
 * person who joined in the same era is one word beginning with the same digit, and
 * the first version of this shipped a room in which every avatar read `0`. The
 * docblocks on both sides claimed the opposite ("everyone stays distinguishable"),
 * which is how a cosmetic bug becomes a false statement about the product.
 *
 * The last two alphanumerics are where a uuidv7's randomness lives, so two people
 * in one room reading the same pair is a 1-in-256 coincidence rather than a
 * certainty. It is still a coincidence that can happen, and nothing here pretends
 * otherwise: these letters are a hint beside a row, never the way somebody is
 * identified. A real display name is `deferred-work.md`'s item.
 */
export function identityInitialsFor(identity: string): string {
  const usable = [...identity.replace(/[^\p{L}\p{N}]/gu, '')];
  if (usable.length === 0) {
    return '?';
  }
  return usable.slice(-2).join('').toUpperCase();
}

/**
 * One video publication, reduced to the three facts that decide whether to draw it.
 *
 * Structural, so a test can build one without a `Room` — which is the point:
 * {@link videoKeyFor} is the subtlest decision in Story 2.7 and it was previously
 * written inline in `room-shell.tsx`, where nothing in the DOM-less `web` project
 * could execute it.
 */
export interface MediaVideoPublication {
  readonly trackSid: string;
  readonly subscribed: boolean;
  readonly muted: boolean;
  readonly hasTrack: boolean;
}

/**
 * WHICH of somebody's video publications a tile should draw, as a stable key —
 * `identity:trackSid` — or `null` for the letters.
 *
 * ## Why a key and not a boolean
 *
 * A participant may hold more than one video publication, and the first version of
 * this filed every remote track under the IDENTITY alone. Two consequences, both
 * silent: a second publication overwrote the first, and ONE unsubscribe blanked a
 * tile whose other track was still live. Keying by the publication's own `trackSid`
 * makes both impossible — a track is stored, found and removed under the thing that
 * identifies it.
 *
 * ## Why all three conditions
 *
 * Each is a way the answer is "draw nothing" while a `<video>` would still mount,
 * and each is reachable: an UNSUBSCRIBED publication carries no frames; a MUTED one
 * is what a hidden tab and the instant before an unpublish both look like; and a
 * publication with no `track` is one there is nothing to attach. A tile that draws
 * for any of them is a black rectangle where an avatar belongs.
 *
 * The FIRST match wins rather than the last, so a tile does not swap between two
 * live publications every time the map is rebuilt.
 */
export function videoKeyFor(
  identity: string,
  publications: readonly MediaVideoPublication[],
): string | null {
  const showable = publications.find(
    (publication) => publication.subscribed && !publication.muted && publication.hasTrack,
  );
  return showable === undefined ? null : `${identity}:${showable.trackSid}`;
}

/**
 * A participant as the media plane sees one: who they are, and whether their
 * microphone is travelling.
 *
 * Structural, so a test can build one without a `Room`. `identity` is the
 * token's `sub`, which is the account id — never shown, only used as a key.
 */
export interface MediaParticipant {
  readonly identity: string;
  /** The display name LiveKit carries, when there is one. */
  readonly name?: string;
  readonly micOn: boolean;
  /**
   * WHICH picture of theirs to draw, or `null` for the letters — Story 2.7.
   *
   * A key rather than a boolean, and that is {@link videoKeyFor}'s whole reason.
   */
  readonly videoKey: string | null;
}

/**
 * One row of the list.
 *
 * `label` is DATA — a name off the wire — and `isSelf` is what the panel reads to
 * put the catalogue's word for the reader in its place. The panel never composes
 * a sentence out of a name.
 *
 * **`label` is `''` for everybody today, and that is a fact about the wire rather
 * than about this function.** `mintRoomToken` sets `sub` and no `name` claim, so
 * LiveKit has no display name to carry and the only string a remote participant
 * arrives with is the account id. Putting that id on a screen in a product whose
 * whole argument is presence without identity would be the wrong answer, so an
 * unnamed row carries an empty label and the panel renders the catalogue's word
 * for a person instead. `initials` then comes from {@link identityInitialsFor} —
 * the TAIL of the identity, where a uuidv7's randomness is, because its head is a
 * timestamp everybody in the room shares. `deferred-work.md` records who owns a
 * real display name.
 */
export interface ParticipantRow {
  readonly id: string;
  readonly label: string;
  readonly initials: string;
  readonly speaking: boolean;
  readonly micOn: boolean;
  /** Draw a `<video>` for this row, or the letters. See {@link videoKeyFor}. */
  readonly videoKey: string | null;
  readonly isSelf: boolean;
}

/**
 * The rows, ordered: the reader first, then everybody else by name.
 *
 * The reader is pinned to the top rather than sorted among the rest so that the
 * row whose microphone state a person can DO something about does not move under
 * them every time somebody joins. `localeCompare` with `vi` is what puts
 * Vietnamese names in the order a Vietnamese reader expects; `identity` breaks a
 * tie so two people with one name have a stable order rather than a flickering
 * one.
 *
 * A remote carrying the reader's own identity is dropped. LiveKit does not
 * produce one — the eviction in `deferred-work.md` is the reason it cannot — and
 * a duplicate row would be a person seeing themselves twice, so it is refused
 * here rather than left to the server's good behaviour.
 */
export function participantRowsFor(
  local: MediaParticipant | null,
  remotes: readonly MediaParticipant[],
  speakers: readonly string[],
): readonly ParticipantRow[] {
  const speaking = new Set(speakers);
  const rowFor = (participant: MediaParticipant, isSelf: boolean): ParticipantRow => {
    const name = participant.name?.trim() ?? '';
    return {
      id: participant.identity,
      label: name,
      // Two different readers, because a name and a uuid are different shapes and
      // the name-shaped reader answers `0` for every uuid on earth.
      initials: name.length > 0 ? avatarInitialsFor(name) : identityInitialsFor(participant.identity),
      speaking: speaking.has(participant.identity) && participant.micOn,
      micOn: participant.micOn,
      videoKey: participant.videoKey,
      isSelf,
    };
  };

  const seen = new Set<string>();
  const rows: ParticipantRow[] = [];
  if (local !== null) {
    seen.add(local.identity);
    rows.push(rowFor(local, true));
  }
  const others = remotes
    .filter((participant) => {
      if (seen.has(participant.identity)) {
        return false;
      }
      seen.add(participant.identity);
      return true;
    })
    .map((participant) => rowFor(participant, false))
    .sort((a, b) => a.label.localeCompare(b.label, 'vi') || a.id.localeCompare(b.id));

  return [...rows, ...others];
}
