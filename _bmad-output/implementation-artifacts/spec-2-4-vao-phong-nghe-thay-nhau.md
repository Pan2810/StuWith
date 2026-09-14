---
title: 'Story 2.4 — Vào phòng và nghe thấy nhau'
type: 'feature'
created: '2026-09-14'
status: 'done'
baseline_commit: 'ab7eda484312e0216806cffa4c57800f4efd46d0'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.3 dừng ở `RoomShell` — một thẻ tóm tắt quyết định. Token LiveKit được cấp, `url` đã có trong thân 201, và không dòng mã nào ở `apps/web` nối tới. Hôm nay hai người cùng bấm "Vào phòng" một phòng thì không ai nghe thấy ai; phòng học chưa tồn tại.

**Approach:** `RoomShell` nối `livekit-client` tới `url` bằng chính token nó được trao, publish **một track micro** (Opus + DTX + RED), subscribe audio của mọi người khác, và render danh sách người tham gia có chữ chứ không chỉ màu. Mặt phẳng media chỉ mở sau khi đã `admitted`, nên tính chất "không bỏ qua được pre-join" của 2.3 không bị nới. Story này **không publish video** — xem Boundaries.

## Boundaries & Constraints

**Always:**
- `RoomShell` tự xin lại micro. Page đã dừng mọi track trước khi nó mount (`page.tsx:418`); 2.4 chọn xin lại thay vì đổi cách trao, để pre-join giữ được tính chất "không để đèn camera sáng" và để `listen-only` **không mở micro lần nào**.
- Một lần bấm → một token → **một** `Room.connect`. Không reconnect bằng token mới, không connect lần hai dưới cùng `sub` (`deferred-work.md:541` — LiveKit đá kết nối cũ khi trùng identity).
- Audio publish luôn bật `dtx` và `red`, và audio track được đặt mức ưu tiên cao tường minh — không dựa vào mặc định của SDK.
- Token sống 120s (`rooms.ts:352`). Nếu `expiresAt` đi qua trước khi `Connected`, huỷ kết nối và về pre-join kèm câu giải thích. Đây là mục defer của 2.3 về `RoomDecision.expiresAt`.
- Track micro nghe `ended` (rút thiết bị, OS thu hồi): unpublish, hiện trạng thái tắt mic **bằng chữ**. Đây là mục defer của 2.3 về track kết thúc từ bên ngoài.
- Rời trang, unmount, hoặc bấm "Rời phòng" → `room.disconnect()` **và** mọi track `stop()`.
- Mọi quyết định là hàm thuần export (`participantRowsFor`, `joinPhaseFor`, `tokenExpiredAt`, `audioPublishOptions`); `RoomPanel` không state để `renderToStaticMarkup` chạy được; chỉ `RoomShell` giữ effect và SDK. Khuôn của `pre-join.tsx`.
- Chuỗi qua catalogue `room.*` cả VI lẫn EN; câu dùng chung import từ contracts. Mọi trạng thái (đang nói, mic tắt, đang nối) có chữ, không chỉ màu.

**Ask First:** publish video track ở bất kỳ chế độ nào; thêm dependency npm ngoài `livekit-client`; đổi `ROOM_TOKEN_TTL_SECONDS`; thêm biến môi trường `NEXT_PUBLIC_*` thứ hai cho web; dùng LiveKit data channel; đổi `infra/livekit.yaml`.

