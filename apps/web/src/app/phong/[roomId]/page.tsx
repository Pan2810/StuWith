'use client';

import { AUTH_ME_PATH, parseCurrentUser, roomTokenPath } from '@stuwith/contracts';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { profileLoadOutcome, type ProfileLoadOutcome } from '../../profile-load';
import { useApiBaseUrl, useAuthorizedFetch } from '../../session-expiry-provider';
import {
  PreJoinPanel,
  admissionMatchesRoom,
  browserFamilyFor,
  deviceStateFor,
  joinOutcomeFor,
  joinRequestFor,
  mediaConstraintsFor,
  micLevelFromSamples,
  preJoinStateFor,
  retriesAudioOnly,
  roomDecisionFor,
  roomIdFrom,
  type BrowserFamily,
  type DeviceState,
  type JoinPhase,
  type MediaStage,
} from './pre-join';
import { DEFAULT_FACE_MODE, type FaceMode, type RoomDecision } from './room-shell';

/**
 * `/phong/{roomId}` — whose FIRST state is pre-join.
 *
 * Everything in this file needs a browser and nothing else: two calls through
 * the seam, `setState`, `getUserMedia`, an `AudioContext`, and the handlers that
 * start and stop tracks. Every DECISION — what a device error means, which mode
 * is in force, what a status code means, which of six states the screen is in —
 * is an exported function in `pre-join.tsx`, because the `web` Vitest project has
 * no DOM and a decision left here is a decision no test can run (`AGENTS.md` §6).
 *
 * ## Three things about media that are rules, not implementation details
 *
 * - **Only a local `<video>` ever sees a frame.** There is no
 *   `RTCPeerConnection`, no `WebSocket`, no `livekit-client` here; the browser
 *   probe in `tests/e2e/web/phong.spec.ts` wraps both constructors and listens to
 *   every request to prove it. Story 2.4 connects, from `RoomShell`.
 * - **"Ẩn mặt" stops the camera track, and only "Để nguyên" asks for it again.**
 *   Both live in {@link chooseFaceMode}, a HANDLER — not an effect keyed on the
 *   mode — so no re-render, network recovery or device change can ever turn the
 *   camera back on. The light goes off when the person says so and comes back
 *   when the person says so. A camera that arrives AFTER the person has already
 *   pressed "Ẩn mặt" again (the request was still in flight) is stopped on
 *   arrival: what was chosen last is what is in force, always.
 * - **The token is asked for ONCE, when "Vào phòng" is pressed.** Not on mount
 *   (the TTL is the pre-join budget and a person may sit longer) and not on every
 *   change of mind (`sub = user.id` is LiveKit's participant identity, and a
 *   second connection under it evicts the first — `deferred-work.md`). It lives in
 *   React state and in nothing else. On the `201` every pre-join stream is
 *   stopped before the shell renders — see `room-shell.tsx` for what 2.4 inherits.
 */
