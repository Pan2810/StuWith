import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { LIVEKIT_HANDOFF_FILE, WEB_BASE_URL } from '../../../playwright.config';
import { roomPathname, scenario } from '../support/scenario';

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
       */
      await expect(pageB.getByText('Đang nói')).toBeVisible({ timeout: 30_000 });

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
      await expect(pageA.locator('main [role="alert"]')).toHaveCount(0);
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
      await expect(pageA.locator('main [role="alert"]')).toHaveCount(0);

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
});
