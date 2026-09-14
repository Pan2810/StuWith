---
title: 'Story 2.7 (1/3) — Pipeline xử lý khung hình và lần publish video đầu tiên'
type: 'feature'
created: '2026-09-14'
status: 'done'
baseline_commit: 'e3bfbdd37512854d9547c4ace7e3579c9ae8c2a1'
review_loop_iteration: 1
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.4 mở phòng nhưng chỉ publish audio, nên "Để nguyên" hôm nay là lời hứa suông: chọn nó xong vẫn không ai thấy ai, và "Ẩn mặt" không khác gì. `TrackSubscribed` bỏ qua mọi track video (`room-shell.tsx:396`). Không dòng nào trong `apps/web` tạo canvas, gọi `captureStream` hay `requestVideoFrameCallback` — grep ra 0.

**Approach:** Dựng pipeline canvas client-side và publish **track của canvas**, không bao giờ track của camera, kể cả ở Để nguyên — AD-30 luật (b), đóng bằng cấu trúc chứ không bằng canh giờ. Ẩn mặt = không publish video track nào. Thêm đường nhận video của người khác, và một nhóm chọn chế độ **trong phòng** đổi tức thì kèm ô xem trước chính mình. Story này **không** làm Filter và **không** làm thang hạ bậc.

## Boundaries & Constraints

**Always:**
- `publishTrack` chỉ bao giờ nhận track sinh từ `canvas.captureStream()`. Track của `getUserMedia` chỉ được gắn vào một `<video>` ẩn làm nguồn vẽ và **không bao giờ** đi tới LiveKit. Đây là tính chất phải đo được ở `RTCRtpSender.track.id`, không phải một lời bình.
- Ẩn mặt = không có video sender nào. Không phải track bị mute, không phải track đen — `unpublishTrack` và `stop()` camera, đèn camera tắt.
- Không sự kiện hệ thống nào đưa người dùng về Để nguyên. Chỉ tay người dùng bấm.
- Đổi chế độ tức thì, không dialog xác nhận. Nhóm `role="radiogroup"` có nhãn nhóm, mỗi mục `role="radio"` + `aria-checked`, đi được bằng phím mũi tên. Filter có mặt nhưng `disabled`.
- Token mang `canPublishSources: ['microphone','camera']`. Nguồn khác (screen share, dữ liệu) bị **server** từ chối, không phải bị ẩn nút.
- Rời trang, unmount, đổi sang Ẩn mặt, hoặc rời phòng → dừng vòng vẽ, `stop()` mọi track, và `close()` mọi thứ pipeline giữ.
- `RoomPanel` vẫn không state để `renderToStaticMarkup` chạy được; mọi phần tử sống nhận qua ref. Quyết định là hàm thuần export.
- Chuỗi qua catalogue `room.*` cả VI lẫn EN; mọi trạng thái có chữ, không chỉ màu.

**Ask First:** thêm bất kỳ dependency npm nào (`@mediapipe/*` thuộc phần 2/3, **không** thuộc story này); bật simulcast, `adaptiveStream` hay `dynacast`; đổi `infra/livekit.yaml`; thêm biến môi trường mới; đổi độ phân giải hay FPS mặc định của pipeline sau khi đã chốt.