export default function PhongPage() {
  const params = useParams<{ roomId: string }>();
  // Judged by the contract's predicate; `null` means no endpoint is ever called.
  const roomId = roomIdFrom(params?.roomId);

  const authorizedFetch = useAuthorizedFetch();
  /** From the provider, never from `process.env` — the layout reads it once. */
  const apiBaseUrl = useApiBaseUrl();

  const [profile, setProfile] = useState<ProfileLoadOutcome | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [faceMode, setFaceMode] = useState<FaceMode>(DEFAULT_FACE_MODE);
  const [micLevel, setMicLevel] = useState(0);
  const [join, setJoin] = useState<JoinPhase>({ kind: 'idle' });
  const [admitted, setAdmitted] = useState<RoomDecision | null>(null);
  const [browserFamily, setBrowserFamily] = useState<BrowserFamily>('other');
  /** "Thử lại quyền" pressed, browser not yet answered: the help block stays, the button waits. */
  const [retryingDevices, setRetryingDevices] = useState(false);
  /** Bumped whenever the camera stream changes, so the attach effect re-runs. */
  const [cameraEpoch, setCameraEpoch] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  /**
   * The LATEST choice and device answer, readable from inside a promise that
   * started before they changed. Two async paths need them: a camera arriving
   * after "Ẩn mặt" was pressed again, and a `201` arriving after a change of
   * mind — in both, what the person chose LAST is what counts.
   */
  const faceModeRef = useRef<FaceMode>(DEFAULT_FACE_MODE);
  const deviceRef = useRef<DeviceState | null>(null);
  /** One `getUserMedia` loop at a time; a second press while one runs is a no-op. */
  const requestingDevicesRef = useRef(false);
  /**
   * Which mount this request belongs to. StrictMode mounts, unmounts and mounts
   * again in development, and a `getUserMedia` that resolves after its mount is
   * gone would otherwise leave a camera open that nothing holds a reference to.
   */
  const generationRef = useRef(0);

  useEffect(() => {
    setBrowserFamily(browserFamilyFor(navigator.userAgent));
  }, []);

  useEffect(() => {
    deviceRef.current = device;
  }, [device]);

  /* ------------------------------------------------------------- profile -- */

  const loadProfile = useCallback(async () => {
    try {
      const response = await authorizedFetch(`${apiBaseUrl}${AUTH_ME_PATH}`);
      const retryAfter = response.headers.get('retry-after');
      if (response.status !== 200) {
        setProfile(profileLoadOutcome(response.status, null, retryAfter));
        return;
      }
      setProfile(profileLoadOutcome(200, parseCurrentUser(await response.json()), retryAfter));
    } catch {
      setProfile(profileLoadOutcome(0, null, null));
    }
  }, [authorizedFetch, apiBaseUrl]);

  useEffect(() => {
    if (roomId === null) {
      return;
    }
    void loadProfile();
  }, [roomId, loadProfile]);

  /* -------------------------------------------------------------- tracks -- */

  const stopTracks = (stream: MediaStream | null): void => {
    stream?.getTracks().forEach((track) => track.stop());
  };

  const stopMeter = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context !== null) {
      void context.close().catch(() => undefined);
    }
  }, []);

  /** Every device this page holds, released. The one routine three exits share. */
  const releaseDevices = useCallback((): void => {
    stopTracks(cameraRef.current);
    stopTracks(audioRef.current);
    cameraRef.current = null;
    audioRef.current = null;
    stopMeter();
  }, [stopMeter]);

  /**
   * The microphone meter: `AudioContext` + `AnalyserNode`, sampled on animation
   * frames, published to state about ten times a second.
   *
   * The context is created AFTER the stream was granted and `resume()`d at once;
   * a browser that still holds it suspended until a gesture gets a second
   * `resume()` on the first pointer or key event, and until then the level is
   * honestly `0` — "Chưa nghe thấy", which is true.
   *
   * The meter is OPTIONAL: a browser that refuses another `AudioContext` (there is
   * a per-page limit) or a source it cannot wire throws here, and the answer is a
   * meter that stays at 0, never a screen with no way in. `adoptStream` catches it.
   */
  const startMeter = useCallback(
    (audio: MediaStream): void => {
      stopMeter();
      const Context = window.AudioContext;
      if (typeof Context !== 'function') {
        return;
      }
      const context = new Context();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(audio).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let lastPublished = 0;

      const tick = (now: number): void => {
        if (audioContextRef.current !== context) {
          return;
        }
        analyser.getByteTimeDomainData(samples);
        if (now - lastPublished >= 100) {
          lastPublished = now;
          setMicLevel(micLevelFromSamples(samples));
        }
        frameRef.current = requestAnimationFrame(tick);
      };
      void context.resume().catch(() => undefined);
      frameRef.current = requestAnimationFrame(tick);
    },
    [stopMeter],
  );

  useEffect(() => {
    const wake = (): void => {
      const context = audioContextRef.current;
      if (context !== null && context.state === 'suspended') {
        void context.resume().catch(() => undefined);
      }
    };
    document.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
    return () => {
      document.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
    };
  }, []);

  /**
   * Take a granted stream in: the video tracks become the preview, the audio
   * tracks feed the meter. Never throws — see {@link startMeter}.
   */
  const adoptStream = useCallback(
    (stream: MediaStream): void => {
      const video = stream.getVideoTracks();
      const audio = stream.getAudioTracks();
      if (video.length > 0) {
        stopTracks(cameraRef.current);
        cameraRef.current = new MediaStream(video);
        setCameraEpoch((epoch) => epoch + 1);
      }
      if (audio.length > 0) {
        stopTracks(audioRef.current);
        audioRef.current = new MediaStream(audio);
        try {
          startMeter(audioRef.current);
        } catch {
          // The microphone is open and will travel; only the meter is missing,
          // and "Chưa nghe thấy" is what it honestly reads.
          stopMeter();
        }
      }
    },
    [startMeter, stopMeter],
  );

  /**
   * Ask for both devices; on "no camera", ask for audio alone.
   *
   * The loop is two iterations at most and every branch of it is a pure function
   * in `pre-join.tsx`. What is here is only the call and the bookkeeping.
   *
   * On the FIRST ask the screen says "Đang xin quyền…"; on a RETRY the previous
   * answer stays on the screen (it is still the truth) and only the retry button
   * waits. A second press while the loop runs does nothing — one prompt at a time.
   */
  const requestDevices = useCallback(
    async (initial: boolean) => {
      if (requestingDevicesRef.current) {
        return;
      }
      requestingDevicesRef.current = true;
      const generation = generationRef.current;
      if (initial) {
        setDevice(null);
      } else {
        setRetryingDevices(true);
      }
      try {
        if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
          setDevice('unreadable');
          return;
        }
        let stage: MediaStage = 'both';
        for (;;) {
          let stream: MediaStream | null = null;
          let errorName: string | null = null;
          try {
            stream = await navigator.mediaDevices.getUserMedia(mediaConstraintsFor(stage));
          } catch (error) {
            errorName = error instanceof Error ? error.name : 'UnknownError';
          }
          if (generation !== generationRef.current) {
            // This mount is gone. Nothing may keep a device open on its behalf.
            stopTracks(stream);
            return;
          }
          const state = deviceStateFor(errorName, stage);
          if (stream !== null) {
            if (faceModeRef.current === 'show') {
              adoptStream(stream);
            } else {
              // The person chose to hide while the browser was still asking: the
              // microphone is taken, the camera is stopped on arrival.
              const audioOnly = new MediaStream(stream.getAudioTracks());
              stream.getVideoTracks().forEach((track) => track.stop());
              if (audioOnly.getAudioTracks().length > 0) {
                adoptStream(audioOnly);
              }
            }
          }
          if (retriesAudioOnly(state, stage)) {
            stage = 'audio-only';
            continue;
          }
          setDevice(state);
          return;
        }
      } finally {
        requestingDevicesRef.current = false;
        setRetryingDevices(false);
      }
    },
    [adoptStream],
  );

  // Devices are asked for once there is a person to ask for them. A signed-out
  // visitor is never prompted for a camera by a page they cannot use.
  useEffect(() => {
    if (profile?.kind !== 'profile') {
      return;
    }
    void requestDevices(true);
  }, [profile?.kind, requestDevices]);

  // Attach whatever camera stream exists to whatever `<video>` exists. The element
  // mounts only while a face is shown; the stream exists only while the person
  // has not chosen to hide it.
  useEffect(() => {
    const element = videoRef.current;
    if (element !== null && element.srcObject !== cameraRef.current) {
      element.srcObject = cameraRef.current;
    }
  }, [cameraEpoch, faceMode, device]);

  /**
   * The ONE place the camera is stopped and the ONE place it is asked for again.
   * A handler, so only a press does either — see the file docblock.
   *
   * Anything that is not "Để nguyên" stops the camera: "Ẩn mặt" today, and any
   * mode a later story adds is hidden-by-default until it says otherwise.
   */
  const chooseFaceMode = useCallback(
    (mode: FaceMode): void => {
      faceModeRef.current = mode;
      setFaceMode(mode);
      if (mode !== 'show') {
        stopTracks(cameraRef.current);
        cameraRef.current = null;
        setCameraEpoch((epoch) => epoch + 1);
        return;
      }
      if (device === 'granted' && cameraRef.current === null) {
        const generation = generationRef.current;
        void navigator.mediaDevices
          .getUserMedia(mediaConstraintsFor('video-only'))
          .then((stream) => {
            if (generation !== generationRef.current || faceModeRef.current !== 'show') {
              // Unmounted, or the person pressed "Ẩn mặt" again before the camera
              // answered: the last choice wins and the late stream is ended here.
              stopTracks(stream);
              return;
            }
            adoptStream(stream);
          })
          .catch((error: unknown) => {
            // The camera went away between the two presses. `deviceStateFor`
            // says what that means — a revoked permission is the help block, a
            // missing or busy camera is "no camera" — and nothing here decides to
            // show a face that cannot be shown.
            const name = error instanceof Error ? error.name : 'UnknownError';
            setDevice(deviceStateFor(name, 'video-only'));
          });
      }
    },
    [device, adoptStream],
  );

  // Rời trang: every track stops, the meter stops, the context closes.
  useEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
      releaseDevices();
    };
  }, [releaseDevices]);

  /* ---------------------------------------------------------------- join -- */

  const requestToken = useCallback(async () => {
    if (roomId === null || device === null || join.kind === 'requesting') {
      return;
    }
    setJoin({ kind: 'requesting' });
    try {
      const response = await authorizedFetch(`${apiBaseUrl}${roomTokenPath(roomId)}`, {
        method: 'POST',
      });
      const body: unknown = await response.json().catch(() => null);
      const outcome = joinOutcomeFor(response.status, body);
      if (outcome.kind === 'admitted') {
        if (!admissionMatchesRoom(roomId, outcome.token)) {
          setJoin({
            kind: 'refused',
            messageKey: 'preJoin.joinTryAgain',
            retryable: true,
            offersCreateRoom: false,
          });
          return;
        }
        // The choice AS IT STANDS NOW, not as it stood at the press: the group is
        // disabled during the round trip, but a device answer may have changed.
        const request = joinRequestFor({
          device: deviceRef.current ?? device,
          faceMode: faceModeRef.current,
        });
        // The shell displays nothing, so nothing may stay open behind it.
        releaseDevices();
        setJoin({ kind: 'idle' });
        // The ONLY assignment of `admitted` in the app: a 201, after a press.
        setAdmitted(roomDecisionFor(request, outcome.token));
        return;
      }
      setJoin({
        kind: 'refused',
        messageKey: outcome.messageKey,
        retryable: outcome.retryable,
        offersCreateRoom: outcome.offersCreateRoom,
      });
    } catch {
      // Nothing came back at all. `joinOutcomeFor(0, …)` is the same "we do not
      // know that it worked" as a 5xx: a sentence and a retry.
      const outcome = joinOutcomeFor(0, null);
      if (outcome.kind === 'refused') {
        setJoin({
          kind: 'refused',
          messageKey: outcome.messageKey,
          retryable: outcome.retryable,
          offersCreateRoom: outcome.offersCreateRoom,
        });
      }
    }
  }, [roomId, device, join.kind, authorizedFetch, apiBaseUrl, releaseDevices]);

  const state = preJoinStateFor(roomId, profile, device, admitted);

  return (
    <main className="page-shell">
      <PreJoinPanel
        state={state}
        faceMode={faceMode}
        micLevel={micLevel}
        videoRef={videoRef}
        join={join}
        retryingDevices={retryingDevices}
        browserFamily={browserFamily}
        apiBaseUrl={apiBaseUrl}
        onFaceModeChange={chooseFaceMode}
        onRetryDevices={() => void requestDevices(false)}
        onJoin={() => void requestToken()}
        onRetryProfile={() => void loadProfile()}
        onWaitFinished={() => setProfile(profileLoadOutcome(0, null, null))}
      />
    </main>
  );
}
