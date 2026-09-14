---
title: 'Story 2.5 — Thang suy giảm mạng bốn bậc'
type: 'feature'
created: '2026-09-14'
status: 'done'
baseline_commit: '33ebed5a31e7c23c031c507bbdef71d8a29bcf72'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Phòng học hôm nay chỉ có hai trạng thái: chạy, hoặc mất kết nối. Không có gì đọc chất lượng mạng — `ConnectionQualityChanged` không có listener nào trong `apps/web`. `simulcast`, `adaptiveStream`, `dynacast` đều đang `false` với docblock ghi đích danh story này là chủ. Nhóm người dùng mục tiêu học đêm trên wifi phòng trọ, nên "buổi học không gãy khi mạng yếu" là chức năng, không phải nhánh lỗi.

**Approach:** Một thang bốn bậc lái bởi `ConnectionQuality` của SDK, cắm vào **đúng reconciler** mà Story 2.7 đã dựng — bậc mạng là chiều "muốn" thứ ba bên cạnh chế độ khuôn mặt và `videoPaused`, không phải một vòng lặp song song. Bật simulcast để bậc 1–2 có thứ để tụt. Bậc 3 tắt video và **không bao giờ** tự bật lại.

## Boundaries & Constraints

**Always:**
- Bậc mạng đi qua `stepVideo`/`wake` (`room-shell.tsx:1238`, `:1340`). Reconciler đã mang hai chiều trực giao (`faceModeRef`, `handle.videoPaused`); bậc là chiều thứ ba. **Không** thêm vòng lặp thứ hai, không thêm effect riêng — Story 2.7 mất một loopback vì một trạng thái bất đồng bộ nằm ngoài chỗ này.
- **Mạng hồi phục không bao giờ tự bật camera.** Sau bậc 3 chỉ hiện nút "Bật lại camera". `EXPERIENCE.md`: *"Tự bật lại camera cho một người đang ẩn mặt là vi phạm nghiêm trọng."* Người đang Ẩn mặt bấm nút đó cũng không được đổi chế độ của họ.
- **Audio không bao giờ bị hy sinh.** Không bậc nào tắt, bóp hay trì hoãn đường audio. Bậc 3 tắt video *để* cứu tiếng.
- Lên bậc thì **im lặng**: chip đổi, không banner, không thông báo. Xuống bậc 3 mới có banner một dòng.
- Chip hoãn **3 giây** đọc từ `--motion-network-chip-debounce` (`tokens.css:133`) — một nguồn duy nhất, không gõ lại số.
- Mọi bậc có **chữ**, không chỉ màu: cặp xanh-lá/đất-nung là cặp khó nhất với người mù màu đỏ-lục.
- `RoomPanel` vẫn không state; bậc và banner tới bằng props. Quyết định là hàm thuần export trong `room-media.ts`.
- Chip **chất lượng mạng** và chip **pha kết nối** là hai thứ khác nhau (`STATUS_KEYS` :143 hôm nay là pha). Story này phải nói rõ chúng hợp nhất hay đứng cạnh nhau, và không để người dùng thấy hai chip mâu thuẫn.

**Ask First:** thêm dependency npm; bật `adaptiveStream`/`dynacast` **khác** với quyết định ghi trong spec này; đổi `VIDEO_MAX_BITRATE` hay `PIPELINE_FPS`; đổi `infra/livekit.yaml`; thêm biến môi trường; dùng CDP throttling làm nền cho một AC.

