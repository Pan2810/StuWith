import type {
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomOptions,
  TrackPublishOptions,
} from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '../../i18n/messages';
import {
  PIPELINE_FPS,
  PIPELINE_READY_TIMEOUT_MS,
  createFramePipeline,
  pipelineSizeFor,
  type FramePipeline,
} from './frame-pipeline';
import {
  MEDIA_FACE_MODES,
  audioPublishOptions,
  cameraProblemFor,
  disconnectReasonKeyFor,
  faceModeAllowsVideo,
  faceModeSelectable,
  initialFaceModeFor,
  isLiveConnection,
  joinPhaseFor,
  participantRowsFor,
  roomConnectionStateFor,
  roomOptionsFor,
  tokenExpiredAt,
  videoKeyFor,
  videoPublishOptions,
  type CameraProblem,
  type MediaParticipant,
  type MediaVideoPublication,
  type RoomConnectionState,
} from './room-media';
import { RoomPanel } from './room-panel';

/**
 * The vocabulary of a presence DECISION, and the shell that acts on one.
 *
 * ## Why the types live here and not in `pre-join.tsx`
 *
 * `pre-join.tsx` renders this component on its `admitted` branch, so it imports
 * from here. If the face-mode union lived there, this file would have to import it
 * back — and `.dependency-cruiser.cjs` runs with `tsPreCompilationDeps: true`, so a
 * type-only import is an edge like any other and `no-circular` fails the build.
 * The decision is what this component CONSUMES, which makes it the natural owner
 * of the decision's shape; the screen that produces it reads the shape from here.
 *
 * ## What this shell is, from Story 2.4
 *
 * The media plane, and the only place in `apps/web` that opens one. It takes the
 * token it was handed, connects to LiveKit once, publishes ONE microphone track,
 * subscribes to everybody else's audio, and renders {@link RoomPanel} from the
 * result. Three things Story 2.3 decided still hold, and this file is where they
 * are kept:
 *
 * - **the token is requested exactly ONCE, when "Vào phòng" is pressed**, and it
 *   produces exactly ONE `Room.connect`. `deferred-work.md` records why: the
 *   token's `sub` is `user.id`, LiveKit treats that as the participant identity,
 *   and a second connection under the same identity evicts the first. There is no
 *   reconnect-with-a-new-token path here; the SDK's own resume is what handles a
 *   dropped network, and a connection that really ends goes back to pre-join;
 * - **the decision arrives in memory only.** `token` lives in React state on the
 *   page above and in the props of this component, never in `localStorage`,
 *   `sessionStorage`, a cookie or a log line — and {@link RoomPanel} is handed a
 *   shape that does not carry it, so the markup cannot leak it even by accident.
 *   A reload lands on pre-join again, which is what {@link backToPreJoin} uses;
 * - **the pre-join streams are STOPPED before this renders** (`page.tsx` ends
 *   every track on the `201`). So this shell asks for the microphone AGAIN rather
 *   than inheriting one. That is the choice Story 2.4 made of the two Story 2.3
 *   left open, and it is what keeps `listen-only` honest: on that branch
 *   `getUserMedia` is not called even once, so no light comes on and no track
 *   exists to publish by mistake.
 *
 * ## Video, from Story 2.7 — and the two invariants that hold it up
 *
 * `publishTrack` only ever receives a track that came out of
 * `canvas.captureStream()`. The camera track feeds a detached `<video>` inside
 * {@link createFramePipeline} and never travels: AD-30 rule (b), closed by
 * structure rather than by timing, and measured at `RTCRtpSender.track.id` in
 * `tests/e2e/livekit/phong-media.spec.ts`.
 *
 * **BẤT BIẾN 1 — one source of truth for the mode somebody WANTS.**
 * {@link RoomShell}'s `faceModeRef` is written synchronously by
 * `onChangeFaceMode`, before and independently of whether any of the video
 * machinery exists yet. Everything asynchronous reads it again after every
 * `await` through ONE reconciler, {@link RunHandle.wake} → `syncVideo`, and
 * `decision.faceMode` is never consulted after an `await` anywhere. That is not
 * tidiness: review round 1 of this story reproduced a press of "Ẩn mặt" during
 * `connecting` that reached no callback, so the run read the stale snapshot and
 * published the face of the person who had just asked to hide it. `client-address.ts`
 * is the file `AGENTS.md` keeps as the record of what patching one `await` at a
 * time costs, so the rule is stated once here and the call sites obey it.
 *
 * **BẤT BIẾN 2 — video never stands in front of audio.** `epic-2-context.md`:
 * video may degrade and then stop; sound may never drop. So nothing video-related
 * is awaited on the path to `room.connect()` — `syncVideo` is kicked off with
 * `void` and its publish step waits for the connection instead of the other way
 * round — and the pipeline's `whenReady` carries a timeout plus `error`/`ended`
 * listeners, because a camera that yields a track and then never fires
 * `loadedmetadata` would otherwise cost somebody the room's sound as well.
 *
 * ## Why `livekit-client` is imported dynamically
 *
 * At the top of this file it appears only as TYPES, which are erased. The runtime
 * import happens inside the effect. Two reasons, and the first is not performance:
 * the `web` Vitest project runs in `node` with no DOM (`AGENTS.md` §6), and
 * `pre-join.test.tsx` renders this component through `renderToStaticMarkup` — a
 * browser SDK evaluated at module scope would take that suite down with it. The
 * second is that the bundle for pre-join then contains no media SDK at all, which
 * is the same claim the negative probe in `tests/e2e/web/phong.spec.ts` makes
 * about the network: nothing on the media plane exists until somebody joins.
 */

/**
 * The three modes the group offers, in display order — `MEDIA_FACE_MODES` itself,
 * not a copy, so a fourth mode cannot arrive on one side of the graph only.
 *
 * `filter` is in the list and refused, and Story 2.7 did NOT change that: the ML
 * pipeline is a separate deliverable (`deferred-work.md`), so it is still rendered
 * as a disabled choice labelled "Sắp có" — now in the room as well as at pre-join.
 *
 * THREE places say no to it, and they are not redundant copies of one rule:
 * `faceModeAvailable` (pre-join's markup), `faceModeSelectable` (the room's markup
 * AND `changeFaceMode`, so a mode cannot reach `faceModeRef` through a second
 * caller), and `faceModeAllowsVideo` (the camera, so even a mode that somehow got
 * in cannot open a device). The first two are about what a person may press; the
 * last is the one that keeps an unfiltered face off the wire.
 */
export const FACE_MODES = MEDIA_FACE_MODES;

export type FaceMode = (typeof FACE_MODES)[number];

/**
 * "Để nguyên" is the default, not "Ẩn mặt", and that is a product decision rather
 * than a convenience: `EXPERIENCE.md` Flow 1 has the preview ON and only the person
 * seeing it, then the person CHOOSING to hide. The local preview exposes nothing —
 * no track leaves the machine in this story — and the warn-coloured sentence beside
 * the default is where the decision is made. Changing this is an "Ask First" item.
 */
export const DEFAULT_FACE_MODE: FaceMode = 'show';

/** Whether the microphone travels into the room, or the person only listens. */
export type AudioIntent = 'mic' | 'listen-only';

