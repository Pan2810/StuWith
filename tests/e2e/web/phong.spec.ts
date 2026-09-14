import { expect, test, type Page } from '@playwright/test';
import { FAKE_API_BASE_URL, WEB_BASE_URL } from '../../../playwright.config';
import { CREATE_ROOM_PATHNAME, roomPathname, scenario } from '../support/scenario';

/**
 * Story 2.3's screen, in a real Chromium with fake devices.
 *
 * `pre-join.test.tsx` covers every decision and every branch of the markup, and
 * says what it cannot: that React runs the page's effects, that `getUserMedia` is
 * asked and its answer classified, that "Ẩn mặt" really ENDS the camera track,
 * that a press of "Vào phòng" really posts to the token endpoint, and that the
 * shell really appears only after a `201`. Those are the cases here.
 *
 * ## Two seams, and which one is the product's
 *
 * - The refused-device rows are produced by overriding
 *   `navigator.mediaDevices.getUserMedia` with `addInitScript` so it throws the
 *   named `DOMException`. That is a seam INSIDE the browser, not a product seam:
 *   the product's boundary with the device is the browser's own API, and nothing
 *   of ours sits on the far side of it to mutate. It is recorded here so nobody
 *   mistakes a green run for proof about a real permission prompt.
 * - The **negative probe** is the other way round. `guardMediaPlane` wraps
 *   `RTCPeerConnection` and `WebSocket`, records every stream `getUserMedia`
 *   hands out and every URL a socket was opened to, and listens to every request
 *   the page makes. From Story 2.4 it asserts in TWO PHASES, because the claim
 *   changes at admission and only one half of it was ever about zero:
 *   {@link expectNoMediaPlane} holds while the pre-join screen is up — nothing on
 *   the media plane exists, which is what "pre-join cannot be skipped" means in
 *   the network — and {@link expectMediaPlaneOnlyToRoom} holds after it, where
 *   the plane is open and the only address it reaches is the one the token named.
 *   Both mutations are on the client: a `WebSocket(url)` during pre-join turns
 *   the first, a second origin turns the second. Proving that sound really
 *   crosses the browser ↔ LiveKit boundary needs a real server on the far side
 *   and is `tests/e2e/livekit/phong-media.spec.ts`, which is where the far-side
 *   mutation `deferred-work.md` asked Story 2.4 for now lives.
 */

const ROOM_ID = '019200f1-0000-7000-8000-000000000001';
const ROOM = roomPathname(ROOM_ID);

/** Every request the page made, by URL, and the media-plane counters. */
interface MediaPlaneProbe {
  readonly requests: string[];
  readonly counters: () => Promise<{ peerConnections: number; webSockets: number }>;
  /** Every URL a `WebSocket` was constructed with, in order. Story 2.4. */
  readonly webSocketUrls: () => Promise<string[]>;
  /** Every ICE server URL an `RTCPeerConnection` was CONFIGURED with. Story 2.4. */
  readonly iceServerUrls: () => Promise<string[]>;
  readonly videoTrackStates: () => Promise<string[]>;
  readonly audioTrackStates: () => Promise<string[]>;
  readonly getUserMediaCalls: () => Promise<number>;
}

/**
 * Whether the mounted `<video>` is really PLAYING the camera: its `srcObject` is a
 * `MediaStream` with a live video track, and frames have arrived (`videoWidth`).
 * `toBeVisible()` alone is satisfied by an empty box with a CSS size.
 */
const previewIsLive = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector('video');
    const stream = element?.srcObject;
    return (
      element !== null &&
      stream instanceof MediaStream &&
      stream.getVideoTracks().some((track) => track.readyState === 'live') &&
      element.videoWidth > 0
    );
  });

/**
 * Installed BEFORE navigation. Wraps the two media-plane constructors with a
 * Proxy whose `construct` trap counts and then defers to the real one, so a real
 * connection would still be made — and counted.
 */