**Never:** tự bật lại camera ở bất kỳ đường nào. Đổi chế độ khuôn mặt của người dùng vì một sự kiện hệ thống. Thang hạ bậc **của filter** theo FPS — đó là nợ riêng của 2.7 phần 3/3, cùng hình dạng nhưng khác tín hiệu và khác chủ; không gộp. Lưới đi được bằng bàn phím và `control-bar` (2.6). Chat (2.8). Đụng đường audio.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Bậc 1 | `ConnectionQuality.Excellent` | Simulcast bật, lớp cao; chip `ok` "Mạng tốt" | N/A |
| Bậc 2 | `Good` | Video tự tụt lớp; chip **vẫn** `ok`, **không** banner, không thông báo | N/A |
| Bậc 3 | `Poor` | Video tắt hẳn, ô thành avatar; chip `warn` "Mạng yếu" + banner một dòng; audio không suy suyển | N/A |
| Bậc 4 | `Lost`, hoặc mất kết nối thật | Banner "Mất kết nối — đang thử lại", lưới đóng băng, thử lại trong 30 giây | hết 30s → câu kết, có lối ra |
| Hồi phục 3 → 1 | `Poor` → `Excellent` | Chip về `ok` **trong im lặng**; camera **không** tự bật; hiện nút "Bật lại camera" | N/A |
| Bấm "Bật lại camera" | người dùng bấm | Camera bật lại qua đúng đường của 2.7 (pipeline → publish track canvas) | từ chối → câu giải thích |
| Đang Ẩn mặt, mạng tụt rồi hồi | `hide` suốt | **Không** nút "Bật lại camera", không banner về camera — họ có tắt video đâu mà bật | N/A |
| Mạng dao động liên tục | quality đổi nhiều lần trong 3s | Chip đổi **một lần**, sau hoãn; không nhấp nháy | N/A |
| Tụt bậc khi tab đang ẩn | `Poor` + `document.hidden` | Hai chiều "muốn" cùng nói tắt video; không xung đột, không publish lại khi hiện tab nếu đang bậc 3 | N/A |
| Bậc 3 rồi rời phòng | bấm "Rời phòng" | Dọn như thường; không có trạng thái thang nào sống sót | N/A |
| `Unknown` | SDK chưa đo được | Coi như bậc 1, không banner — không doạ người dùng bằng một ẩn số | N/A |
| Hồi phục khi người dùng đã tự bấm Ẩn mặt ở bậc 3 | `Poor` → `Excellent`, `faceMode==='hide'` | Không nút, không tự bật — lựa chọn của người thắng trạng thái của mạng | N/A |

## Probe ranh giới

**Ranh giới:** trình duyệt ↔ LiveKit. Hai nửa của story này đứng ở hai phía khác nhau của một ranh giới đo được, và phải nói thẳng nửa nào là nửa nào.

**Probe:** mở rộng `tests/e2e/livekit/phong-media.spec.ts` (container thật, hai Chromium thật).
1. **Simulcast có thật trên dây.** `negotiatedDescriptions` (`:260`) đã đọc SDP đã thương lượng; bật simulcast thì SDP mang nhiều encoding cho `m=video`. Đây là bậc 1 phát biểu dưới dạng đo được, và nó đỏ khi `simulcast` trở về `false`.
2. **Bậc 3 thật sự gỡ sender.** `videoSenderCount` (`:392`) về 0 và trình duyệt kia mất ô video — cùng phép đo Story 2.7 đã dựng, nay do thang lái.
3. **Bậc 4 lái bằng việc TẮT HẲN CONTAINER giữa phiên.** `global-setup` giữ `StartedTestContainer`; probe dừng nó, rồi khẳng định màn hình vào bậc 4, lưới đóng băng, và audio đã mất. Đây là kích thích thật ở phía bên kia, không phải một cờ trong trang.
4. **Hồi phục không bật camera.** Sau bậc 3, đưa quality về `Excellent`: chip về `ok`, **không** sender video nào xuất hiện, và nút "Bật lại camera" có mặt.

**Nửa KHÔNG phải probe, khai rõ:** chuyển bậc 1↔2↔3 được lái bằng một seam **trong trình duyệt** phát đúng sự kiện `ConnectionQualityChanged` của SDK — cùng hạng với `refuseDevices` và `setTabHidden` đã có. Lý do: tín hiệu ấy là phép đo của chính LiveKit, và việc ép nó từ bên ngoài **không xác minh được** trong harness này — Playwright 1.62.1 có `newCDPSession`, nhưng `Network.emulateNetworkConditions` có bóp được đường UDP/SRTP hay không nằm trong C++ của Chromium, không đọc ra được từ repo. Đây là ẩn số đã đo, không phải phỏng đoán; đừng dựng một AC trên nó.