**Never:** publish **video** — epic-2-context ràng buộc "track publish lên LiveKit luôn là track đã qua pipeline xử lý, kể cả ở chế độ Để nguyên", và pipeline đó là Story 2.7; 2.4 render mọi người bằng avatar chữ cái và ghi nợ. Lưới đi được bằng bàn phím và thanh điều khiển đầy đủ (2.6). Thang suy giảm mạng, simulcast, chip chất lượng (2.5). Chat (2.8). WebSocket tới `apps/realtime-gateway`, ghi `room_participants`, duyệt/tìm phòng — đã tách khỏi story này, ba mục cuối `deferred-work.md`. `LIVEKIT_API_KEY`/`SECRET` xuất hiện dưới `apps/web`. Token vào `localStorage`/`sessionStorage`/cookie/log.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Vào phòng, có mic | `decision.audio==='mic'` | `getUserMedia({audio:true})` → connect → publish; heading phòng, danh sách có chính mình | N/A |
| Nghe thấy người khác | người thứ hai publish audio | Hàng của họ xuất hiện, audio được subscribe và phát ra loa | N/A |
| Chỉ để nghe | `decision.audio==='listen-only'` | Connect, **không** gọi `getUserMedia`, không publish; hàng của mình ghi "Đang tắt micro" | N/A |
| Đang nói | `ActiveSpeakersChanged` | Hàng đổi trạng thái kèm chữ "Đang nói" | N/A |
| Mic bị rút giữa phòng | track `ended` | Unpublish, hàng mình thành "Đang tắt micro", câu giải thích | không tự xin lại |
| Người khác rời | `ParticipantDisconnected` | Hàng biến mất, đếm lại số người | N/A |
| Bị đá vì trùng identity | `Disconnected` reason duplicate | Câu "Bạn đã vào phòng này ở nơi khác", không tự nối lại | N/A |
| Token hết hạn trước khi nối xong | `expiresAt` < now | Huỷ connect, về pre-join + câu "Chờ quá lâu, hãy vào lại" | không retry ngầm |
| LiveKit từ chối token | connect ném | Câu "Không vào được phòng" + nút thử lại đưa về pre-join | không retry ngầm |
| Mất mạng giữa phòng | `Reconnecting` / `Reconnected` | Trạng thái "Đang nối lại" có chữ; `Reconnected` về bình thường | SDK tự lo, ta chỉ hiện |
| Mất hẳn | `Disconnected` | Câu mất kết nối + đường về pre-join | không retry ngầm |
| Rời phòng | bấm "Rời phòng" | `disconnect()`, track dừng, về pre-join | N/A |

## Probe ranh giới

**Ranh giới:** trình duyệt ↔ **LiveKit** (nhà cung cấp bên ngoài). Ranh giới này chưa từng mở: gate `tests/gates/livekit-token.test.ts` đã chạm nó nhưng bằng **`node:http` thô** ở tầng WebSocket upgrade, nên nó chứng minh token hợp lệ chứ không chứng minh một trình duyệt nối được và **nghe được**. Mục `deferred-work.md` của 2.3 ghi đúng nghĩa vụ này: 2.4 phải khai probe mới có mutation ở phía LiveKit.

**Probe:** `tests/e2e/livekit/phong-media.spec.ts`, chạy trong project Playwright mới `livekit`. `globalSetup` khởi động **`livekit/livekit-server:v1.13.5` thật** bằng `testcontainers` (đã là devDependency gốc), cùng image `infra/docker-compose.yml:64` pin. Fake API ở chế độ này ký token bằng chính `mintRoomToken` của `apps/api/dist` với cặp key của container và trả `url` trỏ vào container. **Hai** browser context cùng vào một phòng; khẳng định context B thấy A trong `remoteParticipants`, audio track của A **được subscribe**, và `RTCPeerConnection.getStats()` cho `inbound-rtp` audio có `bytesReceived > 0` — tức là tiếng thật sự đi qua, không chỉ signal bắt tay xong. Bỏ qua bằng `STUWITH_SKIP_TESTCONTAINERS=1`, và **từ chối** khi `CI` được đặt, đúng luật `packages/db/src/__testing__/postgres.ts`.

**Sẽ đỏ khi:** khởi động container với `LIVEKIT_KEYS` mang **secret khác** cặp mà `mintRoomToken` ký — mutation nằm hẳn ở phía LiveKit, không phải trong mã của ta — thì `connect` bị từ chối và probe đỏ ở bước đầu tiên. Mutation thứ hai, ở phía ta nhưng qua cả seam: xoá `room: input.roomId` khỏi grant trong `apps/api/src/rooms/room-token.ts:62-67` rồi build lại → server trả 400 "no room name". Cả hai phải **chạy thật**, không phải nghĩ ra.

</frozen-after-approval>

## Code Map

Neo tự đo trên `ab7eda4`. Đừng tìm lại.

**Web — chỗ cắm** — `apps/web/src/app/phong/[roomId]/room-shell.tsx`: `RoomDecision` :76-83 (`roomId`, `faceMode`, `audio`, `token`, `url`, `expiresAt`), `FaceMode` :55, `AudioIntent` :67, `ROOM_SHELL_HEADING_ID` :90, `RoomShell` :102 (hôm nay chỉ 3 thẻ), docblock :19-40 **đã ghi ba điều 2.4 thừa kế** — một token một lần, chỉ trong bộ nhớ, stream đã dừng. `pre-join.tsx:681` là dòng DUY NHẤT render `RoomShell`, trong `case 'admitted'` của `PreJoinPanel` :676; `preJoinStateFor` :502-527 là nơi `admitted` sinh ra. `page.tsx:390` `requestToken`, :418 `releaseDevices()` ngay trước :421 `setAdmitted`; `releaseDevices` :151-157 → `stopTracks` :134-136 + `stopMeter` :138-148; effect unmount :380-386. i18n: `useT` từ `../../i18n/use-t`, gọi `t('room.heading')` (`room-shell.tsx:103,107`).