async function guardMediaPlane(page: Page): Promise<MediaPlaneProbe> {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });
  await page.addInitScript(() => {
    const probe = {
      peerConnections: 0,
      webSockets: 0,
      getUserMediaCalls: 0,
      streams: [] as MediaStream[],
      webSocketUrls: [] as string[],
      iceServerUrls: [] as string[],
    };
    (window as unknown as { __stuwithProbe: typeof probe }).__stuwithProbe = probe;

    const counted = <T extends new (...args: never[]) => object>(
      Original: T,
      bump: (args: unknown[]) => void,
    ): T =>
      new Proxy(Original, {
        construct(target, args, newTarget) {
          bump(args as unknown[]);
          return Reflect.construct(target, args, newTarget) as object;
        },
      });
    if (typeof window.RTCPeerConnection === 'function') {
      window.RTCPeerConnection = counted(window.RTCPeerConnection, (args) => {
        probe.peerConnections += 1;
        // The CONFIGURATION as well as the count. After admission a peer
        // connection is allowed to exist, so the question becomes which addresses
        // it was built to reach — and an ICE server is an address like any other.
        const configuration = args[0] as RTCConfiguration | undefined;
        for (const server of configuration?.iceServers ?? []) {
          const urls = server.urls;
          for (const url of typeof urls === 'string' ? [urls] : urls) {
            probe.iceServerUrls.push(url);
          }
        }
      });
    }
    if (typeof window.WebSocket === 'function') {
      window.WebSocket = counted(window.WebSocket, (args) => {
        probe.webSockets += 1;
        // The URL as well as the count, because from Story 2.4 the question is no
        // longer "was one opened" but "was one opened anywhere it should not be".
        probe.webSocketUrls.push(String(args[0]));
      });
    }

    // Every stream the product is handed is remembered, so a spec can ask each
    // track's `readyState` without the page having to expose its own refs.
    const devices = navigator.mediaDevices;
    if (devices !== undefined) {
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        probe.getUserMediaCalls += 1;
        const stream = await original(constraints);
        probe.streams.push(stream);
        return stream;
      };
    }
  });

  return {
    requests,
    counters: () =>
      page.evaluate(() => {
        const probe = (window as unknown as { __stuwithProbe: { peerConnections: number; webSockets: number } })
          .__stuwithProbe;
        return { peerConnections: probe.peerConnections, webSockets: probe.webSockets };
      }),
    webSocketUrls: () =>
      page.evaluate(
        () => (window as unknown as { __stuwithProbe: { webSocketUrls: string[] } }).__stuwithProbe.webSocketUrls,
      ),
    iceServerUrls: () =>
      page.evaluate(
        () => (window as unknown as { __stuwithProbe: { iceServerUrls: string[] } }).__stuwithProbe.iceServerUrls,
      ),
    videoTrackStates: () =>
      page.evaluate(() =>
        (window as unknown as { __stuwithProbe: { streams: MediaStream[] } }).__stuwithProbe.streams.flatMap(
          (stream) => stream.getVideoTracks().map((track) => track.readyState as string),
        ),
      ),
    audioTrackStates: () =>
      page.evaluate(() =>
        (window as unknown as { __stuwithProbe: { streams: MediaStream[] } }).__stuwithProbe.streams.flatMap(
          (stream) => stream.getAudioTracks().map((track) => track.readyState as string),
        ),
      ),
    getUserMediaCalls: () =>
      page.evaluate(
        () => (window as unknown as { __stuwithProbe: { getUserMediaCalls: number } }).__stuwithProbe.getUserMediaCalls,
      ),
  };
}

/**
 * The media plane's address, as the stand-in API puts it in the `201`.
 *
 * Spelled by hand for the reason every route in `scenario.ts` is: a test that
 * imports the constant it is checking cannot notice the constant changing under
 * the product. The `http` spelling is the same host — `livekit-client` falls back
 * to a plain request against `/rtc/validate` when the socket is refused, and that
 * request is part of "the media plane", not a stranger.
 */
const LIVEKIT_WS_ORIGIN = 'ws://127.0.0.1:7880';
const LIVEKIT_HTTP_ORIGIN = 'http://127.0.0.1:7880';

/**
 * The negative probe, for the phase where it is still absolute: BEFORE admission.
 *
 * This is the property Story 2.3 shipped and Story 2.4 does not relax — nobody
 * lands in a room without deciding, so nothing on the media plane may exist while
 * the pre-join screen is up. After admission the claim changes shape rather than
 * disappearing; that half is {@link expectMediaPlaneOnlyToRoom}.
 */
async function expectNoMediaPlane(probe: MediaPlaneProbe): Promise<void> {
  const counters = await probe.counters();
  expect(counters.peerConnections, 'no RTCPeerConnection may be constructed before admission').toBe(0);
  expect(counters.webSockets, 'no WebSocket may be opened before admission').toBe(0);
  const strangers = probe.requests.filter(
    (url) => !url.startsWith(WEB_BASE_URL) && !url.startsWith(FAKE_API_BASE_URL),
  );
  expect(strangers, 'no request may leave the web origin or the stand-in API').toEqual([]);
}

/**
 * The probe's second phase: the media plane is open, and open to exactly one place.
 *
 * "Zero connections" was the whole assertion while nothing connected. Now that
 * `RoomShell` does, the assertion that carries the same weight is that the ONLY
 * address it reaches is the one the token named — a socket to any other origin,
 * or a request to any host but the web origin, the stand-in API and LiveKit, is
 * still red. The mutation is the same shape as before and still on the client:
 * point `Room.connect` at a second URL and this turns.
 *
 * There is no real LiveKit behind this port in the `web` project, and that is on
 * purpose: proving that sound crosses the boundary needs a real server and is
 * `tests/e2e/livekit/phong-media.spec.ts`. What this proves is the address.
 */
async function expectMediaPlaneOnlyToRoom(probe: MediaPlaneProbe): Promise<void> {
  const sockets = await probe.webSocketUrls();
  expect(sockets.length, 'Story 2.4 must open the media plane once admitted').toBeGreaterThan(0);
  expect(
    sockets.filter((url) => !url.startsWith(LIVEKIT_WS_ORIGIN)),
    'the only socket allowed is the one the token named',
  ).toEqual([]);

  /**
   * The `RTCPeerConnection` half, which the first version of this function
   * dropped entirely.
   *
   * Before Story 2.4 the assertion was `peerConnections === 0`, and rewriting the
   * function for the post-admission phase deleted it rather than adapting it — so
   * a peer connection built against somebody else's STUN or TURN server became
   * invisible to a probe whose whole job is to say where the media plane may
   * reach. `0` is no longer the right claim (2.4 is allowed to build one), so the
   * claim is about the ADDRESSES it is configured with: every ICE server a
   * connection is constructed with has to be on the host the token named, and a
   * configuration is as much a place traffic goes as a URL is.
   */
  const strangeIceServers = await probe.iceServerUrls();
  expect(
    strangeIceServers.filter((url) => !url.includes('127.0.0.1')),
    'no RTCPeerConnection may be configured with an ICE server outside the room’s own host',
  ).toEqual([]);

  const strangers = probe.requests.filter(
    (url) =>
      !url.startsWith(WEB_BASE_URL) &&
      !url.startsWith(FAKE_API_BASE_URL) &&
      !url.startsWith(LIVEKIT_HTTP_ORIGIN),
  );
  expect(strangers, 'no request may leave the web origin, the stand-in API or LiveKit').toEqual([]);
}