**Never:** chế độ Filter và bất kỳ ML nào — đã tách, `deferred-work.md`. Đo FPS và thang tự hạ bậc — đã tách. Thang suy giảm mạng bốn bậc, simulcast, chip chất lượng (2.5). Lưới đi được bằng bàn phím và `control-bar` đầy đủ (2.6) — story này đặt nhóm chọn chế độ thẳng trong `RoomPanel`, 2.6 dời nó vào popover. Publish track camera trực tiếp ở bất kỳ nhánh nào. Gắn processor **sau** khi publish.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Vào phòng ở Để nguyên | `faceMode==='show'`, có camera | Pipeline chạy, publish track canvas; người khác thấy hình | N/A |
| Nhận video người khác | remote publish video | Ô của họ hiện `<video>` đang phát | N/A |
| Vào phòng ở Ẩn mặt | `faceMode==='hide'` | `getUserMedia` **không** xin video lần nào; không video sender; mọi người là avatar chữ cái | N/A |
| Đổi sang Ẩn mặt trong phòng | đang Để nguyên | Tức thì: unpublish, dừng vòng vẽ, `stop()` camera, ô mình thành avatar | N/A |
| Đổi sang Để nguyên trong phòng | đang Ẩn mặt | Xin camera, dựng pipeline, publish track canvas mới | từ chối → câu giải thích, giữ Ẩn mặt |
| Camera bị từ chối lúc vào | `NotAllowedError` | Vào phòng ở Ẩn mặt kèm câu nói vì sao; audio không bị ảnh hưởng | không tự xin lại |
| Không có camera | `NotFoundError` | Để nguyên `disabled`, Ẩn mặt là lựa chọn duy nhất | N/A |
| Camera bị rút giữa phòng | track `ended` | Unpublish, về Ẩn mặt, câu giải thích — **không** tự quay lại Để nguyên | không tự xin lại |
| Tab bị ẩn | `visibilitychange` | **Người dùng chốt 2026-09-14:** dừng vòng vẽ CÓ CHỦ Ý và mute publication, nên phía kia thấy avatar chứ không phải một khung hình đứng. Chế độ khuôn mặt KHÔNG đổi — quay lại tab thì tự phát tiếp, nên không sự kiện hệ thống nào đưa ai về Để nguyên | N/A |
| Server từ chối publish video | grant thiếu `camera` | Câu giải thích, người dùng vẫn ở trong phòng và vẫn nghe được | không retry ngầm |
| Người khác tắt video | `TrackUnsubscribed` video | Ô của họ về avatar chữ cái, không để `<video>` mồ côi | N/A |
| Rời phòng khi đang Để nguyên | bấm "Rời phòng" | Vòng vẽ dừng, canvas track và camera track đều `ended` | N/A |

## Probe ranh giới

**Ranh giới:** trình duyệt ↔ LiveKit, cho **video** — chưa có gì phủ. Story 2.4 mở ranh giới này cho audio; grep `tests/` không ra một assertion nào về `m=video`, về `inbound-rtp` video, hay về một track video được subscribe. AD-30 luật (d) đòi probe ở tầng trình duyệt cho đúng đường này, và luật (b) là thứ duy nhất trong repo hôm nay hoàn toàn chưa được kiểm.

**Probe:** mở rộng `tests/e2e/livekit/phong-media.spec.ts` (container LiveKit thật, hai Chromium thật, camera giả của Chromium có hoạ tiết **chuyển động** nên khung hình thực sự đổi). Bốn khẳng định, và khẳng định đầu là cái mang cả story:
1. **Danh tính track trên dây.** Bọc `HTMLCanvasElement.prototype.captureStream` và `navigator.mediaDevices.getUserMedia` bằng `addInitScript` để thu `id` của mọi track hai bên sinh ra; rồi đọc `RTCRtpSender.track.id` off `RTCPeerConnection` thật đã thu bằng `collectPeerConnections`. Id đang gửi phải **nằm trong tập track canvas** và **không bao giờ** nằm trong tập track camera. Đây chính là AD-30 luật (b), phát biểu dưới dạng đo được: một bản dựng gắn processor sau khi publish sẽ để lộ id của camera ở sender.
2. `m=video` có trong SDP đã thương lượng, đọc bằng `negotiatedDescriptions` đã có (`phong-media.spec.ts:226`).
3. Phía kia có `inbound-rtp` video với `bytesReceived > 0` **và** `framesDecoded > 0` — hình thật sự giải mã được, không chỉ bắt tay xong.
4. Ở Ẩn mặt: **không sender video nào tồn tại** (không phải sender có track bị mute), và `getUserMedia` không được gọi với `video` lần nào.