/**
 * What pre-join hands the room: the choice, and the admission that came back.
 *
 * `expiresAt` is the wire's `expires_at` — the instant BOTH the token and the
 * reserved seat lapse (`ROOM_TOKEN_TTL_SECONDS`). The effect below watches it and
 * goes back to pre-join rather than connecting into a refusal it cannot explain.
 */
export interface RoomDecision {
  readonly roomId: string;
  readonly faceMode: FaceMode;
  readonly audio: AudioIntent;
  readonly token: string;
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * `setTimeout`'s ceiling. A delay above it is truncated to 32 bits and fires
 * almost immediately, which for the expiry clock below would mean aborting a join
 * the moment it started — the exact opposite of what the timer is for. A far-future
 * `expires_at`, or a client clock running behind the server's, reaches it.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The key the self-preview `<video>` is registered under.
 *
 * An `@` prefix so it can never collide with a participant identity: identities
 * are uuidv7s off the token's `sub`, and a bare word like `self` is a key somebody
 * could one day mint.
 */
const SELF_PREVIEW_KEY = '@self';

/**
 * How many passes the video reconciler may take before it declares itself broken.
 * See the loop for what an unbounded version costs when a step stops advancing.
 */
const VIDEO_SYNC_MAX_PASSES = 64;

/**
 * One sentence per thing that can be wrong with a camera — a `Record`, so a fourth
 * {@link CameraProblem} would not compile until somebody wrote its sentence.
 */
const CAMERA_PROBLEM_KEYS: Readonly<Record<CameraProblem, MessageKey>> = {
  missing: 'room.errorCameraMissing',
  blocked: 'room.errorCameraDenied',
  busy: 'room.errorCameraBusy',
};

/**
 * Everything ONE run of the effect owns.
 *
 * Component-level refs looked like the obvious home for the room and the
 * microphone track and were wrong for a reason StrictMode makes routine: the
 * effect runs, is cleaned up and runs again on the same component, so two runs
 * share every ref. Mount #1's `getUserMedia` resolving late then stopped mount
 * #2's live track, and mount #1's cleanup nulled mount #2's room. `cancelled`
 * cannot help — it guards state writes, and these are writes to shared memory.
 *
 * So each run gets its own handle, and `runRef` holds the CURRENT one so that
 * `leave` (which is not inside the effect) can reach it. The handle is assigned
 * synchronously at the top of the effect, before the first `await`, which is what
 * makes "the button always acts on the run that is on screen" true.
 */
interface RunHandle {
  /** Torn down by React. Nothing may write state or hold a socket after this. */
  cancelled: boolean;
  /** "Rời phòng" was pressed. The run must stop where it is — see {@link RoomShell}. */
  aborted: boolean;
  room: Room | null;
  micTrack: MediaStreamTrack | null;
  micPublished: boolean;
  connected: boolean;
  /** The CAMERA track. It draws the canvas and never reaches `publishTrack`. */
  camTrack: MediaStreamTrack | null;
  /** Owns the canvas, the draw loop, and the only track that may be published. */
  pipeline: FramePipeline | null;
  camPublished: boolean;
  /** Kept so a hidden tab can mute the publication rather than freeze a frame. */
  videoPublication: LocalTrackPublication | null;
  /**
   * The tab is hidden and the picture should be PAUSED — the WANTED state, written
   * synchronously by the `visibilitychange` listener exactly as `faceModeRef` is
   * written by a press. {@link RunHandle.videoMuted} is the state actually reached,
   * and `stepVideo` is what closes the gap: two quick flips then settle in the
   * order they were made rather than in the order two fire-and-forget promises
   * happen to resolve.
   */
  videoPaused: boolean;
  videoMuted: boolean;
  /** Everything the video path holds, released synchronously. Shared with `leave`. */
  releaseVideo: () => void;
  /**
   * "Reconcile the video with what `faceModeRef` now says." The ONE entry point.
   *
   * Assigned a no-op synchronously at the top of the effect and replaced once the
   * run can act, so a press is never dropped for want of a callback: `syncVideo`
   * is LEVEL-triggered — it reads the wanted mode rather than an event — and the
   * run calls it unconditionally when it reaches the video stage. A press that
   * lands before then is therefore carried out, not swallowed.
   */
  wake: () => void;
  /** `syncVideo` is running. A second caller queues instead of interleaving. */
  videoSyncing: boolean;
  videoSyncQueued: boolean;
}

/**
 * Which video publications a participant is offering, in the shape
 * {@link videoKeyFor} decides over. Reading `.values()` twice — once for a key and
 * once for a boolean — is how two views of one fact drift apart.
 */
function videoPublicationsOf(participant: Participant): MediaVideoPublication[] {
  return [...participant.videoTrackPublications.values()].map((publication) => ({
    trackSid: publication.trackSid,
    subscribed: publication.isSubscribed,
    muted: publication.isMuted,
    hasTrack: publication.track !== undefined,
  }));
}

/** A remote participant, reduced to what the list needs. */
function remoteViewOf(participant: Participant): MediaParticipant {
  return {
    identity: participant.identity,
    name: participant.name,
    // Somebody who has published nothing, or has muted what they published, is
    // "Đang tắt micro" — one state with one sentence, however it was reached.
    micOn: [...participant.audioTrackPublications.values()].some((publication) => !publication.isMuted),
    // WHICH picture of theirs to draw, by `identity:trackSid`. The rule, and why
    // all three conditions are needed, live in `room-media.ts` where a DOM-less
    // test can execute them.
    videoKey: videoKeyFor(participant.identity, videoPublicationsOf(participant)),
  };
}

/**
 * The room, with media under it.
 *
 * Rendered from ONE state of the page above — `admitted` — and from nothing else.
 * That is the whole of "pre-join cannot be skipped": there is no route, query
 * parameter or reload that produces a `RoomDecision` without a `201` from the
 * token endpoint after a press of "Vào phòng", so there is no way to stand here
 * without having decided.
 */
export function RoomShell({ decision }: { readonly decision: RoomDecision }) {
  const [connection, setConnection] = useState<RoomConnectionState>('connecting');
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [micNoticeKey, setMicNoticeKey] = useState<MessageKey | null>(null);
  const [expired, setExpired] = useState(false);
  const [local, setLocal] = useState<MediaParticipant | null>(null);
  const [remotes, setRemotes] = useState<readonly MediaParticipant[]>([]);
  const [speakers, setSpeakers] = useState<readonly string[]>([]);

  /**
   * The browser refused to play the room's sound until somebody asks for it.
   *
   * Autoplay policy, and it is the failure this whole story exists to prevent
   * dressed as a success: the chip says "Đang ở trong phòng", everybody is listed,
   * and there is no sound and nothing on screen admitting it. The SDK reports it
   * through `AudioPlaybackStatusChanged`, and `room.startAudio()` inside a click is
   * the only thing that lifts it.
   */
  const [audioBlocked, setAudioBlocked] = useState(false);

  /**
   * The mode the screen SHOWS. `faceModeRef` below is the mode the run OBEYS, and
   * the two are written together — this one for React, that one for everything
   * asynchronous. `decision.faceMode` seeds both and is never read again.
   */
  const [faceMode, setFaceMode] = useState<FaceMode>(initialFaceModeFor(decision.faceMode));
  /** Camera answered `NotFoundError`: "Để nguyên" is disabled rather than failing. */
  const [cameraMissing, setCameraMissing] = useState(false);
  /** The canvas track is really published, which is what the preview may claim. */
  const [selfVideoOn, setSelfVideoOn] = useState(false);
  /** The camera's own bad news. Never fatal to the room, never to the sound. */
  const [videoNoticeKey, setVideoNoticeKey] = useState<MessageKey | null>(null);

  /** The run that is on screen. Assigned before the effect's first `await`. */
  const runRef = useRef<RunHandle | null>(null);
  /** Where every remote `<audio>` element the SDK builds is parked. */
  const audioHostRef = useRef<HTMLDivElement | null>(null);

  /**
   * **BẤT BIẾN 1.** The mode somebody wants, readable synchronously from anywhere.
   *
   * A `useRef` rather than state because every consumer is asynchronous and state
   * is a value captured at render: `decision.faceMode` is a snapshot of the moment
   * pre-join ended, and by the time `getUserMedia`, the pipeline and `connect`
   * have each resolved, the person may have pressed twice. It survives an effect
   * re-run on purpose, so the next run starts from the last press rather than from
   * the admission.
   */
  const faceModeRef = useRef<FaceMode>(initialFaceModeFor(decision.faceMode));

  /**
   * The `MediaStreamTrack` each `<video>` on the screen should be playing, by key.
   *
   * Keyed by `identity:trackSid` for everybody else (see {@link videoKeyFor}) and
   * by {@link SELF_PREVIEW_KEY} for the preview beside the mode group. It exists
   * because the element and the track never arrive in the same instant: a
   * subscription lands before React has rendered the row that will hold it, and a
   * track registered after the element mounted has to find it. Both directions go
   * through {@link showVideo}.
   */
  const videoTracksRef = useRef<Map<string, MediaStreamTrack>>(new Map());
  const videoElementsRef = useRef<Map<string, HTMLVideoElement>>(new Map());

  /** Put a stream on an element, muted: the room's SOUND comes from `audioHostRef`. */
  const playInto = (element: HTMLVideoElement, track: MediaStreamTrack): void => {
    element.srcObject = new MediaStream([track]);
    // Muted AND video-only, which is what makes this immune to the autoplay
    // policy the room's audio has to negotiate with — and what stops a subscribed
    // participant being heard twice, once here and once from the audio host.
    element.muted = true;
    void element.play().catch(() => undefined);
  };

  /**
   * ONE callback ref for every `<video>` on the screen, and it never changes.
   *
   * Two things had to be true at once and the first version got only one of them.
   * The identity must be STABLE — a fresh function per render makes React detach
   * and re-attach every tile on every keystroke of somebody's microphone level,
   * and the picture flickers for as long as the room lasts. And nothing may be
   * WRITTEN during render: the memoised-per-key version filled a `Map` from inside
   * the render pass, which is a side effect React is explicitly allowed to discard
   * or replay.
   *
   * So the key travels on the element itself (`data-video-key`, written by
   * `RoomPanel`), and the cleanup comes from React 19's ref-cleanup contract — the
   * function returned here runs when that exact element goes away, so a detach
   * knows which key it was without the ref having to be keyed at all.
   */
  const videoRef = useCallback((element: HTMLVideoElement): (() => void) => {
    const key = element.dataset['videoKey'] ?? '';
    videoElementsRef.current.set(key, element);
    const track = videoTracksRef.current.get(key);
    if (track !== undefined) {
      playInto(element, track);
    }
    return () => {
      // Only if this element is still the one filed under the key: a re-render
      // that swaps the element runs the new attach BEFORE the old cleanup, and an
      // unconditional delete would then drop the live element.
      if (videoElementsRef.current.get(key) === element) {
        videoElementsRef.current.delete(key);
      }
      element.srcObject = null;
    };
  }, []);

  /** Register a track for a key, and attach it now if the element is already up. */
  const showVideo = useCallback((key: string, track: MediaStreamTrack): void => {
    videoTracksRef.current.set(key, track);
    const element = videoElementsRef.current.get(key);
    if (element !== undefined) {
      playInto(element, track);
    }
  }, []);

  /** Forget a key's track, and leave no element playing a stream nobody owns. */
  const hideVideo = useCallback((key: string): void => {
    videoTracksRef.current.delete(key);
    const element = videoElementsRef.current.get(key);
    if (element !== undefined) {
      element.srcObject = null;
    }
  }, []);

  /**
   * Everything filed under one participant, forgotten.
   *
   * Keys carry the `trackSid`, so somebody who left holds as many entries as they
   * had publications and none of them can be named from outside. Without this the
   * two maps grow for the life of the session — a leak in a room people come and
   * go from all evening, which is the room this product is.
   */
  const forgetParticipant = useCallback((identity: string): void => {
    const prefix = `${identity}:`;
    for (const key of [...videoTracksRef.current.keys()]) {
      if (key.startsWith(prefix)) {
        hideVideo(key);
      }
    }
    for (const key of [...videoElementsRef.current.keys()]) {
      if (key.startsWith(prefix)) {
        videoElementsRef.current.delete(key);
      }
    }
  }, [hideVideo]);

  /**
   * Back to pre-join by RELOADING, which is the whole mechanism rather than a
   * shortcut.
   *
   * The decision lives in React state on the page above and nowhere else — no
   * storage, no cookie, no URL — so a reload IS the way back to the pre-join
   * screen, and `tests/e2e/web/phong.spec.ts` has asserted that property since
   * Story 2.3. Threading a callback down through `PreJoinPanel` would add a second
   * way to reach the same state, and the second way is the one that rots.
   */
  const backToPreJoin = useCallback(() => {
    window.location.reload();
  }, []);

  /**
   * "Rời phòng", and it has to work during `connecting` as well as after.
   *
   * The button is offered from the first frame — a person who pressed "Vào phòng"
   * by mistake must not have to wait for a handshake to finish before they can get
   * out. Setting `aborted` is what makes that real: the asynchronous run checks it
   * before it connects and before it publishes, so a press mid-handshake cannot be
   * followed a second later by a microphone going live behind a screen that says
   * "Đã rời phòng".
   */
  const leave = useCallback(() => {
    const handle = runRef.current;
    setConnection('disconnected');
    setMicNoticeKey(null);
    setAudioBlocked(false);
    if (handle === null) {
      return;
    }
    handle.aborted = true;
    handle.micPublished = false;
    handle.micTrack?.stop();
    handle.micTrack = null;
    /**
     * The camera half — through the run's OWN release rather than a second copy.
     *
     * There were two, and they had already diverged: this one forgot the local
     * identity's entry in `videoTracksRef`. Two teardowns that must stay identical
     * are one teardown and a bug waiting for the next field. `leave` does NOT
     * unmount, so the effect's cleanup never runs here — which is why the camera
     * light depends on this call and not on React.
     */
    handle.releaseVideo();
    setVideoNoticeKey(null);
    void handle.room?.disconnect();
  }, []);

  /**
   * The mode group, pressed. The ONLY thing in the product that changes the mode.
   *
   * Three lines in a fixed order, and the order is the invariant: the ref FIRST,
   * synchronously, so every asynchronous reader already sees the new answer before
   * React has re-rendered anything; then the screen; then a nudge to the run. The
   * nudge is allowed to reach nothing — `syncVideo` reads `faceModeRef` rather
   * than a queue of events, and the run calls it when it is ready — so a press
   * during `connecting` is carried out rather than lost.
   */
  const changeFaceMode = useCallback((mode: FaceMode): void => {
    /**
     * Refused HERE, not only by the disabled radio.
     *
     * `faceModeRef` is the one source of truth for the whole video machine, so a
     * mode that gets into it is a mode the machine acts on. A defence that lives
     * in a `disabled` attribute is one that Story 2.6's popover, a keyboard path
     * or a test walks straight past.
     */
    if (!faceModeSelectable(mode)) {
      return;
    }
    faceModeRef.current = mode;
    setFaceMode(mode);
    // A deliberate new choice clears the explanation the previous one produced.
    // `giveUpVideo` inside the run sets both the mode and its sentence together,
    // so it is never this line that wipes its own reason.
    setVideoNoticeKey(null);
    runRef.current?.wake();
  }, []);

  /** The gesture the autoplay policy is waiting for. */
  const enableAudio = useCallback(() => {
    const room = runRef.current?.room;
    if (room === null || room === undefined) {
      return;
    }
    void room
      .startAudio()
      .then(() => {
        setAudioBlocked(!room.canPlaybackAudio);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    /**
     * This run's own state. See {@link RunHandle} for why none of it is a
     * component ref, and why the assignment below happens before any `await`.
     */
    const handle: RunHandle = {
      cancelled: false,
      aborted: false,
      room: null,
      micTrack: null,
      micPublished: false,
      connected: false,
      camTrack: null,
      pipeline: null,
      camPublished: false,
      videoPublication: null,
      // Seeded from the CURRENT visibility rather than from `false`: a room joined
      // in a background tab must not start by publishing a drawing loop nobody is
      // looking at, and `false` here would have said it should.
      videoPaused: document.visibilityState === 'hidden',
      videoMuted: false,
      releaseVideo: () => undefined,
      // Replaced once the run can act on a press. See {@link RunHandle.wake} for
      // why a press that lands before then is still carried out.
      wake: () => undefined,
      videoSyncing: false,
      videoSyncQueued: false,
    };
    runRef.current = handle;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    const stopMic = (): void => {
      handle.micPublished = false;
      handle.micTrack?.stop();
      handle.micTrack = null;
    };

    /**
     * The camera, ENDED — not muted, not left holding a black frame.
     *
     * "Ẩn mặt là vắng mặt, không phải im lặng": the light on the device is the
     * only part of this promise a person can check without trusting us, so the
     * track is stopped rather than disabled.
     */
    const stopCam = (): void => {
      handle.camTrack?.stop();
      handle.camTrack = null;
    };

    /** The key the LOCAL picture is filed under in the row list, while published. */
    const localVideoKey = (): string | null => {
      const identity = handle.room?.localParticipant.identity;
      const sid = handle.videoPublication?.trackSid;
      return identity === undefined || sid === undefined ? null : `${identity}:${sid}`;
    };

    /**
     * The preview follows the PUBLICATION, both halves of it.
     *
     * `camPublished` alone was the first version, and it went false-by-omission on
     * the hidden-tab path: the far side correctly showed letters while the local
     * box went on rendering a picture under "Đây là hình mọi người đang thấy." That
     * sentence is offered throughout this change as EVIDENCE rather than
     * reassurance, so it has to be false whenever the room is not receiving one.
     */
    const showSelfPreview = (): void => {
      if (!handle.cancelled) {
        setSelfVideoOn(handle.camPublished && !handle.videoPaused);
      }
    };

    /**
     * Stop CAPTURING — synchronously, and this is the half a person can verify.
     *
     * The camera track ends and the draw loop stops, so the light on the device
     * goes out in the same frame as the press. The canvas track is deliberately
     * left ALIVE: `unpublishTrack` is next, and unpublishing a track that has
     * already been stopped is how the previous version asked the SDK to find
     * something that was no longer there.
     */
    const stopCapture = (): void => {
      handle.camPublished = false;
      handle.pipeline?.pause();
      stopCam();
      hideVideo(SELF_PREVIEW_KEY);
      const key = localVideoKey();
      if (key !== null) {
        hideVideo(key);
      }
      showSelfPreview();
    };

    /**
     * Everything the video path holds, released — synchronously, in one place.
     *
     * It does NOT unpublish: `disableVideo` does, because unpublishing is an
     * `await` that travels to the server while every caller of this function is on
     * a path where the local machine has to be clean IMMEDIATELY (teardown, abort,
     * a mode that changed under an `await`). Assigned onto the handle so that
     * `leave` — which does not unmount, so never reaches this effect's cleanup —
     * runs the same routine rather than a second copy of it.
     */
    const releaseVideo = (): void => {
      stopCapture();
      handle.videoPublication = null;
      handle.videoMuted = false;
      handle.pipeline?.stop();
      handle.pipeline = null;
    };
    handle.releaseVideo = releaseVideo;

    /**
     * The tab went away, or came back — **người dùng chốt 2026-09-14**.
     *
     * A hidden tab throttles timers and stops `requestAnimationFrame`, so a canvas
     * left alone keeps publishing whatever frame it last drew: everybody else sees
     * a photograph of somebody who is not there, which reads as presence and is
     * worse than an avatar. The FACE MODE is not touched, so coming back resumes on
     * its own and no system event has moved anybody to "Để nguyên".
     *
     * This listener only records the WANT, exactly as a press on the mode group
     * only records a want. Two quick flips used to settle in whichever order two
     * fire-and-forget promises happened to resolve, with nothing to correct an
     * inverted result; now `stepVideo` reconciles it like everything else
     * asynchronous in this file.
     *
     * Registered from the first frame even though nothing is published yet: it
     * costs nothing and closes the window where a tab hidden mid-publish is never
     * noticed.
     */
    const applyVisibility = (): void => {
      handle.videoPaused = document.visibilityState === 'hidden';
      /**
       * The LOCAL guarantee, taken immediately and unconditionally.
       *
       * {@link FramePipeline.pause} stops the draw loop AND disables the canvas
       * track, so no real frame can leave the machine even if the `mute()` below
       * never reaches the server. `mute()` is what turns the far tile into the
       * letters; this is what makes the picture stop.
       */
      if (handle.videoPaused) {
        handle.pipeline?.pause();
      }
      handle.wake();
    };
    document.addEventListener('visibilitychange', applyVisibility);

    /**
     * Video could not happen, and the person is told why — in the ONE direction
     * that is safe.
     *
     * Writing `hide` into `faceModeRef` is what makes the reconciler below
     * terminate: `wanted` becomes `false`, the next pass settles, and nothing
     * retries a device the browser has just refused. It is also the only direction
     * `epic-2-context.md` permits a system event to move somebody — never back to
     * "Để nguyên", which is a press and nothing else.
     */
    const giveUpVideo = (key: MessageKey): void => {
      faceModeRef.current = 'hide';
      releaseVideo();
      if (handle.cancelled) {
        return;
      }
      setFaceMode('hide');
      setVideoNoticeKey(key);
    };

    /** Nothing on the media plane is left running, whatever ended this run. */
    const giveUp = (key: MessageKey | null): void => {
      stopMic();
      releaseVideo();
      if (handle.cancelled) {
        return;
      }
      /**
       * Somebody who pressed "Rời phòng" is not told the join failed.
       *
       * `aborted` was checked before `connect` and after it, but NOT on the path
       * between the two: a press during the handshake set the screen to "đã rời
       * phòng", the abandoned `connect` then rejected some seconds later, and this
       * function painted "Không vào được phòng." over it. Measured as an
       * intermittent failure of the mid-handshake spec — intermittent because it
       * depends on WHEN the refusal lands, which is the shape of a real defect
       * rather than of a flaky test. `leave` has already said what happened; there
       * is nothing here to add.
       */
      if (handle.aborted) {
        return;
      }
      if (key !== null) {
        setErrorKey(key);
      }
      setConnection('disconnected');
    };

    const run = async (): Promise<void> => {
      // The token and the seat lapse together. Sitting on pre-join past the TTL
      // and then pressing nothing is the ordinary way to arrive here already
      // expired, so it is checked BEFORE a socket is opened rather than after.
      if (tokenExpiredAt(decision.expiresAt, Date.now())) {
        setExpired(true);
        return;
      }

      /**
       * See the file docblock: the SDK is loaded here and never at module scope.
       *
       * The `catch` is not defensive padding. This is a network fetch of a lazy
       * chunk, and it fails for ordinary reasons — offline, a deploy that moved
       * the file out from under an open tab. Unhandled, the screen sits on
       * "Đang vào phòng…" for ever with an unhandled rejection in the console,
       * which is the worst of the failure modes this story has: no sound, no
       * sentence, no way out.
       */
      let livekit: typeof import('livekit-client');
      try {
        livekit = await import('livekit-client');
      } catch {
        giveUp('room.errorConnect');
        return;
      }
      if (handle.cancelled || handle.aborted) {
        stopMic();
        return;
      }

      /**
       * The microphone, asked for again and ONLY on the `mic` branch.
       *
       * A refusal here is not a refusal to enter: the person still hears the room,
       * and the sentence says which half is missing. `listen-only` never reaches
       * this line, which is what makes "getUserMedia is not called once" a
       * property of the code rather than of a flag.
       */
      if (decision.audio === 'mic') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const track = stream.getAudioTracks()[0] ?? null;
          if (track === null) {
            // A stream with no audio track in it. Rare, and silently treating it
            // as listen-only would leave the stream open and the row lying: the
            // screen would say the microphone is on with nothing to publish.
            stream.getTracks().forEach((each) => {
              each.stop();
            });
            setMicNoticeKey('room.errorMicDenied');
          } else {
            handle.micTrack = track;
          }
        } catch {
          setMicNoticeKey('room.errorMicDenied');
        }
      }
      if (handle.cancelled || handle.aborted) {
        stopMic();
        return;
      }

      const options: RoomOptions = roomOptionsFor(decision);
      const room = new livekit.Room(options);
      handle.room = room;

      const refresh = (): void => {
        if (handle.cancelled) {
          return;
        }
        setLocal({
          identity: room.localParticipant.identity,
          name: room.localParticipant.name,
          micOn: handle.micPublished,
          /**
           * Read off this run's own state rather than off the SDK's publications:
           * the canvas track is ours, and `camPublished` together with the tab's
           * state is the single fact that "a picture of me is on the wire" — the
           * same fact the preview beside the mode group claims.
           */
          videoKey: handle.camPublished && !handle.videoPaused ? localVideoKey() : null,
        });
        setRemotes([...room.remoteParticipants.values()].map(remoteViewOf));
        setSpeakers(room.activeSpeakers.map((participant) => participant.identity));
      };

      room
        .on(livekit.RoomEvent.ParticipantConnected, refresh)
        .on(livekit.RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          // Their tracks and their elements, forgotten. Keys carry a `trackSid`,
          // so nothing outside this handler can name them afterwards and both maps
          // would grow for the life of a session people come and go from.
          forgetParticipant(participant.identity);
          refresh();
        })
        .on(livekit.RoomEvent.TrackMuted, refresh)
        .on(livekit.RoomEvent.TrackUnmuted, refresh)
        .on(livekit.RoomEvent.ActiveSpeakersChanged, refresh)
        .on(livekit.RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          /**
           * `attach()` builds an `<audio autoplay playsinline>` already wired to
           * the track and hands it back; parking it in a hidden host is all this
           * screen has to do to make the room audible. Story 2.6 owns the
           * per-person controls that will need these elements by name.
           *
           * With no host to park it in — a subscription arriving during teardown,
           * before the ref is attached — the element would be an orphan: playing
           * nowhere, detached by nothing, and that participant silent for the rest
           * of the session. Detaching is the honest answer to "there is nowhere to
           * put this".
           */
          if (track.kind === livekit.Track.Kind.Audio) {
            const host = audioHostRef.current;
            if (host === null) {
              track.detach().forEach((element) => {
                element.remove();
              });
            } else {
              host.appendChild(track.attach());
            }
          }
          /**
           * Video takes the opposite route, and deliberately: the SDK is NOT asked
           * to build an element. `RoomPanel` owns the tile, so the track is parked
           * under the participant's identity and the row's callback ref picks it
           * up when `videoOn` makes the `<video>` appear — which is the next
           * render, because `refresh()` below is what turns `videoOn` true. An
           * element the SDK built would be one this screen has no place to put,
           * and Story 2.6's grid would then have two ideas of where a face lives.
           */
          if (track.kind === livekit.Track.Kind.Video) {
            // `identity:trackSid`, the key `videoKeyFor` builds. By identity alone
            // a second publication overwrote the first and one unsubscribe blanked
            // a tile whose other track was still live.
            showVideo(`${participant.identity}:${_publication.trackSid}`, track.mediaStreamTrack);
          }
          refresh();
        })
        .on(livekit.RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          track.detach().forEach((element) => {
            element.remove();
          });
          if (track.kind === livekit.Track.Kind.Video) {
            // Otherwise the row keeps a `<video>` holding a stream nobody feeds —
            // the orphan the audio branch above has always refused. By `trackSid`,
            // so ONLY the track that went away is forgotten.
            hideVideo(`${participant.identity}:${_publication.trackSid}`);
          }
          refresh();
        })
        .on(livekit.RoomEvent.AudioPlaybackStatusChanged, () => {
          if (handle.cancelled) {
            return;
          }
          setAudioBlocked(!room.canPlaybackAudio);
        })
        .on(livekit.RoomEvent.ConnectionStateChanged, (state: string) => {
          if (handle.cancelled) {
            return;
          }
          const next = roomConnectionStateFor(String(state));
          if (next === 'connected') {
            handle.connected = true;
            // The room is up: a video step that parked on `waiting` can finish.
            // Idempotent — `stepVideo` settles at once if there is nothing to do.
            handle.wake();
          }
          setConnection(next);
          refresh();
        })
        .on(livekit.RoomEvent.Disconnected, (reason?: number) => {
          if (handle.cancelled) {
            return;
          }
          stopMic();
          // Terminal, not a reconnect: `Reconnecting` is a different event. Nothing
          // may hold a camera open behind a screen that says the room has ended.
          releaseVideo();
          const key = disconnectReasonKeyFor(reason);
          if (key !== null) {
            setErrorKey(key);
          }
          setConnection('disconnected');
        });

      /* ------------------------------------------------------------- video -- */

      /**
       * The options the CANVAS track is published with.
       *
       * `source` is spelled twice on purpose: `videoPublishOptions()` states it as
       * the raw wire value so a unit test can read the decision back without
       * dragging the browser SDK into `room-media.ts`, and the enum below is what
       * makes it typecheck. They are the same string at runtime.
       */
      const publishOptions: TrackPublishOptions = {
        ...videoPublishOptions(),
        source: livekit.Track.Source.Camera,
      };

      /**
       * Whether the room is UP right now, read from the SDK rather than from a
       * flag we set once. `handle.connected` stays true after a disconnection, so
       * a publish failure during a reconnect looked identical to a refusal.
       */
      const roomIsUp = (): boolean => isLiveConnection(roomConnectionStateFor(String(room.state)));


      /**
       * Take the picture off the wire — the ROBUST form, and never silently.
       *
       * `publication.track` is the SDK's own `LocalVideoTrack`, which is what
       * `unpublishTrack` is built to look up; the raw `MediaStreamTrack` is the
       * fallback for the window before a publication exists. The previous version
       * kept only the raw track, nulled the publication first, and swallowed every
       * failure — so a publication left standing on the server was invisible here
       * and unexplained on screen.
       */
      const unpublishVideo = async (
        publication: LocalTrackPublication | null,
        fallback: MediaStreamTrack | null,
      ): Promise<void> => {
        const target = publication?.track ?? fallback;
        if (target === null || target === undefined) {
          return;
        }
        try {
          await room.localParticipant.unpublishTrack(target, true);
        } catch {
          // The canvas track is stopped either way, so nobody keeps receiving a
          // picture — but a publication we failed to retract is not something to
          // stay quiet about, and leaving the room is the one cure a person has.
          if (!handle.cancelled && !handle.aborted && roomIsUp()) {
            setVideoNoticeKey('room.errorVideoStop');
          }
        }
      };

      /**
       * Ask for the camera — and this is the ONLY `getUserMedia` with `video` in
       * the whole shell, reached only when {@link faceModeAllowsVideo} says yes.
       * That is what makes "Ẩn mặt never asks for a camera" a property of the code
       * rather than of a flag somebody could flip.
       */
      const openCamera = async (): Promise<void> => {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        } catch (error) {
          const name = error instanceof Error ? error.name : 'UnknownError';
          /**
           * Three different things, three different sentences — and the third is
           * why this goes through `room-media.ts` rather than a comparison here.
           * A camera held by another application answers `NotReadableError`, which
           * the inline version called a refusal: it told somebody to go and change
           * a permission that was already correct. The classification is shared
           * with `pre-join.tsx`, which had the only complete list.
           */
          const problem = cameraProblemFor(name);
          if (problem === 'missing' && !handle.cancelled) {
            setCameraMissing(true);
          }
          giveUpVideo(CAMERA_PROBLEM_KEYS[problem]);
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        if (track === null) {
          // A stream with no video track in it. Leaving it open would hold a
          // device for a picture that can never be drawn.
          stream.getTracks().forEach((each) => {
            each.stop();
          });
          giveUpVideo('room.errorCameraMissing');
          return;
        }
        /**
         * **BẤT BIẾN 1, at the first assignment.** Read AFTER the `await` and
         * BEFORE `handle.camTrack` is written: a press of "Ẩn mặt" while the
         * browser was still asking means this camera must not be kept, and Story
         * 2.3 paid for exactly this lesson ("camera về muộn sau khi đã bấm Ẩn mặt
         * lại → dừng ngay khi tới").
         */
        if (handle.cancelled || handle.aborted || !faceModeAllowsVideo(faceModeRef.current)) {
          stream.getTracks().forEach((each) => {
            each.stop();
          });
          return;
        }
        handle.camTrack = track;

        /**
         * The camera taken away from under us — unplugged, claimed, revoked.
         *
         * `deferred-work.md` carried this from Story 2.3, where it only froze a
         * preview. With a canvas drawing from it, a dead camera is a frozen frame
         * on other people's screens under a row that says the picture is live. The
         * answer is Ẩn mặt and a sentence — never a second prompt nobody opened,
         * and never a way back to "Để nguyên" that the person did not press.
         */
        track.addEventListener('ended', () => {
          if (handle.cancelled) {
            return;
          }
          const publication = handle.videoPublication;
          const canvasTrack = handle.camPublished ? (handle.pipeline?.track ?? null) : null;
          giveUpVideo('room.errorCameraEnded');
          void unpublishVideo(publication, canvasTrack).catch(() => undefined);
          refresh();
        });
      };

      /**
       * Build the canvas pipeline over the camera we hold, and wait for a frame.
       *
       * `whenReady` is bounded (BẤT BIẾN 2). The failure it exists for is a camera
       * that hands over a track and then never produces a frame: unbounded, that
       * is somebody who cannot hear the room either, because this runs on the same
       * path as everything else.
       */
      const buildPipeline = async (): Promise<void> => {
        const camera = handle.camTrack;
        if (camera === null) {
          return;
        }
        let pipeline: FramePipeline;
        const size = pipelineSizeFor(camera.getSettings());
        try {
          // Synchronous, so nothing can interleave between the mode read that got
          // us here and this assignment.
          pipeline = createFramePipeline({
            source: camera,
            width: size.width,
            height: size.height,
            fps: PIPELINE_FPS,
          });
        } catch {
          giveUpVideo('room.errorVideoPipeline');
          return;
        }
        handle.pipeline = pipeline;
        const ready = await pipeline.whenReady(PIPELINE_READY_TIMEOUT_MS);
        if (handle.cancelled || handle.aborted || !faceModeAllowsVideo(faceModeRef.current)) {
          releaseVideo();
          return;
        }
        if (!ready) {
          giveUpVideo('room.errorVideoPipeline');
          return;
        }
        // A tab hidden while the pipeline was coming up must not start drawing.
        if (handle.videoPaused) {
          pipeline.pause();
        }
      };

      /**
       * Publish — and the argument is `pipeline.track`, which is the whole story.
       *
       * `handle.camTrack` appears nowhere in this function and must never appear
       * here. AD-30 rule (b): the window a processor-after-publish design leaves
       * open is closed by there being no branch on which the camera's own track is
       * an argument to `publishTrack`. `RTCRtpSender.track.id` is where a reviewer
       * checks that claim rather than taking it.
       */
      const publishVideo = async (): Promise<'again' | 'waiting'> => {
        const pipeline = handle.pipeline;
        if (pipeline === null) {
          return 'again';
        }
        let publication: LocalTrackPublication;
        try {
          publication = await room.localParticipant.publishTrack(pipeline.track, publishOptions);
        } catch {
          /**
           * A REFUSAL and a room that went away mid-attempt are different events,
           * and treating both as final made a transient reconnect a permanent
           * "Ẩn mặt" — the system reversing a decision the person never touched,
           * which is the one thing `epic-2-context.md` forbids outright. So the
           * room's own state decides: up means refused (the grant is missing
           * `camera`, or the server said no), down means not yet, and the pipeline
           * survives until the reconnect's `wake()` tries again.
           */
          if (!roomIsUp()) {
            return 'waiting';
          }
          giveUpVideo('room.errorVideoRefused');
          return 'again';
        }
        /**
         * **BẤT BIẾN 1, at the last assignment.** A press of "Ẩn mặt" while the
         * publish was in flight is the exact state review round 1 reproduced: the
         * radio said hidden and the face went out anyway. Read again, and if the
         * answer changed, take it straight back off the wire.
         */
        if (handle.cancelled || handle.aborted || !faceModeAllowsVideo(faceModeRef.current)) {
          const canvasTrack = pipeline.track;
          releaseVideo();
          await unpublishVideo(publication, canvasTrack);
          return 'again';
        }
        handle.camPublished = true;
        handle.videoPublication = publication;
        handle.videoMuted = false;
        // Only NOW may the preview claim to be what everybody sees.
        showVideo(SELF_PREVIEW_KEY, pipeline.track);
        const key = localVideoKey();
        if (key !== null) {
          showVideo(key, pipeline.track);
        }
        showSelfPreview();
        refresh();
        // `again`, so the very next pass applies a pause that arrived while this
        // publish was in flight rather than leaving a hidden tab publishing.
        return 'again';
      };

      /**
       * Bring the muted state of the publication up to what the tab is doing.
       *
       * The ordering problem this solves: two quick flips used to fire two
       * unordered promises, so they could settle inverted with nothing left to
       * correct them. Reconciled, the last flip wins because the last flip is what
       * `handle.videoPaused` says.
       */
      const stepPause = async (): Promise<'again' | 'settled'> => {
        const wanted = handle.videoPaused;
        const publication = handle.videoPublication;
        if (publication === null) {
          handle.videoMuted = wanted;
          return 'again';
        }
        // The local guarantee first, and it cannot fail: the draw loop stops and
        // the canvas track is disabled, so no real frame leaves whatever the
        // signalling below does.
        if (wanted) {
          handle.pipeline?.pause();
        }
        try {
          await (wanted ? publication.mute() : publication.unmute());
        } catch {
          /**
           * `mute()` is what turns the far tile into the letters, and it failed.
           * Frames have already stopped, so nobody is looking at a photograph of
           * somebody who left — but they are looking at a still picture with no
           * explanation, and a swallowed failure is precisely the "a still frame
           * nobody knows is still" this decision exists to prevent. Say so, and
           * leave `videoMuted` where it is so the next flip tries again.
           */
          if (!handle.cancelled) {
            setVideoNoticeKey('room.errorVideoPause');
          }
          return 'settled';
        }
        handle.videoMuted = wanted;
        if (!wanted) {
          handle.pipeline?.resume();
        }
        if (!handle.cancelled) {
          // A flip that worked clears the explanation an earlier one left, and
          // only that one: a camera sentence beside it is somebody else's news.
          setVideoNoticeKey((current) => (current === 'room.errorVideoPause' ? null : current));
        }
        // The preview follows the PUBLICATION, so a paused picture stops claiming
        // to be what everybody sees while the far side is looking at letters.
        showSelfPreview();
        refresh();
        return 'again';
      };

      /** Ẩn mặt: off the wire, loop stopped, camera ended, tile back to letters. */
      const disableVideo = async (): Promise<void> => {
        const publication = handle.videoPublication;
        const pipeline = handle.pipeline;
        const wasPublished = handle.camPublished;
        /**
         * Capture stops SYNCHRONOUSLY — the camera light goes out in the same
         * frame as the press — while the canvas track stays alive just long enough
         * for `unpublishTrack` to have something to find. Stopping it first is how
         * the previous version asked the SDK to retract a track that no longer
         * existed.
         */
        stopCapture();
        handle.videoPublication = null;
        refresh();
        if (wasPublished) {
          await unpublishVideo(publication, pipeline?.track ?? null);
        }
        pipeline?.stop();
        if (handle.pipeline === pipeline) {
          handle.pipeline = null;
        }
        handle.videoMuted = false;
        refresh();
      };

      /**
       * One step towards the mode `faceModeRef` now names, and what to do next.
       *
       * `waiting` is the answer while the room is not up yet: the camera and the
       * pipeline are allowed to be ready before `connect()` resolves — that is how
       * video stays off the critical path — but a publish needs a connection, so
       * the step parks and the post-connect `wake()` resumes it.
       */
      const stepVideo = async (): Promise<'settled' | 'again' | 'waiting'> => {
        if (handle.cancelled || handle.aborted) {
          releaseVideo();
          return 'settled';
        }
        if (!faceModeAllowsVideo(faceModeRef.current)) {
          if (!handle.camPublished && handle.camTrack === null && handle.pipeline === null) {
            return 'settled';
          }
          await disableVideo();
          return 'again';
        }
        if (handle.camPublished) {
          // Published, so the only thing left that can be out of step is whether
          // the tab is showing.
          return handle.videoPaused === handle.videoMuted ? 'settled' : await stepPause();
        }
        if (handle.camTrack === null) {
          await openCamera();
          return 'again';
        }
        if (handle.pipeline === null) {
          await buildPipeline();
          return 'again';
        }
        if (!roomIsUp()) {
          return 'waiting';
        }
        return await publishVideo();
      };

      /**
       * **The reconciler — the one place the video invariant is stated.**
       *
       * It is LEVEL-triggered: it reads the state somebody wants — the face mode
       * they last pressed, and whether their tab is showing — and walks towards
       * it, instead of reacting to an event. That is what makes a press or a tab
       * flip landing in any asynchronous window correct by construction rather
       * than by a guard copied after every `await`, which is how
       * `client-address.ts` died over three rounds (`AGENTS.md`).
       *
       * It terminates. Each `again` either advances the local state machine one
       * rung (no camera → camera → pipeline → published → muted as the tab says)
       * or gives up, and giving up writes `hide` into `faceModeRef`, which settles
       * the next pass. Only a press or a tab flip can raise the target again, and
       * both are bounded by a person.
       */
      const syncVideo = async (): Promise<void> => {
        if (handle.videoSyncing) {
          // Somebody pressed while a step was in flight. Queue rather than
          // interleave — two runs would fight over `handle.camTrack`.
          handle.videoSyncQueued = true;
          return;
        }
        handle.videoSyncing = true;
        try {
          /**
           * BOUNDED, even though the argument above says it terminates.
           *
           * The argument is right and it is also an assumption about every branch
           * of `stepVideo`, which is exactly the kind of assumption that stops
           * being true under an edit. Measured, by breaking one on purpose: a step
           * that returns `again` without advancing spins, every pass calls
           * `refresh()` twice, and React's concurrent-update queue grows until the
           * browser throws `RangeError: Invalid array length` out of its own
           * scheduler — the whole page dies, with no sentence and no camera
           * teardown. The bound turns that into the same safe failure as every
           * other one here: hidden, camera off, and a sentence.
           *
           * It is generous. A real reconcile is at most four passes (camera,
           * pipeline, publish, mute), and a person flipping the mode adds a few
           * more; nothing legitimate comes near this.
           */
          for (let pass = 0; pass < VIDEO_SYNC_MAX_PASSES; pass += 1) {
            let step: 'settled' | 'again' | 'waiting';
            try {
              step = await stepVideo();
            } catch {
              /**
               * Nothing above is meant to throw — every failure it knows about is
               * a branch. An unexpected one used to become an unhandled rejection
               * that abandoned the loop mid-state, leaving the camera LIVE, the
               * machine wedged, and nothing on screen. Fail the way every known
               * failure here fails: camera off, hidden, and a sentence.
               */
              giveUpVideo('room.errorVideoPipeline');
              return;
            }
            if (step !== 'again') {
              return;
            }
          }
          giveUpVideo('room.errorVideoPipeline');
        } finally {
          handle.videoSyncing = false;
          if (handle.videoSyncQueued) {
            handle.videoSyncQueued = false;
            void syncVideo().catch(() => undefined);
          }
        }
      };

      handle.wake = (): void => {
        // `catch` on every entry point: an unhandled rejection here is a state
        // machine that stops with a camera open and no way to say so.
        void syncVideo().catch(() => undefined);
      };
      /**
       * Started here, BEFORE `connect`, and deliberately not awaited: BẤT BIẾN 2.
       * The camera and the pipeline come up alongside the handshake, and the
       * publish step parks until the room is really there.
       */
      handle.wake();

      /**
       * The clock on the admission.
       *
       * It only ever fires against a handshake that has not finished: the token
       * buys the way in, not the session, so a room that is already up is left
       * alone. What it prevents is the silent case — a slow network, a token that
       * lapsed mid-handshake, and a screen that would otherwise sit on "Đang vào
       * phòng…" until LiveKit refused for a reason nobody could read.
       *
       * Two things the first version got wrong. A delay past
       * {@link MAX_TIMEOUT_MS} wraps to 32 bits and fires at once, so a far-future
       * `expires_at` (or a client clock behind the server's) aborted the join
       * instantly; past the ceiling there is nothing worth arming, so no timer is
       * set. And `handle.connected` is set by an EVENT, which can arrive after
       * `connect()` has already resolved — so the room's own state is consulted
       * too, and a room that is up is never torn down by this.
       */
      const remaining = Date.parse(decision.expiresAt) - Date.now();
      if (Number.isFinite(remaining) && remaining <= MAX_TIMEOUT_MS) {
        expiryTimer = setTimeout(
          () => {
            const up = isLiveConnection(roomConnectionStateFor(String(room.state)));
            if (handle.cancelled || handle.aborted || handle.connected || up) {
              return;
            }
            setExpired(true);
            stopMic();
            void room.disconnect();
          },
          Math.max(remaining, 0),
        );
      }

      // "Rời phòng" pressed while the SDK was loading or the device was opening.
      // `leave` has already set the screen; this is the half that stops the run.
      if (handle.aborted) {
        stopMic();
        return;
      }

      try {
        await room.connect(decision.url, decision.token);
      } catch {
        giveUp('room.errorConnect');
        return;
      }
      if (handle.cancelled) {
        return;
      }
      if (handle.aborted) {
        // Pressed during the handshake. The room is up and nobody wants it: no
        // track is published, and the connection is closed rather than left open
        // behind a screen that says the person has left.
        stopMic();
        void room.disconnect();
        return;
      }

      const track = handle.micTrack;
      if (track !== null) {
        const publishOptions: TrackPublishOptions = {
          ...audioPublishOptions(),
          source: livekit.Track.Source.Microphone,
        };
        try {
          await room.localParticipant.publishTrack(track, publishOptions);
          handle.micPublished = true;
        } catch {
          // The room is fine and the microphone did not get into it. Saying so is
          // the whole of the fix: the alternative was a rejection that skipped the
          // final `refresh()` and left an empty list under a connected chip.
          stopMic();
          if (!handle.cancelled) {
            setMicNoticeKey('room.errorMicDenied');
          }
        }
        /**
         * The device being taken away from under us — unplugged, claimed by
         * another app, revoked by the OS. `deferred-work.md` carried this from
         * Story 2.3, where it only froze a preview; with a track on the wire it is
         * a person whose microphone stopped and whose screen still says it is on.
         * Nothing asks for it again: the answer is a sentence and a decision the
         * person makes, not a prompt they did not open.
         */
        if (handle.micPublished) {
          track.addEventListener('ended', () => {
            if (handle.cancelled) {
              return;
            }
            handle.micPublished = false;
            void room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
            setMicNoticeKey('room.errorMicEnded');
            refresh();
          });
        }
      }
      if (!handle.cancelled) {
        setAudioBlocked(!room.canPlaybackAudio);
      }
      /**
       * And now the video, which has been coming up alongside all of the above.
       *
       * Audio is published FIRST and video second, in the order the epic ranks
       * them. This call is what turns a step that parked on `waiting` into a
       * publish, and it reads `faceModeRef` — so somebody who changed their mind
       * during the handshake gets what they last pressed, not what they chose on
       * pre-join.
       */
      handle.wake();
      refresh();
    };