/**
 * Make `getUserMedia` refuse with a named error — for every request, or only
 * for the ones that ask for video. A seam inside the browser; see the file
 * docblock.
 */
async function refuseDevices(page: Page, name: string, onlyVideo = false): Promise<void> {
  await page.addInitScript(
    ({ errorName, videoOnly }) => {
      const devices = navigator.mediaDevices;
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
        if (!videoOnly || constraints?.video) {
          // Counted here as well: `guardMediaPlane`'s wrapper sits UNDER this one
          // and is never reached on the refusing branch, and "Thử lại quyền asks
          // again" is a claim about the product's call, not about the answer.
          const probe = (window as unknown as { __stuwithProbe?: { getUserMediaCalls: number } })
            .__stuwithProbe;
          if (probe !== undefined) {
            probe.getUserMediaCalls += 1;
          }
          return Promise.reject(new DOMException('refused by the spec', errorName));
        }
        return original(constraints);
      };
    },
    { errorName: name, videoOnly: onlyVideo },
  );
}

/**
 * Refuse ONLY an audio-only `getUserMedia` — which, on the happy path, is exactly
 * the one `RoomShell` makes.
 *
 * `pre-join.tsx` asks for `{video, audio}` together, so a filter on "has no video
 * constraint" separates the SHELL's second request from the screen's first without
 * either of them knowing. That separation is what makes `room.errorMicDenied`
 * reachable at all: a refusal AT pre-join produces the listen-only decision, so
 * `audio === 'mic'` and a failing microphone never met anywhere in the suite, and
 * the branch that renders the sentence could be deleted with everything green.
 *
 * A seam inside the browser, like `refuseDevices` above — see the file docblock.
 */
async function refuseAudioOnlyDevices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      if (constraints?.video) {
        return original(constraints);
      }
      const probe = (window as unknown as { __stuwithProbe?: { getUserMediaCalls: number } })
        .__stuwithProbe;
      if (probe !== undefined) {
        probe.getUserMediaCalls += 1;
      }
      return Promise.reject(new DOMException('refused by the spec', 'NotAllowedError'));
    };
  });
}

const modeGroup = (page: Page) => page.getByRole('radiogroup', { name: 'Chế độ khuôn mặt' });
const video = (page: Page) => page.locator('video');
const meter = (page: Page) => page.getByRole('meter', { name: 'Mức âm micro' });
/**
 * The room's heading, found by ID rather than by sentence.
 *
 * It used to key off "Bạn đã vào phòng", and from Story 2.4 that is one of FOUR
 * sentences it can carry: the heading follows the join phase, so a refused join
 * says "Chưa vào được phòng" and a left room says "Bạn đã rời phòng". Every use
 * below means "a shell is on screen rather than pre-join", which is a question
 * about WHICH component rendered — and the id is what answers that without racing
 * the phase. In the `web` project nothing is listening on the LiveKit port, so a
 * join moves from `connecting` to `failed` in milliseconds and a sentence-based
 * helper would be a coin toss.
 *
 * The id is spelled by hand for the reason every route in `scenario.ts` is: a test
 * that imports the constant it is checking cannot notice the constant changing.
 */
const shellHeading = (page: Page) => page.locator('h1#phong-tieu-de');