**Sẽ đỏ khi:** bỏ `'camera'` khỏi `canPublishSources` trong `apps/api/src/rooms/room-token.ts` rồi build lại `apps/api` — **server** từ chối việc publish video trong khi mọi dòng của `apps/web` giữ nguyên, nên khẳng định 1, 2 và 3 cùng đỏ. Mutation thứ hai, ở phía ta nhưng đi qua cả seam: publish `handle.camTrack` thay vì track canvas → khẳng định 1 đỏ trong lúc 2 và 3 vẫn xanh, đúng cái bẫy AD-30 mô tả. Cả hai phải **chạy thật**.

</frozen-after-approval>

## Code Map

Neo tự đo trên `e3bfbdd`. Đừng tìm lại.

**Chỗ cắm chính** — `apps/web/src/app/phong/[roomId]/room-shell.tsx`: `RunHandle` :139-148 (`cancelled`, `aborted`, `room`, `micTrack`, `micPublished`, `connected` — **chưa có trường video nào**); effect :248-563 theo thứ tự `handle` :253-261 → `tokenExpiredAt` :301 → `import('livekit-client')` :316 → `getUserMedia({audio:true})` :336-354 (chỉ nhánh `mic`) → `roomOptionsFor` + `new Room` :360-362 → chuỗi `.on()` :377-441 → hẹn giờ hết hạn :460-474 → `connect` :484 → `publishTrack` :501-538. `stopMic` :264-268 là khuôn cho `stopCam`. `TrackSubscribed` :383-407 **chỉ xử lý `Track.Kind.Audio`** (:396) — video đang bị bỏ qua lặng lẽ; `TrackUnsubscribed` :408-413. `audioHostRef` :587 là div ẩn `className="sr"`. Cleanup :547-562. `giveUp` :271 (đã có guard `aborted`).

**Quyết định thuần** — `room-media.ts`: `audioPublishOptions()` :61 (khuôn cho `videoPublishOptions()`), `MediaFaceMode` :79, `MediaDecision` :81-84 (`{faceMode, audio}`), `MediaRoomOptions` :99-105, `roomOptionsFor` :107-115 — **`adaptiveStream: false` :109 và `dynacast: false` :110 đang ghim cứng**, docblock nói "2.5", nhưng 2.5 chỉ đúng cho simulcast/thang mạng; story này phải quyết định lại có mở không (mặc định: giữ `false`, ghi lý do). `MediaParticipant` :317-322 và `ParticipantRow` :342-349 **chưa có trường video** — phải thêm để ô biết vẽ `<video>` hay avatar. `participantRowsFor` :366.

**Trình bày** — `room-panel.tsx`: props inline :157-171 (chưa có ref, chưa có video); heading :178, chip :185-187, câu tóm tắt dùng `FACE_KEYS[decision.faceMode]` :196-199 (chỗ nhóm chọn chế độ sẽ cắm cạnh), danh sách :229-259, nút rời :268-276. Phải giữ không state — khuôn nhận ref là `PreJoinPanel` (`pre-join.tsx:565` `videoRef`).

**Pre-join (chỉ đọc, để không lặp)** — `page.tsx`: `getUserMedia` :279 và :356, `adoptStream` :223-245, `stopTracks` :134-136, `releaseDevices` :151-157 gọi ở :384 (unmount) và :418 (trên 201, **dừng camera trước khi shell mount** — nên shell tự xin lại). `pre-join.tsx`: `faceModeAvailable` :247-258, `effectiveFaceModeFor` :268-270, radiogroup :828-862, `FACE_MODE_FIELD` :518. Không có canvas ở đâu cả (grep `captureStream|OffscreenCanvas|requestVideoFrameCallback|MediaStreamTrackProcessor|getContext` trên `apps/web/src` ra **0**).

