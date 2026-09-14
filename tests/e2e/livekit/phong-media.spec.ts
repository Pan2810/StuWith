import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { LIVEKIT_HANDOFF_FILE, WEB_BASE_URL } from '../../../playwright.config';
import { roomPathname, scenario } from '../support/scenario';
import { startLiveKitContainer, stopLiveKitContainer } from './livekit-container';

/**
 * **Boundary probe — a real browser, a real `livekit-server`, and real audio.**
 *
 * `AGENTS.md` §4 requires that a story crossing a boundary name the boundary, run
 * a probe IN THAT MEDIUM, and have a mutation on the far side that turns it red.
 * `deferred-work.md` records that Story 2.3 could satisfy only the first two: its
 * negative probe wraps `WebSocket` in the page, which is a mutation on OUR side,
 * because the browser ↔ LiveKit boundary had never been opened. This file opens
 * it.
 *
 * ## Why the existing gate is not this
 *
 * `tests/gates/livekit-token.test.ts` reaches a LiveKit WebSocket upgrade with raw
 * `node:http`. What it proves is that a token `mintRoomToken` signs is ACCEPTED —
 * a claim about the JWT. It cannot prove that a browser connects, that a track is
 * published, that a second browser subscribes to it, or that any sound moves. A
 * function calling a function is not a probe, and neither is a socket handshake
 * standing in for a media session.
 *
 * ## What is asserted, and why `bytesReceived` is the one that matters
 *
 * Two browser contexts join ONE room with `audio: 'mic'`. Each then has to see the
 * other in the participant list, hold a subscribed audio track, and count
 * `inbound-rtp` audio bytes off a real `RTCPeerConnection`. The first two are
 * satisfied by a successful signalling handshake; only the third is evidence that
 * the media path — ICE, DTLS, SRTP, the UDP mux port bound 1:1 by the setup —
 * carried anything. A room where everybody appears and nobody is audible is
 * exactly the failure this story exists to prevent.
 *
 * ## The two mutations, both of which must be RUN rather than imagined
 *
 * 1. **On the far side.** Start the container with a secret that is not the one
 *    the token is signed with (`containerSecret` in
 *    `tests/e2e/livekit/global-setup.ts`). Nothing in `apps/web` or
 *    `apps/api/src/rooms/room-token.ts` changes, and `Room.connect` is refused at
 *    the first step: this file goes red on the heading below.
 * 2. **On our side, through the whole seam.** Delete `room: input.roomId` from the
 *    grant in `apps/api/src/rooms/room-token.ts` and rebuild `apps/api`. The
 *    stand-in API signs with the product's own function, so the token it hands the
 *    browser then names no room and the server refuses it — a mutation that
 *    travels the token's entire path rather than being caught by a unit assertion
 *    about a grant object.
 */

const ROOM_ID = '019200f1-0000-7000-8000-0000000004a1';
const ROOM = roomPathname(ROOM_ID);

/**
 * A SECOND room, for the second test.
 *
 * Measured, not guessed: reusing one room made the two tests fight. A LiveKit room
 * outlives the browsers that left it by a few seconds, so whichever test ran second
 * found the first test's participants still listed and its count assertion failed.
 * One room per test is cheaper than making either test wait for the server to
 * forget — and `room.auto_create: true` means the second one costs nothing.
 */
const ROOM_ID_MIC = '019200f1-0000-7000-8000-0000000004a2';
const ROOM_MIC = roomPathname(ROOM_ID_MIC);
const ROOM_DUPLICATE = roomPathname('019200f1-0000-7000-8000-0000000004a3');
const ROOM_AUTOPLAY = roomPathname('019200f1-0000-7000-8000-0000000004a4');
/** Story 2.7. One room per case, for the reason ROOM_ID_MIC's docblock gives. */
const ROOM_VIDEO = roomPathname('019200f1-0000-7000-8000-0000000004a5');
const ROOM_HIDDEN = roomPathname('019200f1-0000-7000-8000-0000000004a6');
const ROOM_HIDDEN_TAB = roomPathname('019200f1-0000-7000-8000-0000000004a7');
const ROOM_CAMERA_GONE = roomPathname('019200f1-0000-7000-8000-0000000004a8');
const ROOM_NO_CAMERA_GRANT = roomPathname('019200f1-0000-7000-8000-0000000004a9');
/** Story 2.5. One room per case, for the reason ROOM_ID_MIC's docblock gives. */
const ROOM_NETWORK_FLAP = roomPathname('019200f1-0000-7000-8000-0000000004b1');
const ROOM_NETWORK_WEAK = roomPathname('019200f1-0000-7000-8000-0000000004b2');
const ROOM_NETWORK_LOST = roomPathname('019200f1-0000-7000-8000-0000000004b3');
const ROOM_SIMULCAST = roomPathname('019200f1-0000-7000-8000-0000000004b4');
const ROOM_NETWORK_HIDDEN = roomPathname('019200f1-0000-7000-8000-0000000004b5');
const ROOM_NETWORK_FILTER = roomPathname('019200f1-0000-7000-8000-0000000004b6');

/**
 * Two people PER TEST, so a `sub` is never shared across tests.
 *
 * `sub` is the participant identity on LiveKit and a second connection under one
 * identity evicts the first — the behaviour the duplicate-identity case below is
 * about. Shared constants made that a property of the test schedule rather than of
 * the product: one room each keeps them apart today, and the moment anybody turns
 * on parallelism the two tests would start evicting each other and the failure
 * would read as a broken room. A suffix per test removes the question.
 */
const identities = (suffix: string): { a: string; b: string } => ({
  // The last group is EXACTLY twelve hex digits, because `currentUserSchema`
  // parses it as a uuid: a thirteenth character makes the stand-in API answer 500
  // on `/v1/auth/me` and the failure arrives as "pre-join never rendered".
  a: `019200f1-0000-7000-8000-00000000${suffix}a0`,
  b: `019200f1-0000-7000-8000-00000000${suffix}b0`,
});

/**
 * No container, no probe — and a loud line rather than a quiet pass.
 *
 * `tests/e2e/livekit/global-setup.ts` refuses to honour
 * `STUWITH_SKIP_TESTCONTAINERS` when `CI` is set, so this branch cannot be reached
 * in CI: there the absence of the file would mean the container failed to start,
 * and the setup throws before any test runs.
 */
test.skip(
  () => !existsSync(LIVEKIT_HANDOFF_FILE),
  'no livekit-server for this run (STUWITH_SKIP_TESTCONTAINERS)',
);

/**
 * Collects every `RTCPeerConnection` the page builds, so a spec can read
 * `getStats()` off the real one.
 *
 * The product exposes no handle to its `Room`, and it must not grow one for a
 * test. Wrapping the constructor is the seam that already exists in the browser —
 * the same technique `tests/e2e/web/phong.spec.ts` uses to prove the opposite
 * claim — and it defers to the real constructor, so what is measured is the
 * connection the product actually made.
 */
async function collectPeerConnections(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const connections: RTCPeerConnection[] = [];
    (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers = connections;
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args, newTarget) {
        const connection = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        connections.push(connection);
        return connection;
      },
    });
  });
}

/** Audio bytes this page has RECEIVED, summed over every connection it opened. */
function inboundAudioBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const connections = (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers;
    let total = 0;
    for (const connection of connections) {
      const stats = await connection.getStats();
      stats.forEach((report: { type?: string; kind?: string; bytesReceived?: number }) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          total += report.bytesReceived ?? 0;
        }
      });
    }
    return total;
  });
}

/** Whether a remote audio track is attached and live in this page's DOM. */
function subscribedAudioTracks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('audio')].filter((element) => {
        const source = element.srcObject;
        return (
          source instanceof MediaStream &&
          source.getAudioTracks().some((track) => track.readyState === 'live')
        );
      }).length,
  );
}

/** Every audio track this page was ever handed, by `readyState`. */
function localAudioTrackStates(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __stuwithStreams: MediaStream[] }).__stuwithStreams.flatMap((stream) =>
      stream.getAudioTracks().map((track) => track.readyState as string),
    ),
  );
}

async function rememberStreams(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const streams: MediaStream[] = [];
    (window as unknown as { __stuwithStreams: MediaStream[] }).__stuwithStreams = streams;
    (window as unknown as { __stuwithVideoRequests: number }).__stuwithVideoRequests = 0;
    const devices = navigator.mediaDevices;
    if (devices !== undefined) {
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        // Counted BEFORE the await, and counted even if the request is refused:
        // "Ẩn mặt never asks for a camera" is a claim about the call, not about
        // the answer. Story 2.7.
        if (constraints?.video !== undefined && constraints.video !== false) {
          const state = window as unknown as { __stuwithVideoRequests: number };
          state.__stuwithVideoRequests += 1;
        }
        const stream = await original(constraints);
        streams.push(stream);
        return stream;
      };
    }
  });
}

/** A fresh context with the probe's three wrappers installed, signed in as one person. */
async function joinAs(
  context: BrowserContext,
  userId: string,
  room: string = ROOM,
  /**
   * Which face mode to leave pre-join on. `show` is the product's default, so the
   * audio cases below go on exercising exactly the path they always did — and the
   * video cases do not need a fixture of their own.
   */
  faceMode: 'show' | 'hide' = 'show',
  /** Extra scenario state — today only Story 2.7's narrowed room-token grant. */
  extra: { readonly roomTokenWithoutCameraSource?: boolean } = {},
): Promise<Page> {
  await collectPeerConnections(context);
  await rememberStreams(context);
  await rememberCanvasTracks(context);
  const page = await context.newPage();
  await scenario(page, { signedIn: true, userId, useLiveKit: true, ...extra });
  await page.goto(room);
  await expect(page.locator('video')).toBeVisible();
  if (faceMode === 'hide') {
    // Scoped to PRE-JOIN's own group. Unscoped it is unambiguous only because the
    // room's group has not mounted yet — a fact about the order of two screens,
    // not about this press, and one that stops being true the moment a spec wants
    // to press before the shell unmounts.
    await preJoinModeGroup(page).getByRole('radio', { name: 'Ẩn mặt' }).check();
  }
  await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();
  /**
   * The shell is on screen — by ID, not by sentence.
   *
   * From Story 2.4 the heading follows the join phase, so the shell says
   * "Đang vào phòng" first and "Bạn đã vào phòng" only once the room is really up.
   * Waiting here for the connected wording would put the handshake's whole budget
   * inside a helper with the default timeout; every caller asserts
   * "Đang ở trong phòng" itself, with a timeout that suits a real connection.
   */
  await expect(page.locator('h1#phong-tieu-de')).toBeVisible();
  return page;
}

const peopleCount = (page: Page) => page.getByText(/người trong phòng\./);

/**
 * Built by hand rather than through the `page` fixture, because every case here
 * needs TWO contexts in one test. `browser.newContext()` inherits the launch flags
 * (the fake devices are a browser-level argument) but NOT the project's `use`
 * block, so the three things these specs depend on are spelled here.
 */
