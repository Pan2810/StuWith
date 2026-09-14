/**
 * Vòng vẽ khung hình: camera → `<canvas>` → track publish lên LiveKit.
 *
 * ## Vì sao module này tồn tại, và vì sao nó KHÔNG có React
 *
 * AD-30 luật (b) và `epic-2-context.md` cùng nói một câu: *"track publish lên
 * LiveKit luôn là track đã qua pipeline xử lý, kể cả ở chế độ Để nguyên"*. Cách
 * làm hiển nhiên — publish track camera rồi gắn processor sau — để hở một cửa sổ
 * mà khung hình GỐC đã rời máy: giữa lúc `publishTrack` thương lượng xong và lúc
 * processor gắn vào, encoder đọc thẳng từ camera. Cửa sổ đó không đóng được bằng
 * canh giờ, vì nó phụ thuộc mạng, CPU và lịch của trình duyệt. Nó đóng bằng CẤU
 * TRÚC: track duy nhất tồn tại để mà publish là track của canvas, và track camera
 * không bao giờ được trao cho `publishTrack` ở bất kỳ nhánh nào.
 *
 * Tính chất đó đo được, không phải một lời bình: `RTCRtpSender.track.id` phải nằm
 * trong tập id do `canvas.captureStream()` sinh ra và không bao giờ nằm trong tập
 * id do `getUserMedia` sinh ra. `tests/e2e/livekit/phong-media.spec.ts` đọc đúng
 * hai tập đó từ một `RTCPeerConnection` thật.
 *
 * Module này không import React và không import `livekit-client`. Hai hàm quyết
 * định — {@link pipelineSizeFor} và {@link frameFitFor} — là hàm thuần chạy được
 * trong project `web` của Vitest, nơi không có DOM (`AGENTS.md` §6);
 * {@link createFramePipeline} là phần cần trình duyệt và chỉ được gọi trong một
 * effect.
 *
 * ## Story này KHÔNG làm gì
 *
 * Không ML, không Filter, không đo FPS. Vòng vẽ là một `drawImage` letterbox: đó
 * là chỗ Filter (phần 2/3) sẽ cắm vào, và việc dựng sẵn đường ống ở đây là điều
 * làm cho Ẩn mặt và Để nguyên đầy đủ mà không phụ thuộc vào bất cứ thứ gì có thể
 * hỏng.
 */

/** Trần độ phân giải của pipeline. Đổi hai số này là mục "Ask First" của spec. */
export const PIPELINE_MAX_WIDTH = 640;
export const PIPELINE_MAX_HEIGHT = 480;

/**
 * FPS của `captureStream`, ghim tường minh.
 *
 * 24 chứ không phải 30: `epic-2-context.md` đặt tiếng lên trên hình không ngoại
 * lệ, và một phòng học là cảnh gần như tĩnh, nên bốn khung hình mỗi giây đổi lấy
 * băng thông cho Opus là một món hời. Không truyền số này thì `captureStream()`
 * bắt theo mỗi lần canvas đổi — tức là theo đúng nhịp camera, thứ ta không chọn.
 */
export const PIPELINE_FPS = 24;

/**
 * Hạn cho `whenReady()`.
 *
 * BẤT BIẾN 2 của spec: video không bao giờ chặn đường âm thanh. Một camera cấp
 * được track nhưng không bao giờ bắn `loadedmetadata` là chuyện có thật (driver
 * treo, thiết bị ảo); không có hạn này thì người dùng mất luôn cả tiếng vì một
 * cái camera hỏng.
 */
export const PIPELINE_READY_TIMEOUT_MS = 4_000;

export interface FramePipelineSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Kích thước canvas cho một track camera, từ `MediaTrackSettings` của nó.
 *
 * Thu nhỏ để lọt vào {@link PIPELINE_MAX_WIDTH} × {@link PIPELINE_MAX_HEIGHT},
 * GIỮ tỉ lệ, và làm tròn về số CHẴN — encoder video muốn chiều chẵn, và một
 * canvas lẻ là chỗ Chromium tự đệm thêm một hàng điểm ảnh.
 *
 * Một `settings` không đọc được (camera chưa trả kích thước, hoặc trả `0`) rơi về
 * đúng trần. Đó là câu trả lời an toàn: thà vẽ một khung 640×480 đúng tỉ lệ 4:3
 * còn hơn một canvas `0×0` không sinh được khung hình nào.
 */