**BÀI HỌC PHẢI CHÉP SANG, không phải gợi ý** — Story 2.3 đã trả giá cho đúng lớp lỗi này và ghi vào Spec Change Log của nó: *"quyết định đọc từ ref tại thời điểm 201, không từ giá trị bắt lúc bấm"* và *"camera về muộn sau khi đã bấm Ẩn mặt lại → dừng ngay khi tới"*. Ở trong phòng, mọi bước mở camera đều **bất đồng bộ** (tải SDK, `getUserMedia`, dựng pipeline, `connect`), và `RoomPanel` cho bấm đổi chế độ từ khung hình ĐẦU TIÊN — `IN_ROOM` gồm cả `connecting`. Nên `decision.faceMode` là ảnh chụp lúc rời pre-join và **không bao giờ** được dùng làm căn cứ sau một `await`.

**Token** — `apps/api/src/rooms/room-token.ts`: `RoomVideoGrant` :54-59 khai **đúng bốn khoá**, docblock :50-52 nói ba grant admin "không phải thành viên vắng mặt, mà không phải thành viên" — thêm `canPublishSources` phải sửa cả interface lẫn docblock. Grant dựng ở :62-67. **`tests/gates/livekit-token.test.ts:419-434` `toEqual` đúng bốn khoá đó** — sẽ đỏ, và phải sửa cùng lúc chứ không phải nới thành `toMatchObject`. Mục `deferred-work.md` về `canPublishSources` đóng ở đây (thu hẹp: chặn nguồn khác, KHÔNG chặn được raw-vs-processed — server không phân biệt được, đó là lý do luật (b) phải là tính chất cấu trúc phía client).

**Probe harness** — `tests/e2e/livekit/phong-media.spec.ts`: `collectPeerConnections` :108 (proxy `RTCPeerConnection`), `inboundAudioBytes` :124, `subscribedAudioTracks` :141, `localAudioTrackStates` :155, `rememberStreams` :163 (đã bọc `getUserMedia` — nơi thu id camera), `joinAs` :180, `negotiatedDescriptions` :226 (**đọc cả local lẫn remote SDP, thuần chuỗi — dùng lại nguyên cho `m=video`**), `CONTEXT_OPTIONS` :209, describe `mode: 'serial'` :299. `global-setup.ts`: `serverConfig()` :97-127 không có gì về video (mặc định LiveKit đủ); khối `audio:` chỉ liên quan active speaker. `playwright.config.ts`: `BROWSER_USE` :134-146 — `--use-fake-device-for-media-stream` cấp **cả camera giả (hoạ tiết chuyển động) lẫn mic giả**, `permissions` đã có `camera`; project `livekit` :223-235 `timeout: 120_000`.

**Probe phủ định** — `tests/e2e/web/phong.spec.ts`: `guardMediaPlane` :76-173 **đã có `videoTrackStates()` :156-167** và đếm ICE server; `expectNoMediaPlane` :195-203; `expectMediaPlaneOnlyToRoom` :219-253; `refuseDevices(page, name, onlyVideo)` :260-282 (tham số `onlyVideo` đúng thứ ca "camera bị từ chối" cần); `refuseAudioOnlyDevices` :297-313.

**CSS** — `globals.css`: có `.preview` :633-645, `.preview-video` :652-659 (**lật gương `scaleX(-1)`, docblock :650 nói rõ chỉ cho xem trước cục bộ — ô trong phòng phải có class riêng**), `.avatar-letter` :684-704, `.choice:has(input:disabled)` :711-716 (dùng lại cho Filter disabled), `.participant-*` :927-1002. **Chưa có**: ô video trong phòng, lưới video, nhóm chọn chế độ trong phòng.

## Tasks & Acceptance

