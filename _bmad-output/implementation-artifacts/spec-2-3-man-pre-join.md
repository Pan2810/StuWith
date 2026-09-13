---
title: 'Story 2.3 — Màn pre-join: xem trước, chọn khuôn mặt, thử mic'
type: 'feature'
created: '2026-09-13'
status: 'done'
baseline_commit: 'de841c02811ae7c0e6f35d4dfa45f03ac4f52ef9'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2.2 đã có `POST /v1/rooms/{roomId}/token` nhưng không có màn hình nào gọi nó, và không có chỗ nào để người dùng quyết định mình hiện lên thế nào trước khi ai đó nhìn thấy. Nếu Story 2.4 dựng phòng mà không có cổng này, người dùng rơi thẳng vào phòng với camera đang bật — đúng điều định vị "học ẩn danh" cấm.

**Approach:** Một route `/phong/{roomId}` trong `apps/web`, mà **trạng thái đầu tiên của trang chính là pre-join** — vỏ phòng chỉ mount sau khi có quyết định hiện diện *và* token 201, nên không tồn tại URL nào đi vòng. Xem trước bằng `getUserMedia` (chỉ trong máy), ba chế độ là một `radiogroup` (Filter có mặt nhưng vô hiệu — 2.7), Ẩn mặt = dừng track camera + avatar chữ cái, thử mic bằng `AnalyserNode`. Bấm "Vào phòng" mới xin token; 409 được rẽ nhánh bằng `details.reason` thêm vào hợp đồng (mục defer từ 2.2). Story này **không** nối LiveKit — token và quyết định được trao cho `RoomShell` trong bộ nhớ để 2.4 nối.

## Boundaries & Constraints

**Always:**
- Vỏ phòng (`RoomShell`) chỉ render từ trạng thái `admitted`; `admitted` chỉ đến từ một 201 của token endpoint sau khi người dùng bấm "Vào phòng". Tải lại trang = về pre-join.
- Khung hình xem trước chỉ gắn vào `<video>` cục bộ. Trong story này **không** có `RTCPeerConnection`, không `WebSocket`, không request tới origin ngoài web/api.
- Chọn Ẩn mặt → mọi video track `stop()` (đèn camera tắt), `<video>` gỡ khỏi DOM, avatar chữ cái từ `display_name`. Chỉ người dùng bấm lại "Để nguyên" mới xin camera lại — không sự kiện hệ thống nào làm việc đó.
- Token trong phản hồi chỉ sống trong state React; không `localStorage`/`sessionStorage`/cookie/log.
- Chuỗi qua catalogue `preJoin.*`/`room.*` cả VI lẫn EN; câu từ contracts import, không gõ lại. Mọi HTTP qua `useAuthorizedFetch`. Mọi quyết định là hàm thuần export, page chỉ `setState`/effect/media.
- Trạng thái thiết bị và câu xác nhận đều có chữ, không chỉ màu; `radiogroup` có nhãn nhóm, mỗi mục `role="radio"` + `aria-checked`, đi được bằng phím mũi tên.
- Rời trang/unmount → mọi track dừng.

**Ask First:** thêm bất kỳ dependency npm nào (`livekit-client`, `@mediapipe/*`); đổi `ROOM_TOKEN_TTL_SECONDS`; thêm mã vào `ERROR_CODES`; thêm endpoint `GET /v1/rooms/{id}`; sửa stack provider trong `layout.tsx`; thêm header `Permissions-Policy`/CSP; đổi chế độ mặc định khỏi "Để nguyên".