**Contracts** — `packages/contracts/src/rooms.ts`: `roomTokenResponseSchema` :398-403 (`token`, `url: z.url()` :400, `expires_at` :401, `room_id` :402), `ROOM_TOKEN_TTL_SECONDS = 120` :352, `roomPathname` :451, `isRoomId` :377. `apps/api/src/rooms/rooms.service.ts:296` `url: this.config.LIVEKIT_URL`.

**Token phía API (chỉ đọc)** — `apps/api/src/rooms/room-token.ts`: grant :62-67 `{room, roomJoin:true, canPublish:true, canSubscribe:true}`, ký bằng `jose@5.10.0` :69-78, `sub = userId` :72. Không sửa file này; probe dùng lại `mintRoomToken`.

**Gate không được làm đỏ** — `tests/gates/livekit-token.test.ts`: `CLIENT_FORBIDDEN` :448 chỉ hai chuỗi `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, quét `apps/web/src` + `.env*` + `public/` :496-505; `LIVEKIT_URL` **được miễn có chủ ý** :444-446, pin ở :594-601. `livekit-client` là package npm nên không chạm gate. `.dependency-cruiser.cjs:80-98` `ad1-web-touches-contracts-only` chỉ cấm đường workspace (`^apps/`, `packages/(db|domain|config)`), không cấm npm — xác nhận ở `ad-1-dependency-direction.test.ts:339-390`.

**i18n** — `apps/web/src/app/i18n/messages.ts`: `VI_MESSAGES` :68, khoá phẳng dạng chấm, khối `room.*` :269-274 hiện có đúng 6 khoá (`heading`, `faceShow`, `faceHide`, `audioMic`, `audioListenOnly`, `notRecorded`) và comment :267 ghi "Story 2.4 mounts the media here"; khuôn import câu contracts :6 + :293; plural `<base>.one`/`.other` :95-96, đếm plural phải khớp docblock (gate rule 5). `messages.en.ts:37` `EN_MESSAGES`, không được chứa chữ có dấu. `tests/gates/i18n-catalogue.test.ts`: rule 1 :279-449 (literal tiếng Việt hoặc câu 3+ từ ngoài catalogue → đỏ), rule 2 :477-539 (hai catalogue cùng tập khoá), rule 3 :634-698 (câu contracts phải import, danh sách :642-655), rule 4 :545-617, rule 5 :756-798. **aria-label không bị rule 1 bắt nếu viết tiếng Anh** — vẫn phải qua catalogue.

**CSS** — `apps/web/src/app/globals.css`: có sẵn `.card` :244, `.meta` :273, `.button-primary/secondary` :286-311, `.chip-status` :357, `.notice` :405 / `.notice-alert` :414 / `.notice-ok` :719, `.avatar-letter` :684, `.sr` :167. **Chưa có**: hàng/lưới người tham gia, dấu đang nói, dấu tắt mic. `DESIGN.md:334` đặc tả `tile-participant` và `:298-303` bảng breakpoint — 2.4 chỉ làm **danh sách**, 2.6 nâng thành lưới composite. Chỉ dùng token có sẵn.

**Vitest** — `vitest.config.mts:93-145` project `web`: `environment:'node'`, **không DOM**, `include: src/**/*.test.ts(x)`, `oxc.jsx` :116. Nên `RoomShell` (có effect + SDK) **không chạy được** ở đây; chỉ hàm thuần và `RoomPanel` không state. Khuôn: `pre-join.test.tsx:98-129` (`renderToStaticMarkup`, handler là stub).

**E2E** — `playwright.config.ts`: project `api` :99, `web` :115 (`launchOptions.args` :153-157 đã có `--use-fake-device-for-media-stream`, `permissions` :159), `sharedEnv` :66-74 **đã có `LIVEKIT_URL: 'ws://127.0.0.1:7880'`** + key/secret giả, `webServer` :163-247 bốn tiến trình (api :164, fake-api :195, web build+start :213 với `NEXT_PUBLIC_API_BASE_URL` inline lúc build, gateway :234). Chưa có `globalSetup`. `tests/e2e/web/phong.spec.ts`: `guardMediaPlane` :66-132 bọc `RTCPeerConnection`/`WebSocket` bằng `Proxy` đếm `construct`, `expectNoMediaPlane` :135-142 đòi **cả hai bằng 0**, gọi sau khi đã `admitted` ở :514 — **dòng này phải đổi**, nếu không 2.4 làm nó đỏ; `refuseDevices` :150-165; đường tới `admitted` :478-520. `tests/e2e/support/fake-api.cjs:510` nhánh token, :525-542 thân 201, `url` là literal `'ws://127.0.0.1:7880'` :536; `scenario.ts:33-80` kiểu `Scenario`.

**Nợ 2.3 mà story này nhận** — `deferred-work.md`: probe LiveKit chưa có mutation phía xa; `expiresAt` không ai quan sát; track `ended` không được nghe. Ba mục đóng ở đây.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/package.json` — thêm `livekit-client@2.22.3` (Apache-2.0, kiểm trên registry npm 2026-09-14). Đây là dependency npm **duy nhất** story này thêm.
- [x] `apps/web/src/app/phong/[roomId]/room-media.ts` — hàm thuần + kiểu, không import React: `audioPublishOptions()` (dtx + red + ưu tiên cao, tường minh), `participantRowsFor(local, remotes, speakers)` → hàng đã sắp xếp có `{id, label, initials, speaking, micOn, isSelf}`, `joinPhaseFor(connectionState, error, expiredAt)` → `connecting | connected | reconnecting | failed | expired | left`, `tokenExpiredAt(expiresAt, now)`, `disconnectReasonKeyFor(reason)`, `roomOptionsFor(decision)`.
- [x] `apps/web/src/app/phong/[roomId]/room-shell.tsx` — `RoomShell` giữ state + effect: xin `getUserMedia({audio:true})` **chỉ khi** `audio==='mic'`, `Room.connect(decision.url, decision.token)`, publish audio với `audioPublishOptions()`, gắn `RoomEvent` (`ParticipantConnected/Disconnected`, `TrackSubscribed/Unsubscribed`, `ActiveSpeakersChanged`, `ConnectionStateChanged`, `Disconnected`), `<audio autoplay>` cho mỗi track remote, đồng hồ `expiresAt`, listener `ended` trên track mic, cleanup `disconnect()` + `stop()`; render `RoomPanel`. Docblock ghi: không publish video, 2.7 sở hữu pipeline.
- [x] `apps/web/src/app/phong/[roomId]/room-panel.tsx` — component **không state**: heading, chip trạng thái kết nối có chữ, danh sách `<ul>` người tham gia (avatar chữ cái + tên + "Đang nói" / "Đang tắt micro" bằng chữ), câu không ghi lại, nút "Rời phòng", `role="status"` cho thay đổi trạng thái. Ids export.
- [x] `apps/web/src/app/i18n/messages.ts` + `messages.en.ts` — mở rộng khối `room.*`: trạng thái kết nối (4), nhãn danh sách + đếm người (plural `.one`/`.other`), "Đang nói", "Đang tắt micro", "Bạn", nút rời phòng, sáu câu lỗi của ma trận. Cập nhật số đếm plural trong docblock (gate rule 5).
- [x] `apps/web/src/app/globals.css` — `.participant-list`, `.participant-row`, `.participant-state`, `.room-status`; chỉ token có sẵn, reflow 320px, sàn 48px cho nút.
- [x] `apps/web/src/app/phong/[roomId]/room-media.test.ts` + `room-panel.test.tsx` — mọi dòng ma trận qua hàm thuần; `renderToStaticMarkup` cho `RoomPanel` ở cả hai locale; khẳng định `audioPublishOptions()` có `dtx` và `red` bật.
- [x] `tests/e2e/web/phong.spec.ts` — `expectNoMediaPlane` thành **theo giai đoạn**: 0 kết nối cho tới lúc bấm "Vào phòng"; sau `admitted` chỉ `decision.url` được phép mở WebSocket, mọi origin lạ vẫn đỏ. Thêm ca: listen-only không gọi `getUserMedia`, rời phòng đóng kết nối.
- [x] `tests/e2e/support/fake-api.cjs` + `scenario.ts` — chế độ `E2E_LIVEKIT` (đặt bởi globalSetup): ký token thật bằng `mintRoomToken` của `apps/api/dist` với key của container, `url` trỏ container. Không đặt biến thì giữ nguyên hành vi cũ.
- [x] `tests/e2e/livekit/global-setup.ts` + `playwright.config.ts` — project `livekit` (chỉ khớp `livekit/.*\.spec\.ts$`), `globalSetup` khởi động container, xuất `E2E_LIVEKIT_*`; luật skip `STUWITH_SKIP_TESTCONTAINERS=1` và **từ chối khi `CI`**.
- [x] `tests/e2e/livekit/phong-media.spec.ts` — **probe ranh giới**: hai context, subscribe, `bytesReceived > 0`.
- [x] `.github/workflows/ci.yml` — job `livekit-e2e` chạy `--project=livekit`.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — đóng ba mục 2.3 (probe LiveKit, `expiresAt`, track `ended`); ghi mục mới: **publish video chưa tồn tại**, chủ là 2.7; **p90 < 5s trên 4G không đo được trong CI**, cần đo vận hành.

