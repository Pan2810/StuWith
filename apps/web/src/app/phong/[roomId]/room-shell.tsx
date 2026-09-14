import type { Participant, RemoteTrack, Room, RoomOptions, TrackPublishOptions } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '../../i18n/messages';
import {
  audioPublishOptions,
  disconnectReasonKeyFor,
  isLiveConnection,
  joinPhaseFor,
  participantRowsFor,
  roomConnectionStateFor,
  roomOptionsFor,
  tokenExpiredAt,
  type MediaParticipant,
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
 * ## No video, and that is structural rather than unfinished
 *
 * Epic 2's context requires that a video track reaching LiveKit has ALREADY been
 * through the face pipeline, because attaching a processor after publishing leaves
 * a window in which raw frames have left the machine. That pipeline is Story 2.7.
 * So this story publishes audio only and renders everybody as letters; publishing
 * camera here to make "Để nguyên" mean something would open exactly the window the
 * epic forbids, and 2.7 would have to close something already shipped.
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
 * The three modes the group offers, in display order.
 *
 * `filter` is in the list and refused by the screen: it is rendered as a disabled
 * choice labelled "Sắp có" so the group has the shape Story 2.7 fills in, and
 * `faceModeAvailable` in `pre-join.tsx` is the one place that says no to it.
 */
export const FACE_MODES = ['show', 'hide', 'filter'] as const;

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
}

/** A remote participant, reduced to what the list needs. */
function remoteViewOf(participant: Participant): MediaParticipant {
  return {
    identity: participant.identity,
    name: participant.name,
    // Somebody who has published nothing, or has muted what they published, is
    // "Đang tắt micro" — one state with one sentence, however it was reached.
    micOn: [...participant.audioTrackPublications.values()].some((publication) => !publication.isMuted),
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

  /** The run that is on screen. Assigned before the effect's first `await`. */
  const runRef = useRef<RunHandle | null>(null);
  /** Where every remote `<audio>` element the SDK builds is parked. */
  const audioHostRef = useRef<HTMLDivElement | null>(null);

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
    void handle.room?.disconnect();
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
    };
    runRef.current = handle;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    const stopMic = (): void => {
      handle.micPublished = false;
      handle.micTrack?.stop();
      handle.micTrack = null;
    };

    /** Nothing on the media plane is left running, whatever ended this run. */
    const giveUp = (key: MessageKey | null): void => {
      stopMic();
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
        });
        setRemotes([...room.remoteParticipants.values()].map(remoteViewOf));
        setSpeakers(room.activeSpeakers.map((participant) => participant.identity));
      };

      room
        .on(livekit.RoomEvent.ParticipantConnected, refresh)
        .on(livekit.RoomEvent.ParticipantDisconnected, refresh)
        .on(livekit.RoomEvent.TrackMuted, refresh)
        .on(livekit.RoomEvent.TrackUnmuted, refresh)
        .on(livekit.RoomEvent.ActiveSpeakersChanged, refresh)
        .on(livekit.RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
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
          refresh();
        })
        .on(livekit.RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((element) => {
            element.remove();
          });
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
          }
          setConnection(next);
          refresh();
        })
        .on(livekit.RoomEvent.Disconnected, (reason?: number) => {
          if (handle.cancelled) {
            return;
          }
          stopMic();
          const key = disconnectReasonKeyFor(reason);
          if (key !== null) {
            setErrorKey(key);
          }
          setConnection('disconnected');
        });

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
      refresh();
    };

    void run();

    return () => {
      handle.cancelled = true;
      if (expiryTimer !== null) {
        clearTimeout(expiryTimer);
      }
      stopMic();
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
        errorKey={phase === 'expired' ? 'room.errorExpired' : errorKey}
        micNoticeKey={micNoticeKey}
        audioBlocked={audioBlocked}
        onLeave={leave}
        onEnableAudio={enableAudio}
        onBackToPreJoin={backToPreJoin}
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