**Never:** kết nối LiveKit hay publish track (2.4); Filter hoạt động hay bất kỳ ML nào (2.7); thẻ thông tin phòng (tên/host/gói/đang có mặt) — chưa có endpoint đọc phòng, ghi defer cho 2.4; đọc `process.env` lần thứ hai trong web; `LIVEKIT_API_KEY`/`SECRET` xuất hiện dưới `apps/web`; tự chuyển Ẩn mặt → Để nguyên; `fetch` trần ngoài seam.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Vào trang, đã đăng nhập, quyền cấp | `/phong/{uuid}`, cam+mic OK | Pre-join: `<video>` xem trước, nhóm chọn mặc định "Để nguyên", cảnh báo "Khuôn mặt bạn sẽ hiện với mọi người trong phòng", vạch mic, dòng "Buổi học không được ghi lại" | N/A |
| Chọn Ẩn mặt | click/phím mũi tên | Video track `readyState==='ended'`, avatar chữ cái, câu "Không ai trong phòng thấy khuôn mặt bạn, kể cả host" (notice ok) | N/A |
| Chọn Filter | mục `disabled`, nhãn phụ "Sắp có" | Không chọn được, không đổi trạng thái | N/A |
| Trình duyệt chặn | `NotAllowedError` | Khối hướng dẫn 3 bước theo `browserFamilyFor(userAgent)` (chrome/edge/firefox/safari/khác) + "Thử lại quyền" + "Vào phòng chỉ để nghe" | Thử lại = gọi `getUserMedia` lại |
| Không có camera, có mic | `NotFoundError` video, audio OK | "Để nguyên" `disabled`, Ẩn mặt tự là lựa chọn duy nhất, vạch mic vẫn chạy | N/A |
| Không có mic | `NotFoundError` cả hai và audio-only | "Không thấy micro. Bạn vẫn vào phòng và dùng chat được." + nút vào phòng | N/A |
| Lỗi thiết bị khác | `NotReadableError`, … | Câu chung "Không mở được camera/micro" + "Vào phòng chỉ để nghe" | N/A |
| Chưa đăng nhập | `/v1/auth/me` 401 sau refresh | Nhánh signed-out với link đăng nhập mang return path về `/phong/{id}` | N/A |
| Vào phòng | click → `POST …/token` | 201 → `admitted`, `RoomShell` nhận `{faceMode, audio:'mic'|'listen-only', token, url, expires_at}` | N/A |
| Bị từ chối | 403 / 404 | Câu tương ứng + link về Tạo phòng | không retry |
| Phòng đầy / đóng | 409 `details.reason` = `room_full` / `room_closed` | Hai câu khác nhau; thiếu `reason` → câu chung "Không vào được phòng lúc này" | không retry |
| Không có phản hồi / 5xx | network, 500 | "Thử lại" giữ nguyên quyết định và track | nút thử lại |
| roomId sai định dạng | `/phong/abc` | Câu không tìm thấy phòng, không gọi API | N/A |

## Probe ranh giới

**Ranh giới:** trình duyệt (origin `apps/web`) ↔ `apps/api` trên `POST /v1/rooms/{roomId}/token` — cross-origin, mang cookie, đọc thân JSON và `x-request-id`. Đây là seam Epic 1 vỡ bảy lần; probe của 2.1 chạy qua `fake-api.cjs` nên mutation phía server không làm nó đỏ (docblock `tests/gates/cors-policy.test.ts`). Ranh giới trình duyệt ↔ LiveKit **không mở** ở story này; probe phủ định bên dưới khai rõ mutation của nó nằm phía client.

**Probe:** `tests/e2e/web/phong-token-seam.spec.ts` — trang thật trên origin web, `page.evaluate` gọi `fetch(API_BASE_URL + roomTokenPath(uuid), {method:'POST', credentials:'include'})` tới **process `apps/api` thật** mà suite đã khởi động (không cookie → 401 trước khi chạm DB, `session-authenticator.ts:76-95`); khẳng định status 401, thân `error.code === 'unauthenticated'` đọc được, `x-request-id` đọc được. Cần `WEB_BASE_URL` của api trong `playwright.config.ts` = origin web e2e. Probe phủ định: `phong.spec.ts` gói `RTCPeerConnection`/`WebSocket` bằng `addInitScript` và nghe `page.on('request')` — suốt pre-join không có kết nối nào và không request nào rời khỏi web/fake-api.

**Sẽ đỏ khi:** trong `apps/api/src/http-setup.ts` bỏ `credentials: CORS_ALLOW_CREDENTIALS` hoặc đổi `origin` khỏi `config.WEB_BASE_URL` → trình duyệt ném `TypeError` trên `fetch` có `credentials:'include'` → probe đỏ (trong khi `cors-policy.test.ts` chỉ đỏ ở nửa đầu). Probe phủ định đỏ khi page mở `WebSocket(url)` ở pre-join — mutation phía client, ghi nhận là chưa phải mutation phía xa.