**Sẽ đỏ khi:** dừng container LiveKit giữa phiên (`container.stop()`, phía bên kia hoàn toàn) mà sản phẩm không vào bậc 4 — khẳng định 3 đỏ. Mutation thứ hai, đi qua cả seam: đặt `simulcast: false` trong `videoPublishOptions()` rồi chạy lại → khẳng định 1 đỏ trong khi 2, 3, 4 vẫn xanh. Cả hai phải **chạy thật**.

</frozen-after-approval>

## Code Map

Neo tự đo trên `33ebed5`. Đừng tìm lại.

**Reconciler — chỗ bậc mạng phải cắm vào** — `apps/web/src/app/phong/[roomId]/room-shell.tsx`: `RunHandle` :216-257 (`videoPaused` :240 là "muốn", `videoMuted` :241 là "đã tới" — **khuôn mẫu cho bậc mạng**), `stepVideo` :1238-1267 (một micro-bước level-triggered, đọc `faceModeAllowsVideo(faceModeRef.current)` :1243), `stepPause` :1159-1202 (chiều thứ hai, mute/unmute publication), `syncVideo` :1285-1338 (vòng có trần `VIDEO_SYNC_MAX_PASSES` :189), `handle.wake` :1340-1344 (**điểm vào duy nhất**, gọi từ :522 đổi chế độ, :682 visibility, :900 `ConnectionStateChanged`). `faceModeRef` :345. `applyVisibility` :669-684 là khuôn gần nhất: ghi "muốn" đồng bộ rồi `wake()`.

**RoomEvent đã đăng ký** :822-918 — `ParticipantConnected` :822, `ParticipantDisconnected` :823, `TrackMuted` :830, `TrackUnmuted` :831, `ActiveSpeakersChanged` :832, `TrackSubscribed` :833, `TrackUnsubscribed` :873, `AudioPlaybackStatusChanged` :885, `ConnectionStateChanged` :891, `Disconnected` :905. **Chưa có `ConnectionQualityChanged`** — chỗ cắm tín hiệu mới.

**State và ref** :298-358 — `connection` :298, `errorKey` :299, `micNoticeKey` :300, `expired` :301, `local` :302, `remotes` :303, `speakers` :304, `audioBlocked` :315, `faceMode` :322, `cameraMissing` :324, `selfVideoOn` :326, `videoNoticeKey` :328; refs `runRef` :331, `audioHostRef` :333, `videoTracksRef` :357, `videoElementsRef` :358. `leave` :468-492, `releaseVideo` :641-648, cleanup :1466-1486.

**SDK (chỉ đọc)** — `livekit-client@2.22.3`: `RoomEvent.ConnectionQualityChanged` (`room/events.d.ts:222`, tham số `(quality, participant)`), `RoomEvent.TrackStreamStateChanged` :233 (fires theo ràng buộc băng thông của subscriber), `Reconnecting` :19 / `Reconnected` :29. `ConnectionQuality` (`room/participant/Participant.d.ts:13-23`): `Excellent | Good | Poor | Lost | Unknown`. `LocalTrackPublication.pauseUpstream()/resumeUpstream()` :32/:37; `LocalVideoTrack.setPublishingLayers` :89. `TrackPublishDefaults.simulcast` mặc định **true** (`room/track/options.d.ts:67`).

**Ba công tắc story này phải QUYẾT, không phải phát hiện** — `room-media.ts`: docblock :87-92 (`simulcast: false` — *"ba lớp độ phân giải là thang suy giảm mạng, và thang đó là Story 2.5. Bật nó ở đây có nghĩa là 2.5 phát hiện ra nó đã bật thay vì quyết định bật"*), :256-268 (`adaptiveStream`/`dynacast` — *"cả hai là hai công tắc của thang"*). `MediaRoomOptions` :278-294, `videoPublishOptions()` :124-131, `VIDEO_MAX_BITRATE` :122, `degradationPreference: 'maintain-framerate'`. Ba docblock này phải được viết lại thành quyết định, không để nguyên câu hoãn.

**Quyết định thuần khác** — `room-media.ts`: `JoinPhase` :376, `joinPhaseFor` :378-400, `RoomConnectionState` :332-345, `isLiveConnection` :361, `ParticipantRow` :576-585, `participantRowsFor` :602-641, `faceModeAllowsVideo` :171, `initialFaceModeFor` :198, `videoKeyFor` :528.