test.describe('phòng — pre-join', () => {
  test('the created-room screen leads here, so the screen is reachable without typing a URL', async ({
    page,
  }) => {
    // Rule B of `routes.test.ts` says a product module names the route; only a
    // browser can say the link actually navigates.
    await scenario(page, { signedIn: true });
    await page.goto(CREATE_ROOM_PATHNAME);
    await page.getByLabel('Tên phòng').fill('Ôn thi cuối kỳ');
    await page.getByRole('radio', { name: 'Ôn thi' }).check();
    await page.getByRole('radio', { name: 'Ai cũng có thể tìm thấy' }).check();
    const createdResponse = page.waitForResponse(
      (response) => response.url().endsWith('/v1/rooms') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Tạo phòng' }).click();
    await expect(page.getByRole('heading', { name: 'Đã tạo phòng' })).toBeVisible();
    // The id the 201 body carried — `Room` holds two UUIDs, and the link must be
    // built from THIS one, not the owner's.
    const created = (await (await createdResponse).json()) as { id: string; owner_user_id: string };

    await page.getByRole('link', { name: 'Vào phòng' }).click();

    await expect(page).toHaveURL(`${WEB_BASE_URL}${roomPathname(created.id)}`);
    expect(created.owner_user_id).not.toBe(created.id);
    await expect(page.getByRole('heading', { name: 'Trước khi vào, bạn muốn hiện thế nào?' })).toBeVisible();
  });

  test('happy path: preview, the group defaulting to Để nguyên, the warning, the meter, the promise — and no media plane', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });

    const profileRequest = page.waitForRequest((request) => request.url().endsWith('/v1/auth/me'));
    await page.goto(ROOM);
    await profileRequest;

    // The preview is a LOCAL <video>, playing a real (fake) camera track — and
    // PLAYING it: the stream is attached and frames arrive. Deleting the attach
    // effect leaves a visible black box, which this line is what catches.
    await expect(video(page)).toBeVisible();
    await expect.poll(() => previewIsLive(page), { timeout: 10_000 }).toBe(true);
    expect(await probe.getUserMediaCalls()).toBeGreaterThanOrEqual(1);
    await expect(modeGroup(page)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Để nguyên' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).not.toBeChecked();
    await expect(page.getByText('Khuôn mặt bạn sẽ hiện với mọi người trong phòng.')).toBeVisible();
    await expect(page.getByText('Buổi học không được ghi lại.')).toBeVisible();

    // The meter is a `meter` WITH words, and it runs: the fake microphone is a
    // tone, and the analyser reads it as something above silence.
    await expect(meter(page)).toBeVisible();
    await expect(meter(page)).toHaveAttribute('aria-valuetext', /Nghe rõ|Chưa nghe thấy/);
    await expect
      .poll(async () => Number(await meter(page).getAttribute('aria-valuenow')), {
        message: 'the analyser must publish a level above silence for the fake microphone',
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // No token was asked for on mount: the request happens on the press, once.
    expect(probe.requests.filter((url) => url.endsWith('/token'))).toEqual([]);
    await expectNoMediaPlane(probe);
  });

  test('Filter is present, disabled, labelled "Sắp có", and cannot be chosen', async ({ page }) => {
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();

    const filter = page.getByRole('radio', { name: 'Filter' });
    await expect(filter).toBeDisabled();
    await expect(page.getByText('Sắp có')).toBeVisible();
    // A click on the disabled option changes nothing.
    await filter.click({ force: true });
    await expect(page.getByRole('radio', { name: 'Để nguyên' })).toBeChecked();
    await expect(filter).not.toBeChecked();
  });

  test('Ẩn mặt ends every video track, removes the <video>, and shows the initials', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    expect(await probe.videoTrackStates()).toContain('live');

    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();

    // The element is GONE, not hidden — and the track underneath it has ended,
    // which is what "the camera light goes off" means to the browser.
    await expect(video(page)).toHaveCount(0);
    await expect.poll(() => probe.videoTrackStates()).not.toContain('live');
    expect((await probe.videoTrackStates()).every((state) => state === 'ended')).toBe(true);

    // The avatar carries the initials of `display_name` ("Người dùng thử").
    const avatar = page.getByRole('img', { name: 'Avatar chữ cái của bạn' });
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveText('NT');
    await expect(page.getByText('Không ai trong phòng thấy khuôn mặt bạn, kể cả host')).toBeVisible();
    await expect(page.getByText('Khuôn mặt bạn sẽ hiện với mọi người trong phòng.')).toHaveCount(0);
    // The microphone is untouched by hiding a face.
    await expect(meter(page)).toBeVisible();

    await expectNoMediaPlane(probe);
  });

  test('the group is a keyboard radiogroup: arrow keys move the choice, and stop at the disabled one', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();

    await page.getByRole('radio', { name: 'Để nguyên' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeChecked();
    await expect(video(page)).toHaveCount(0);
    // A second press must NOT land on Filter, which is disabled: native radios
    // skip it, so the choice wraps back to Để nguyên — the person's own press.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Filter' })).not.toBeChecked();
    await expect(page.getByRole('radio', { name: 'Để nguyên' })).toBeChecked();
    await expect(video(page)).toBeVisible();
  });

  test('only "Để nguyên" pressed again brings the camera back — a reload does not, and it lands on pre-join', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await expect(video(page)).toHaveCount(0);
    const callsAfterHide = await probe.getUserMediaCalls();

    // Time passes, nothing happens: no system event re-asks for the camera.
    await page.waitForTimeout(500);
    expect(await probe.getUserMediaCalls()).toBe(callsAfterHide);
    await expect(video(page)).toHaveCount(0);

    // The person asks. One more request, video only, and the preview is back —
    // attached and playing, not merely mounted.
    await page.getByRole('radio', { name: 'Để nguyên' }).check();
    await expect(video(page)).toBeVisible();
    expect(await probe.getUserMediaCalls()).toBe(callsAfterHide + 1);
    await expect.poll(() => probe.videoTrackStates()).toContain('live');
    await expect.poll(() => previewIsLive(page), { timeout: 10_000 }).toBe(true);
  });

  test('when the camera is gone by the time "Để nguyên" is pressed again, the face stays hidden — and a revoked permission shows the help', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await expect(video(page)).toHaveCount(0);

    // The camera is unplugged between the two presses.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('unplugged by the spec', 'NotFoundError'));
    });
    // `click`, not `check`: the choice is refused and the group flips back to
    // "Ẩn mặt" at once, which `check` would report as a click that did nothing.
    await page.getByRole('radio', { name: 'Để nguyên' }).click();
    await expect(page.getByRole('radio', { name: 'Để nguyên' })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeChecked();
    await expect(video(page)).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'Avatar chữ cái của bạn' })).toBeVisible();
    await expect(page.getByText('Không thấy camera.')).toBeVisible();
    // The microphone that is open is not called unreadable.
    await expect(meter(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vào phòng', exact: true })).toBeVisible();

    // The other way it goes: the permission was revoked. That is the help block.
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('revoked by the spec', 'NotAllowedError'));
    });
    await page.getByRole('radio', { name: 'Để nguyên' }).click();
    await expect(page.getByRole('heading', { name: 'Trình duyệt đang chặn camera và micro' })).toBeVisible();
    await expect(video(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Vào phòng chỉ để nghe' })).toBeVisible();
  });

  test('a camera that arrives AFTER "Ẩn mặt" was pressed again is stopped on arrival — the last choice wins', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await expect.poll(() => probe.videoTrackStates()).not.toContain('live');

    // The next `getUserMedia` answers only when the spec says so.
    await page.evaluate(() => {
      const devices = navigator.mediaDevices;
      const original = devices.getUserMedia.bind(devices);
      const gate = { release: () => undefined as void };
      (window as unknown as { __stuwithGate: typeof gate }).__stuwithGate = gate;
      devices.getUserMedia = (constraints?: MediaStreamConstraints) =>
        new Promise<MediaStream>((resolve, reject) => {
          gate.release = () => {
            original(constraints).then(resolve, reject);
          };
        });
    });

    // "Để nguyên", then "Ẩn mặt" again while the camera is still being asked for.
    await page.getByRole('radio', { name: 'Để nguyên' }).check();
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await expect(video(page)).toHaveCount(0);

    // Now the camera answers. It must be ended at once, never adopted.
    await page.evaluate(() => (window as unknown as { __stuwithGate: { release: () => void } }).__stuwithGate.release());
    await expect.poll(() => probe.getUserMediaCalls()).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(300);
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeChecked();
    await expect(video(page)).toHaveCount(0);
    expect((await probe.videoTrackStates()).filter((state) => state === 'live')).toEqual([]);
  });

  test('leaving the page by a client-side navigation ends every track — the camera light goes off', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await expect.poll(() => probe.videoTrackStates()).toContain('live');
    await expect.poll(() => probe.audioTrackStates()).toContain('live');
    const callsBefore = await probe.getUserMediaCalls();

    // The brand link in the header is a `next/link`: the document survives, the
    // page unmounts, and only the cleanup effect can stop what it opened.
    await page.locator('header a[href="/"]').first().click();
    await expect(page).toHaveURL(`${WEB_BASE_URL}/`);
    await expect.poll(() => probe.videoTrackStates()).not.toContain('live');
    await expect.poll(() => probe.audioTrackStates()).not.toContain('live');
    expect(await probe.getUserMediaCalls()).toBe(callsBefore);
  });

  test('the microphone meter wakes on the first gesture when the browser keeps the AudioContext suspended', async ({
    page,
  }) => {
    /**
     * The `web` project launches Chromium with `--autoplay-policy=no-user-gesture-required`,
     * so a fresh `AudioContext` is `running` and the page's wake-on-gesture branch
     * never executes in the other cases. This case reproduces the policy every
     * real browser applies: the context is suspended on creation and `resume()`
     * is refused until a pointer or key event has happened. What is asserted is
     * the page's own handler: the meter reads 0 until the first click, and rises
     * after it.
     */
    await page.addInitScript(() => {
      let gestureSeen = false;
      document.addEventListener('pointerdown', () => {
        gestureSeen = true;
      }, true);
      const Original = window.AudioContext;
      window.AudioContext = new Proxy(Original, {
        construct(target, args, newTarget) {
          const context = Reflect.construct(target, args, newTarget) as AudioContext;
          const realResume = context.resume.bind(context);
          void context.suspend();
          context.resume = () =>
            gestureSeen
              ? realResume()
              : Promise.reject(new DOMException('gesture required by the spec', 'NotAllowedError'));
          return context;
        },
      });
    });
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(meter(page)).toBeVisible();

    // Suspended: the level stays at 0 and the sentence says so.
    await page.waitForTimeout(600);
    expect(Number(await meter(page).getAttribute('aria-valuenow'))).toBe(0);
    await expect(meter(page)).toHaveAttribute('aria-valuetext', 'Chưa nghe thấy');

    // The first gesture anywhere on the page wakes it.
    await page.mouse.click(4, 4);
    await expect
      .poll(async () => Number(await meter(page).getAttribute('aria-valuenow')), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  test('"Vào phòng" posts to the token endpoint ONCE, and the shell appears only after the 201', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await expect(shellHeading(page)).toHaveCount(0);

    // The half of the probe that is still absolute: nothing on the media plane
    // exists while the pre-join screen is up.
    await expectNoMediaPlane(probe);

    const tokenRequest = page.waitForRequest(
      (request) =>
        request.url() === `${FAKE_API_BASE_URL}/v1/rooms/${ROOM_ID}/token` && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();
    await tokenRequest;

    await expect(shellHeading(page)).toBeVisible();
    await expect(page.getByText('Bạn đang ẩn mặt.')).toBeVisible();
    await expect(page.getByText('Micro của bạn đang bật.')).toBeVisible();
    await expect(page.getByText('Buổi học này không được ghi lại.')).toBeVisible();
    // Pre-join is gone with the decision made.
    await expect(modeGroup(page)).toHaveCount(0);
    await expect(video(page)).toHaveCount(0);
    // Exactly one token request in the whole session.
    expect(probe.requests.filter((url) => url.endsWith('/token'))).toHaveLength(1);
    // And the token itself is nowhere in the page, nor in any storage.
    const leaked = await page.evaluate(() => ({
      inDom: document.documentElement.outerHTML.includes('e2e-token.'),
      inLocal: Object.values(localStorage).some((value) => value.includes('e2e-token.')),
      inSession: Object.values(sessionStorage).some((value) => value.includes('e2e-token.')),
      inCookie: document.cookie.includes('e2e-token.'),
    }));
    expect(leaked).toEqual({ inDom: false, inLocal: false, inSession: false, inCookie: false });

    // Past admission the plane opens — to the URL the token named and to nothing
    // else. `expect.poll` because the connection starts in an effect.
    await expect.poll(async () => (await probe.counters()).webSockets).toBeGreaterThan(0);
    await expectMediaPlaneOnlyToRoom(probe);

    // A reload is pre-join again. The decision lived in memory and nowhere else.
    await page.reload();
    await expect(video(page)).toBeVisible();
    await expect(shellHeading(page)).toHaveCount(0);
  });

  test('an admission that has already lapsed never opens a socket, and says why', async ({ page }) => {
    /**
     * The expiry branch, which nothing executed before this case: deleting BOTH the
     * pre-connect guard and the `setTimeout` in `RoomShell` left the unit suites,
     * `--project=web` and `--project=livekit` all green.
     *
     * The `201` is real and its `expires_at` is in the past — the one thing the
     * stand-in API can do that the product cannot, and the alternative (sitting out
     * a 120-second TTL inside a spec) is a timeout rather than a test.
     */
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true, expiresAtOffsetSeconds: -1 });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    await expect(shellHeading(page)).toBeVisible();
    await expect(page.getByText('Chờ quá lâu, hãy vào lại.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
    // And the point of checking BEFORE connecting: a lapsed admission opens
    // nothing at all, so the negative probe still holds past admission here.
    await expectNoMediaPlane(probe);
  });

  test('"Rời phòng" pressed DURING the handshake stops the join rather than racing it', async ({
    page,
  }) => {
    /**
     * The button is offered from the first frame — somebody who pressed "Vào phòng"
     * by mistake must not have to wait out a handshake to get out — and for one
     * round pressing it there did nothing but redraw: `leave` read a room reference
     * that is only assigned AFTER `getUserMedia`, so the asynchronous run carried on,
     * connected, and published a microphone behind a screen that said the person had
     * left.
     *
     * The handshake has to HANG for the press to land inside it, and a closed port
     * on `127.0.0.1` does not hang — it is refused immediately, so the window was
     * really the SDK's retry backoff. Measured: green alone, red inside the full
     * run. `roomTokenUrl` points the admission at a blackholed address instead
     * (`192.0.2.0/24`, RFC 5737, carried by no router), so the TCP connect sits
     * pending and `connecting` lasts as long as this spec needs.
     */
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true, roomTokenUrl: 'ws://192.0.2.1:7880' });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    // Mid-handshake, for real: the chip says so and the room has not answered.
    await expect(page.getByText('Đang vào phòng…')).toBeVisible();
    await page.getByRole('button', { name: 'Rời phòng' }).click();

    await expect(page.getByRole('heading', { name: 'Bạn đã rời phòng' })).toBeVisible();
    // The microphone the shell opened is ended, and stays ended.
    await expect.poll(() => probe.audioTrackStates()).not.toContain('live');
    // And the abandoned run never comes back to overwrite the screen: no refusal
    // sentence arrives afterwards, because there is no join left to refuse.
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('heading', { name: 'Bạn đã rời phòng' })).toBeVisible();
    await expect(page.locator('main [role="alert"]')).toHaveCount(0);
    await expect.poll(() => probe.audioTrackStates()).not.toContain('live');
  });

  test('a microphone the SHELL cannot open says so, and the room is joined anyway', async ({ page }) => {
    /**
     * `room.errorMicDenied` was set in a branch nothing could reach: a refusal at
     * pre-join yields `audio: 'listen-only'`, so "wanted the microphone AND could
     * not have it" existed in the code and nowhere else.
     */
    const probe = await guardMediaPlane(page);
    await refuseAudioOnlyDevices(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    // Pre-join is unaffected: it asks for both devices at once and is granted.
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    await expect(page.getByText('Không mở được micro. Bạn vẫn nghe được mọi người.')).toBeVisible();
    // Still a join: the sentence says which half is missing, not that the room is lost.
    await expect.poll(async () => (await probe.counters()).webSockets).toBeGreaterThan(0);
    await expectMediaPlaneOnlyToRoom(probe);
  });

  test('there is no other URL: a second segment is a 404 and a query parameter changes nothing', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true });

    const response = await page.goto(`${ROOM}/chuan-bi`);
    expect(response?.status()).toBe(404);

    await page.goto(`${ROOM}?admitted=1&skip=pre-join`);
    await expect(video(page)).toBeVisible();
    await expect(shellHeading(page)).toHaveCount(0);
  });

  test('when the browser blocks the devices: the three steps for this browser, a retry that asks again, and a way in to listen', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await refuseDevices(page, 'NotAllowedError');
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);

    await expect(page.getByRole('heading', { name: 'Trình duyệt đang chặn camera và micro' })).toBeVisible();
    // Chromium's steps: the lock icon, the two toggles, the reload.
    const steps = page.locator('.permission-help ol li');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('thanh địa chỉ');
    await expect(steps.nth(2)).toHaveText('Tải lại trang này.');
    await expect(video(page)).toHaveCount(0);
    await expect(modeGroup(page)).toHaveCount(0);

    // "Thử lại quyền" is the ONLY thing that asks again — and it does ask.
    const before = await probe.getUserMediaCalls();
    await page.getByRole('button', { name: 'Thử lại quyền' }).click();
    await expect.poll(() => probe.getUserMediaCalls()).toBeGreaterThan(before);
    await expect(page.getByRole('heading', { name: 'Trình duyệt đang chặn camera và micro' })).toBeVisible();

    // "Vào phòng chỉ để nghe": a token is still asked for, and the shell receives
    // `listen-only`.
    const tokenRequest = page.waitForRequest(
      (request) => request.url().endsWith(`/v1/rooms/${ROOM_ID}/token`) && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Vào phòng chỉ để nghe' }).click();
    await tokenRequest;
    // The shell asks for NOTHING on the listen-only branch. The count is taken
    // across admission rather than from zero, because the pre-join screen already
    // asked (and was refused) on the way in.
    const asked = await probe.getUserMediaCalls();
    await expect(shellHeading(page)).toBeVisible();
    await expect(page.getByText('Bạn vào chỉ để nghe.')).toBeVisible();
    await expect(page.getByText('Bạn đang ẩn mặt.')).toBeVisible();
    await expect.poll(async () => (await probe.counters()).webSockets).toBeGreaterThan(0);
    expect(
      await probe.getUserMediaCalls(),
      'listen-only must not open the microphone even once',
    ).toBe(asked);
    await expectMediaPlaneOnlyToRoom(probe);
  });

  test('with no camera but a microphone: Để nguyên is disabled, Ẩn mặt is the choice, and the meter runs', async ({
    page,
  }) => {
    await refuseDevices(page, 'NotFoundError', true);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);

    await expect(page.getByRole('radio', { name: 'Để nguyên' })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeChecked();
    await expect(page.getByRole('img', { name: 'Avatar chữ cái của bạn' })).toBeVisible();
    await expect(page.getByText('Không thấy camera.')).toBeVisible();
    await expect(video(page)).toHaveCount(0);
    await expect(meter(page)).toBeVisible();
    // And it RUNS: the audio-only retry's stream feeds the analyser. A retry
    // that opened the microphone and never adopted it would leave this at 0.
    await expect
      .poll(async () => Number(await meter(page).getAttribute('aria-valuenow')), { timeout: 10_000 })
      .toBeGreaterThan(0);
    // The plain label: the microphone still travels.
    await expect(page.getByRole('button', { name: 'Vào phòng', exact: true })).toBeVisible();
  });

  test('with no microphone at all: the sentence, and a way in', async ({ page }) => {
    await refuseDevices(page, 'NotFoundError');
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);

    await expect(page.getByText('Không thấy micro. Bạn vẫn vào phòng và dùng chat được.')).toBeVisible();
    await expect(meter(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Vào phòng chỉ để nghe' }).click();
    await expect(shellHeading(page)).toBeVisible();
    await expect(page.getByText('Bạn vào chỉ để nghe.')).toBeVisible();
  });

  test('another device error: the general sentence and the listen-only exit', async ({ page }) => {
    await refuseDevices(page, 'NotReadableError');
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);

    await expect(page.getByText('Không mở được camera/micro.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Trình duyệt đang chặn camera và micro' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Vào phòng chỉ để nghe' })).toBeVisible();
  });

  /**
   * The two 409s, told apart by `details.reason` — the field Story 2.2 deferred
   * and this story added. The fake builds both bodies through the contract's own
   * `makeError`, so what the browser reads is exactly what `apps/api` sends.
   */
  test('a full room and a closed room are two different sentences, from details.reason', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true, roomTokenStatus: 409, roomTokenReason: 'room_full' });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    const message = page.locator('#vao-phong-loi');
    await expect(message).toHaveAttribute('role', 'alert');
    await expect(message).toHaveText('Phòng đã đủ người. Hãy thử lại sau hoặc chọn phòng khác.');
    await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Về trang tạo phòng' })).toHaveAttribute(
      'href',
      CREATE_ROOM_PATHNAME,
    );
    await expect(shellHeading(page)).toHaveCount(0);

    await scenario(page, { signedIn: true, roomTokenStatus: 409, roomTokenReason: 'room_closed' });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();
    await expect(page.locator('#vao-phong-loi')).toHaveText('Phòng này đã đóng. Hãy chọn phòng khác.');
  });

  test('a 409 with no reason gets the general sentence, never a guess', async ({ page }) => {
    await scenario(page, { signedIn: true, roomTokenStatus: 409 });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    await expect(page.locator('#vao-phong-loi')).toHaveText('Không vào được phòng lúc này.');
    await expect(page.getByText('Phòng đã đủ người.')).toHaveCount(0);
    await expect(page.getByText('Phòng này đã đóng.')).toHaveCount(0);
  });

  test('403 and 404 are their own sentences, with a way to create a room and no retry', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true, roomTokenStatus: 403 });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();
    await expect(page.locator('#vao-phong-loi')).toHaveText('Bạn không thể vào phòng học lúc này.');
    await expect(page.getByRole('link', { name: 'Về trang tạo phòng' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toHaveCount(0);

    await scenario(page, { signedIn: true, roomTokenStatus: 404 });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();
    await expect(page.locator('#vao-phong-loi')).toHaveText('Không tìm thấy phòng này.');
  });

  test('a 5xx keeps the decision and the tracks, and "Thử lại" gets in once the server does', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true, roomTokenStatus: 500 });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    await expect(page.locator('#vao-phong-loi')).toHaveText('Chưa vào được phòng. Hãy thử lại.');
    // Still Ẩn mặt, still the avatar, microphone still open: nothing was reset.
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeChecked();
    await expect(page.getByRole('img', { name: 'Avatar chữ cái của bạn' })).toBeVisible();
    await expect(meter(page)).toBeVisible();

    await scenario(page, { signedIn: true, roomTokenStatus: 201 });
    await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
    await expect(shellHeading(page)).toBeVisible();
    await expect(page.getByText('Bạn đang ẩn mặt.')).toBeVisible();
    expect(probe.requests.filter((url) => url.endsWith('/token'))).toHaveLength(2);
    /**
     * Admitted, and then refused by a port with no LiveKit behind it: the camera
     * never comes back, and the microphone the SHELL opened is ended again rather
     * than left running behind a screen that says the join failed.
     */
    expect((await probe.videoTrackStates()).filter((state) => state === 'live')).toEqual([]);
    // A generous budget on purpose: this is a REAL connection attempt to a port
    // nothing is listening on, and livekit-client retries once before it gives up.
    // Five seconds is enough on an idle machine and not enough when the whole
    // suite is running, which is a flake rather than a finding.
    await expect(page.getByText('Không vào được phòng.')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => probe.audioTrackStates()).not.toContain('live');
    await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
    await expectMediaPlaneOnlyToRoom(probe);
  });

  test('no answer at all keeps the decision and the tracks, with the same sentence and a retry', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('radio', { name: 'Ẩn mặt' }).check();

    // The request never reaches the API: the fetch itself throws.
    await page.route((url) => url.pathname.endsWith('/token'), (route) => route.abort());
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    await expect(page.locator('#vao-phong-loi')).toHaveText('Chưa vào được phòng. Hãy thử lại.');
    await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Ẩn mặt' })).toBeEnabled();
    await expect(meter(page)).toBeVisible();
    expect(await probe.audioTrackStates()).toContain('live');
    await expect(shellHeading(page)).toHaveCount(0);
  });

  test('a 401 on the token — the session ended under the screen — is its own sentence, and the seam raises its dialog', async ({
    page,
  }) => {
    await scenario(page, { signedIn: true, roomTokenStatus: 401 });
    await page.goto(ROOM);
    await expect(video(page)).toBeVisible();
    await page.getByRole('button', { name: 'Vào phòng', exact: true }).click();

    await expect(page.locator('#vao-phong-loi')).toHaveText(
      'Phiên đăng nhập đã kết thúc. Hãy đăng nhập lại rồi thử lại.',
    );
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thử lại', exact: true })).toHaveCount(0);
    await expect(shellHeading(page)).toHaveCount(0);
  });

  test('a rate-limited profile read waits with a countdown and asks for no device; an unavailable one offers a live retry', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true, meStatus: 429 });
    await page.goto(ROOM);

    const retry = page.getByRole('button', { name: 'Thử lại', exact: true });
    await expect(retry).toBeDisabled();
    await expect(page.getByText(/Thử lại sau \d+ giây/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Tiếp tục với/ })).toHaveCount(0);
    await expect(video(page)).toHaveCount(0);
    expect(await probe.getUserMediaCalls()).toBe(0);

    await scenario(page, { signedIn: true, meStatus: 503 });
    await page.goto(ROOM);
    await expect(retry).toBeEnabled();
    const secondRead = page.waitForRequest((request) => request.url().endsWith('/v1/auth/me'));
    await retry.click();
    await secondRead;
  });

  test('a malformed room id shows the not-found sentence and calls no endpoint at all', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: true });
    await page.goto('/phong/abc');

    await expect(page.getByText('Không tìm thấy phòng này.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Về trang tạo phòng' })).toBeVisible();
    await expect(video(page)).toHaveCount(0);
    expect(probe.requests.filter((url) => url.includes('/v1/'))).toEqual([]);
    expect(await probe.getUserMediaCalls()).toBe(0);
  });

  test('a signed-out visitor is offered the sign-in links carrying this room as the return path, and no camera is asked for', async ({
    page,
  }) => {
    const probe = await guardMediaPlane(page);
    await scenario(page, { signedIn: false });
    await page.goto(ROOM);

    await expect(page.getByText('Bạn cần đăng nhập trước khi vào phòng.')).toBeVisible();
    /**
     * Scoped to the screen's own `<nav>`: the seam ALSO raises the session-expiry
     * dialog here (a 401 on `/v1/auth/me` off the login page, renewal refused —
     * the same thing `/tao-phong` does for a signed-out visitor), and that dialog
     * carries its own provider links with the same return path. The page's links
     * are what remain once "Để sau" is pressed, so they are what this case is about.
     */
    const google = page.getByRole('navigation').getByRole('link', { name: /Tiếp tục với Google/ });
    await expect(google).toHaveAttribute('href', new RegExp(`quay-ve=${encodeURIComponent(ROOM)}`));
    await expect(video(page)).toHaveCount(0);
    expect(await probe.getUserMediaCalls()).toBe(0);
  });

  test('every label is readable at 320px, in both locales, with nothing cut off', async ({ browser }) => {
    const HEADING_AT: Readonly<Record<string, string>> = {
      'vi-VN': 'Trước khi vào, bạn muốn hiện thế nào?',
      'en-GB': 'Before you go in, how do you want to appear?',
    };

    for (const locale of ['vi-VN', 'en-GB'] as const) {
      const context = await browser.newContext({ locale, viewport: { width: 320, height: 720 } });
      const page = await context.newPage();
      try {
        await scenario(page, { signedIn: true });
        await page.goto(ROOM);
        await expect(page.getByRole('heading', { name: HEADING_AT[locale] })).toBeVisible();
        await expect(page.locator('video')).toBeVisible();

        const overflow = await page.evaluate(() => {
          const cut: string[] = [];
          for (const element of document.querySelectorAll('label, legend, button, .meta, .notice, h1, h2')) {
            if (element.scrollWidth > element.clientWidth + 1) {
              cut.push(`${element.tagName}: ${element.textContent ?? ''}`);
            }
          }
          return {
            cut,
            pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
        expect(overflow.cut, `text is cut off at 320px in ${locale}`).toEqual([]);
        expect(overflow.pageScrollsSideways, `the page scrolls sideways in ${locale}`).toBe(false);
      } finally {
        await context.close();
      }
    }
  });
});