</frozen-after-approval>

## Code Map

Neo tự đo trên `de841c0`. Đừng tìm lại.

**Contracts** — `packages/contracts/src/rooms.ts`: `CREATE_ROOM_PATHNAME` :172 (khuôn `*_PATHNAME`), `ROOM_TOKEN_TTL_SECONDS` :352 (docblock :347 nói 120s là ngân sách pre-join), `roomTokenPath` :382, `isRoomId` :377, `roomTokenResponseSchema` :398, bốn `*_MESSAGE` :421-427 (docblock :406 "web đọc STATUS"). `error.ts:122` `makeError(code, message, details?)`, `details` là `Record<string, string|number|boolean>` :125. `openapi.ts:522-585` `roomTokenPathItem()` — mô tả 409 cần nêu `details.reason`. `auth.ts:84` `currentUserSchema` có `display_name` :86. `contracts.test.ts` describe `the create-room endpoint` là khuôn pin publish.

**API** — `rooms.service.ts:242/244` hai `makeError('conflict', …)` → thêm `{ reason }`. `room-token.flow.test.ts` pin thân 409 qua parser mới. `http-setup.ts:121-186` CORS đọc hằng contracts (`origin` :135, `credentials` :160). `session-authenticator.ts:76-95` không cookie → `null` trước store.

**Web — khuôn** — `tao-phong/page.tsx` ('use client', docblock :19-32: page chỉ state/effect/fetch) + `create-room-form.tsx` (hàm thuần export + panel không state; `createRoomOutcomeFor` :231; `exhausted(never)` :636; nhánh `created` :78/:468 — **thêm link `roomPathname(room.id)`** ở đây để thoả rule B `routes.test.ts:208`). `dang-nhap/sign-in-outcome.tsx:569` link đăng nhập là `<a href>` thường; `session-expiry.ts:84` `returnPathFor`; `profile-load.ts:58` `profileLoadOutcome(status, user, retryAfter)` dùng cho bước `/v1/auth/me`. Seam: `session-expiry-provider.tsx:103` `useAuthorizedFetch`, :108 `useApiBaseUrl`. `layout.tsx:89` đọc env DUY NHẤT — không đọc lại.

**Web — gate** — `seam-usage.test.ts:236-275` file nhắc `roomTokenPath` phải dùng seam; `:47` chỉ provider được `fetch` trần. `routes.test.ts:124-155` resolver hiểu `[roomId]` cho `*_PATHNAME` dạng `/phong/{roomId}`; rule C :319 export phải có mã sản phẩm dùng. `tests/gates/i18n-catalogue.test.ts:135/185` mọi ký tự Việt hay câu Anh ngoài catalogue → đỏ, kể cả `aria-label`; `:653` câu shared phải import. `tests/gates/livekit-token.test.ts:527-529` quét `apps/web/src`, `.env*`, `public/`. `ad-1-dependency-direction.test.ts:339-383` web chỉ import `@stuwith/contracts`.

**Web — i18n & CSS** — `i18n/messages.ts:64` `VI_MESSAGES`, :204-209 khuôn import câu contracts, `.plural`/`.nodes` :238-243; `messages.en.ts` không import gì. `globals.css`: `.field-group` :528 + `legend` :539, `.choice-list` :548, `.choice` :568, `input[type=radio]` :595, `:has(:checked)` :608 (**radiogroup có sẵn**, màu là kênh thứ hai :588), `.notice` :405 / `.notice-alert` :414, `.chip-status` :357, `.card` :244, `.button-primary/secondary` :286, `.sr` :167. Chưa có: khung xem trước, avatar chữ cái, vạch mic. `tokens.css` chỉ đọc (gate khớp `DESIGN.md`). Mockup 1:1: `ux-designs/…/mockups/pre-join.html` (ba trạng thái).

**Web unit test** — `vitest.config.mts:139` project `web` `environment:'node'`, không DOM: panel không `'use client'`, không state; `renderToStaticMarkup`; đa ngôn ngữ bằng `<I18nProvider locale>` lặp `LOCALES` (`date-of-birth-form.test.tsx:393`).