**Execution:**
- [ ] **BẤT BIẾN 1 — một nguồn sự thật duy nhất cho chế độ đang muốn.** Dựng `faceModeRef` (hoặc một trường trên `handle`) mà `changeFaceMode` ghi NGAY, trước và độc lập với việc `handle.enableVideo`/`disableVideo` đã tồn tại hay chưa. Mọi đường bất đồng bộ đọc nó SAU mỗi `await` và trước mỗi hành động có hệ quả: trước khi gán `handle.camTrack`/`handle.pipeline`, trước `setSelfVideoOn(true)`, và trước MỌI `publishTrack` video. Không đọc `decision.faceMode` sau một `await` ở bất kỳ đâu. Cú bấm rơi vào cửa sổ chưa có callback phải được xếp hàng rồi thi hành khi run sẵn sàng, **không** được nuốt bằng `?.`. Đây là một bất biến: phát biểu ở MỘT chỗ rồi các điểm gọi tuân theo, không phải một guard chép lại ở mỗi `await`.
- [ ] **BẤT BIẾN 2 — video không bao giờ chặn đường âm thanh.** epic-2-context: *"Video được phép tụt bậc rồi tắt hẳn; tiếng không bao giờ được rớt."* Mở camera và dựng pipeline **không được** nằm chắn trước `room.connect()`; `whenReady()` phải có timeout cùng listener `error`/`ended` rồi rơi về `room.errorVideoPipeline`. Hôm nay một camera cấp được track nhưng treo không trả `loadedmetadata` làm người dùng không vào được phòng và mất luôn cả tiếng.
- [ ] `apps/web/src/app/phong/[roomId]/frame-pipeline.ts` — module MỚI, không import React: `createFramePipeline({ source, width, height, fps })` trả `{ track, stop }`; dựng `<canvas>` ngoài DOM, vòng vẽ bằng `requestVideoFrameCallback` (fallback `requestAnimationFrame`), `canvas.captureStream(fps)`; `stop()` huỷ vòng vẽ, `stop()` track canvas, gỡ `<video>` nguồn. Hàm thuần đi kèm: `pipelineSizeFor(settings)`, `frameFitFor(srcW, srcH, dstW, dstH)` (letterbox, không méo). Docblock nêu AD-30 luật (b) và vì sao processor gắn sau publish là sai.
- [ ] `apps/web/src/app/phong/[roomId]/room-media.ts` — `videoPublishOptions()` (nguồn `camera`, không simulcast, độ phân giải và FPS ghim tường minh); `MediaParticipant` và `ParticipantRow` thêm `videoOn`; `participantRowsFor` mang nó ra; quyết định lại `adaptiveStream`/`dynacast` và ghi lý do vào docblock; `faceModeAllowsVideo(faceMode)`.
- [ ] `apps/web/src/app/phong/[roomId]/room-shell.tsx` — `RunHandle` thêm `camTrack`, `pipeline`, `camPublished`; `stopCam` theo khuôn `stopMic` :264; xin camera CHỈ khi `faceModeAllowsVideo`; dựng pipeline rồi `publishTrack(pipeline.track, videoPublishOptions())` — **không bao giờ** `handle.camTrack`; `TrackSubscribed` thêm nhánh `Track.Kind.Video` gắn vào ô của đúng participant; `TrackUnsubscribed` gỡ; listener `ended` trên camera track → unpublish + về Ẩn mặt + câu giải thích; `onChangeFaceMode` bật/tắt tức thì; cleanup dừng pipeline.
- [ ] `apps/web/src/app/phong/[roomId]/room-panel.tsx` — nhận `faceMode`, `onChangeFaceMode`, `selfVideoRef`, `videoRefFor(identity)`; render nhóm `radiogroup` ba mục (Filter `disabled`, nhãn "Sắp có") cạnh câu tóm tắt, ô xem trước chính mình, và `<video>` cho mỗi hàng có `videoOn` — còn lại là avatar. Vẫn không state.
- [ ] `apps/api/src/rooms/room-token.ts` — `RoomVideoGrant` thêm `canPublishSources: readonly ['microphone','camera']`; sửa docblock :50-52 vì "đúng bốn khoá" không còn đúng.
- [ ] `tests/gates/livekit-token.test.ts` — cập nhật `toEqual` ở :419-434 cho grant mới, và thêm một ca khẳng định `canPublishSources` KHÔNG chứa `screen_share`.
- [ ] `apps/web/src/app/i18n/messages.ts` + `messages.en.ts` — khối chế độ khuôn mặt trong phòng (nhãn nhóm, ba nhãn, "Sắp có"), câu camera bị từ chối, câu camera bị rút, câu server từ chối publish video, nhãn ô xem trước. Cập nhật số đếm trong docblock (gate rule 5).
- [ ] `apps/web/src/app/globals.css` — `.room-video`, `.participant-video`, `.face-mode-group`, ô xem trước trong phòng; **không** dùng lại `.preview-video` (lật gương chỉ đúng cho xem trước cục bộ); reflow 320px, sàn 48px.
- [ ] `apps/web/src/app/phong/[roomId]/frame-pipeline.test.ts` + `room-media.test.ts` + `room-panel.test.tsx` — hàm thuần và markup cho mọi dòng ma trận; cả hai locale; `videoPublishOptions()` ghim tường minh.
- [ ] `tests/e2e/web/phong.spec.ts` — ca "camera bị từ chối lúc vào phòng" dùng `refuseDevices(..., onlyVideo)`; ca Ẩn mặt khẳng định `getUserMedia` không lần nào được gọi với `video` sau khi vào phòng; `expectMediaPlaneOnlyToRoom` vẫn xanh.
- [ ] `tests/e2e/livekit/phong-media.spec.ts` — **probe ranh giới**: bọc `captureStream`, đọc `RTCRtpSender.track.id`, `m=video`, `framesDecoded > 0`, và ca Ẩn mặt không có sender video.
- [ ] `_bmad-output/implementation-artifacts/deferred-work.md` — đóng mục `canPublishSources` (ghi rõ nó KHÔNG cưỡng chế được raw-vs-processed); đóng nửa camera của mục track `ended`; ghi nợ mới nếu `adaptiveStream`/`dynacast` vẫn để `false`.