**Trình bày** — `room-panel.tsx`: props :217-251, chip :265-267 (`STATUS_KEYS` :143-150 theo **pha**, `STATUS_TONES` :153-160 → `chip-status ok|warn`), khối notice :369-406 (mỗi loại một `<p role="alert">`; banner mạng cắm vào đây, sau `videoNoticeKey` :390), nút cạnh `onEnableAudio` :402 là khuôn cho "Bật lại camera". Docblock :6-14 cấm state.

**i18n** — `messages.ts` hiện có 42 khoá `room.*` (đã liệt kê trong điều tra; không trùng tên khi thêm). Docblock rule-5 ở :25-26 và :32-37 khai *"3 plural strings and 7 interpolation templates"* — gate **đếm** chứ không tin, nên chỉ sửa khi thật sự thêm plural/interpolation.

**CSS** — `globals.css`: `.chip-status` :357-371 + `::before` :373-380 + `.ok` :382 / `.warn` :387 / `.coin` :392; `.room-status` :923; `.participant-*` :927-1008; `.room-video` :1044; `.participant-video` :1081; `.face-mode-group` :1022. **Chưa có** container banner mạng. `tokens.css:133` `--motion-network-chip-debounce: 3000ms` — đã tồn tại, gate `design-tokens.test.ts` khớp nó với `DESIGN.md:126`; **đọc, đừng gõ lại số**.

**E2E** — `tests/e2e/livekit/phong-media.spec.ts` (1177 dòng): `collectPeerConnections` :114, `inboundAudioBytes` :130, `inboundVideo` :402 (`bytesReceived` + `framesDecoded`), `negotiatedDescriptions` :260 (**đọc SDP local+remote, dùng lại cho simulcast**), `videoSenderTrackIds` :380, `videoSenderCount` :392, `subscribedAudioTracks` :147, `rememberStreams` :169, `joinAs` :194, `setTabHidden` :471, `endLocalCamera` :491, `canvasTrackIds` :356, `cameraTrackIds` :363. **Không helper nào đọc `outbound-rtp` hay `getParameters()`** — encoding của sender chưa từng được đo. `global-setup.ts` `serverConfig()` :97-127 không có gì về băng thông/codec/simulcast; container được giữ trong closure, nên `stop()` giữa phiên là khả thi.