**E2E** — `playwright.config.ts:116-135` project `web` chưa có `launchOptions`/`permissions`; api webServer :138-160 `WEB_BASE_URL: 'http://127.0.0.1:3000'` → đổi thành `WEB_BASE_URL` (3100). `fake-api.cjs:383-420` khuôn nhánh `ROOMS_PATH` (401 → parser thật → `state.roomsStatus`); `scenario.ts:31-66` `Scenario` (`roomsStatus`, `roomsRetryAfterSeconds`), route literal gõ tay :26-29. 61 test hiện có. Giả thiết bị: Chromium `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; chặn/không thiết bị mô phỏng bằng `addInitScript` ghi đè `navigator.mediaDevices.getUserMedia` ném `DOMException(name)` — seam nội trình duyệt, không phải seam sản phẩm.

**Deferred liên quan** — `deferred-work.md:541` (`sub = user.id`, LiveKit đá kết nối cũ khi cùng identity — 2.3 xin token đúng một lần lúc bấm "Vào phòng", ghi vào Design Notes cho 2.4), `:557` (409 hai nghĩa — story này đóng).

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/rooms.ts` — `ROOM_PATHNAME = '/phong/{roomId}'`, `roomPathname(roomId)`, `ROOM_TOKEN_REFUSAL_REASONS = ['room_full','room_closed'] as const`, `roomTokenRefusalReason(body): reason | null` (parse `error.details.reason` bằng zod, không cast); `openapi.ts` mô tả 409 nêu `details.reason`; `contracts.test.ts` pin.
- [x] `apps/api/src/rooms/rooms.service.ts` — hai 409 mang `{ reason }`; `room-token.flow.test.ts` đọc lại qua `roomTokenRefusalReason`.
- [x] `apps/web/src/app/phong/[roomId]/pre-join.tsx` — hàm thuần: `deviceStateFor(errorName, stage)` (`granted | blocked | no-camera | no-mic | unreadable`), `browserFamilyFor(userAgent)`, `presenceNoticeFor(faceMode)`, `avatarInitialsFor(displayName)` (≤2 ký tự, bỏ dấu, hoa), `micLevelLabelKeyFor(level)`, `joinOutcomeFor(status, body)`, `joinRequestFor(state)` (`audio: 'mic'|'listen-only'`), `preJoinStateFor(profile, device)`; component `PreJoinPanel` không state, nhận `videoRef`, `micLevel`, callbacks; ids export.
- [x] `apps/web/src/app/phong/[roomId]/room-shell.tsx` — `RoomShell({ decision })` tối thiểu: tóm tắt quyết định + dòng không ghi lại; docblock nói 2.4 mount media ở đây và xin token đúng một lần (mục `sub = user.id`).
- [x] `apps/web/src/app/phong/[roomId]/page.tsx` — `'use client'`; `useParams` + `isRoomId`; effect tải `/v1/auth/me` (`profileLoadOutcome`); effect `getUserMedia({video,audio})` → phân loại, thử lại `{audio}` khi `NotFoundError`; `AudioContext` + `AnalyserNode` cập nhật `micLevel` (rAF, dừng khi unmount); đổi chế độ → `stop()` track; "Vào phòng" → `authorizedFetch(roomTokenPath)`, `roomTokenResponseSchema.safeParse` → `admitted`; cleanup dừng mọi track và đóng `AudioContext`.
- [x] `apps/web/src/app/tao-phong/create-room-form.tsx` — nhánh `created` thêm link "Vào phòng" → `roomPathname(room.id)` (rule B/C).
- [x] `apps/web/src/app/i18n/messages.ts` + `messages.en.ts` — khối `preJoin.*` (tiêu đề, phụ đề, ba nhãn chế độ + "Sắp có", hai câu xác nhận, 3 bước × 5 trình duyệt, hai nút thoát, câu không mic, câu không ghi lại, nhãn vạch mic 2 mức, câu 403/404/409×2/chung/thử lại) và `room.*`; import `ROOM_ADMISSION_FORBIDDEN_MESSAGE`, `ROOM_NOT_FOUND_MESSAGE`, `ROOM_FULL_MESSAGE`, `ROOM_CLOSED_MESSAGE` theo khuôn :204.
- [x] `apps/web/src/app/globals.css` — `.preview`, `.preview-label`, `.avatar-letter`, `.mic-level` (`role="meter"`, kèm chữ), `.permission-help`; chỉ dùng token có sẵn.
- [x] `apps/web/src/app/phong/[roomId]/pre-join.test.tsx` — mọi dòng ma trận qua hàm thuần + `renderToStaticMarkup` (radiogroup semantics, Filter disabled, avatar, cả hai locale).
- [x] `tests/e2e/support/fake-api.cjs` + `scenario.ts` — nhánh `POST /v1/rooms/:id/token`: 401 nếu chưa đăng nhập, rồi `state.roomTokenStatus` (201 thân theo `roomTokenResponseSchema`, 409 qua `makeError('conflict', …, { reason: state.roomTokenReason })` từ contracts dist).
- [x] `playwright.config.ts` — project `web`: `launchOptions.args` giả thiết bị, `permissions: ['camera','microphone']`; api webServer `WEB_BASE_URL: WEB_BASE_URL`.
- [x] `tests/e2e/web/phong.spec.ts` — happy path, Ẩn mặt (track ended qua `page.evaluate`), chặn quyền, không mic, 409 hai nghĩa, không bỏ qua được (`/phong/{id}` tải lại → pre-join; không có URL khác), probe phủ định.
- [x] `tests/e2e/web/phong-token-seam.spec.ts` — **probe ranh giới** (trình duyệt thật → api thật).
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — thẻ thông tin phòng ở pre-join chờ endpoint đọc phòng (2.4); đóng mục `:557`.