    void run();

    return () => {
      handle.cancelled = true;
      if (expiryTimer !== null) {
        clearTimeout(expiryTimer);
      }
      stopMic();
      // The draw loop, the canvas track and the camera, all ended — leaving the
      // page, unmounting and leaving the room are one routine, not three.
      releaseVideo();
      document.removeEventListener('visibilitychange', applyVisibility);
      videoTracksRef.current.clear();
      audioHostRef.current?.replaceChildren();
      handle.room?.removeAllListeners();
      void handle.room?.disconnect();
      // Only if this run is still the current one: under StrictMode the NEXT
      // effect has already installed its handle by the time some teardowns run,
      // and nulling it here would take the live room away from the live screen.
      if (runRef.current === handle) {
        runRef.current = null;
      }
    };
  }, [decision]);

  const phase = joinPhaseFor(connection, errorKey, expired);
  const rows = participantRowsFor(local, remotes, speakers);

  return (
    <>
      <RoomPanel
        decision={decision}
        phase={phase}
        rows={rows}
        faceMode={faceMode}
        showAvailable={!cameraMissing}
        selfVideoOn={selfVideoOn}
        selfVideoKey={SELF_PREVIEW_KEY}
        videoRef={videoRef}
        errorKey={phase === 'expired' ? 'room.errorExpired' : errorKey}
        micNoticeKey={micNoticeKey}
        videoNoticeKey={videoNoticeKey}
        audioBlocked={audioBlocked}
        onLeave={leave}
        onEnableAudio={enableAudio}
        onBackToPreJoin={backToPreJoin}
        onChangeFaceMode={changeFaceMode}
      />
      {/*
        Where the SDK's `<audio>` elements live. `aria-hidden`, because they are
        the room's sound and not a control: the participant list is what a screen
        reader is meant to read, and an unlabelled media element per person would
        be a second, wordless copy of it.
      */}
      <div ref={audioHostRef} className="sr" aria-hidden="true" />
    </>
  );
}