const CONTEXT_OPTIONS = {
  baseURL: WEB_BASE_URL,
  locale: 'vi-VN',
  permissions: ['camera', 'microphone'],
} as const;

/**
 * The negotiated SDP of every connection this page opened.
 *
 * What it is for: `audioPublishOptions()` was asserted only against the object it
 * had just built, and `roomOptionsFor(...).publishDefaults` was compared with
 * itself — neither observed that the SDK applied any of it, and `bytesReceived > 0`
 * is satisfied by the SDK's defaults exactly as well as by ours. The SDP is where
 * the decision becomes a fact on the wire: `usedtx=1` is DTX, and a `red` payload
 * type is RED. Delete either flag from `audioPublishOptions()` and this goes red
 * for the right reason.
 */
function negotiatedDescriptions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers
      .flatMap((connection) => [
        connection.currentLocalDescription?.sdp ?? '',
        // The ANSWER, and it is the half that carries DTX. `usedtx` is not in the
        // offer: livekit-client's own comment in `setMungedSDP` says the SERVER
        // sets per-track codec params on the sections mapped to a published track,
        // so the offer carries Chromium's defaults and the answer carries the
        // publish options. Reading only the local description asserted about the
        // browser rather than about anything this story decided.
        connection.currentRemoteDescription?.sdp ?? '',
      ])
      .filter((sdp) => sdp.length > 0),
  );
}

/**
 * Refuse to PLAY media in this context, which is what an autoplay policy does.
 *
 * `playwright.config.ts` passes `--autoplay-policy=no-user-gesture-required` so the
 * real policy never fires, which means the product's blocked-audio branch is
 * unreachable in this suite unless a spec puts it back. Wrapping
 * `HTMLMediaElement.play` is the layer LiveKit actually watches: `track.attach()`
 * ends up calling it, the rejection is what sets `canPlaybackAudio` false and
 * raises `AudioPlaybackStatusChanged`, and `room.startAudio()` is what retries it.
 * Story 2.3 used the same shape one layer down for the suspended `AudioContext`.
 */
async function refuseAudioPlayback(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    let allowed = false;
    (window as unknown as { __stuwithAllowPlayback: () => void }).__stuwithAllowPlayback = () => {
      allowed = true;
    };
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
      return allowed
        ? original.call(this)
        : Promise.reject(new DOMException('blocked by the spec', 'NotAllowedError'));
    };
  });
}

/**
 * End the local microphone track the way the OS does, from outside the page.
 *
 * `MediaStreamTrack.stop()` deliberately does NOT fire `ended` — the spec reserves
 * that event for the source going away on its own (unplugged, claimed by another
 * application, revoked). There is no Chromium switch that takes a fake device away
 * mid-session, so the event is dispatched on the real track instead. What that
 * buys is the part a render test cannot reach: the listener in `room-shell.tsx`
 * runs for real, `unpublishTrack` really travels to the server, and the assertion
 * below is read off the OTHER browser rather than off our own state.
 */
function endLocalMicrophone(page: Page): Promise<void> {
  return page.evaluate(() => {
    const streams = (window as unknown as { __stuwithStreams: MediaStream[] }).__stuwithStreams;
    for (const stream of streams) {
      for (const track of stream.getAudioTracks()) {
        track.dispatchEvent(new Event('ended'));
      }
    }
  });
}

/**
 * Every track id `canvas.captureStream()` has ever produced in this page.
 *
 * The other half of {@link rememberStreams}, and together they are the whole of
 * AD-30 rule (b) as a measurement. `getUserMedia` mints the CAMERA's track ids;
 * `captureStream` mints the CANVAS's; and the id on the wire has to come from the
 * second set and never from the first. Both wrappers defer to the real function,
 * so what is measured is the pipeline the product actually built.
 */
async function rememberCanvasTracks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const ids: string[] = [];
    (window as unknown as { __stuwithCanvasTrackIds: string[] }).__stuwithCanvasTrackIds = ids;
    const original = HTMLCanvasElement.prototype.captureStream;
    if (typeof original !== 'function') {
      return;
    }
    HTMLCanvasElement.prototype.captureStream = function captureStream(
      this: HTMLCanvasElement,
      frameRate?: number,
    ) {
      const stream = original.call(this, frameRate);
      for (const track of stream.getVideoTracks()) {
        ids.push(track.id);
      }
      return stream;
    };
  });
}

/** The ids of every track a canvas in this page handed out. */
function canvasTrackIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __stuwithCanvasTrackIds: string[] }).__stuwithCanvasTrackIds,
  );
}

/** The ids of every VIDEO track `getUserMedia` handed this page — the camera's. */
function cameraTrackIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __stuwithStreams: MediaStream[] }).__stuwithStreams.flatMap((stream) =>
      stream.getVideoTracks().map((track) => track.id),
    ),
  );
}

/**
 * The id of every video track being SENT, read off the real `RTCPeerConnection`.
 *
 * This is the measurement the whole story rests on. A test that asks "is there a
 * canvas" proves we drew something; it says nothing about what went up the wire.
 * `RTCRtpSender.track.id` is the one place those two possibilities separate, and
 * a build that attached a processor AFTER publishing would show a camera id here
 * while every other assertion in this file stayed green.
 */
function videoSenderTrackIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers.flatMap((connection) =>
      connection
        .getSenders()
        .filter((sender) => sender.track !== null && sender.track.kind === 'video')
        .map((sender) => sender.track?.id ?? ''),
    ),
  );
}

/** How many video senders exist at all — `0` is what "Ẩn mặt" has to mean. */
function videoSenderCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers.flatMap((connection) =>
        connection.getSenders().filter((sender) => sender.track?.kind === 'video'),
      ).length,
  );
}

/** Bytes AND decoded frames of inbound video, summed over every connection. */
function inboundVideo(page: Page): Promise<{ bytesReceived: number; framesDecoded: number }> {
  return page.evaluate(async () => {
    const connections = (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers;
    let bytesReceived = 0;
    let framesDecoded = 0;
    for (const connection of connections) {
      const stats = await connection.getStats();
      stats.forEach(
        (report: { type?: string; kind?: string; bytesReceived?: number; framesDecoded?: number }) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            bytesReceived += report.bytesReceived ?? 0;
            framesDecoded += report.framesDecoded ?? 0;
          }
        },
      );
    }
    return { bytesReceived, framesDecoded };
  });
}

/** How many `getUserMedia` calls asked for video. `1` is pre-join's, and only its. */
function videoRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __stuwithVideoRequests: number }).__stuwithVideoRequests,
  );
}

/** Pre-join's face-mode group, and the room's. Two screens, two legends. */
const preJoinModeGroup = (page: Page) => page.getByRole('radiogroup', { name: 'Chế độ khuôn mặt' });
const roomModeGroup = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Khuôn mặt của bạn trong phòng' });

/** Every VIDEO track this page was ever handed by `getUserMedia`, by `readyState`. */
function localVideoTrackStates(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __stuwithStreams: MediaStream[] }).__stuwithStreams.flatMap((stream) =>
      stream.getVideoTracks().map((track) => track.readyState as string),
    ),
  );
}

/**
 * The `<video>` elements drawn for OTHER people, never for the reader.
 *
 * The reader's own row draws a face too — a room where both cameras are on has
 * two tiles — so a bare `#phong-nguoi-tham-gia video` counts the local canvas as
 * evidence that a remote picture arrived, which is the one thing it is not.
 * Measured: the first spelling read `2` for one remote face.
 *
 * "Not the first row" rather than "the row that says Người học", and the
 * difference is whether this keeps working. `participantRowsFor` PINS the reader
 * to the top — a documented product invariant, with its own reason (the row whose
 * microphone you can act on must not move under you) and its own unit coverage —
 * while `room.participantUnnamed` is only what a remote row says while nobody has
 * a display name. `deferred-work.md` already owns giving people one, and on the
 * day it lands this locator would have silently stopped measuring the far side.
 */
const remoteVideos = (page: Page) =>
  page.locator('#phong-nguoi-tham-gia li:not(:first-child) video');

/**
 * Hide and show the tab, the only way a spec can.
 *
 * There is no Playwright API for `visibilityState`, and `page.bringToFront()` does
 * not change it for a headless context. Redefining the getter and dispatching the
 * real event is the layer the product listens on, and the ASSERTIONS are all read
 * from the OTHER browser — so what is proved is that the far side stops receiving
 * a picture, not that our own handler ran.
 */