**Acceptance Criteria:**
- Given Chromium với thiết bị giả, when tải `/phong/{uuid}` rồi chọn Ẩn mặt, then không còn `<video>` và mọi video track `readyState === 'ended'`, avatar hiện chữ cái, và suốt phiên không có `RTCPeerConnection`/`WebSocket` nào được tạo.
- Given `getUserMedia` ném `NotAllowedError`, when tải trang, then hướng dẫn đúng họ trình duyệt và nút "Vào phòng chỉ để nghe" bấm được → token vẫn được xin và `RoomShell` nhận `audio:'listen-only'`.
- Given api thật, when trình duyệt trên origin web gọi token endpoint có credentials, then đọc được 401 JSON và `x-request-id`.
- Given `pnpm typecheck`, when thiếu một khoá `preJoin.*` ở EN, then đỏ.
- Given gate `livekit-token` AC5, `i18n-catalogue`, `seam-usage`, `routes`, `cors-policy`, then vẫn xanh.

## Spec Change Log

- 2026-09-13 (review vòng 1 — 31 phát hiện sau khử trùng lặp, KHÔNG có `intent_gap`/`bad_spec`, 22 patch đã áp, 5 defer ghi vào `deferred-work.md`, còn lại reject). Patch đáng ghi vì lệch với Tasks: (1) `roomDecisionFor(request, token)` bỏ tham số `roomId` — `roomId` của quyết định là `room_id` của thân 201, và `admissionMatchesRoom` từ chối 201 nêu phòng khác; (2) `MediaStage` thêm `'video-only'` cho lần xin lại camera khi bấm "Để nguyên", để lỗi ở đó đi qua `deviceStateFor` (quyền bị thu hồi → khối hướng dẫn) thay vì hard-code `no-camera`; (3) trên 201 page dừng MỌI track và meter trước khi render `RoomShell` — docblock `room-shell.tsx` ghi 2.4 phải xin lại hoặc đổi cách trao; (4) nhóm chọn `disabled` trong lúc xin token và quyết định đọc từ ref tại thời điểm 201; (5) "Thử lại quyền" giữ nguyên khối hướng dẫn, khoá nút trong lúc chờ, một vòng `getUserMedia` mỗi lần; (6) camera về muộn sau khi đã bấm Ẩn mặt lại → dừng ngay khi tới. Hai khoá i18n mới `preJoin.checkingSession`, `room.notRecorded`, `preJoin.previewVideoLabel` (nhãn `<video>`). E2E thêm 7 ca: xem trước thật sự phát (`srcObject` + `videoWidth`), rời trang bằng client-side navigation dừng track, meter chạy ở ca không camera, wake-on-gesture với `AudioContext` bị ép suspended, camera mất/quyền thu hồi giữa hai lần bấm, abort request token, 401 token, `meStatus` 429/503. KEEP: máy trạng thái `admitted` chỉ từ 201; probe ranh giới trình duyệt thật → api thật; mọi quyết định là hàm thuần.