export function pipelineSizeFor(
  settings: { readonly width?: number; readonly height?: number } | null | undefined,
): FramePipelineSize {
  const rawWidth = settings?.width ?? 0;
  const rawHeight = settings?.height ?? 0;
  const usable =
    Number.isFinite(rawWidth) && Number.isFinite(rawHeight) && rawWidth > 0 && rawHeight > 0;
  if (!usable) {
    return { width: PIPELINE_MAX_WIDTH, height: PIPELINE_MAX_HEIGHT };
  }
  const scale = Math.min(PIPELINE_MAX_WIDTH / rawWidth, PIPELINE_MAX_HEIGHT / rawHeight, 1);
  return { width: evenFloor(rawWidth * scale), height: evenFloor(rawHeight * scale) };
}

/** Chẵn, và ít nhất 2 — một canvas rộng 0 điểm ảnh không phải là một khung hình. */
function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export interface FrameFit {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Hình chữ nhật để `drawImage` vẽ nguồn vào canvas — letterbox, KHÔNG méo.
 *
 * Kéo giãn cho đầy khung là cách một khuôn mặt bị bóp ngang mà không ai ở đầu kia
 * biết vì sao. Nguồn giữ nguyên tỉ lệ, phần thừa là viền, và viền được canh giữa.
 * Một chiều không đọc được trả về đúng cả khung: không có tỉ lệ thì không có gì
 * để giữ, và vẽ đầy khung vẫn hơn không vẽ gì.
 */
export function frameFitFor(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): FrameFit {
  const usable =
    Number.isFinite(sourceWidth) &&
    Number.isFinite(sourceHeight) &&
    sourceWidth > 0 &&
    sourceHeight > 0;
  if (!usable) {
    return { x: 0, y: 0, width: targetWidth, height: targetHeight };
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

export interface FramePipelineOptions {
  /** Track CAMERA. Nó vào đây làm nguồn vẽ và không bao giờ đi tới `publishTrack`. */
  readonly source: MediaStreamTrack;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export interface FramePipeline {
  /**
   * Track của canvas — thứ DUY NHẤT được phép trao cho `publishTrack`.
   *
   * `id` của nó là thứ probe đọc lại ở `RTCRtpSender.track.id`.
   */
  readonly track: MediaStreamTrack;
  /**
   * `true` khi khung hình đầu tiên đã thật sự được vẽ; `false` khi hết hạn, khi
   * `<video>` báo lỗi, hoặc khi camera kết thúc trước lúc đó. KHÔNG bao giờ ném:
   * người gọi phải xử lý một pipeline không lên bằng một câu, không bằng `catch`.
   */
  whenReady(timeoutMs: number): Promise<boolean>;
  /**
   * Dừng vẽ có chủ ý (tab bị ẩn) — và dừng luôn việc khung hình RỜI MÁY.
   *
   * Chỉ huỷ vòng vẽ thì chưa đủ, và đây là chỗ dễ đọc sai nhất của cả module:
   * `captureStream(fps)` vẫn phát khung hình cuối cùng đã vẽ, nên đầu kia thấy một
   * TẤM ẢNH của người không còn ở đó — thứ đọc ra là "đang có mặt", tệ hơn hẳn một
   * avatar, và đúng cái mà quyết định về tab ẩn sinh ra để chặn. Nên `pause()` còn
   * đặt `track.enabled = false`: đó là bảo đảm CỤC BỘ, đồng bộ, không đi qua mạng
   * và không thể thất bại. `mute()` trên publication là thứ biến ô bên kia thành
   * chữ cái, nhưng nó là một vòng tín hiệu và vòng đó hỏng được — nếu nó hỏng,
   * dòng này vẫn đã chặn hình.
   */
  pause(): void;
  resume(): void;
  /** Huỷ vòng vẽ, `stop()` track canvas, gỡ `<video>` nguồn. KHÔNG chạm camera. */
  stop(): void;
}

/**
 * Dựng pipeline. Đồng bộ, nên nó không bao giờ nằm chắn trước `room.connect()`.
 *
 * `<video>` và `<canvas>` đều ở NGOÀI DOM. Một `<video>` gắn vào cây tài liệu là
 * một phần tử media không nhãn mà screen reader phải đọc, và là một khung hình
 * gốc hiện trên màn hình ở chế độ mà người dùng vừa bảo là hãy xử lý nó. Chrome
 * vẫn phát và vẫn bắn `requestVideoFrameCallback` cho một `<video>` rời cây.
 */
export function createFramePipeline(options: FramePipelineOptions): FramePipeline {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([options.source]);

  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    // Không có 2D context thì không có pipeline, và không có pipeline thì không
    // có gì để publish. Ném ở đây, đồng bộ, trước khi bất cứ thứ gì được cấp
    // phát — người gọi đổi nó thành một câu và giữ nguyên Ẩn mặt.
    video.srcObject = null;
    throw new Error('canvas 2d context unavailable');
  }

  const track = canvas.captureStream(options.fps).getVideoTracks()[0];
  if (track === undefined) {
    video.srcObject = null;
    throw new Error('canvas captureStream: no track');
  }

  let stopped = false;
  let paused = false;
  let drawn = false;
  let frameHandle: number | null = null;
  let animationHandle: number | null = null;
  const readyWaiters: Array<(ready: boolean) => void> = [];

  const settle = (ready: boolean): void => {
    const waiters = readyWaiters.splice(0, readyWaiters.length);
    for (const waiter of waiters) {
      waiter(ready);
    }
  };

  const draw = (): void => {
    if (stopped) {
      return;
    }
    if (!paused && video.videoWidth > 0 && video.videoHeight > 0) {
      const fit = frameFitFor(video.videoWidth, video.videoHeight, canvas.width, canvas.height);
      // Nền đen dưới letterbox: không xoá thì viền giữ lại khung hình CŨ khi tỉ
      // lệ camera đổi giữa chừng (xoay điện thoại), tức là một mảnh hình cũ ở lại
      // trên dây.
      context.fillStyle = '#000000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, fit.x, fit.y, fit.width, fit.height);
      if (!drawn) {
        drawn = true;
        settle(true);
      }
    }
    schedule();
  };

  /**
   * `requestVideoFrameCallback` là nhịp ĐÚNG: nó bắn một lần cho mỗi khung hình
   * camera thật sự tới, nên không có khung nào bị vẽ hai lần và không có khung
   * nào bị bỏ. `requestAnimationFrame` là đường lùi cho trình duyệt chưa có nó —
   * nó bám theo nhịp vẽ màn hình, không theo nhịp camera, và dừng hẳn khi tab bị
   * ẩn (điều ở đây vô hại: tab bị ẩn thì ta cũng đã chủ động dừng).
   */
  function schedule(): void {
    if (stopped) {
      return;
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameHandle = video.requestVideoFrameCallback(() => {
        frameHandle = null;
        draw();
      });
      return;
    }
    animationHandle = requestAnimationFrame(() => {
      animationHandle = null;
      draw();
    });
  }

  const onSourceEnded = (): void => {
    // Camera biến mất trước khung hình đầu tiên: không bao giờ có `drawn`, nên
    // người chờ phải được trả lời ngay thay vì ngồi hết hạn.
    if (!drawn) {
      settle(false);
    }
  };
  const onVideoError = (): void => {
    if (!drawn) {
      settle(false);
    }
  };
  options.source.addEventListener('ended', onSourceEnded);
  video.addEventListener('error', onVideoError);

  // `play()` bị từ chối không phải là lỗi ở đây: `<video>` này câm và rời cây,
  // nên chính sách autoplay không đụng tới; nếu có, vòng vẽ vẫn chạy và
  // `whenReady` là thứ nói thật về việc có khung hình hay không.
  void video.play().catch(() => undefined);
  schedule();

  return {
    track,
    whenReady(timeoutMs: number): Promise<boolean> {
      // `stopped` is asked FIRST. The other order answers `true` for a pipeline
      // that drew one frame and was then torn down — which is a caller about to
      // publish a track that has already been stopped.
      if (stopped) {
        return Promise.resolve(false);
      }
      if (drawn) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (ready: boolean): void => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          resolve(ready);
        };
        const timer = setTimeout(() => {
          finish(false);
        }, timeoutMs);
        readyWaiters.push(finish);
      });
    },
    pause(): void {
      paused = true;
      // Xem docblock của {@link FramePipeline.pause}: vòng vẽ dừng là chưa đủ.
      track.enabled = false;
    },
    resume(): void {
      paused = false;
      track.enabled = true;
    },
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      if (frameHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameHandle);
      }
      if (animationHandle !== null) {
        cancelAnimationFrame(animationHandle);
      }
      frameHandle = null;
      animationHandle = null;
      options.source.removeEventListener('ended', onSourceEnded);
      video.removeEventListener('error', onVideoError);
      video.pause();
      video.srcObject = null;
      video.remove();
      track.stop();
      settle(false);
    },
  };
}