function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  return page.evaluate((isHidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (isHidden ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/**
 * End the local CAMERA track the way the OS does, from outside the page.
 *
 * The same seam {@link endLocalMicrophone} uses and for the same reason:
 * `MediaStreamTrack.stop()` deliberately does NOT fire `ended` — the spec reserves
 * that event for the source going away on its own (unplugged, claimed, revoked) —
 * and no Chromium switch takes a fake device away mid-session. Dispatching on the
 * real track is what makes the listener in `room-shell.tsx` run for real, so the
 * unpublish really travels and the assertion is read off the OTHER browser.
 */
function endLocalCamera(page: Page): Promise<void> {
  return page.evaluate(() => {
    const streams = (window as unknown as { __stuwithStreams: MediaStream[] }).__stuwithStreams;
    for (const stream of streams) {
      for (const track of stream.getVideoTracks()) {
        track.dispatchEvent(new Event('ended'));
      }
    }
  });
}

/* -------------------------------------------------------------------------- *
 * Story 2.5 — the ladder, and the two halves of how it is driven
 * -------------------------------------------------------------------------- */

/**
 * `livekit.ConnectionQuality` as the wire numbers, from
 * `@livekit/protocol`'s `livekit_models_pb.js`. Written out rather than imported
 * for the reason every other constant in this suite is: the package is not a
 * dependency of `tests/`, and a spec that reached into `node_modules` for an enum
 * would be a spec that stops compiling on a version bump for no product reason.
 */
const QUALITY_POOR = 0;
const QUALITY_EXCELLENT = 2;
/**
 * `LOST` is how bậc 4 is reached INSIDE a debounce window.
 *
 * The container-stop case is the real far-side stimulus for bậc 4 and stays
 * that; it cannot be used here because stopping a server takes seconds and the
 * window is three. `networkRungFor('lost', 'connected')` is bậc 4 by the same
 * table, reached in one injected frame.
 */
const QUALITY_LOST = 3;

/**
 * **The in-browser seam for rungs 1–3, declared as a seam rather than a probe.**
 *
 * The spec says this half is NOT the boundary probe and says why: `ConnectionQuality`
 * is LiveKit's own measurement of the line, and there is no verified way to force
 * a real one from outside. Playwright 1.62.1 has `newCDPSession`, but whether
 * `Network.emulateNetworkConditions` throttles UDP/SRTP at all lives in Chromium's
 * C++ and cannot be read off this repository — a measured unknown, not a guess.
 * So bậc 4, the one rung with a real far-side stimulus, is driven by stopping the
 * container; rungs 1–3 are driven here, in the browser, at the SDK's own input.
 *
 * It is the same class of seam as `refuseDevices` and {@link setTabHidden}: it
 * changes what the page is TOLD, never what the product does with it. Everything
 * downstream — the reconciler, the unpublish, the `RTCRtpSender` going away, the
 * far side losing a tile — is the product running for real, and the assertions
 * are read off the OTHER browser wherever they can be.
 *
 * **Installed per case, not by `joinAs`.** It used to be one of the four wrappers
 * every context in this file got, which put a `WebSocket` proxy in front of the
 * Story 2.4 and 2.7 cases that have nothing to do with the ladder — cost and risk
 * bought for nothing. The ladder's own cases ask for it by name.
 *
 * ## How it works, because "inject a protobuf" deserves an explanation
 *
 * `livekit-client` learns a participant's quality from a `SignalResponse` on the
 * signalling socket whose `connection_quality` field (number 12) carries a
 * `ConnectionQualityUpdate`. Each entry is matched by `participant_sid` — which
 * nothing outside the page knows — so this does not BUILD a message, it takes the
 * server's own next one and rewrites one varint in it: field 2 of a chosen
 * `ConnectionQualityInfo`. Every sid, every length and the whole framing are the
 * server's; only the quality value is ours.
 *
 * **One entry at a time, which is what makes the local-participant filter
 * testable.** The first version overwrote every entry by construction, so both
 * participants always went poor together and a build with no filter at all was
 * indistinguishable from one with it. Targeting by INDEX needs no knowledge of
 * which sid is local: exactly one of the entries must be able to take this
 * browser's camera off, and that is a sharper claim than "the filter exists".
 *
 * Two details are load-bearing:
 *
 * - the listener is installed in the `construct` trap, which is BEFORE
 *   `livekit-client` assigns `ws.onmessage` (it does so inside `ws.onopen`). A
 *   property handler participates as an ordinary listener at the position it was
 *   assigned, so ours runs first and `stopImmediatePropagation()` can hold a
 *   frame back;
 * - a real update is REWRITTEN rather than dropped while a quality is forced.
 *   The server goes on sending the truth every few seconds, and without this the
 *   forced value would be undone about two seconds later — the assertions below
 *   would then be racing a heartbeat rather than testing a ladder. The SDK still
 *   receives a well-formed update on the cadence it expects.
 */
async function interceptSignalQuality(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    /** SignalResponse field 12, wire type 2 — the only tag a quality frame opens with. */
    const QUALITY_TAG = 0x62;

    const sockets: WebSocket[] = [];
    let template: Uint8Array | null = null;
    let forced: { index: number; quality: number } | null = null;
    let injecting = false;

    const readVarint = (bytes: Uint8Array, at: number): readonly [number, number] => {
      let result = 0;
      let shift = 0;
      let index = at;
      let byte = 0;
      do {
        byte = bytes[index] ?? 0;
        index += 1;
        result += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while ((byte & 0x80) !== 0 && shift < 64);
      return [result, index] as const;
    };

    /**
     * Walk a quality frame, rewriting `quality` on the chosen entry — or on every
     * entry when `target` is negative. Answers the number of entries it saw, or
     * `null` on anything it does not recognise: a protocol change then shows up
     * as "the seam could not drive it" rather than as a product bug.
     */
    const walk = (bytes: Uint8Array, quality: number | null, target: number): number | null => {
      const [tag, afterTag] = readVarint(bytes, 0);
      if (tag !== QUALITY_TAG) {
        return null;
      }
      const [updateLength, updateStart] = readVarint(bytes, afterTag);
      const updateEnd = updateStart + updateLength;
      let cursor = updateStart;
      let seen = 0;
      while (cursor < updateEnd) {
        const [entryTag, afterEntryTag] = readVarint(bytes, cursor);
        if ((entryTag & 7) !== 2) {
          return null;
        }
        const [entryLength, entryStart] = readVarint(bytes, afterEntryTag);
        const entryEnd = entryStart + entryLength;
        // `updates` is field 1; anything else inside this message is unknown to us.
        if (entryTag >> 3 === 1) {
          const chosen = quality !== null && (target < 0 || target === seen);
          seen += 1;
          let field = entryStart;
          while (field < entryEnd) {
            const [fieldTag, afterFieldTag] = readVarint(bytes, field);
            const number = fieldTag >> 3;
            const wire = fieldTag & 7;
            if (number === 2 && wire === 0) {
              // POOR..LOST are 0..3, so both the value there and the one going in
              // are a single byte and the frame's length prefixes stay true.
              if (((bytes[afterFieldTag] ?? 0) & 0x80) !== 0) {
                return null;
              }
              if (chosen) {
                bytes[afterFieldTag] = quality;
              }
              field = afterFieldTag + 1;
            } else if (wire === 0) {
              const [, next] = readVarint(bytes, afterFieldTag);
              field = next;
            } else if (wire === 2) {
              const [length, next] = readVarint(bytes, afterFieldTag);
              field = next + length;
            } else if (wire === 5) {
              field = afterFieldTag + 4;
            } else if (wire === 1) {
              field = afterFieldTag + 8;
            } else {
              return null;
            }
          }
        }
        cursor = entryEnd;
      }
      return seen;
    };

    const dispatch = (bytes: Uint8Array): void => {
      injecting = true;
      try {
        for (const socket of sockets) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.dispatchEvent(new MessageEvent('message', { data: bytes.buffer }));
          }
        }
      } finally {
        injecting = false;
      }
    };

    const state = window as unknown as {
      __stuwithForceQuality: (quality: number | null, index?: number) => boolean;
      __stuwithQualityEntries: () => number;
    };

    state.__stuwithQualityEntries = () =>
      template === null ? 0 : (walk(template.slice(), null, -1) ?? 0);

    state.__stuwithForceQuality = (quality: number | null, index = -1) => {
      forced = quality === null ? null : { index, quality };
      if (quality === null || template === null) {
        return false;
      }
      const bytes = template.slice();
      if (walk(bytes, quality, index) === null) {
        return false;
      }
      dispatch(bytes);
      return true;
    };

    const Original = window.WebSocket;
    window.WebSocket = new Proxy(Original, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        sockets.push(socket);
        // Pruned, or a long session accumulates every socket it ever opened —
        // and `dispatch` would walk a list that only ever grows.
        const forget = (): void => {
          const at = sockets.indexOf(socket);
          if (at >= 0) {
            sockets.splice(at, 1);
          }
        };
        socket.addEventListener('close', forget);
        socket.addEventListener('error', forget);
        socket.addEventListener('message', (event: MessageEvent) => {
          if (injecting || !(event.data instanceof ArrayBuffer)) {
            return;
          }
          const bytes = new Uint8Array(event.data);
          if (bytes.length === 0 || bytes[0] !== QUALITY_TAG) {
            return;
          }
          // The server's own frame is the template: every sid and every length in
          // it is the server's, which is what makes the rewrite honest.
          template = bytes.slice();
          if (forced === null) {
            return;
          }
          const rewritten = bytes.slice();
          if (walk(rewritten, forced.quality, forced.index) === null) {
            return;
          }
          event.stopImmediatePropagation();
          dispatch(rewritten);
        });
        return socket;
      },
    });
  });
}

/**
 * Force a quality on ONE page and wait until the injection really happened.
 *
 * The `expect.poll` is not politeness: the seam needs the server's own next
 * quality frame as a template, and until one has arrived there is nothing to
 * rewrite. Without the poll a spec would force a value into the void and then
 * assert about a ladder that was never told anything — green for a product that
 * does nothing, which is the exact failure `AGENTS.md` §4 is about.
 *
 * `index` defaults to "every participant in the frame", which is what the cases
 * about THIS browser's own line want. A non-negative index targets one entry —
 * see the local-participant filter case.
 */
async function forceQuality(page: Page, quality: number, index = -1): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([value, at]: readonly [number, number]) =>
            (
              window as unknown as {
                __stuwithForceQuality: (q: number | null, i?: number) => boolean;
              }
            ).__stuwithForceQuality(value, at),
          [quality, index] as const,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Wait until the server has sent a quality frame naming at least two people.
 *
 * The seam rewrites the server's OWN frame, so the entries it can target are
 * whatever that frame happens to carry. A case about "somebody else's line"
 * cannot begin until a frame exists that has a somebody else in it, and asserting
 * on a one-entry frame would be asserting about a room with one person in it.
 */
async function waitForQualityEntries(page: Page, atLeast: number): Promise<number> {
  await expect
    .poll(() => qualityEntryCount(page), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(atLeast);
  return qualityEntryCount(page);
}

/** How many participants the server's own quality frame carries. */
function qualityEntryCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __stuwithQualityEntries: () => number }).__stuwithQualityEntries(),
  );
}

/**
 * Every ladder-driven fact on the screen, read in ONE round trip.
 *
 * The point is the single instant. The invariant under test is that two props
 * carry DIFFERENT rungs at the same moment — the chip still holding its old
 * value while the banner and the frozen list already describe the new one — and
 * four separate `expect` calls cannot say that: each retries on its own clock,
 * so a banner arriving three seconds late still satisfies one written with the
 * default timeout. Reading all four together makes the claim about a state
 * rather than about a sequence.
 *
 * `restart` is the BUTTON's presence rather than the region's text, because the
 * region is always mounted (empty when there is nothing to offer).
 */
function ladderSnapshot(page: Page): Promise<{
  chip: string | null;
  banner: string;
  frozen: boolean;
  restart: boolean;
}> {
  return page.evaluate(() => ({
    chip: document.querySelector('#phong-mang')?.textContent ?? null,
    banner: document.querySelector('#phong-mang-thong-bao')?.textContent ?? '',
    frozen:
      document.querySelector('#phong-nguoi-tham-gia')?.classList.contains('participant-list-frozen') ??
      false,
    restart: document.querySelector('#phong-mang-bat-lai button') !== null,
  }));
}

/**
 * How long a paired assertion may wait — deliberately SHORTER than the debounce.
 *
 * `--motion-network-chip-debounce` is three seconds, and every assertion below
 * has to land while the two rungs still disagree. Playwright's five-second
 * default is longer than the window, so a consequence that arrived late would
 * still satisfy it — which is exactly the hole these cases exist to close. Two
 * seconds is comfortably longer than the milliseconds a correct build needs and
 * comfortably shorter than the window a broken one would need.
 */
const INSIDE_THE_WINDOW = 2_000;

/** The network chip, which is a different element from the phase chip beside it. */
const networkChip = (page: Page) => page.locator('#phong-mang');

/**
 * The simulcast layers this page is really offering, off its own local SDP.
 *
 * `negotiatedDescriptions` joins the local and remote descriptions together,
 * which is right for reading back what the SERVER answered about audio. Simulcast
 * is the opposite direction — it is what the publisher's own offer declares — so
 * this reads `currentLocalDescription` alone, and only the `m=video` sections of
 * it.
 */