**Acceptance Criteria:**
- Given hai trình duyệt thật và một `livekit-server` thật, when cả hai vào phòng ở Để nguyên, then `RTCRtpSender.track.id` nằm trong tập track canvas và không nằm trong tập track camera, SDP có `m=video`, và phía kia có `framesDecoded > 0`.
- Given grant bỏ `'camera'` khỏi `canPublishSources`, when chạy probe, then probe đỏ.
- Given publish `handle.camTrack` thay vì track canvas, when chạy probe, then khẳng định danh tính track đỏ còn hai khẳng định kia vẫn xanh.
- Given `faceMode === 'hide'`, when ở trong phòng, then không sender video nào tồn tại và `getUserMedia` không được gọi với `video` lần nào.
- Given đang Để nguyên, when camera bị rút, then về Ẩn mặt kèm câu giải thích và **không** tự quay lại Để nguyên.
- Given `test:gates`, then `livekit-token`, `i18n-catalogue`, `contrast`, `ad-1` xanh.

## Spec Change Log

- 2026-09-14 (review vòng 1 — `bad_spec`, loopback về step-03). **Phát hiện kích hoạt:** cả ba lớp review độc lập tìm ra cùng một gốc ở năm biểu hiện — chế độ khuôn mặt đổi trong cửa sổ bất đồng bộ bị bỏ qua, và ở một chiều nó **publish khuôn mặt của người vừa bấm Ẩn mặt**. Dựng lại được: bấm "Ẩn mặt" lúc đang `connecting` → `handle.disableVideo` còn `null` nên cú bấm chỉ đổi state React → run đọc `decision.faceMode === 'show'` ở `room-shell.tsx:1043` → mở camera rồi publish, với radio "Ẩn mặt" đang chọn cạnh ô xem trước đang sống dưới dòng "Đây là hình mọi người đang thấy". Chiều ngược lại thì cú bấm "Để nguyên" bị nuốt lặng lẽ. **Sửa gì trong spec:** thêm hai nhiệm vụ BẤT BIẾN ở đầu Execution (một nguồn sự thật cho chế độ đang muốn, đọc lại sau mỗi `await`; video không chặn audio, pipeline phải có timeout), và chép vào Code Map bài học Story 2.3 đã trả giá để học. **Trạng thái xấu đã tránh:** vá từng điểm `await` một — đúng cách `client-address.ts` chết sau ba vòng, mỗi vòng vá cái ví dụ được chỉ (`AGENTS.md`). **KEEP — phải sống sót qua lần dựng lại:** (1) phép đo danh tính track ở `RTCRtpSender.track.id`, kèm hai bảo vệ chống đúng-vacuous (camera thật sự đã mở, canvas thật sự đã sinh track) và `expect.soft` để thấy được sự bất đối xứng; (2) ba mutation đã chạy đỏ thật — bỏ `'camera'` khỏi `canPublishSources`, publish `handle.camTrack`, gỡ listener `visibilitychange`; (3) quyết định của người dùng về tab ẩn: dừng vẽ có chủ ý + mute publication, chế độ khuôn mặt không đổi, mọi khẳng định đọc từ trình duyệt THỨ HAI; (4) `canPublishSources` trong grant kèm ghi chú rõ nó KHÔNG cưỡng chế được raw-vs-processed; (5) `faceModeAllowsVideo` trả `false` cho `filter`; (6) `roomTokenWithoutCameraSource` ký lại bằng chính `mintRoomToken` của sản phẩm; (7) `MEDIA_FACE_MODES` và `videoPublishOptions()` ghim tường minh.

