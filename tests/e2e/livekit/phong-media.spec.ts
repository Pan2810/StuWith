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
    const devices = navigator.mediaDevices;
    if (devices !== undefined) {
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await original(constraints);
        streams.push(stream);
        return stream;
      };
    }
  });
}

/** A fresh context with the probe's two wrappers installed, signed in as one person. */
async function joinAs(context: BrowserContext, userId: string, room: string = ROOM): Promise<Page> {
  await collectPeerConnections(context);
  await rememberStreams(context);
  const page = await context.newPage();
  await scenario(page, { signedIn: true, userId, useLiveKit: true });
  await page.goto(room);
  await expect(page.locator('video')).toBeVisible();
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
});