function videoSimulcast(page: Page): Promise<{ rids: string[]; simulcastLines: number }> {
  return page.evaluate(() => {
    const rids: string[] = [];
    let simulcastLines = 0;
    for (const connection of (window as unknown as { __stuwithPeers: RTCPeerConnection[] }).__stuwithPeers) {
      const sdp = connection.currentLocalDescription?.sdp ?? '';
      if (sdp === '') {
        continue;
      }
      for (const section of sdp.split(/^m=/m).slice(1)) {
        if (!section.startsWith('video')) {
          continue;
        }
        for (const raw of section.split('\n')) {
          const line = raw.trim();
          const rid = /^a=rid:([^ ]+) send/.exec(line);
          if (rid?.[1] !== undefined) {
            rids.push(rid[1]);
          }
          if (line.startsWith('a=simulcast:send')) {
            simulcastLines += 1;
          }
        }
      }
    }
    return { rids, simulcastLines };
  });
}

/**
 * Serial, and for a reason stronger than tidiness: every case here drives two
 * browser contexts through one `livekit-server` on one 1:1-bound UDP port, and the
 * eviction the duplicate-identity case is about is exactly what parallel cases
 * would do to each other by accident.
 */
test.describe.configure({ mode: 'serial' });

test.describe('phòng — browser ↔ LiveKit', () => {
  test('two browsers in one room see each other AND hear each other', async ({ browser }) => {
    const people = identities('01');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a);
      // The room is really up — not merely "the screen rendered". This is the
      // assertion the far-side mutation turns: a token signed with the wrong
      // secret never reaches `connected`.
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      await expect(peopleCount(pageA)).toHaveText('Có 1 người trong phòng.');

      const pageB = await joinAs(contextB, people.b);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // Each sees the other. Two rows, one of them the reader's own.
      await expect(peopleCount(pageB)).toHaveText('Có 2 người trong phòng.');
      await expect(peopleCount(pageA)).toHaveText('Có 2 người trong phòng.');
      await expect(pageB.getByRole('listitem')).toHaveCount(2);
      await expect(pageB.getByText('Bạn', { exact: true })).toBeVisible();

      // The other side's audio is SUBSCRIBED — a live remote track, attached.
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBeGreaterThan(0);
      await expect.poll(() => subscribedAudioTracks(pageA), { timeout: 30_000 }).toBeGreaterThan(0);

      /**
       * And sound actually moved. Everything above is satisfied by a signalling
       * handshake; only this is evidence that ICE, DTLS and SRTP completed and
       * that the fake microphone's tone crossed the boundary.
       */
      await expect
        .poll(() => inboundAudioBytes(pageB), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(() => inboundAudioBytes(pageA), { timeout: 30_000 })
        .toBeGreaterThan(0);

      /**
       * And the encoding really reached the WIRE.
       *
       * What this closes: `audioPublishOptions()` was asserted only against the
       * object it had just built and `roomOptionsFor(...).publishDefaults` was
       * compared with itself, so nothing anywhere observed that the SDK applied
       * any of it — and `bytesReceived > 0` is silent about DTX and RED. The
       * negotiated SDP is where both stop being claims: `usedtx=1` in the
       * server's answer, and a `red/48000` payload type on the audio m-line.
       *
       * What this does NOT prove, said plainly rather than implied: that WE asked
       * for them. `livekit-client`'s own `publishDefaults` are `dtx: true,
       * red: true, forceStereo: false` — the same three values — so a run with
       * our options deleted produces the same SDP. Two things were tried and
       * neither works: `audioPreset.maxBitrate` is sent in the AddTrack request
       * and never appears as `maxaveragebitrate` in any description this probe
       * can read, and `priority` is an RTP sender parameter that never reaches
       * the SDP at all.
       *
       * What DOES make the two flags unfalsifiable is not a test: `dtx` and `red`
       * on {@link AudioPublishOptions} are typed `true`, not `boolean`, so
       * `dtx: false` is a compile error and `next build` refuses it — measured on
       * 2026-09-14 by making that exact edit. A type that cannot express the
       * wrong value is a stronger control than an assertion about a default.
       */
      const sdp = (await negotiatedDescriptions(pageA)).join('\n');
      expect(sdp, 'the publisher must have a negotiated audio description').toContain('m=audio');
      expect(sdp, 'DTX must reach the wire').toContain('usedtx=1');
      expect(sdp.toLowerCase(), 'RED must be offered on the audio track').toContain('red/48000');

      /**
       * Somebody is SPEAKING, in words, on the other side's row.
       *
       * Nothing asserted this before: replacing `setSpeakers(room.activeSpeakers…)`
       * with `setSpeakers([])`, or dropping the `ActiveSpeakersChanged`
       * registration entirely, left the whole suite green. The Chromium fake
       * microphone is a continuous tone, so LiveKit's speaker detection fires on
       * its own — no gesture, no fixture.
       *
       * **Scoped to A's ROW, and that is a correction rather than a narrowing.**
       * The document-wide spelling was `pageB.getByText('Đang nói')`, which is a
       * STRICT locator: it fails when two elements match. Both fake microphones
       * emit a continuous tone, so both people really are speaking, and LiveKit
       * puts both in `activeSpeakers` whenever its observer happens to sample
       * them together — at which point the page renders "Đang nói" on two rows
       * and the assertion failed BECAUSE the product was right. Measured on
       * 2026-09-14: twice in seven consecutive runs of this project, always this
       * line, always "resolved to 2 elements".
       *
       * "Not the first row" is `remoteVideos`' own rule and it is exactly what
       * this case means to claim: the person on the OTHER side is shown as
       * speaking. `participantRowsFor` pins the reader to the top, so the second
       * row is A's — a sharper claim than "somebody somewhere on this page", and
       * one that is true however many people are talking at once.
       */
      await expect(
        pageB.locator('#phong-nguoi-tham-gia li:not(:first-child)').getByText('Đang nói'),
      ).toBeVisible({ timeout: 30_000 });

      /**
       * "Rời phòng" really disconnects: the other side loses the row, and the
       * person leaving is left with no open microphone and a way back to pre-join.
       */
      await pageA.getByRole('button', { name: 'Rời phòng' }).click();
      // `exact`, because the phase heading now reads "Bạn đã rời phòng" and the
      // chip reads "Đã rời phòng": a substring match sees both.
      await expect(pageA.getByText('Đã rời phòng', { exact: true })).toBeVisible();
      await expect(pageA.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
      expect(await localAudioTrackStates(pageA)).not.toContain('live');
      /**
       * And the CAMERA, which nothing here asserted for a round.
       *
       * `leave` does not unmount, so the effect's cleanup never runs on this path:
       * delete the camera teardown from it and the light stays on behind a heading
       * that says the person has left, with this whole file still green. The far
       * side losing the row does not cover it either — an unpublished track and a
       * stopped one look identical from over there.
       */
      expect(await localVideoTrackStates(pageA)).not.toContain('live');
      await expect(remoteVideos(pageB)).toHaveCount(0, { timeout: 30_000 });
      /**
       * And a clean leave is SILENT about faults. `failed`, `expired` and `left`
       * all render the same chip and the same button, so without this line dropping
       * the `if (key !== null)` guard in the Disconnected handler would show every
       * single leaver "Mất kết nối tới phòng." with nothing in the suite going red.
       */
      // Scoped to `main`: Next.js renders its own route announcer as a
      // `role="alert"` outside the page content, so a document-wide locator is
      // never zero and the assertion would be about the framework.
      // `:not(:empty)` because Story 2.5's ladder banner is a PERSISTENT
      // `role="alert"` region — a live region inserted together with its content
      // is commonly missed by AT, so it exists empty and fills. "No alert" has
      // always meant "nothing announced", which is what an empty region does.
      await expect(pageA.locator('main [role="alert"]:not(:empty)')).toHaveCount(0);
      await expect(peopleCount(pageB)).toHaveText('Có 1 người trong phòng.', { timeout: 30_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
  test('a microphone that ends from outside is unpublished, and the other side loses the sound', async ({
    browser,
  }) => {
    const people = identities('02');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_MIC);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_MIC);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // B is really hearing A before anything is taken away — otherwise the
      // assertion after the event would pass on a room that never worked.
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      await endLocalMicrophone(pageA);

      // A stays IN the room and says which half is missing.
      await expect(
        pageA.getByText('Micro đã ngừng hoạt động. Hãy vào lại phòng nếu muốn bật lại.'),
      ).toBeVisible();
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible();
      await expect(peopleCount(pageA)).toHaveText('Có 2 người trong phòng.');

      // And the unpublish travelled: B loses the subscribed track. This is the
      // half no render test can reach.
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBe(0);
      await expect(pageB.getByText('Đang tắt micro')).toBeVisible({ timeout: 30_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('the same person joining twice is told so, in the words for that case', async ({ browser }) => {
    /**
     * `room.errorDuplicate` existed with nothing reaching it through the shell.
     *
     * It is the case `deferred-work.md` predicted before any code could produce it:
     * a room token's `sub` is the account id, LiveKit treats that as the
     * participant identity, and a second connection under it evicts the first. Told
     * as "Mất kết nối tới phòng." it is a product that drops people at random; told
     * plainly it is a sentence somebody can act on. ONE `userId` for both contexts
     * is the whole fixture.
     */
    const person = identities('03').a;
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, person, ROOM_DUPLICATE);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      const pageB = await joinAs(contextB, person, ROOM_DUPLICATE);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // The FIRST tab is the one that learns about it, and it learns the reason.
      await expect(pageA.getByText('Bạn đã vào phòng này ở nơi khác.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(pageA.getByText('Mất kết nối tới phòng.')).toHaveCount(0);
      await expect(pageA.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
      // And it does not quietly reconnect underneath the sentence.
      expect(await localAudioTrackStates(pageA)).not.toContain('live');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a browser that refuses to play the room says so, and the button turns it on', async ({
    browser,
  }) => {
    /**
     * The failure that looks most like success: the chip says the room is up,
     * everybody is listed, and there is silence.
     *
     * Nothing in the product noticed it before this case — no listener on
     * `AudioPlaybackStatusChanged`, no sentence, no gesture — and nothing in the
     * suite could have, because `--autoplay-policy=no-user-gesture-required` is in
     * the launch args. {@link refuseAudioPlayback} puts the policy back for ONE
     * context, so both halves run here for real: the room really is up, the audio
     * really is refused, and `room.startAudio()` really lifts it.
     */
    const people = identities('04');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);
    await refuseAudioPlayback(contextB);

    try {
      /**
       * The BLOCKED browser joins FIRST, into an empty room, and this order is the
       * whole test.
       *
       * Joining second, there is already a track to play, so playback is refused
       * during the handshake and the one-shot `setAudioBlocked(!canPlaybackAudio)`
       * after `connect()` catches it — which means the case passed with the
       * `AudioPlaybackStatusChanged` registration deleted. Measured, by deleting
       * it. Joining an EMPTY room there is nothing to play and nothing to refuse,
       * so the only thing that can ever raise the sentence is the event that fires
       * when somebody else starts publishing.
       */
      const pageB = await joinAs(contextB, people.b, ROOM_AUTOPLAY);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      await expect(peopleCount(pageB)).toHaveText('Có 1 người trong phòng.', { timeout: 30_000 });
      // Nothing to hear yet, so nothing to complain about yet.
      await expect(pageB.getByText('Trình duyệt đang chặn âm thanh của phòng.')).toHaveCount(0);

      const pageA = await joinAs(contextA, people.a, ROOM_AUTOPLAY);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      // The room really is up for B — this is not a join that failed quietly.
      await expect(peopleCount(pageB)).toHaveText('Có 2 người trong phòng.', { timeout: 30_000 });

      await expect(pageB.getByText('Trình duyệt đang chặn âm thanh của phòng.')).toBeVisible({
        timeout: 30_000,
      });

      // The gesture. Playback is allowed again first, exactly as a real browser
      // allows it once a user has clicked something.
      await pageB.evaluate(() => {
        (window as unknown as { __stuwithAllowPlayback: () => void }).__stuwithAllowPlayback();
      });
      await pageB.getByRole('button', { name: 'Bật âm thanh' }).click();
      await expect(pageB.getByText('Trình duyệt đang chặn âm thanh của phòng.')).toHaveCount(0, {
        timeout: 30_000,
      });
      // And the sound arrives: the whole point of the button.
      await expect.poll(() => inboundAudioBytes(pageB), { timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('Để nguyên publishes the CANVAS track, never the camera, and the other side decodes it', async ({
    browser,
  }) => {
    /**
     * **The boundary probe this story exists for.**
     *
     * `epic-2-context.md` and AD-30 rule (b): the track reaching LiveKit has
     * already been through the face pipeline, in every mode including "Để
     * nguyên", because attaching a processor after publishing leaves a window in
     * which raw frames have left the machine — and that window is closed by
     * structure rather than by timing.
     *
     * Four assertions, and the FIRST is the one that carries the story. The other
     * three are satisfied just as well by a build that publishes the camera
     * directly, which is exactly the trap: a room where video works is not
     * evidence that the frames on the wire are the ones we drew.
     */
    const people = identities('05');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_VIDEO);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_VIDEO);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      await expect(peopleCount(pageB)).toHaveText('Có 2 người trong phòng.', { timeout: 30_000 });

      // A really is publishing a face: its own preview only renders once the
      // canvas track is on the wire.
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => videoSenderCount(pageA), { timeout: 30_000 }).toBeGreaterThan(0);

      /* -- 1. Track identity on the wire. AD-30 rule (b), as a measurement. -- */

      const canvasIds = await canvasTrackIds(pageA);
      const cameraIds = await cameraTrackIds(pageA);
      /**
       * Two guards against being vacuously right, and both were needed: with no
       * camera opened, "the sender is not a camera track" is true of a room with
       * no video at all; with no canvas built, "the sender is a canvas track" has
       * an empty set on both sides of the question.
       */
      expect(cameraIds.length, 'the camera must really have been opened').toBeGreaterThan(0);
      expect(canvasIds.length, 'a canvas track must really have been created').toBeGreaterThan(0);
      // Disjoint, so "in the canvas set" and "not in the camera set" are two
      // different facts rather than one fact said twice.
      expect(canvasIds.filter((id) => cameraIds.includes(id))).toEqual([]);

      const senderIds = await videoSenderTrackIds(pageA);
      expect(senderIds.length, 'there must be a video track being sent').toBeGreaterThan(0);
      /**
       * `expect.soft` on BOTH halves, so a failing run prints the asymmetry rather
       * than stopping at the first line. Publishing `handle.camTrack` instead of
       * the pipeline's track turns both of these and leaves 2, 3 and 4 green —
       * which is the shape the spec asked to be able to see.
       */
      expect
        .soft(
          senderIds.filter((id) => !canvasIds.includes(id)),
          'every video track being sent must have come from canvas.captureStream()',
        )
        .toEqual([]);
      expect
        .soft(
          senderIds.filter((id) => cameraIds.includes(id)),
          'no track getUserMedia handed out may ever reach an RTCRtpSender',
        )
        .toEqual([]);

      /* -- 2. The video really was negotiated. -- */

      const sdp = (await negotiatedDescriptions(pageA)).join('\n');
      expect(sdp, 'the publisher must have a negotiated video description').toContain('m=video');

      /* -- 3. The other side decoded real frames, not just a handshake. -- */

      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.bytesReceived), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.framesDecoded), { timeout: 30_000 })
        .toBeGreaterThan(0);

      /* -- 4. And a person can see it: the row draws a face, not the letters. -- */

      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      /**
       * And it is PLAYING, not merely mounted: `videoWidth` is zero until a frame
       * has been decoded into the element, so `toBeVisible()` on an empty box with
       * a CSS size would not have said this.
       */
      await expect
        .poll(
          () =>
            remoteVideos(pageB).evaluate((element) =>
              element instanceof HTMLVideoElement ? element.videoWidth : 0,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);

      /* ---- 5. show → hide → show, which is where a stale pipeline shows up ---- */

      /**
       * The round trip, and it has to start from a room that is ALREADY showing —
       * that is the whole discrimination. Drop the line that forgets the pipeline
       * on the way down, and the way back up republishes the STOPPED canvas track:
       * the far side then holds a track that never carries a frame while the local
       * preview goes on saying "Đây là hình mọi người đang thấy", and every other
       * assertion in this file stays green because `m=video` is still negotiated,
       * a sender still exists, and its id is still A canvas id.
       *
       * Measured: written as a round trip from a room that had never shown a face,
       * that mutation passed. What catches it is the id NOT being one of the ids
       * from before the cycle.
       */
      const beforeCycleIds = await canvasTrackIds(pageA);
      await roomModeGroup(pageA).getByRole('radio', { name: 'Ẩn mặt' }).check();
      await expect(remoteVideos(pageB)).toHaveCount(0, { timeout: 30_000 });
      /**
       * And a deliberate hide is SILENT about faults — the same claim the clean
       * leave above makes, and the one that catches a teardown which does not
       * settle.
       *
       * Measured: forget the pipeline on the way down and the reconciler stops
       * making progress. Unbounded that took the whole page with it; bounded, it
       * gives up and prints "Không dựng được hình để gửi đi" at somebody who only
       * pressed Ẩn mặt — and every assertion after this point still passes,
       * because giving up also repairs the state it gave up on. This line is what
       * sees it. Scoped to `main`, because Next renders its own route announcer as
       * a `role="alert"` outside the page content.
       */
      // `:not(:empty)` because Story 2.5's ladder banner is a PERSISTENT
      // `role="alert"` region — a live region inserted together with its content
      // is commonly missed by AT, so it exists empty and fills. "No alert" has
      // always meant "nothing announced", which is what an empty region does.
      await expect(pageA.locator('main [role="alert"]:not(:empty)')).toHaveCount(0);

      await roomModeGroup(pageA).getByRole('radio', { name: 'Để nguyên' }).check();
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });

      const afterCycleIds = await canvasTrackIds(pageA);
      const cycleSenderIds = await videoSenderTrackIds(pageA);
      expect(afterCycleIds.length, 'the second pass must build its OWN canvas track').toBeGreaterThan(
        beforeCycleIds.length,
      );
      expect(cycleSenderIds.length, 'there must be a video track being sent').toBeGreaterThan(0);
      expect.soft(cycleSenderIds.filter((id) => !afterCycleIds.includes(id))).toEqual([]);
      expect.soft(cycleSenderIds.filter((id) => cameraIds.includes(id))).toEqual([]);
      expect
        .soft(
          cycleSenderIds.filter((id) => beforeCycleIds.includes(id)),
          'the republished track must be the NEW canvas track, not the stopped one',
        )
        .toEqual([]);
      // And the picture is really moving again, which a stopped track cannot do.
      const framesBefore = (await inboundVideo(pageB)).framesDecoded;
      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.framesDecoded), { timeout: 30_000 })
        .toBeGreaterThan(framesBefore);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('Ẩn mặt has no video sender at all, and never asks for a camera', async ({ browser }) => {
    /**
     * "Ẩn mặt là vắng mặt, không phải im lặng." A sender holding a muted track is
     * still a track that left the machine, and the last rung of both degradation
     * ladders (2.5 and the filter one) is this mode — so it must not depend on a
     * pipeline that may be the thing that broke.
     *
     * Read from B as well as from A: the absence is asserted where it matters, on
     * the screen of the person who might have seen a face.
     */
    const people = identities('06');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_HIDDEN, 'hide');
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_HIDDEN);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      await expect(peopleCount(pageB)).toHaveText('Có 2 người trong phòng.', { timeout: 30_000 });

      // B is really connected to A — the sound proves the session is live, so the
      // absence below is an absence of VIDEO rather than of a room.
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      // Long enough for a shell that WAS going to publish to have done so.
      await pageA.waitForTimeout(3_000);
      expect(await videoSenderCount(pageA), 'Ẩn mặt must have NO video sender').toBe(0);
      expect(await videoSenderTrackIds(pageA)).toEqual([]);
      /**
       * Exactly one, and it is pre-join's `{video, audio}` at mount. The room asked
       * for none — which is what makes "the camera light never came on in the
       * room" a property of the code rather than of a flag.
       */
      expect(await videoRequestCount(pageA)).toBe(1);
      expect(await canvasTrackIds(pageA)).toEqual([]);

      // And nobody sees a face of theirs: B draws the letters for A's row.
      await expect(remoteVideos(pageB)).toHaveCount(0);

      /* ---- and Ẩn mặt → Để nguyên, which is a first publish AFTER connecting ---- */

      /**
       * The only route through `openCamera` → `buildPipeline` → `publishVideo`
       * with the room already up — every other case builds the pipeline alongside
       * the handshake. The identity rule has to hold on this path too, so the
       * sender's id is read again rather than assumed from the other case.
       */
      await roomModeGroup(pageA).getByRole('radio', { name: 'Để nguyên' }).check();

      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.framesDecoded), { timeout: 30_000 })
        .toBeGreaterThan(0);

      const canvasIds = await canvasTrackIds(pageA);
      const cameraIds = await cameraTrackIds(pageA);
      const senderIds = await videoSenderTrackIds(pageA);
      expect(canvasIds.length, 'a canvas track must really have been created').toBeGreaterThan(0);
      expect(cameraIds.length, 'the camera must really have been opened').toBeGreaterThan(0);
      expect(senderIds.length, 'there must be a video track being sent').toBeGreaterThan(0);
      expect
        .soft(
          senderIds.filter((id) => !canvasIds.includes(id)),
          'the track published after connecting must have come from canvas.captureStream()',
        )
        .toEqual([]);
      expect
        .soft(
          senderIds.filter((id) => cameraIds.includes(id)),
          'no track getUserMedia handed out may ever reach an RTCRtpSender',
        )
        .toEqual([]);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a hidden tab stops sending a picture, and the face mode does not change', async ({
    browser,
  }) => {
    /**
     * **Người dùng chốt 2026-09-14.** A hidden tab throttles timers, so a canvas
     * that kept publishing would send the last frame it drew for as long as the
     * tab stayed away: everybody else sees a photograph of somebody who is not
     * there, which reads as presence and is worse than an avatar. So the draw loop
     * stops on purpose and the publication is muted.
     *
     * The mode is NOT touched, and that is the half that matters most — coming
     * back resumes on its own, so no system event has moved anybody to "Để
     * nguyên", which `epic-2-context.md` forbids outright.
     *
     * Every assertion is read from the SECOND browser. Reading our own state would
     * prove that our handler ran; reading B's tile proves the far side stopped
     * receiving a picture and started receiving one again.
     */
    const people = identities('07');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_HIDDEN_TAB);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_HIDDEN_TAB);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // B is really seeing A's face before anything is hidden.
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });

      await setTabHidden(pageA, true);

      // The far side loses the picture and gets the letters back. Deleting the
      // `visibilitychange` registration turns this line.
      await expect(remoteVideos(pageB)).toHaveCount(0, { timeout: 30_000 });

      // A's own screen has NOT changed mode: the radio is still on "Để nguyên".
      await expect(pageA.getByText('Bạn đang để nguyên khuôn mặt.')).toBeVisible();

      await setTabHidden(pageA, false);

      // And it comes back on its own, with no press.
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.framesDecoded), { timeout: 30_000 })
        .toBeGreaterThan(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a camera that ends from outside goes back to Ẩn mặt, and never back on its own', async ({
    browser,
  }) => {
    /**
     * The matrix row "camera bị rút giữa phòng", and the half of
     * `deferred-work.md`'s track-`ended` item that has consequences.
     *
     * With a canvas drawing from a dead camera, the far side keeps receiving the
     * LAST FRAME — a photograph of somebody who is not there, under a row that
     * says the picture is live. So the answer is Ẩn mặt plus a sentence; and the
     * thing this case is really guarding is the second half of
     * `epic-2-context.md`'s rule: nothing puts anybody BACK on "Để nguyên" except
     * a press. A recovery path that re-asked for the device would pass every other
     * assertion here.
     */
    const people = identities('08');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_CAMERA_GONE);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_CAMERA_GONE);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // B is really seeing A before anything is taken away — otherwise everything
      // below would pass on a room where video never worked.
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });

      await endLocalCamera(pageA);

      // A stays IN the room and says which half is missing.
      await expect(
        pageA.getByText('Camera đã ngừng hoạt động. Bạn đang ở chế độ ẩn mặt.'),
      ).toBeVisible();
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible();
      await expect(pageA.getByText('Bạn đang ẩn mặt.')).toBeVisible();
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toHaveCount(0);

      // And the unpublish travelled: B's row is the letters again. This is the
      // half no render test can reach.
      await expect(remoteVideos(pageB)).toHaveCount(0, { timeout: 30_000 });
      // The sound is untouched — video may stop, tiếng thì không.
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      // Nothing re-asks, and nothing drifts back: still Ẩn mặt a few seconds on,
      // and no second camera request was ever made.
      await pageA.waitForTimeout(3_000);
      expect(await videoSenderCount(pageA)).toBe(0);
      expect(await videoRequestCount(pageA)).toBe(2);
      await expect(remoteVideos(pageB)).toHaveCount(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a room token that refuses the camera source says so, and the sound is untouched', async ({
    browser,
  }) => {
    /**
     * `room.errorVideoRefused` — the branch for "the server said no to my picture".
     *
     * It cannot happen with the product's own grant, which allows the camera, so
     * the only honest way to execute it is to narrow the grant on a REAL token and
     * let a REAL `livekit-server` refuse the publish.
     * `roomTokenWithoutCameraSource` does that without re-implementing anything:
     * `mintRoomToken` mints the token, one claim of the decoded payload is
     * narrowed, and it is signed again with the same secret — so a change to the
     * grant's shape travels here, which a hand-built token would not.
     *
     * The assertion that matters most is the LAST one. `epic-2-context.md` ranks
     * audio above video without exception, so a refused picture must cost the
     * picture and nothing else: B still hears A.
     */
    const people = identities('09');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_NO_CAMERA_GRANT, 'show', {
        roomTokenWithoutCameraSource: true,
      });
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_NO_CAMERA_GRANT);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // The sentence, and the person is still IN the room.
      await expect(
        pageA.getByText('Phòng không nhận hình của bạn. Bạn vẫn nghe được mọi người.'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible();
      await expect(peopleCount(pageA)).toHaveText('Có 2 người trong phòng.', { timeout: 30_000 });

      // No sender, and no camera left running for a picture nobody will receive.
      expect(await videoSenderCount(pageA)).toBe(0);
      await expect.poll(() => localVideoTrackStates(pageA), { timeout: 30_000 }).not.toContain('live');
      await expect(remoteVideos(pageB)).toHaveCount(0);
      // No preview either: the caption is evidence, and there is nothing to show.
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toHaveCount(0);

      /**
       * And the sound crossed anyway. Video may be refused; tiếng thì không —
       * read from B, off a real `inbound-rtp`, because our own state cannot say it.
       */
      await expect.poll(() => inboundAudioBytes(pageB), { timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a line that wobbles moves the chip once, after the token’s own delay', async ({ browser }) => {
    /**
     * The matrix row "mạng dao động liên tục", and it now observes the three
     * things the first version of this case could not.
     *
     * 1. **The hold itself.** Reading only the settled state meant deleting
     *    `chipTimer` and calling `setChipRung` synchronously left everything
     *    green — the case asserted where the chip ENDED, which is the same either
     *    way. So the chip is read INSIDE the window, immediately after a drop,
     *    where a debounced chip still says "Mạng tốt" and an undebounced one has
     *    already moved.
     * 2. **That the chip still changes during a sustained wobble.** A window
     *    restarted on every change is pushed forward for ever by a line that
     *    keeps moving, so the chip changes ZERO times while the matrix promises
     *    exactly one. The loop below holds the rung at bậc 3 for most of every
     *    second and flicks it away twice a second, which a restarting timer never
     *    survives — and a fixed window commits on schedule, every time.
     * 3. **That the token is readable under the name the product uses.**
     *    `NETWORK_CHIP_DEBOUNCE_FALLBACK_MS` is numerically identical to the
     *    token, so mistyping the custom property at the `getComputedStyle` call
     *    would make the product behave correctly for the wrong reason, for ever.
     *    Reading the same property here turns a renamed token into a red run
     *    instead of a silent fallback.
     *
     * One browser: this case is about a chip. The LADDER still acts at once,
     * which is the point — the picture really does come off the wire here, and
     * only the chip waits.
     */
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    await interceptSignalQuality(contextA);

    try {
      const pageA = await joinAs(contextA, identities('10').a, ROOM_NETWORK_FLAP);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      await expect(networkChip(pageA)).toHaveText('Mạng tốt', { timeout: 30_000 });

      /* -- 3. The token, read from the page under the product's own name. -- */

      const token = await pageA.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--motion-network-chip-debounce')
          .trim(),
      );
      expect(
        token,
        'the product reads --motion-network-chip-debounce by this exact name; an empty ' +
          'value means the token was renamed and the shell has been falling back ever since',
      ).not.toBe('');
      expect(token, 'the token must be a CSS time the shell can parse').toMatch(/^\d*\.?\d+(ms|s)$/);

      /* -- 1. Inside the window: the chip has NOT moved. -- */

      // The list has to be on screen before the frozen half below can mean
      // anything: a missing `<ul>` reports "not frozen" just as a live one does.
      await expect(pageA.locator('#phong-nguoi-tham-gia')).toHaveCount(1);

      await forceQuality(pageA, QUALITY_POOR);

      /**
       * **BOTH HALVES OF THE INVARIANT, AGAINST ONE INSTANT.**
       *
       * The chip is still holding "Mạng tốt" — that is the debounce doing its
       * job — AND the banner is already there, because the ladder does not wait
       * three seconds to say why a camera went off. Only a build whose two props
       * carry different rungs at this moment can satisfy both at once:
       *
       * - point the banner at the DEBOUNCED rung and `banner` is empty here,
       *   which is the defect this whole split exists to prevent;
       * - point the chip at the LIVE rung and `chip` already reads "Mạng yếu".
       *
       * Asserted as one object rather than as four `expect`s, because four
       * assertions retry on four clocks and a late banner satisfies one written
       * with the default timeout. See {@link INSIDE_THE_WINDOW}.
       */
      await expect
        .poll(() => ladderSnapshot(pageA), { timeout: INSIDE_THE_WINDOW })
        .toEqual({
          chip: 'Mạng tốt',
          banner: 'Mạng yếu nên video đã tắt để giữ tiếng.',
          frozen: false,
          restart: false,
        });

      /**
       * And bậc 4's half, still inside the SAME window the drop above opened.
       *
       * The list freezes from the live rung, so the pair here is a chip that has
       * not moved at all beside a list that already has. `LOST` reaches bậc 4 in
       * one frame; the container-stop case remains the real far-side stimulus
       * for that rung and is untouched.
       */
      await forceQuality(pageA, QUALITY_LOST);
      await expect
        .poll(() => ladderSnapshot(pageA), { timeout: INSIDE_THE_WINDOW })
        .toMatchObject({ chip: 'Mạng tốt', frozen: true });

      await forceQuality(pageA, QUALITY_EXCELLENT);

      /* -- 2. A sustained wobble still moves the chip. -- */

      let sawWeak = false;
      for (let pass = 0; pass < 12; pass += 1) {
        // Two changes back to back, then most of a second at bậc 3: the rung is
        // almost always poor, and it CHANGES twice a second — faster than the
        // window, which is the shape that defeats a restarting timer.
        await forceQuality(pageA, QUALITY_EXCELLENT);
        await forceQuality(pageA, QUALITY_POOR);
        await pageA.waitForTimeout(900);
        if ((await networkChip(pageA).textContent()) === 'Mạng yếu') {
          sawWeak = true;
        }
      }
      expect(
        sawWeak,
        'a chip whose window restarts on every change never updates at all while a line ' +
          'keeps moving — the matrix promises exactly one change, not zero',
      ).toBe(true);

      /* -- and it settles on the LAST value once the line stops moving -- */

      await forceQuality(pageA, QUALITY_EXCELLENT);
      await expect(networkChip(pageA)).toHaveText('Mạng tốt', { timeout: 30_000 });

      /**
       * And the ladder never waited for any of that. `Poor` reached the
       * reconciler immediately, so the picture is off the wire — and it stays off
       * even though the line recovered, because only a press may put it back.
       */
      expect(await videoSenderCount(pageA)).toBe(0);
      await expect(pageA.getByRole('button', { name: 'Bật lại camera' })).toBeVisible();
    } finally {
      await contextA.close();
    }
  });

  test('bậc 3 takes the picture off the wire, keeps the sound, and never restores it by itself', async ({
    browser,
  }) => {
    /**
     * **The rung the whole story is built around.** Three claims, and the third is
     * the one `epic-2-context.md` ranks above everything else:
     *
     * 1. the sender really goes — not a muted track, which is still a track that
     *    left the machine — and the far side really loses the tile;
     * 2. the SOUND keeps moving while it happens. Read off B's own `inbound-rtp`,
     *    because our state cannot say it: video may be sacrificed, tiếng thì
     *    không;
     * 3. recovery restores NOTHING. The chip goes quietly back to "Mạng tốt", no
     *    sender appears, and the only thing that changes is that a button is
     *    offered. A build that republished on recovery would pass 1 and 2 and
     *    fail here, which is why this half is in the same test rather than
     *    trusted to a unit assertion.
     */
    const people = identities('11');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);
    await interceptSignalQuality(contextA);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_NETWORK_WEAK);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_NETWORK_WEAK);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // B is really seeing AND hearing A before anything is taken away. Without
      // this every assertion below would pass on a room that never worked.
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(() => inboundAudioBytes(pageB), { timeout: 30_000 }).toBeGreaterThan(0);
      const audioBefore = await inboundAudioBytes(pageB);

      await forceQuality(pageA, QUALITY_POOR);

      /* -- 1. The sender goes, and the far side loses the tile. -- */

      await expect.poll(() => videoSenderCount(pageA), { timeout: 30_000 }).toBe(0);
      await expect(remoteVideos(pageB)).toHaveCount(0, { timeout: 30_000 });
      // And the camera itself is off — the light a person can check without
      // trusting us. Bậc 3 is "vắng mặt", not a paused picture.
      await expect.poll(() => localVideoTrackStates(pageA), { timeout: 30_000 }).not.toContain('live');

      // In words, both of them: the chip after its delay, and the banner that
      // says what the trade bought.
      await expect(networkChip(pageA)).toHaveText('Mạng yếu', { timeout: 30_000 });
      await expect(pageA.getByText('Mạng yếu nên video đã tắt để giữ tiếng.')).toBeVisible();
      // The person is still IN the room, and their MODE has not been touched.
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible();
      await expect(pageA.getByText('Bạn đang để nguyên khuôn mặt.')).toBeVisible();

      /* -- 2. And the sound never stopped. -- */

      await expect
        .poll(() => inboundAudioBytes(pageB), { timeout: 30_000 })
        .toBeGreaterThan(audioBefore);
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      /* -- 3. Recovery restores nothing, and offers instead. -- */

      await forceQuality(pageA, QUALITY_EXCELLENT);

      /**
       * **The invitation is on the live rung too, and this is what says so.**
       *
       * The mirror of the banner appearing three seconds late is the way OUT
       * appearing three seconds late — somebody looking at a recovered room with
       * no picture and nothing offering it back. `offersCameraRestart` reads the
       * live rung, and until this line nothing observed that: every other
       * assertion about the button runs after the window has closed, by which
       * time both props agree and reading either one passes.
       *
       * The chip is still on "Mạng yếu" here — it committed that value during
       * the bậc 3 stretch above — so the pair can only hold while the two props
       * disagree.
       */
      await expect
        .poll(() => ladderSnapshot(pageA), { timeout: INSIDE_THE_WINDOW })
        .toMatchObject({ chip: 'Mạng yếu', restart: true });

      await expect(networkChip(pageA)).toHaveText('Mạng tốt', { timeout: 30_000 });
      // The alert has gone — going up a rung is silent.
      await expect(pageA.getByText('Mất kết nối — đang thử lại.')).toHaveCount(0);
      // Long enough for a build that was going to republish to have done so.
      await pageA.waitForTimeout(3_000);
      expect(await videoSenderCount(pageA), 'recovery must never republish by itself').toBe(0);
      await expect(remoteVideos(pageB)).toHaveCount(0);

      const restart = pageA.getByRole('button', { name: 'Bật lại camera' });
      await expect(restart).toBeVisible();

      /* -- and the press really works, through Story 2.7's own path -- */

      await restart.click();
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      // The republished track is a CANVAS track, on this path as on every other.
      const canvasIds = await canvasTrackIds(pageA);
      const cameraIds = await cameraTrackIds(pageA);
      const senderIds = await videoSenderTrackIds(pageA);
      expect(senderIds.length, 'there must be a video track being sent').toBeGreaterThan(0);
      expect.soft(senderIds.filter((id) => !canvasIds.includes(id))).toEqual([]);
      expect.soft(senderIds.filter((id) => cameraIds.includes(id))).toEqual([]);
      // The offer is gone once it has been taken.
      await expect(restart).toHaveCount(0);

      /* ---- and the matrix row "bậc 3 rồi rời phòng": leaving FROM bậc 3 ---- */

      /**
       * Back down to bậc 3 first, and that step is the case rather than a
       * preamble.
       *
       * The risk here is the opposite of a leak. `disableVideo` has already run
       * by the time somebody presses "Rời phòng" at bậc 3, so `leave`'s own
       * camera teardown is a no-op — and a no-op cannot tell you whether the path
       * it stands on still exists. Leaving from a room where video is UP would
       * exercise the ordinary teardown and say nothing about this row at all,
       * which is why the quality is dropped again instead of leaving from the
       * recovered state above.
       *
       * What this row really asks is whether any LADDER state outlives the room,
       * and that is the half nothing else in this file reaches: `leave` does not
       * unmount, so the effect's cleanup never runs on this path and the chip's
       * debounce, the rung and the "a picture was taken" memory are all cleared by
       * hand or not at all.
       *
       * Said plainly about what this does NOT cover: bậc 4's thirty-second clock
       * is not running here, because bậc 4 is not this row. `leave` stops both
       * clocks through one call, and the container-stop case is where a clock is
       * ever ticking.
       */
      await forceQuality(pageA, QUALITY_POOR);
      await expect.poll(() => videoSenderCount(pageA), { timeout: 30_000 }).toBe(0);
      await expect(pageA.getByText('Mạng yếu nên video đã tắt để giữ tiếng.')).toBeVisible({
        timeout: 30_000,
      });

      await pageA.getByRole('button', { name: 'Rời phòng' }).click();

      // The ordinary teardown, in full — the same claims the clean-leave case at
      // the top of this file makes, now from a room the ladder had already
      // stripped of video.
      await expect(pageA.getByText('Đã rời phòng', { exact: true })).toBeVisible();
      await expect(pageA.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
      expect(await localAudioTrackStates(pageA)).not.toContain('live');
      expect(await localVideoTrackStates(pageA)).not.toContain('live');
      expect(await videoSenderCount(pageA)).toBe(0);

      /**
       * And NO ladder state survives. Three things, because three different
       * mechanisms could have left one behind: the chip is a rung held in state,
       * the banner is a rung plus a clock, and the invitation is the remembered
       * fact that a picture was taken. All three are gone with the room.
       */
      await expect(networkChip(pageA)).toHaveCount(0);
      // The alert REGION is always mounted so that AT can observe it fill; what
      // must not survive is anything IN it.
      await expect(pageA.locator('#phong-mang-thong-bao')).toBeEmpty();
      await expect(pageA.locator('#phong-mang-bat-lai')).toBeEmpty();
      await expect(pageA.getByRole('button', { name: 'Bật lại camera' })).toHaveCount(0);
      // Scoped to `main`, because Next renders its own route announcer as a
      // `role="alert"` outside the page content. A clean leave is silent about
      // faults, and the ladder must not be the thing that breaks that.
      // `:not(:empty)` because Story 2.5's ladder banner is a PERSISTENT
      // `role="alert"` region — a live region inserted together with its content
      // is commonly missed by AT, so it exists empty and fills. "No alert" has
      // always meant "nothing announced", which is what an empty region does.
      await expect(pageA.locator('main [role="alert"]:not(:empty)')).toHaveCount(0);

      // The far side loses the row, which is how we know the room really ended
      // rather than the screen merely repainting.
      await expect(peopleCount(pageB)).toHaveText('Có 1 người trong phòng.', { timeout: 30_000 });
      await expect(remoteVideos(pageB)).toHaveCount(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a tab hidden AND a line at bậc 3 agree, and unhiding alone puts nothing back', async ({
    browser,
  }) => {
    /**
     * **Two independent "wanted" dimensions aimed at one piece of media.**
     *
     * This is the shape that cost Story 2.7 a loopback, so it gets a case of its
     * own rather than a line inside another. `handle.videoPaused` is what the TAB
     * wants; `handle.networkVideoOff` plus the live rung is what the LADDER wants;
     * `faceModeRef` is what the PERSON wants. Neither of the first two ever says
     * "yes, publish" — they can only refuse — so they cannot contradict each
     * other. What they CAN do is clear at different times, and that is the whole
     * risk: the dimension that clears first must not be read as permission.
     *
     * The sequence walks exactly that. Video is up; the tab goes away (dimension
     * one refuses); the line falls to bậc 3 while it is still away (dimension two
     * refuses as well); then the tab comes back — one refusal lifts, and the
     * other is still standing. A build that treated the unhide as "resume what we
     * had" would republish into a line the ladder had already ruled out, and
     * would do it without anybody pressing anything, which is the rule
     * `epic-2-context.md` puts above the rest.
     *
     * Read from B wherever it can be: a tile that never comes back is a fact
     * about the far side, not about our own state.
     *
     * **The mutation:** in `applyVisibility`, make the unhide path ignore the
     * rung — clear `handle.networkVideoOff` and force `handle.wantedRung` back to
     * 1 when the tab becomes visible. That is "the unhide republishes
     * unconditionally" in two lines, and it leaves the plain bậc 3 case above
     * untouched (it never hides a tab), so this case is the one that goes red.
     */
    const people = identities('14');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);
    await interceptSignalQuality(contextA);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_NETWORK_HIDDEN);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_NETWORK_HIDDEN);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // Bậc 1 with a picture really on the wire. Everything below is about taking
      // it away twice and giving it back once.
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });

      /* -- 1. The TAB refuses. The publication is muted; the ladder is untouched. -- */

      await setTabHidden(pageA, true);
      await expect(remoteVideos(pageB)).toHaveCount(0, { timeout: 30_000 });

      /* -- 2. And now the LADDER refuses too, while the tab is still away. -- */

      await forceQuality(pageA, QUALITY_POOR);
      await expect.poll(() => videoSenderCount(pageA), { timeout: 30_000 }).toBe(0);
      await expect(remoteVideos(pageB)).toHaveCount(0);
      /**
       * The camera itself is off, which separates the two dimensions from each
       * other: a hidden tab MUTES a publication and leaves the device open, while
       * bậc 3 ends it. Without this line "no tile at the far end" would be
       * satisfied by the tab alone and the ladder could have done nothing at all.
       */
      await expect.poll(() => localVideoTrackStates(pageA), { timeout: 30_000 }).not.toContain('live');

      /* -- 3. The tab comes back. ONE refusal lifts; the other still stands. -- */

      await setTabHidden(pageA, false);
      // Long enough for a build that was going to republish to have done so — the
      // whole round trip is camera, pipeline, publish, and it is seconds at most.
      await pageA.waitForTimeout(3_000);
      expect(await videoSenderCount(pageA), 'unhiding alone must not publish anything').toBe(0);
      await expect(remoteVideos(pageB)).toHaveCount(0);
      await expect.poll(() => localVideoTrackStates(pageA), { timeout: 30_000 }).not.toContain('live');
      // No system event has moved anybody's mode, in either direction.
      await expect(pageA.getByText('Bạn đang để nguyên khuôn mặt.')).toBeVisible();
      // And the sound was never part of this.
      await expect.poll(() => subscribedAudioTracks(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      /**
       * There is no invitation YET, and that is the design rather than a gap: at
       * bậc 3 the button would publish straight into the conditions the ladder
       * just refused. The way back is a press, and the press is only offered once
       * the line can carry a picture again.
       */
      await expect(pageA.getByRole('button', { name: 'Bật lại camera' })).toHaveCount(0);
      await expect(pageA.getByText('Mạng yếu nên video đã tắt để giữ tiếng.')).toBeVisible();

      /* -- 4. The line recovers. Still nothing comes back on its own. -- */

      await forceQuality(pageA, QUALITY_EXCELLENT);
      const restart = pageA.getByRole('button', { name: 'Bật lại camera' });
      await expect(restart).toBeVisible({ timeout: 30_000 });
      expect(await videoSenderCount(pageA), 'recovery must never republish by itself').toBe(0);
      await expect(remoteVideos(pageB)).toHaveCount(0);

      /* -- 5. The PRESS is what offers the way back, and it works. -- */

      await restart.click();
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      // And the picture is really moving, which a track restored from a stopped
      // pipeline could not do.
      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.framesDecoded), { timeout: 30_000 })
        .toBeGreaterThan(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('one person’s bad line never takes anybody else’s camera off', async ({ browser }) => {
    /**
     * **The one line stopping a train passenger from hiding four other faces.**
     *
     * `ConnectionQualityChanged` fires for EVERY participant, ours and everybody
     * else's (`room/events.d.ts:222`, `(quality, participant)`). The listener
     * keeps only the local participant's, and without that filter one person on
     * bad wifi would take the camera off every other person in the room — a
     * failure that reads, from the inside, as the product randomly hiding people.
     *
     * Until now nothing could turn that line red. The seam overwrote every entry
     * in a quality frame by construction, so both participants always went poor
     * together and a build with no filter at all produced identical output.
     *
     * **The shape of the assertion, and why it needs no knowledge of which sid is
     * which.** The frame names two people. Exactly ONE of them may be able to
     * take this browser's camera off. Delete the filter and both can, so the
     * count is two; filter on the wrong participant and the count is still one,
     * but the OTHER assertion in the loop — that B's tile never goes — is what
     * catches that. Neither spelling requires us to know which entry is local,
     * which is knowledge the page does not expose and a test has no business
     * reconstructing.
     */
    const people = identities('15');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);
    await interceptSignalQuality(contextA);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_NETWORK_FILTER);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_NETWORK_FILTER);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // Both cameras really are on the wire before anything is injected.
      await expect.poll(() => videoSenderCount(pageA), { timeout: 30_000 }).toBeGreaterThan(0);
      await expect(remoteVideos(pageA)).toHaveCount(1, { timeout: 30_000 });
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });

      const entries = await waitForQualityEntries(pageA, 2);

      const tookTheCamera: boolean[] = [];
      for (let index = 0; index < entries; index += 1) {
        await forceQuality(pageA, QUALITY_POOR, index);
        // Long enough for a ladder that was going to act to have acted: the whole
        // teardown is an unpublish and a stopped capture.
        await pageA.waitForTimeout(3_000);
        const gone = (await videoSenderCount(pageA)) === 0;
        tookTheCamera.push(gone);

        /**
         * B's tile is read every pass, and it is the half that says the filter
         * kept the RIGHT participant. Nothing injected into A's page may change
         * what B publishes — B's own line was never touched — so a pass that
         * blanked it would mean A had acted on somebody else's quality.
         */
        await expect(remoteVideos(pageA)).toHaveCount(1);

        await forceQuality(pageA, QUALITY_EXCELLENT, index);
        if (gone) {
          // Put the room back the way the next pass needs it — and through the
          // product's own way back, never by waiting for a republish nobody
          // asked for.
          await pageA.getByRole('button', { name: 'Bật lại camera' }).click();
          await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
            timeout: 30_000,
          });
          await expect.poll(() => videoSenderCount(pageA), { timeout: 30_000 }).toBeGreaterThan(0);
        }
      }

      expect(
        tookTheCamera.filter(Boolean).length,
        `exactly one of the ${entries} people in this frame may control this browser's camera; ` +
          'two means the local-participant filter is gone, zero means the ladder stopped ' +
          'listening at all',
      ).toBe(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('stopping the real livekit-server puts the screen on bậc 4 and freezes the list', async ({
    browser,
  }) => {
    /**
     * **The far-side stimulus, and the only one this story has.**
     *
     * `AGENTS.md` §4: the mutation lives on the other side of the boundary. For
     * "mất kết nối" there is no honest way to do that from inside the page — a
     * wrapped `WebSocket` is a mutation on OUR side, which is exactly what
     * `deferred-work.md` recorded Story 2.3 as unable to escape. So the container
     * is stopped: the server, in the medium where it lives, goes away mid-session.
     *
     * It is also the mutation for this case. Leave the container running and
     * bậc 4 never arrives; delete the `ConnectionStateChanged` half of `applyRung`
     * and the screen sits on "Mạng tốt" over a room that has stopped existing.
     */
    const people = identities('12');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_NETWORK_LOST);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_NETWORK_LOST);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      await expect(peopleCount(pageA)).toHaveText('Có 2 người trong phòng.', { timeout: 30_000 });
      // The room really is carrying sound before it is taken away.
      await expect.poll(() => inboundAudioBytes(pageA), { timeout: 30_000 }).toBeGreaterThan(0);

      try {
        await stopLiveKitContainer();

        // The screen says it, in words, and the list says it is frozen.
        await expect(pageA.getByText('Mất kết nối — đang thử lại.')).toBeVisible({ timeout: 60_000 });
        await expect(pageA.getByText('Lưới đang đóng băng cho tới khi nối lại được.')).toBeVisible();
        /**
         * The thirty-second clock is RUNNING, and this is the line that says so.
         *
         * Making `armRetryClock` a no-op leaves `networkRetrySeconds` null for
         * ever — the banner then renders the same sentence every other assertion
         * here reads, and the whole case stays green over a dead clock. The
         * countdown is the only thing on screen that a stopped clock cannot
         * produce, and it is asserted by shape rather than by value so this does
         * not have to wait the window out.
         */
        await expect(pageA.getByText(/Thử lại sau \d+ giây\./)).toBeVisible({ timeout: 30_000 });
        await expect(pageA.locator('#phong-nguoi-tham-gia.participant-list-frozen')).toHaveCount(1);
        // No network chip at bậc 4 — the phase chip owns the state there, and two
        // chips telling one story is the contradiction the panel refuses.
        await expect(networkChip(pageA)).toHaveCount(0);

        /**
         * And the sound really has gone. This is the half that separates "the
         * screen noticed" from "the screen guessed": with the server stopped no
         * RTP can arrive, so `bytesReceived` stops moving — measured over a
         * window rather than asserted as a number, because the total is whatever
         * the session had already carried.
         */
        await pageA.waitForTimeout(3_000);
        const settled = await inboundAudioBytes(pageA);
        await pageA.waitForTimeout(5_000);
        expect(await inboundAudioBytes(pageA), 'no audio may arrive from a server that is gone').toBe(
          settled,
        );
      } finally {
        // Started again before anything else, so a later case — and the global
        // teardown — still find a container where they left one.
        await startLiveKitContainer();
      }
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('simulcast really reaches the wire, which is what bậc 1 and bậc 2 stand on', async ({
    browser,
  }) => {
    /**
     * **Bậc 1 stated as a measurement.**
     *
     * Without simulcast there is nothing between "the whole picture" and "no
     * picture", so bậc 2 — the rung that tụt lặng lẽ — would not exist. That the
     * ladder HAS a middle is therefore a claim about the SDP rather than about a
     * boolean in a config object, and `videoPublishOptions().simulcast` being
     * `true` is satisfied just as well by a build the SDK ignored.
     *
     * `a=rid:` and `a=simulcast:send` are what Chromium writes when the publisher
     * was given more than one `sendEncoding`. TWO rather than three is the right
     * number and is not a weakening: `computeVideoEncodings` adds a third layer
     * only above a 960px long edge, and `pipelineSizeFor` caps the canvas at
     * 640×480.
     *
     * **The mutation, and it must be RUN:** set `simulcast: false` in
     * `videoPublishOptions()` and re-run. `computeVideoEncodings` then returns a
     * single encoding, Chromium writes no rid and no simulcast line, and this case
     * goes red while every other case in this file stays green. The field is typed
     * `boolean` rather than literal `true` for exactly that reason — a mutation
     * that cannot be run is a mutation nobody has ever run.
     *
     * LAST in the file on purpose. The project is `serial`, so a failure skips
     * everything after it; anywhere earlier, this mutation would leave the other
     * three ladder cases SKIPPED rather than green, and a skipped case proves
     * nothing.
     */
    const people = identities('13');
    const contextA = await browser.newContext(CONTEXT_OPTIONS);
    const contextB = await browser.newContext(CONTEXT_OPTIONS);

    try {
      const pageA = await joinAs(contextA, people.a, ROOM_SIMULCAST);
      await expect(pageA.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });
      const pageB = await joinAs(contextB, people.b, ROOM_SIMULCAST);
      await expect(pageB.getByText('Đang ở trong phòng')).toBeVisible({ timeout: 30_000 });

      // A is really publishing a face, and B is really decoding it — otherwise
      // the SDP below would be an assertion about a negotiation nobody used.
      await expect(pageA.getByText('Đây là hình mọi người đang thấy.')).toBeVisible({
        timeout: 30_000,
      });
      await expect(remoteVideos(pageB)).toHaveCount(1, { timeout: 30_000 });
      await expect
        .poll(() => inboundVideo(pageB).then((stats) => stats.framesDecoded), { timeout: 30_000 })
        .toBeGreaterThan(0);

      const layers = await videoSimulcast(pageA);
      expect(
        layers.simulcastLines,
        'the publisher must declare simulcast on its video m-line',
      ).toBeGreaterThan(0);
      expect(
        [...new Set(layers.rids)].length,
        'the ladder needs more than one encoding to fall down through',
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