**Nợ story này nhận** — `deferred-work.md:662-665`: `adaptiveStream`/`dynacast` còn `false`, ghi đích danh 2.5. **Không** nhận `:672-675` (thang FPS của filter) — cùng hình dạng, khác tín hiệu, thuộc 2.7 phần 3/3.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/web/src/app/phong/[roomId]/room-media.ts` — `NETWORK_RUNGS` và `NetworkRung` (1–4); `networkRungFor(quality, connectionState)` thuần; `rungAllowsVideo(rung)`; `rungChipToneFor` / `rungChipKeyFor` / `rungBannerKeyFor` (bậc 2 trả `null` — im lặng là một quyết định, không phải chỗ trống); `offersCameraRestart(rung, faceMode, wasOnBeforeDrop)`. Bật `simulcast: true` trong `videoPublishOptions()` và **quyết** `adaptiveStream`/`dynacast` trong `roomOptionsFor` — viết lại cả ba docblock thành quyết định kèm lý do.
- [ ] `apps/web/src/app/phong/[roomId]/room-shell.tsx` — listener `ConnectionQualityChanged` ghi `handle.wantedRung` đồng bộ rồi `wake()`, đúng khuôn `applyVisibility` :669; `stepVideo` thêm nhánh bậc mạng **cùng cấp** với `stepPause`, trả `'again' | 'settled' | 'waiting'`; hoãn chip 3s đọc từ CSS var; nhớ "video đã bật trước khi tụt bậc" để biết có mời bật lại không; `onRestartCamera` đi đúng đường của 2.7. Không effect mới, không vòng lặp mới.
- [ ] `apps/web/src/app/phong/[roomId]/room-panel.tsx` — chip đọc bậc mạng (nói rõ quan hệ với chip pha), banner một dòng cho bậc 3 và bậc 4, nút "Bật lại camera" có điều kiện, lưới đóng băng ở bậc 4 có **chữ** nói là đang đóng băng. Vẫn không state.
- [ ] `apps/web/src/app/i18n/messages.ts` + `messages.en.ts` — chip hai mức, banner bậc 3, banner bậc 4 kèm đếm ngược, câu hết 30 giây, nhãn nút bật lại camera, nhãn lưới đóng băng. Chỉ sửa số đếm docblock nếu thật sự thêm plural/interpolation.
- [ ] `apps/web/src/app/globals.css` — container banner mạng và trạng thái đóng băng của lưới; dùng `.chip-status.warn` có sẵn; reflow 320px, sàn 48px.
- [ ] `apps/web/src/app/phong/[roomId]/room-media.test.ts` + `room-panel.test.tsx` — mọi dòng ma trận qua hàm thuần; cả hai locale; khẳng định bậc 2 **không** sinh banner; khẳng định `offersCameraRestart` trả `false` khi người dùng đang tự Ẩn mặt.
- [ ] `tests/e2e/livekit/phong-media.spec.ts` — **probe**: simulcast trong SDP; bậc 3 gỡ sender và phía kia mất ô; bậc 4 bằng `container.stop()` thật; hồi phục không bật camera và có nút.
- [ ] `tests/e2e/livekit/global-setup.ts` — cho probe chạm được container (dừng, và nếu cần thì khởi động lại) mà không phá luật skip `STUWITH_SKIP_TESTCONTAINERS` / từ chối khi `CI`.
- [ ] `_bmad-output/implementation-artifacts/deferred-work.md` — đóng mục `:662-665`; ghi nợ mới nếu bậc 2 không đo được trực tiếp.

**Acceptance Criteria:**
- Given hai trình duyệt thật và một `livekit-server` thật ở bậc 1, when đọc SDP đã thương lượng, then `m=video` mang nhiều encoding; đặt `simulcast: false` thì khẳng định này đỏ còn các khẳng định khác vẫn xanh.
- Given đang ở bậc 1 có video, when quality xuống `Poor`, then không còn sender video, phía kia mất ô, và `inboundAudioBytes` phía kia **vẫn tăng**.
- Given đang trong phòng, when container LiveKit bị dừng, then màn hình vào bậc 4 với chữ, lưới đóng băng; probe đỏ nếu sản phẩm không nhận ra.
- Given vừa hồi phục từ bậc 3, when chip về `ok`, then **không** sender video nào tự xuất hiện và nút "Bật lại camera" có mặt.
- Given người dùng đang tự Ẩn mặt, when mạng tụt rồi hồi, then không có nút bật lại camera và chế độ của họ không đổi.
- Given quality dao động nhiều lần trong 3 giây, when chip cập nhật, then nó đổi đúng một lần.
- Given `test:gates`, then `design-tokens`, `i18n-catalogue`, `contrast`, `livekit-token`, `ad-1` xanh.

## Design Notes

**Bậc mạng là chiều "muốn" thứ ba, không phải máy trạng thái thứ hai.** `RunHandle` đã có cặp `videoPaused` (muốn) / `videoMuted` (đã tới) cho tab ẩn. Bậc mạng có đúng hình dạng đó. Story 2.7 tốn một loopback vì một trạng thái bất đồng bộ nằm ngoài reconciler; đây là cùng cái bẫy, đã biết trước.

**Im lặng ở bậc 2 là tính năng.** Ô "không báo gì" trong ma trận là một khẳng định phải test, không phải một ô trống. Người dùng không cần biết video vừa tụt lớp, và nói cho họ biết là biến một thứ đang hoạt động thành một thứ trông như hỏng.

**Phân biệt "mạng tắt video" với "người dùng tắt video".** Hai nguyên nhân, hai lối ra. Mạng tắt thì mời bật lại khi hồi phục; người dùng tắt thì tuyệt đối im. Trộn hai cái là cách nhanh nhất để vi phạm luật lớn nhất của epic.

## Verification

**Commands:**
- `corepack pnpm run build:packages` rồi `corepack pnpm --filter api build`.
- `corepack pnpm run typecheck` · `corepack pnpm run dep-check`.
- `corepack pnpm run test:unit` — mutation: cho bậc 2 sinh banner → đỏ.
- `corepack pnpm exec vitest run --project gates` — `design-tokens` xanh (token hoãn chip đã có sẵn, đừng thêm bản sao).
- `corepack pnpm exec playwright test` — **ba lượt liên tiếp**, không chỉ một.
- Rồi **chạy thật** hai mutation ở "Sẽ đỏ khi" và khôi phục.
- Sau e2e: `git checkout -- apps/web/next-env.d.ts`.

## Suggested Review Order

**Điểm vào: hai giá trị bậc, và chỉ một trong hai được lái hành vi**

- `wantedRung` là sự thật; bản đã hoãn chỉ để chip khỏi nhấp nháy và không bao giờ quyết định gì
  [`room-shell.tsx:895`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L895)

- Cửa sổ hoãn MỞ một lần rồi chốt ở giá trị lúc đóng — không `clearTimeout` ở mỗi lần đổi, nên dao động kéo dài không đẩy hạn đi mãi
  [`room-shell.tsx:871`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L871)

- Panel nhận hai prop rời, nên đường dây không thể lặng lẽ gộp lại
  [`room-panel.tsx:349`](../../apps/web/src/app/phong/%5BroomId%5D/room-panel.tsx#L349)

**Bậc mạng là chiều "muốn" thứ ba, cắm vào reconciler của 2.7**

- Một micro-bước cùng cấp với `stepPause`, không phải vòng lặp song song
  [`room-shell.tsx:1649`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1649)

- Chốt chỉ bật cho tấm hình THẬT SỰ đã lên sóng — người đang Ẩn mặt không bị mạng "lấy đi" thứ họ chưa có
  [`room-shell.tsx:1604`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1604)

- Chỉ đọc chất lượng của CHÍNH MÌNH: wifi yếu của một người không được tắt camera bốn người khác
  [`room-shell.tsx:1241`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L1241)

**Đồng hồ giữ MỐC, không đếm nhịp**

- `retryDeadline` là một thời điểm tường, đặt một lần mỗi đợt; tab ngủ dậy thấy 0 chứ không thấy 28
  [`room-shell.tsx:805`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L805)

- Đợt chỉ kết thúc trên một đường LÀNH, nên 4→3→4 không gia hạn thêm ba mươi giây
  [`room-shell.tsx:825`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L825)

**Quyết định thuần**

- Bậc đọc từ HAI tín hiệu, và trạng thái kết nối là lá phiếu phủ quyết
  [`room-media.ts:506`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L506)

- Nút bật lại camera chỉ xuất hiện khi chính mạng đã lấy hình đi, và chỉ khi bậc cho phép
  [`room-media.ts:654`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L654)

- Bậc 2 trả `null` — im lặng là một quyết định, không phải chỗ trống
  [`room-media.ts:620`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L620)

- Ba công tắc được QUYẾT kèm lý do: simulcast bật, dynacast bật, adaptiveStream vẫn tắt
  [`room-media.ts:87`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L87)

**Probe — chỗ phép đo phải chụp hai sự thật cùng một lúc**

- `ladderSnapshot` đọc bốn sự thật trong MỘT vòng: bốn `expect` rời mỗi cái tự retry theo đồng hồ riêng, nên một banner tới muộn ba giây vẫn qua
  [`phong-media.spec.ts:1659`](../../tests/e2e/livekit/phong-media.spec.ts#L1659)

- Bậc 4 lái bằng việc DỪNG HẲN container thật, và khẳng định `bytesReceived` ngừng tăng
  [`phong-media.spec.ts:2098`](../../tests/e2e/livekit/phong-media.spec.ts#L2098)

- Simulcast có thật trên dây — nền của bậc 1 và bậc 2
  [`phong-media.spec.ts:2173`](../../tests/e2e/livekit/phong-media.spec.ts#L2173)

- Chỉ chất lượng của một người tụt, camera người kia không suy suyển
  [`phong-media.spec.ts:2015`](../../tests/e2e/livekit/phong-media.spec.ts#L2015)

- Tab ẩn giao với bậc 3: tab ẩn MUTE và để thiết bị mở, bậc 3 KẾT THÚC nó — đó là chỗ hai chiều phân biệt được
  [`phong-media.spec.ts:1902`](../../tests/e2e/livekit/phong-media.spec.ts#L1902)