**Acceptance Criteria:**
- Given hai trình duyệt thật và một `livekit-server` thật, when cả hai vào cùng một phòng với `audio:'mic'`, then mỗi bên thấy bên kia trong danh sách và `inbound-rtp` audio có `bytesReceived > 0`.
- Given container ký bằng secret khác, when chạy probe, then probe đỏ ở bước connect.
- Given `decision.audio === 'listen-only'`, when vào phòng, then `navigator.mediaDevices.getUserMedia` **không được gọi lần nào** và không có track nào được publish.
- Given đang ở pre-join, when chưa bấm "Vào phòng", then vẫn không có `RTCPeerConnection`/`WebSocket` nào — tính chất của 2.3 không bị nới.
- Given rời trang hoặc bấm "Rời phòng", when kết nối đang mở, then `room.disconnect()` chạy và mọi track `readyState === 'ended'`.
- Given `pnpm typecheck`, when thiếu một khoá `room.*` ở EN, then đỏ. Given `test:gates`, then `livekit-token` AC5, `i18n-catalogue`, `ad-1` vẫn xanh.

## Design Notes

**Vì sao 2.4 không publish video.** Epic-2-context đặt một ràng buộc cấu trúc: mọi track video rời máy phải **đã** qua pipeline xử lý, vì gắn processor sau khi publish để hở một cửa sổ khung hình gốc. Pipeline đó là Story 2.7. Nếu 2.4 publish camera thô để "Để nguyên" có nghĩa ngay, nó mở đúng cửa sổ mà epic cấm, và 2.7 sẽ phải đóng lại một thứ đã ship. ACs của chính story này chỉ nói **nghe** và **danh sách người tham gia**. Nên 2.4 dừng ở audio, mọi người là avatar chữ cái, và nợ được ghi có chủ.