## Design Notes

**Pre-join là trạng thái, không phải URL.** Một route thứ hai `/phong/{id}/chuan-bi` cần một guard chuyển hướng ở route phòng — tức một `if` mà 2.4 có thể quên. Khi vỏ phòng chỉ render từ `admitted`, "không bỏ qua được bằng bất kỳ đường nào" là tính chất của máy trạng thái, không phải của guard.

**Mặc định Để nguyên, không phải Ẩn mặt.** Walkthrough Flow 1 (`EXPERIENCE.md:320-321`): camera xem trước bật, chỉ mình thấy, rồi người dùng *chọn* Ẩn mặt. Xem trước cục bộ không lộ gì; câu cảnh báo màu warn ở Để nguyên là chỗ quyết định xảy ra.

**Token xin lúc bấm, không lúc tải.** TTL 120s là ngân sách pre-join (`rooms.ts:347`); người dùng có thể ngồi lâu hơn. Xin đúng một lần cũng tránh hai kết nối cùng `sub` bị LiveKit đá (`deferred-work.md:541`).

**`details.reason` thay vì so chuỗi.** Web đọc STATUS chứ không đọc câu (`rooms.ts:406`); so `message` là so chuỗi hiển thị và vỡ khi 2.0 đã đưa i18n về client. Thêm `details` tuỳ chọn là thay đổi tương thích (AD-13).

## Verification

- `corepack pnpm run build:packages` — trước mọi thứ (web/api đọc contracts từ `dist`).
- `corepack pnpm run typecheck` — xanh; ĐỎ khi bỏ một khoá `preJoin.*` khỏi `messages.en.ts`.
- `corepack pnpm run test:unit` — xanh (`web`, `api`, `contracts`); mutation: `RoomShell` render khi chưa `admitted` → `pre-join.test.tsx` đỏ.
- `corepack pnpm run test:gates` — cần Docker; `i18n-catalogue`, `livekit-token` AC5, `cors-policy`, `routes`/`seam-usage` (trong `test:unit`) xanh.
- `corepack pnpm exec playwright test` — 61 + mới; mutation bỏ `credentials` trong `http-setup.ts` → `phong-token-seam.spec.ts` đỏ → khôi phục; mutation mở `WebSocket` ở pre-join → probe phủ định đỏ → khôi phục.
- Sau e2e: `git checkout -- apps/web/next-env.d.ts`.

## Suggested Review Order

**Điểm vào: pre-join là trạng thái, vỏ phòng chỉ từ `admitted`**