## Design Notes

**Vì sao danh tính track là phép đo đúng.** AD-30 luật (b) nói cửa sổ rò phải đóng bằng cấu trúc. Một test kiểu "có canvas không" chứng minh được là ta có vẽ; nó không chứng minh thứ *đi lên dây* là cái đã vẽ. `RTCRtpSender.track.id` là chỗ duy nhất hai khả năng đó tách nhau, và nó đọc được từ `RTCPeerConnection` thật mà `collectPeerConnections` đã thu sẵn từ 2.4.

**`canPublishSources` không cứu được luật (b).** Server không phân biệt được track canvas với track camera — cả hai đều là `camera` source. Nên grant chỉ chặn được *nguồn khác* (screen share), và mục nợ đóng ở đây phải ghi đúng phạm vi đó, kẻo người sau đọc thành "đã cưỡng chế ở server rồi".

**Ẩn mặt là vắng mặt, không phải im lặng.** Một sender có track bị mute vẫn là một track đã rời máy. Ẩn mặt phải là không có sender — và đó cũng là điều kiện để phần 3/3 hạ bậc về Ẩn mặt mà không phụ thuộc vào pipeline đang hỏng.

## Verification

**Commands:**
- `corepack pnpm run build:packages` rồi `corepack pnpm --filter api build` — probe dùng `apps/api/dist`.
- `corepack pnpm run typecheck` · `corepack pnpm run dep-check`.
- `corepack pnpm run test:unit` — mutation: bỏ `source: camera` trong `videoPublishOptions()` → đỏ.
- `corepack pnpm exec vitest run --project gates` — `livekit-token` phải xanh SAU khi sửa grant, và đỏ nếu quên sửa.
- `corepack pnpm exec playwright test` — cả ba project; chạy **nhiều lượt**, không chỉ một: Story 2.4 có một lỗi thật chỉ đỏ khoảng một phần tư số lượt.
- Rồi **chạy thật** hai mutation ở "Sẽ đỏ khi" và khôi phục.
- Sau e2e: `git checkout -- apps/web/next-env.d.ts`.