**Ưu tiên băng thông cho audio, nói cho đúng.** Khi không có video track nào, "audio ưu tiên hơn video" đúng một cách rỗng. Việc thật ở đây là đặt tường minh `dtx`, `red` và mức ưu tiên của sender thay vì thừa hưởng mặc định SDK — để khi 2.5 thêm video, cái phải nhường đã được khai sẵn. Spec không tuyên bố đã đo được sự tranh chấp băng thông.

**p90 < 5s trên 4G không đo được trong CI.** Probe khẳng định tiếng đi qua, không khẳng định phân vị trên 4G. Ghi thành nợ vận hành thay vì dựng một con số giả trong e2e.

## Verification

**Commands:**
- `corepack pnpm install` — thêm `livekit-client`.
- `corepack pnpm run build:packages` rồi `corepack pnpm --filter api build` — probe dùng `apps/api/dist`.
- `corepack pnpm run typecheck` — xanh; ĐỎ khi bỏ một khoá `room.*` khỏi `messages.en.ts`.
- `corepack pnpm run test:unit` — xanh; mutation: bỏ `dtx` trong `audioPublishOptions()` → `room-media.test.ts` đỏ.
- `corepack pnpm run test:gates` — cần Docker; `livekit-token` AC5, `i18n-catalogue`, `ad-1` xanh.
- `corepack pnpm exec playwright test --project=web` — ca cũ của 2.3 xanh sau khi `expectNoMediaPlane` thành theo giai đoạn.
- `corepack pnpm exec playwright test --project=livekit` — probe xanh; rồi **chạy thật** hai mutation ở "Sẽ đỏ khi" và khôi phục.
- Sau e2e: `git checkout -- apps/web/next-env.d.ts`.