- Máy trạng thái sáu nhánh; `admitted` chỉ sinh từ một `RoomDecision`, không có nhánh nào khác
  [`pre-join.tsx:502`](../../apps/web/src/app/phong/[roomId]/pre-join.tsx#L502)

- Dòng DUY NHẤT render `RoomShell`
  [`pre-join.tsx:676`](../../apps/web/src/app/phong/[roomId]/pre-join.tsx#L676)

- Xin token đúng một lần lúc bấm; kiểm `room_id` khớp URL; dừng mọi track trước khi vào vỏ phòng
  [`page.tsx:390`](../../apps/web/src/app/phong/[roomId]/page.tsx#L390)

- Quyết định đọc từ ref tại thời điểm 201, không từ giá trị bắt lúc bấm
  [`page.tsx:418`](../../apps/web/src/app/phong/[roomId]/page.tsx#L418)

**Camera: chỉ tay người dùng bật/tắt, và lựa chọn sau cùng thắng**

- Handler chứ không phải effect: Ẩn mặt dừng track, Để nguyên xin lại; camera về muộn bị dừng ngay
  [`page.tsx:343`](../../apps/web/src/app/phong/[roomId]/page.tsx#L343)

- Điểm race đã vá: stream tới sau khi đã bấm Ẩn mặt lại → `stopTracks`
  [`page.tsx:358`](../../apps/web/src/app/phong/[roomId]/page.tsx#L358)

- Vòng xin thiết bị: hai lần tối đa, một vòng mỗi lúc, giữ trạng thái cũ khi thử lại
  [`page.tsx:257`](../../apps/web/src/app/phong/[roomId]/page.tsx#L257)

- Một từ cho mỗi câu trả lời của `getUserMedia`, kể cả stage `video-only`
  [`pre-join.tsx:131`](../../apps/web/src/app/phong/[roomId]/pre-join.tsx#L131)

- Chọn Để nguyên mà không có camera thì hiệu lực là Ẩn mặt — không bao giờ chiều ngược lại
  [`pre-join.tsx:267`](../../apps/web/src/app/phong/[roomId]/pre-join.tsx#L267)

**Hợp đồng 409 hai nghĩa và route phòng**

- `details.reason` — thay đổi tương thích, đóng mục defer từ 2.2
  [`rooms.ts:470`](../../packages/contracts/src/rooms.ts#L470)

- Parser client dùng chung, zod chứ không cast
  [`rooms.ts:498`](../../packages/contracts/src/rooms.ts#L498)

- Hai 409 của api mang `reason`
  [`rooms.service.ts:257`](../../apps/api/src/rooms/rooms.service.ts#L257)

- Web rẽ nhánh bằng `reason`, không bằng câu; thiếu `reason` → câu chung
  [`pre-join.tsx:387`](../../apps/web/src/app/phong/[roomId]/pre-join.tsx#L387)

- `ROOM_PATHNAME` dạng template + builder; rule B của `routes.test.ts` học cách nhận builder
  [`rooms.ts:448`](../../packages/contracts/src/rooms.ts#L448)

- Đường duy nhất trong sản phẩm dẫn tới phòng: từ màn "Đã tạo phòng"
  [`create-room-form.tsx:499`](../../apps/web/src/app/tao-phong/create-room-form.tsx#L499)

**Probe ranh giới**

- Trình duyệt thật trên origin web → process `apps/api` thật; đỏ khi bỏ `credentials` phía server (đã chạy)
  [`phong-token-seam.spec.ts:55`](../../tests/e2e/web/phong-token-seam.spec.ts#L55)

- Probe phủ định: đếm `RTCPeerConnection`/`WebSocket`, nghe mọi request
  [`phong.spec.ts:66`](../../tests/e2e/web/phong.spec.ts#L66)

- Xem trước phải THẬT SỰ phát (`srcObject` + `videoWidth`), không chỉ hiện hộp
  [`phong.spec.ts:49`](../../tests/e2e/web/phong.spec.ts#L49)

- Wake-on-gesture của `AudioContext` dưới chính sách autoplay thật, mô phỏng bằng `resume()` bị từ chối tới khi có gesture
  [`phong.spec.ts:431`](../../tests/e2e/web/phong.spec.ts#L431)

- `WEB_BASE_URL` của api = origin web e2e, và cờ thiết bị giả của Chromium
  [`playwright.config.ts:152`](../../playwright.config.ts#L152)

**Ngoại vi**

- Vỏ phòng tối thiểu và hai điều 2.4 thừa kế (một token một lần; stream đã dừng)
  [`room-shell.tsx:102`](../../apps/web/src/app/phong/[roomId]/room-shell.tsx#L102)

- Fake API trả 401 → 404 → theo scenario, 409 qua `makeError` thật của contracts
  [`fake-api.cjs:525`](../../tests/e2e/support/fake-api.cjs#L525)

- Khối `preJoin.*` VI và EN, câu contracts import chứ không gõ lại
  [`messages.ts:210`](../../apps/web/src/app/i18n/messages.ts#L210)

- CSS mới: khung xem trước, avatar co theo khung ở 320px, vạch mic có chữ
  [`globals.css:633`](../../apps/web/src/app/globals.css#L633)
