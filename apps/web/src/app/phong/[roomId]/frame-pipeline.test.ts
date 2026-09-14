import { describe, expect, it } from 'vitest';
import {
  PIPELINE_FPS,
  PIPELINE_MAX_HEIGHT,
  PIPELINE_MAX_WIDTH,
  PIPELINE_READY_TIMEOUT_MS,
  frameFitFor,
  pipelineSizeFor,
} from './frame-pipeline';

/**
 * The two decisions the draw loop makes, executed.
 *
 * What is NOT here, said plainly: {@link createFramePipeline} itself. It needs a
 * `<canvas>`, a `<video>` and `captureStream`, and the `web` Vitest project runs
 * in `node` with no DOM (`AGENTS.md` §6) — a mock canvas would prove that a mock
 * canvas works. The claim that matters about that function is not a shape anyway;
 * it is that the track leaving the machine is the CANVAS's, and the only place
 * that can be observed is `RTCRtpSender.track.id` on a real peer connection, in
 * `tests/e2e/livekit/phong-media.spec.ts`.
 */

describe('pipelineSizeFor — inside the ceiling, tỉ lệ giữ nguyên, chiều chẵn', () => {
  it('leaves a camera already inside the ceiling alone', () => {
    expect(pipelineSizeFor({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
    expect(pipelineSizeFor({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
  });

  it('shrinks a 720p camera to fit, keeping 16:9 rather than squaring it off', () => {
    // 1280×720 against a 640×480 ceiling: width binds at 0.5, so 640×360. A
    // version that clamped each side independently would answer 640×480 and
    // publish a stretched face.
    expect(pipelineSizeFor({ width: 1280, height: 720 })).toEqual({ width: 640, height: 360 });
  });

  it('shrinks a portrait camera by its HEIGHT, which is the side that binds', () => {
    expect(pipelineSizeFor({ width: 720, height: 1280 })).toEqual({ width: 270, height: 480 });
  });

  it('never answers wider or taller than the ceiling, for any plausible camera', () => {
    // A property rather than four examples: the ceiling is what keeps the encoder
    // inside the bitrate `videoPublishOptions()` asks for.
    for (const width of [160, 320, 640, 800, 1280, 1920, 3840]) {
      for (const height of [120, 240, 360, 480, 720, 1080, 2160]) {
        const size = pipelineSizeFor({ width, height });
        expect(size.width).toBeLessThanOrEqual(PIPELINE_MAX_WIDTH);
        expect(size.height).toBeLessThanOrEqual(PIPELINE_MAX_HEIGHT);
        expect(size.width % 2).toBe(0);
        expect(size.height % 2).toBe(0);
        // The aspect ratio survives the trip, within the rounding to even sides.
        expect(Math.abs(size.width / size.height - width / height)).toBeLessThan(0.05);
      }
    }
  });

  it('falls back to the full ceiling when the camera reports nothing usable', () => {
    /**
     * A camera that has not published its settings yet answers `{}`, and a canvas
     * sized `0×0` produces a track that never carries a frame — the failure would
     * read as "the other side sees nothing" with no error anywhere. 4:3 at the
     * ceiling is the safe answer.
     */
    const ceiling = { width: PIPELINE_MAX_WIDTH, height: PIPELINE_MAX_HEIGHT };
    expect(pipelineSizeFor({})).toEqual(ceiling);
    expect(pipelineSizeFor(null)).toEqual(ceiling);
    expect(pipelineSizeFor(undefined)).toEqual(ceiling);
    expect(pipelineSizeFor({ width: 0, height: 0 })).toEqual(ceiling);
    expect(pipelineSizeFor({ width: Number.NaN, height: 480 })).toEqual(ceiling);
  });

  it('never answers a side of zero, however small the camera claims to be', () => {
    expect(pipelineSizeFor({ width: 1, height: 1 }).width).toBeGreaterThan(0);
    expect(pipelineSizeFor({ width: 1, height: 1 }).height).toBeGreaterThan(0);
  });
});

describe('frameFitFor — letterbox, không méo', () => {
  it('fills the canvas exactly when the aspect ratios agree', () => {
    expect(frameFitFor(1280, 960, 640, 480)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });

  it('puts bars left and right for a source taller than the canvas', () => {
    const fit = frameFitFor(480, 640, 640, 480);
    expect(fit.height).toBe(480);
    expect(fit.width).toBe(360);
    // Centred: the two bars are the same width, which is what makes a face sit in
    // the middle of somebody else's tile rather than against one edge.
    expect(fit.x).toBe((640 - 360) / 2);
    expect(fit.y).toBe(0);
  });

  it('puts bars top and bottom for a source wider than the canvas', () => {
    const fit = frameFitFor(1280, 720, 640, 480);
    expect(fit.width).toBe(640);
    expect(fit.height).toBe(360);
    expect(fit.x).toBe(0);
    expect(fit.y).toBe((480 - 360) / 2);
  });

  it('never distorts: the drawn rectangle keeps the SOURCE aspect ratio', () => {
    /**
     * The mutation this catches is the obvious "simplification" —
     * `drawImage(video, 0, 0, canvas.width, canvas.height)` — which fills the
     * canvas and squashes a face sideways. Nobody at the far end can tell that
     * from a person with a wide face, which is why it is a property here.
     */
    for (const [sourceWidth, sourceHeight] of [
      [1280, 720],
      [640, 480],
      [480, 640],
      [1920, 1080],
      [300, 700],
    ] as const) {
      const fit = frameFitFor(sourceWidth, sourceHeight, 640, 480);
      expect(Math.abs(fit.width / fit.height - sourceWidth / sourceHeight)).toBeLessThan(0.001);
      expect(fit.width).toBeLessThanOrEqual(640);
      expect(fit.height).toBeLessThanOrEqual(480);
    }
  });

  it('draws the whole canvas when the source has no readable size', () => {
    // Better a frame than no frame: a `0` dimension arrives from a `<video>` that
    // has a track and no metadata yet, and the draw loop calls this every frame.
    expect(frameFitFor(0, 0, 640, 480)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(frameFitFor(Number.NaN, 480, 640, 480)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });
});

describe('the numbers are pinned, because a default is somebody else’s decision', () => {
  it('captures at a rate this story chose rather than at the camera’s', () => {
    /**
     * `captureStream()` with no argument captures on every canvas change — the
     * camera's own rate, which nobody here picked. The constant is what makes the
     * bitrate in `videoPublishOptions()` mean something.
     */
    expect(PIPELINE_FPS).toBe(24);
  });

  it('bounds the wait for a first frame, because audio is behind it', () => {
    // BẤT BIẾN 2. Unbounded, a camera that yields a track and then never produces
    // a frame costs somebody the room's SOUND as well as its picture.
    expect(PIPELINE_READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PIPELINE_READY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