## Suggested Review Order

**Điểm vào: quyết định đi vào phòng, và ai được quyết định cái gì**

- Toàn bộ vòng đời kết nối trong một effect; `handle` là trạng thái của MỘT lượt chạy, không phải của component
  [`room-shell.tsx:143`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L143)

- `leave` dựng cờ abort rồi mới đóng; nó không chờ `roomRef` vì `roomRef` tới sau `getUserMedia`
  [`room-shell.tsx:219`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L219)

- Người đã tự bấm rời KHÔNG bị báo lỗi — lỗ này chỉ lộ ra khi refusal về sau lúc bấm
  [`room-shell.tsx:271`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L271)

- Ba lần hỏi `aborted` quanh `connect`: trước, trong catch, và sau khi phòng đã lên
  [`room-shell.tsx:484`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L484)

**Micro: mở một lần, và chỉ khi người dùng đã chọn nói**

- `listen-only` không chạm `getUserMedia` dòng nào — tính chất của mã, không phải của một cờ
  [`room-shell.tsx:508`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L508)

- Thiết bị bị lấy mất từ bên ngoài: unpublish, câu giải thích, và KHÔNG tự xin lại
  [`room-shell.tsx:528`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L528)

- Opus DTX + RED + ưu tiên, khai tường minh vì mặc định là quyết định của người khác
  [`room-media.ts:61`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L61)

**Nghe được, kể cả khi trình duyệt từ chối phát**

- `AudioPlaybackStatusChanged` + `startAudio()` trong một click — phòng im lặng phải nói ra
  [`room-shell.tsx:414`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L414)

- Track remote gắn vào DOM; ref null thì detach chứ không bỏ rơi một người câm
  [`room-shell.tsx:383`](../../apps/web/src/app/phong/%5BroomId%5D/room-shell.tsx#L383)

**Đồng hồ token: 120 giây mua cái bắt tay, không mua cả phiên**

- Kiểm TRƯỚC khi mở socket, vì ngồi lâu ở pre-join là đường thường nhất tới đây
  [`room-media.ts:135`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L135)

- `expired` thắng `failed` vì token lỡ hạn là NGUYÊN NHÂN; và không áp dụng sau khi đã lên
  [`room-media.ts:199`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L199)

**Danh sách người tham gia: mọi trạng thái đều có chữ**

- Hàng đã sắp xếp, tự mình đứng đầu, người trùng identity bị loại
  [`room-media.ts:366`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L366)

- Chữ cái avatar lấy từ ĐUÔI identity — lấy đầu thì mọi UUIDv7 đều ra "0"
  [`room-media.ts:302`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L302)

- Hai mã disconnect được tách; phần còn lại gom một câu, và ghi nợ ai còn thiếu câu riêng
  [`room-media.ts:238`](../../apps/web/src/app/phong/%5BroomId%5D/room-media.ts#L238)

**Probe ranh giới — nơi duy nhất chứng minh có người nghe được người**

- `bytesReceived > 0`: ICE, DTLS, SRTP đã xong, không chỉ bắt tay signalling
  [`phong-media.spec.ts:332`](../../tests/e2e/livekit/phong-media.spec.ts#L332)

- `usedtx=1` trong SDP thương lượng — DTX thành sự thật trên dây, không còn là hằng số tự soi
  [`phong-media.spec.ts:365`](../../tests/e2e/livekit/phong-media.spec.ts#L365)

- Container thật, cổng UDP buộc 1:1 vì ICE mang theo số cổng và không remap được
  [`global-setup.ts:223`](../../tests/e2e/livekit/global-setup.ts#L223)

- Probe phủ định của 2.3 chia hai giai đoạn: tuyệt đối 0 trước `admitted`, chỉ `decision.url` sau đó
  [`phong.spec.ts:219`](../../tests/e2e/web/phong.spec.ts#L219)

**Ngoại vi**

- Fake API ký token THẬT bằng `mintRoomToken` của `apps/api/dist` khi container đang lên
  [`fake-api.cjs:632`](../../tests/e2e/support/fake-api.cjs#L632)

- `roomTokenUrl`: địa chỉ blackhole để bắt tay TREO — cổng đóng thì bị từ chối tức thì, không treo
  [`scenario.ts:116`](../../tests/e2e/support/scenario.ts#L116)

- Job CI riêng cho probe; `realtime-gateway` vẫn phải build vì `webServer` là cấp config
  [`ci.yml:267`](../../.github/workflows/ci.yml#L267)