## Suggested Review Order

**Điểm vào: bất biến đã khiến story này phải dựng lại một lần**

- Chế độ đang MUỐN sống ở một ref, ghi đồng bộ lúc bấm; `decision.faceMode` chỉ là hạt giống
  [`room-shell.tsx:345`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L345)

- Reconciler level-triggered: mỗi vòng đọc lại ref, và dòng đầu tiên là cờ huỷ — nên một cờ đặt ở bất kỳ đâu cũng được tuân thủ
  [`room-shell.tsx:1238`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1238)

- Một cú bấm rơi vào lúc chưa có callback được xếp hàng chứ không bị nuốt
  [`room-shell.tsx:1285`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1285)

**AD-30 luật (b): thứ đi lên dây không bao giờ là camera**

- Dòng publish video DUY NHẤT, và đối số của nó là track của canvas
  [`room-shell.tsx:1106`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1106)

- Camera chỉ là nguồn vẽ: gắn vào `<video>` ẩn, không bao giờ ra khỏi module này
  [`frame-pipeline.ts:175`](../../apps/web/src/app/phong/%5BroomId%5D/frame-pipeline.ts#L175)

- Letterbox: khung không khớp tỉ lệ thì viền đen, không bao giờ méo mặt
  [`frame-pipeline.ts:108`](../../apps/web/src/app/phong/%5BroomId%5D/frame-pipeline.ts#L108)

**Bất biến 2: video không bao giờ chắn đường tiếng**

- `whenReady` có hạn giờ; camera treo thì rơi về Ẩn mặt kèm câu, không giữ người dùng ngoài phòng
  [`frame-pipeline.ts:56`](../../apps/web/src/app/phong/%5BroomId%5D/frame-pipeline.ts#L56)

- Mở camera và dựng pipeline không nằm chắn trước `connect()`; publish đợi phòng lên
  [`room-shell.tsx:1099`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1099)

- Vòng reconcile có trần: một bước không tiến phải suy biến thành "ẩn mặt, tắt camera, một câu", không giết tab
  [`room-shell.tsx:189`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L189)

**Tab ẩn — quyết định của con người, 2026-09-14**

- Dừng vẽ VÀ mute publication: phía kia thấy avatar, không phải một khung hình đứng
  [`room-shell.tsx:669`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L669)

- Một đường dọn dẹp dùng chung cho rời phòng, đổi chế độ và unmount
  [`room-shell.tsx:641`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L641)

**Probe ranh giới — phép đo mà mọi phép kiểm "có video không" đều bỏ lọt**

- Id đang gửi phải thuộc tập canvas và không thuộc tập camera, kèm hai bảo vệ chống đúng-vacuous
  [`phong-media.spec.ts:800`](../../tests/e2e/livekit/phong-media.spec.ts#L800)

- Đọc lại id sau vòng ẩn→hiện, nên lần publish thứ hai cũng bị soi
  [`phong-media.spec.ts:906`](../../tests/e2e/livekit/phong-media.spec.ts#L906)

- Ẩn mặt là VẮNG MẶT: không sender nào, không lần nào hỏi camera
  [`phong-media.spec.ts:931`](../../tests/e2e/livekit/phong-media.spec.ts#L931)

- Token từ chối nguồn camera: câu giải thích hiện ra, tiếng không suy suyển
  [`phong-media.spec.ts:1123`](../../tests/e2e/livekit/phong-media.spec.ts#L1123)

**Hợp đồng token**

- `canPublishSources`, kèm docblock nói thẳng nó KHÔNG cưỡng chế được luật (b)
  [`room-token.ts:51`](../../apps/api/src/rooms/room-token.ts#L51)
