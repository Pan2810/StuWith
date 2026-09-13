---
title: 'Story 2.2 — Cấp token vào phòng kèm giữ chỗ nguyên tử'
type: 'feature'
created: '2026-09-12'
status: 'done'
baseline_commit: 'dfbfdbb0bd608fa13cd77d8a072a7b49f7884139'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-9 tuyên "token vào phòng là điểm chốt quyền duy nhất" và AD-22 tuyên "một phép kiểm chỉ đọc là gợi ý, không phải cổng" — nhưng hôm nay không gì cấp token LiveKit, `room_reservations` chưa tồn tại, ba biến `LIVEKIT_*` được validate mà không ai đọc, và điều kiện "không bị ban" không có cột nào để đọc. Story 2.3/2.4 không có gì để nối vào.

**Approach:** Một `POST /v1/rooms/{roomId}/token` trong `apps/api`: giải phiên → một hàm domain quyết ban + tuổi → adapter giữ chỗ **trong cùng transaction** với phép đếm (khoá dòng `rooms` bằng `FOR UPDATE`) → ký JWT HS256 ngắn hạn, riêng cho một phòng, bằng `jose` đã có → ghi `room_token.issued`. Migration thêm bảng `room_reservations` (chủ ghi `stuwith_api`, kể cả dọn hết hạn) và cột `users.banned_at` — **chưa có người ghi cho tới Story 4.7**, nhưng điểm chốt đọc nó fail-closed ngay từ story này (quyết định con người 2026-09-12).

## Boundaries & Constraints

**Always:**
- Bốn điều kiện đi qua **một** phương thức service và **một** hàm domain (`roomAdmission`); trần quyết trong transaction của adapter, không bao giờ bằng một lần đọc rồi ghi. 130 người bấm cùng lúc vào trần 100 → đúng 100 token, đo trên PG18 thật.
- Token: `iss = LIVEKIT_API_KEY`, `sub = user.id`, `exp = now + 120s`, `video = { room: roomId, roomJoin: true, canPublish: true, canSubscribe: true }`. **Không** `roomCreate`/`roomAdmin`/`roomList`. Tên phòng phía LiveKit **là** `rooms.id`.
- `LIVEKIT_API_SECRET` không rời `apps/api`. Response mang `token`, `url` (`LIVEKIT_URL`), `expires_at`, `room_id`.
- `users.banned_at` khác NULL → 403, không ngoại lệ. Tuổi: vào phòng **không có sàn** (PRD US-0.5 AC3), hàm domain vẫn là nơi duy nhất Story 3.x thêm luật.
- Cùng (phòng, người) xin lại trong TTL → **gia hạn** chỗ đang giữ, không chiếm chỗ thứ hai, token mới.
- Chỗ hết hạn do chính `apps/api` xoá, bên trong transaction giữ chỗ (AD-22). `stuwith_realtime` bị từ chối `42501` khi `INSERT`/`UPDATE`/`DELETE` vào `room_reservations` — chứng minh bằng câu lệnh thật.
- Mọi lần cấp ghi một dòng `room_token.issued`: actor = người, subject = phòng, metadata chỉ id và mốc thời gian.
- Cả hai FK của `room_reservations` là `ON DELETE RESTRICT` — không mở cửa hậu cho gate AC5 của 2.1, và không rơi vào bẫy CASCADE đã ghi ở `deferred-work.md`.
- `RoomsModule.forRuntime(config, runtime)` — story này là lúc module bắt đầu đọc môi trường; docblock "no config" phải đổi theo.

**Ask First:** thêm dependency (không dự kiến: `jose@5.10.0` đã có) · thêm giá trị vào `AUDIT_ACTIONS`, `RATE_LIMIT_ACTIONS` hay `ERROR_CODES` · đổi TTL 120 giây.

**Never:**
- Không màn hình (2.3) · không gateway, không `room_participants`, không hiện diện thật, không giải phóng chỗ khi rời phòng (2.4) · không endpoint ban/kick/thu hồi và không người ghi `banned_at` (4.7) · không `livekit-server-sdk` (4.7 cần cho lệnh đuổi).
- Không rate limit cho route này — mục đã có trong `deferred-work.md`; story này ghi thêm bằng chứng mới: mỗi lần cấp là một dòng audit **vĩnh viễn**.
- Không audit lần từ chối (`room_token.refused` không có trong `AUDIT_ACTIONS`) · không đọc `room_participants` để đếm trần · không `DELETE`/`UPDATE` trạng thái `rooms`.
- Không đổi tên `AuthRuntime` trong story này dù nó nhận thành viên thứ tám — đó là diff đổi tên thuần, làm riêng.

## I/O & Edge-Case Matrix

`POST /v1/rooms/{roomId}/token`, không body.

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Hợp lệ | Đăng nhập, phòng `open`, còn chỗ | `201` `{token,url,expires_at,room_id}`; một dòng `room_reservations`; một dòng audit | N/A |
| Chưa đăng nhập | Không cookie / phiên chết | `401 unauthenticated` | Không chạm DB phòng |
| Bị ban | `users.banned_at` khác NULL | `403 forbidden` | Không giữ chỗ, không token |
| Không có phòng | id không phải uuid, hoặc không tồn tại | `404 not_found`, **cùng body** cho cả hai | Không lộ định dạng id |
| Phòng đang/đã đóng | `status` ∈ {`closing`,`closed`} | `409 conflict`, `ROOM_CLOSED_MESSAGE` | Không giữ chỗ |
| Phòng đầy | chỗ còn hiệu lực = `max_participants` | `409 conflict`, `ROOM_FULL_MESSAGE` | Số chỗ không đổi |
| Xin lại | cùng người, cùng phòng, trong TTL | `201`, `expires_at` mới, **số chỗ không đổi** | N/A |
| 130 đồng thời | trần 100, 130 người khác nhau | đúng 100 × `201`, 30 × `409` đầy; chưa bao giờ > 100 dòng hiệu lực | N/A |
| Store lỗi giữa chừng | pool chết / transaction ném | `500`, không token, không dòng lẻ | Fault lan lên, không thành nhánh trả về |

## Probe ranh giới

**Ranh giới:** ta ↔ LiveKit (nhà cung cấp ngoài). Token do `apps/api` ký phải là thứ một `livekit-server` **thật** chấp nhận, và chỉ cho đúng phòng nó nêu tên. Không unit test nào trên `jose` chứng minh được điều đó — nó chỉ chứng minh ta đã ký một cái gì đó.

**Probe:** `tests/gates/livekit-token.test.ts` khởi động `livekit/livekit-server:v1.13.5` (testcontainers `GenericContainer`, `LIVEKIT_KEYS` từ env) và gửi upgrade WebSocket thô tới `/rtc?access_token=…` bằng `node:http` (không cần nói giao thức, chỉ đọc status trước khi socket bị huỷ). Token lấy từ **chính `mintRoomToken` của `apps/api` đã build** (gates build api trước). Khẳng định: token hợp lệ → `101`; cùng token bỏ `video.room` hoặc `roomJoin:false` → bị từ chối (`401`; `400` khi thiếu `video.room` — đo trên v1.13.5, sửa câu theo quyết định con người 2026-09-13); token ký bằng secret khác → `401`; token giải mã ra không có `roomCreate`/`roomAdmin`/`roomList`. Cùng file: quét `apps/web/src` + `next.config.ts` không chứa `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` — AC5 "không credential tĩnh phía client". Tôn trọng `STUWITH_SKIP_TESTCONTAINERS` đúng cách `postgres.ts` làm: từ chối bỏ qua khi `CI` được đặt.

**Sẽ đỏ khi:** container được khởi động với secret trong `LIVEKIT_KEYS` **khác** secret `apps/api` dùng để ký → ca `101` thành `401`. Chạy mutation đó thật. Mutation phía gần để đối chiếu: bỏ `video.room` khỏi claim trong `mintRoomToken` → LiveKit trả `401`.

</frozen-after-approval>

## Code Map

Neo tự đo trên `dfbfdbb`. Đừng tìm lại.

**Cấu hình** — `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` đã trong `apiEnvShape` (`packages/config/src/schema.ts:247-249`, `secret(32)`), `.env.example:52-54`. Không ai đọc chúng ở `apps/api` hôm nay. `jose@5.10.0` là dependency của `apps/api` (`apps/api/package.json:22`). `livekit-server-sdk` **không** được cài đâu cả; `packages/domain/package.json:19` nêu đích danh nó là infra SDK.

**Port & domain** — `RoomPort` (`packages/domain/src/ports/room-port.ts:89-118`): `createRoom`, `findRoomById` (docblock :112 đã hứa "Story 2.2 asks this before it issues a token"). `User` (`ports/identity-port.ts:5-63`): có `plan` :32, `dateOfBirth` :61 — **thêm `bannedAt: Date | null`**. Khuôn policy: `policies/date-of-birth.ts:209` `isAdult(user, clock)`, `fixedAt` :226; khuôn refusal-là-nhánh-trả-về: `heartbeat-port.ts` (AGENTS.md §6 "ClockPort và HeartbeatPort"). Refusal của `RateLimitPort`/`AuditPort` không có — fault ném.

**Adapter** — `pg/room-adapter.ts:102` (`Pool` qua constructor, `createRoom` :105, `findRoomById` :134); `in-memory/room-adapter.ts:31` (`Map`, `nextId` :88). Identity: `pg/identity-adapter.ts:72-86` là chỗ chọn cột + map row (`plan` :83, `date_of_birth` :84 qua `to_char`) — thêm `banned_at`; `in-memory/identity-adapter.ts:58-62` dựng `User` — thêm `bannedAt: null`. Test-kit: `runRoomPortContract` `test-kit.ts:1782` (options :1766: `label`, `createHarness`, `skip`, `hookTimeoutMs`); wiring PG `room-contract.pg.test.ts:29-103` (pool thật + pool chết cho ca fault :84-89). Identity contract `test-kit.ts:263`.

**Migration** — khuôn `1788480200000_rooms-and-plans.js`: `pgm.sql()` thô, không `down`; GRANT/REVOKE tường minh :177-184; COMMENT ON ROLE :187-199. Tên mới `1788480300000_room-reservations.js`. Roles migration :162/:166 đã tuyên `room_reservations` thuộc `stuwith_api`. Probe `42501`: `rooms-migration.test.ts:231-260` (`connectionStringFor` :234, `withClient` :247, trồng phòng :253). ⚠️ Gate 4 lọc tên file: suite phải chứa `migration`. `identity-schema.test.ts:96-118` pin cột `users` bằng cách chạy `migration.up(fakePgm)` — cột mới cần một ca ở đó hoặc ở suite migration mới. `audit-append-only.test.ts:123` anchored operand `audit_events` → `ON CONFLICT`/`DELETE` trên bảng khác không bị bắt; `no-hard-delete-rooms.test.ts` có sẵn ví dụ LEGITIMATE `DELETE FROM room_reservations`.

**API** — `rooms.service.ts:85-121` khuôn: `authenticator.authenticate(cookie)` → 401; `caller.at` là mốc thời gian duy nhất; refusal bằng `makeError` không ném. `RoomOutcome` :28. `rooms.controller.ts:41-45` `@Post()` + `@Res()`; **không** `setGlobalPrefix`, tham số path đọc từ `request.params` dạng `unknown`. `rooms.runtime.ts` chỉ có `rooms` (docblock nói rõ không audit, không clock — đổi: thêm `reservations`, `audit`; clock vẫn không). `rooms.module.ts:59-64` `REQUIRED_METHODS` — mở rộng cho port mới; :28 nhận `(runtime)` — thành `(config, runtime)` như `AuthModule.forConfig`. `app.module.ts:89` gọi `RoomsModule.forRuntime(runtime)`. `auth.runtime.ts:32-64` `AuthRuntime` có `audit` :48 — thêm `reservations`. Audit writer khuôn: `auth/audit.ts:150-162` `recordSignedIn` (`sourceService:'api'`, `actorUserId`, `subjectId`, `requestId`, `metadata`); `AuditPort.append` (`ports/audit-port.ts:68`). `AUDIT_ACTIONS` đã có `room_token.issued` (`contracts/src/audit.ts:15`); metadata chỉ string/number/boolean :46. `request_id` lấy như auth: xem `recordSignInFailed` call site `auth.service.ts:312`.

**Contracts** — `rooms.ts`: `ROOMS_PATH` :161, `roomSchema` :190, `ROOM_STATUSES` :146. `ERROR_CODES` (`error.ts`): `validation_failed, unauthenticated, forbidden, not_found, rate_limited, conflict, internal_error` — **đủ**, không thêm. Khuôn path có tham số: `openapi.ts:239` `'/v1/auth/{provider}/start'` + `parameters:[{name,in:'path',required:true,schema}]`; `paths` gộp tại :494-495. `contracts.test.ts` describe `the create-room endpoint` (2.1) là khuôn pin publish.

**Harness & test** — `createAuthHarness` (`auth/__testing__/auth-harness.ts:321`) dựng in-memory cho `identity/rooms/sessions/audit` :386-389; `options.wrapIdentity` :411 là cách `rooms.flow.test.ts` ép `plan` (`planOverride`, :60-70) — dùng đúng cách đó để trồng `bannedAt`. Không có harness API chạy trên PG: ca 130-đồng-thời sống ở contract suite của adapter (`db` project, PG18 thật), ca HTTP chỉ chứng minh mapping. `vitest.config.mts`: `api` project **không Docker** (AGENTS.md §5) → probe LiveKit đặt ở `gates` (:148, `testTimeout` 300s, serial, `test:gates` build api trước — `package.json:23`). `testcontainers@12.1.0` là devDependency gốc; `GenericContainer`/`Wait` đã dùng ở `packages/db/src/__testing__/postgres.ts:4`; `STUWITH_SKIP_TESTCONTAINERS` :35-41.

**Web** — không chạm. `seam-usage.test.ts` tự thêm hằng route mới vào `API_ROUTE_CONSTANTS` khi nó vào OpenAPI; chỉ ràng buộc module web nào NHẮC tới nó. `routes.test.ts` rule B/C chỉ về `*_PATHNAME`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/rooms.ts` — `ROOM_TOKEN_TTL_SECONDS = 120`, `ROOM_TOKEN_PATH_TEMPLATE = '/v1/rooms/{roomId}/token'`, `roomTokenPath(roomId)`, `roomTokenResponseSchema`, ba câu `ROOM_FULL_MESSAGE` · `ROOM_CLOSED_MESSAGE` · `ROOM_NOT_FOUND_MESSAGE`, `ROOM_ADMISSION_FORBIDDEN_MESSAGE`; `openapi.ts` path + component + tham số `roomId`; `contracts.test.ts` pin (chỉ `post`, không `delete`, response có đủ bốn khoá).
- [x] `packages/domain/src/ports/identity-port.ts` — `User.bannedAt`; `policies/room-admission.ts` — `roomAdmission(user, clock)` trả `admitted | banned | underage` (nhánh `underage` có docblock nói vì sao hôm nay không tới được); `ports/room-reservation-port.ts` — `reserveSeat(input, now)` trả `reserved | full | closed | no_room`, `@throws` chỉ cho fault.
- [x] `packages/db/migrations/1788480300000_room-reservations.js` — `ALTER TABLE users ADD COLUMN banned_at timestamptz NULL` + COMMENT; `room_reservations` (`id`, `room_id` RESTRICT, `user_id` RESTRICT, `reserved_at`, `expires_at`, CHECK `expires_at > reserved_at`, UNIQUE `(room_id, user_id)`, index `(room_id, expires_at)`); `GRANT INSERT, UPDATE, DELETE … TO stuwith_api`; `REVOKE … FROM stuwith_realtime`; COMMENT ON TABLE nêu AD-22; hai COMMENT ON ROLE.
- [x] `packages/db/src/pg/identity-adapter.ts` + `in-memory/identity-adapter.ts` — đọc/mang `bannedAt`; `test-kit.ts` identity contract: người mới có `bannedAt === null`.
- [x] `packages/db/src/pg/room-reservation-adapter.ts` — một transaction: `SELECT … FROM rooms WHERE id=$1 FOR UPDATE` → `no_room`/`closed` → `DELETE` hết hạn của phòng (khoá TRƯỚC rồi mới dọn — xem Change Log) → nếu có dòng của chính người này: `UPDATE expires_at` → `reserved`; else đếm → `full` hoặc `INSERT`. `in-memory/room-reservation-adapter.ts` — cùng luật, **không `await` giữa đếm và ghi**; `test-kit.ts` `runRoomReservationPortContract` gồm ca 130 đồng thời (`Promise.all`, đếm kết quả) và ca gia hạn; `room-reservation-contract.test.ts` + `.pg.test.ts`.
- [x] `packages/db/src/room-reservations-migration.test.ts` — **probe GRANT** (`42501` cho ba câu lệnh dưới `stuwith_realtime`); bảng tồn tại; `users.banned_at` NULL mặc định; UNIQUE và CHECK có thật (câu lệnh vi phạm bị từ chối).
- [x] `apps/api/src/rooms/room-token.ts` — `mintRoomToken` bằng `jose.SignJWT` HS256; `room-token.test.ts` giải mã và pin từng claim, pin **vắng** ba grant admin.
- [x] `apps/api/src/rooms/{rooms.runtime,rooms.module,rooms.service,rooms.controller}.ts` + `auth/auth.runtime.ts` + `app.module.ts` + nơi dựng runtime production — `reservations`, `audit`, `forRuntime(config, runtime)`, `issueRoomToken(cookie, params, requestId)` (`requestId` đọc qua `request-id.ts` dùng chung với auth), `@Post(':roomId/token')`; `rooms/audit.ts` `recordRoomTokenIssued`.
- [x] `apps/api/src/rooms/room-token.flow.test.ts` — mọi dòng ma trận qua HTTP thật; ban trồng qua `wrapIdentity`; audit row đọc lại từ `harness.audit`.
- [x] `tests/gates/livekit-token.test.ts` — **probe ranh giới 1** + quét AC5.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` — ba mục: audit vĩnh viễn trên route không rate limit · giải phóng chỗ khi rời phòng thuộc 2.4 · `banned_at` chưa có người ghi (4.7).

**Acceptance Criteria:**
- Given migration mới trên PG18 thật, when `stuwith_realtime` `INSERT`/`UPDATE`/`DELETE` vào `room_reservations`, then cả ba bị từ chối `42501`; when `stuwith_api` làm cả ba, then thành công.
- Given `livekit-server` thật cùng cặp key với `apps/api`, when upgrade `/rtc` bằng token của `apps/api`, then `101`; when token thiếu `video.room` hoặc ký bằng secret khác, then `401`.
- Given token cấp cho phòng A đã giải mã, then `video.room === A`, chỉ có `roomJoin` (+ publish/subscribe), không có grant tạo/quản trị/liệt kê phòng.
- Given `apps/web/src` và `next.config.ts`, when quét, then không có `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.
- Given gate AC5 của Story 2.1, when thêm migration này, then vẫn xanh — không `DELETE` nào chạm `rooms`, không CASCADE nào vào `rooms`.

### Review Findings

Vòng review 1 (2026-09-13), `bmad-build` bước 4, ba lớp song song (blind-hunter · edge-case-hunter · verification-gap) trên `dfbfdbb..HEAD`, 40 file. Không lớp nào lỗi. Kiểm chứng độc lập TRƯỚC review: `typecheck` xanh · `dep-check` 221 module 0 vi phạm · `test:unit` 2034/2034 · `test:contract` 457/457 (PG18 + Valkey, gồm migration + probe `42501` ba động từ + ca 130 đồng thời) · gates `livekit-token` 13/13 · Playwright 74/74. Mutation "Sẽ đỏ khi" đã CHẠY THẬT: đổi secret `LIVEKIT_KEYS` của container → 3 đỏ (`101`, `400-không-phải-101`, `mở đúng phòng token nêu`), 10 ca từ chối vẫn xanh; khôi phục → 13/13.

Phân loại: **0 `intent_gap`, 0 `bad_spec`** → không loopback. 15 `patch`, 3 `defer`, 7 `reject`. Gói patch đã gửi cho subagent thực thi ngày 2026-09-13 nhưng subagent dừng vì giới hạn phiên API (429) trước khi sửa gì; **phiên 2026-09-13 (sau) đã áp đủ 15 patch**, tự tay, theo đúng thứ tự dưới, mỗi mục chạy mutation đã khai. Trạng thái sau khi áp (mốc `afdb0d8` + working tree): `typecheck` xanh · `dep-check` 222 module 0 vi phạm · `test:unit` 2067/2067 (49 file) · `test:contract` 459/459 (PG18 + Valkey, gồm migration + probe `42501` + ca 130 đồng thời có sampler) · gates `livekit-token` 16/16 (container thật, `101` thật) + `config-cast-ban` xanh · Playwright 74/74. Mutation đã CHẠY THẬT trong phiên này: P6 bỏ `GREATEST`/`Math.max` → 2 đỏ (PG + in-memory) · P15 bỏ `FOR UPDATE` → pool 10 chạy riêng đỏ 3/3 (109, 108, 109) nhưng cả file với pool ấm có lần XANH → nới pool harness PG lên 32 → đỏ 2/2 (102, 119), khôi phục 21/21 · P1 `.catch(() => undefined)` → 2 đỏ · P2 hạ về `min(1)` → 5 đỏ · P3 bỏ kiểm config → 7 đỏ · P4 thêm `temporaryProbe()` vào `RoomPort` → typecheck đỏ tại `rooms.module.ts:26` (và hai adapter, đúng như mong đợi) → revert, xanh.

- [x] [Review][Patch] Ném sau khi đã commit chỗ không có test; docblock "reserves nothing" chỉ đúng cho fault của `reserveSeat` [apps/api/src/rooms/rooms.service.ts, sau `case 'reserved'`] — nuốt lỗi `recordRoomTokenIssued` rồi trả 201 vẫn xanh cả bộ (đo). Sửa: giữ fail-closed (500, không token, chỗ tự hết hạn sau TTL — bù chỗ thuộc defer C); docblock nói đúng vậy; thêm `wrapAudit` vào harness (khuôn `wrapReservations`) + một ca flow: audit ném → 500, body không có `token`, không dòng audit, đếm chỗ phòng = 1. Mutation: `.catch(() => undefined)` + 201 → ca đỏ. Change Log ghi cách đọc: dòng ma trận "Store lỗi giữa chừng → không dòng lẻ" nói về store GIỮ CHỖ ("pool chết / transaction ném"); audit lỗi sau commit là ca khác. → **ĐÃ ÁP: docblock `issueRoomToken` tách hai loại fault (trong `reserveSeat` → rollback, không gì lẻ; sau commit → 500, không token, không audit, chỗ CÒN giữ tới hết TTL); `wrapAudit` thêm vào `auth-harness.ts` cùng khuôn `wrapReservations`; hai ca flow mới (`Matrix: the audit append fails AFTER the seat was reserved`): 500, body không `token`, 0 dòng audit, đếm chỗ = 1; và ca dương: xin lại → 201 gia hạn đúng dòng đó. Mutation đo: 2 đỏ.**
- [x] [Review][Patch] Seam cấu hình: `LIVEKIT_URL` được config nhận với `z.string().min(1)` nhưng `roomTokenResponseSchema.url` đòi `z.url()` [packages/config/src/schema.ts:247] — `LIVEKIT_URL=livekit-host` boot xanh rồi mọi request token 500 SAU khi đã giữ chỗ và ghi audit vĩnh viễn (đo trên gói contracts đã build). Sửa: siết thành URL parse được (ws/wss/http/https; khuôn `httpUrl` :33 nhưng không dùng lại nếu nó chặn ws) + `load.test.ts` (từ chối `livekit-host` nêu tên biến; nhận `ws://localhost:7880`, `wss://host`) + một câu ở AGENTS.md §6 cạnh các ghi chú "breaking change to an existing .env". Mutation: hạ về `min(1)` → ca đỏ. → **ĐÃ ÁP: `livekitUrl` trong `schema.ts` — `new URL()` parse được và scheme ∈ {ws, wss, http, https} (không dùng `httpUrl` vì nó chặn ws và đòi bare origin); `load.test.ts` thêm describe `LIVEKIT_URL is a URL a media client can open`: 5 ca từ chối nêu tên biến (`livekit-host`, `localhost:7880`, `ftp://`, `wss://`, có khoảng trắng), 5 ca nhận (`ws://localhost:7880`, `wss://host`, có path prefix, http, https), 1 ca vẫn `missing`; AGENTS.md §6 thêm mục "third breaking change to an existing `.env`". Mutation đo: 5 đỏ.**
- [x] [Review][Patch] `forRuntime` fail-close mọi port nhưng không soi `config` — `forRuntime(undefined as never, runtime)` boot xanh, 500 ở lần đọc `LIVEKIT_API_KEY` đầu tiên [apps/api/src/rooms/rooms.module.ts] — sửa: kiểm ba thành viên `LIVEKIT_URL/API_KEY/API_SECRET` là chuỗi không rỗng, lỗi nêu tên thành viên thiếu; ca test cho `undefined` và từng thành viên. Mutation: bỏ kiểm → đỏ. → **ĐÃ ÁP: `REQUIRED_CONFIG` = ba tên `satisfies readonly (keyof ApiEnv)[]`, kiểm chuỗi không rỗng TRƯỚC khi kiểm port, lỗi nêu đúng thành viên thiếu; `rooms.module.test.ts` thêm describe 7 ca (`undefined`/`null`/`{}` nêu cả ba; từng biến thiếu hoặc rỗng nêu đúng biến đó và KHÔNG nêu hai biến kia; config đi trước port). Dùng `as never` chứ không `as ApiEnv` — gate `config-cast-ban` cấm cast vào kiểu config, và ở đây ý là ngược lại. Mutation đo: 7 đỏ.**
- [x] [Review][Patch] Docblock hứa "thêm method vào port là phải kiểm ở đây" nhưng `satisfies readonly (keyof Port)[]` không exhaustive [apps/api/src/rooms/rooms.module.ts:25] — suy danh sách từ `Record<keyof Port, true>` cho cả ba port; chứng minh bằng cách thêm tạm một method vào interface → typecheck đỏ → revert. → **ĐÃ ÁP: ba object `ROOM_PORT_METHODS` / `ROOM_RESERVATION_PORT_METHODS` / `AUDIT_PORT_METHODS` `satisfies Record<keyof Port, true>`, danh sách suy bằng `Object.keys`. Chứng minh: thêm `temporaryProbe(): Promise<void>` vào `RoomPort` → `typecheck` đỏ tại `rooms.module.ts(26,3) TS2741` → revert → xanh.**
- [x] [Review][Patch] Ca "provides the config" tìm provider bằng `useValue === config`, không khẳng định `provide === APP_CONFIG` [apps/api/src/rooms/rooms.module.test.ts:191]. → **ĐÃ ÁP: tìm bằng `candidate.provide === APP_CONFIG`, khẳng định `provider` defined và `useValue` là đúng object.**
- [x] [Review][Patch] Gia hạn đặt `expires_at = now + hold` vô điều kiện; hai request cùng người với `now` (theo phiên) đến lệch thứ tự làm `expires_at` LÙI, token cấp trước sống lâu hơn chỗ [packages/db/src/pg/room-reservation-adapter.ts:112, in-memory:72] — `GREATEST(expires_at, $3)` / `Math.max`; ca contract cả hai adapter: gia hạn với `now` sớm hơn → `expires_at` không đổi, `renewed: true`. Mutation: bỏ `GREATEST` → đỏ cả hai. → **ĐÃ ÁP: PG `SET expires_at = GREATEST(expires_at, $3)`; in-memory `Math.max(held.expiresAt, expiresAt)`; ca contract mới `never moves the expiry BACKWARDS` (gia hạn ở `t0+10` sau khi giữ ở `t0+30` → `expires_at` vẫn `t0+30+HOLD`, `renewed: true`, cùng id, 1 dòng). Mutation đo: 2 đỏ (PG + in-memory).**
- [x] [Review][Patch] `deferred-work.md:522` nói metadata có `renewed: true`; `apps/api/src/rooms/audit.ts:22` nói cố ý KHÔNG ghi (đọc qua `reservation_id` lặp) — sửa câu deferred-work theo audit.ts. → **ĐÃ ÁP: câu trong mục rate-limit của deferred-work sửa theo `audit.ts` — metadata cố ý KHÔNG mang cờ, hai dòng cùng `reservation_id` là cách đọc gia hạn.**
- [x] [Review][Patch] OpenAPI công bố "old enough" là điều kiện đang kiểm, trong khi `room-admission.ts` + PRD US-0.5 AC3 nói vào phòng không có sàn tuổi [packages/contracts/src/openapi.ts:528] — mô tả lại: điều kiện tuổi được xét tại cùng điểm chốt và hôm nay nhận mọi lứa tuổi; Story 3.x thêm luật có tiền ở đó. → **ĐÃ ÁP: mô tả route nói ba điều kiện đang kiểm, và tuổi được xét tại cùng cổng nhưng hôm nay nhận mọi lứa tuổi (PRD US-0.5 AC3), luật có tiền của Epic 3 sẽ thêm tại đó.**
- [x] [Review][Patch] Tham số `roomId` là `type: string` trong khi `room_id`/`Room.id` công bố `format: uuid` [packages/contracts/src/openapi.ts:536] — thêm `format: 'uuid'`, pin ở `contracts.test.ts`; và sửa lý do 404 ở `rooms.ts` (~:368) + `openapi.ts` (~:552): "không công bố định dạng id" là sai vì tài liệu đã công bố; lý do thật là một status cho "không có phòng" bất kể vì sao. → **ĐÃ ÁP: `schema: { type: 'string', format: 'uuid' }`, pin ở `contracts.test.ts` (kèm khẳng định `Room.id` cũng `format: uuid`); lý do 404 viết lại ở `rooms.ts` (`isRoomId`), `openapi.ts` (docblock + mô tả 404), `rooms.service.ts` docblock và comment trong flow test: một status cho "không có phòng ở đây" bất kể vì sao, vì client không có gì khác để làm — không phải vì định dạng id là bí mật (tài liệu đã công bố `uuid`).**
- [x] [Review][Patch] `seed()` nuốt thiếu `RETURNING` bằng `?? ''`, lỗi lộ ra sau thành `22P02` mù [packages/db/src/room-reservations-migration.test.ts:181,187] — ném Error nêu seed nào không ra dòng, như `room-reservation-contract.pg.test.ts`. → **ĐÃ ÁP: helper `returnedId(label, rows)` ném Error nêu seed nào (`the user` / `the room` / `the reservation`) không ra dòng; ba chỗ `?? ''` đã thay.**
- [x] [Review][Patch] Dòng Task ghi `issueRoomToken(cookie, params)`, mã nhận thêm `requestId` [spec, Tasks & Acceptance] — sửa dòng task. → **ĐÃ ÁP: dòng task sửa thành `issueRoomToken(cookie, params, requestId)`.**
- [x] [Review][Patch] Sweep AC5 chỉ đi `apps/web/src` + `next.config.ts`, bỏ `apps/web/.env*` và `apps/web/public/`; và helper upgrade không có timeout — server nhận TCP mà không trả `upgrade`/`response` thì treo tới 300s [tests/gates/livekit-token.test.ts:377-403, :201-230] — mở rộng walk (tự kiểm trồng file qua đúng hàm sản xuất cho từng root mới) + `request.setTimeout(15_000, …)` huỷ request với Error nêu ca. → **ĐÃ ÁP: `clientFiles()` = walk `src` + `next.config.ts` + `apps/web/.env*` (không đệ quy, đúng cách Next đọc) + walk toàn bộ `apps/web/public/` (mọi đuôi); walker chịu được thư mục chưa tồn tại; self-check `it.each(PLANTED)` trồng một file vào MỖI root qua chính `clientFiles()` + `clientCredentialOffences()`, `public/` chỉ bị xoá nếu do probe tạo. `upgrade()` nhận `{ label, query }` và `request.setTimeout(15_000)` huỷ với Error nêu tên ca. Gate chạy thật: 16/16.**
- [x] [Review][Patch] Gate seam web chỉ theo dõi hằng `ROOM_TOKEN_PATH_TEMPLATE`; module web import mỗi `roomTokenPath(id)` lọt `mentionsApi` [apps/web/src/app/seam-usage.test.ts:196] — coi export dạng HÀM tên kết thúc `Path` mà kết quả là đường đã công bố (hoặc khớp template `{param}`) là nhắc API; pin dương `toContain('roomTokenPath')` + ví dụ trồng file. Là file TEST web, không phải màn hình — trong Never. → **ĐÃ ÁP: `API_ROUTE_BUILDERS` — export là hàm, tên kết thúc `Path`, gọi với chuỗi probe trả về đúng một template đã công bố với `{param}` được điền; `mentionsApi` thêm nhánh thứ ba; ca pin dương `toContain('roomTokenPath')` + âm (`makeError`, `isRoomId`); ca trồng file `.tsx` thật chỉ import `roomTokenPath` → đi qua đúng pipeline (walker → strip comment → `mentionsApi`) và bị giữ vào luật seam.**
- [x] [Review][Patch] `requestIdOf` ba nhánh fallback, không có unit test riêng [apps/api/src/request-id.ts:20] — `request-id.test.ts`: mỗi nhánh một ca + thứ tự ưu tiên. → **ĐÃ CÓ SẴN trong `afdb0d8`: `apps/api/src/request-id.test.ts` (100 dòng, mỗi nhánh một ca + thứ tự ưu tiên + ca bỏ qua giá trị rỗng/không phải chuỗi) — phiên trước đã kịp viết trước khi dừng. Xác nhận chạy xanh trong `test:unit`.**
- [x] [Review][Patch] Port docblock (:104) và ma trận hứa "không lúc nào > trần dòng hiệu lực", ca 130 chỉ đếm SAU `Promise.all` [packages/db/src/test-kit.ts, runRoomReservationPortContract] — poll `countLive(roomId)` vài ms một lần TRONG lúc burst (PG đọc qua kết nối riêng để chỉ thấy dòng đã commit), mọi mẫu ≤ trần; giữ khẳng định đếm cuối. Mutation: bỏ `FOR UPDATE` → sampler hoặc đếm cuối đỏ (đo trước: 109/130). → **ĐÃ ÁP: harness có `countLive(roomId, now)` (PG: `withClient` mở kết nối RIÊNG mỗi lần đọc, chỉ thấy dòng đã commit; in-memory: đếm `expiresAt > now`); sampler poll 3 ms một lần TRONG lúc burst, mẫu đầu lấy trước `sleep` nên luôn ≥ 1 mẫu; khẳng định mọi mẫu ≤ trần, giữ đếm cuối. Phát hiện khi đo: với pool 10 mutation chỉ đỏ "thường xuyên" (chạy riêng 3/3 đỏ, cả file pool ấm có lần xanh) → harness PG dùng `createPool(url, { max: 32 })` kèm docblock lý do → đỏ 2/2 (102, 119).**

- [ ] [Review][Defer] `finally { client.release() }` sau `ROLLBACK` hỏng trả client có thể còn trong transaction về pool [packages/db/src/pg/room-reservation-adapter.ts:153] — y hệt `identity-adapter.ts:312`, `session-adapter.ts:152`: khuôn sẵn ở ba adapter, sửa là một quyết định cho cả ba (`release(error)` khi fault).
- [ ] [Review][Defer] `sub = user.id` là identity LiveKit; LiveKit ngắt kết nối cũ khi cùng identity nối lần hai — đúng ca "gia hạn mỗi lần đổi thiết bị ở pre-join" (2.3) và nối lại (2.4) [apps/api/src/rooms/room-token.ts:72] — chưa docblock/spec nào ghi. Chủ: 2.3/2.4.
- [ ] [Review][Defer] Bù chỗ sau fault hậu-commit (mục patch 1) cần đường giải phóng trên port; 2.4 sở hữu giải phóng khi rời phòng nên bù chỗ đi cùng thay đổi đó. Hôm nay chỗ tự hết hạn sau `ROOM_TOKEN_TTL_SECONDS`.
- [x] Ba mục defer trên ĐÃ có trong `deferred-work.md` (ba mục cuối, status "CHƯA CÓ CHỦ (2026-09-13, review vòng 1 của spec 2.2 …)") — phiên trước đã ghi trước khi dừng; phiên này kiểm lại, không ghi trùng.

Đã KIỂM CHỨNG và loại (`reject`): in-memory import từ `../pg/` (cả năm adapter cùng khuôn) · không bump `CONTRACT_VERSION` (là phiên bản API, 2.1 thêm `/v1/rooms` cũng không bump) · bốn câu envelope chưa vào catalogue i18n (chưa màn hình nào dùng, 2.3 đưa vào) · `ADD COLUMN` thiếu `IF NOT EXISTS` (trùng Defer "pre-existing shape" 2.1 đã có người quyết) · symlink trong walker (repo không có, walker dùng chung) · "`LIVEKIT_KEYS` từ env" trong khối đóng băng (là env của CONTAINER, gate làm đúng thế) · sprint-status `in-progress` trong khi spec `in-review` (bước 5 mới đồng bộ sang `review`).

#### Vòng review 2 (2026-09-13)

Ba lớp song song (blind-hunter · edge-case-hunter · verification-gap) trên `dfbfdbb..working tree` sau khi áp 15 patch vòng 1 (44 file, 4633 dòng thêm). Không lớp nào lỗi. 30 mục thô: 18 blind · 11 edge · 1 verification-gap. Phân loại: **0 `intent_gap`, 0 `bad_spec`** → không loopback. **21 `patch`** (đã áp trong cùng phiên), **3 `defer`** (đã ghi vào `deferred-work.md`), **5 `reject`**. Trạng thái sau vòng 2: `typecheck` xanh · `dep-check` 222 module 0 vi phạm · `test:unit` 2071/2071 · `test:contract` 461/461 (20 file, PG18 + Valkey) · gates 550/550 (`livekit-token` 17/17, thêm ca token hết hạn → `401` đo trên container thật) · Playwright không chạy lại (không file nào của `apps/web/src` ngoài test đơn vị bị chạm; 74/74 từ vòng 1 vẫn đúng). Mutation đã chạy thật: bỏ `toLowerCase()` + thêm khoá thứ năm vào body → 2 ca flow đỏ · bỏ kiểm userinfo của `LIVEKIT_URL` → 2 ca `load.test` đỏ.

- [x] [Review][Patch] `roomId` viết HOA đi qua `z.uuid()` và Postgres (so `uuid` theo giá trị) rồi đi nguyên văn vào `video.room`, `room_id` và tên phòng LiveKit → một dòng `rooms`, HAI phòng media; in-memory trả `no_room` [apps/api/src/rooms/rooms.service.ts, `readRoomIdParam`] → **ĐÃ ÁP: gập về chữ thường tại một chỗ (`rooms.id` mint chữ thường là chính tả chuẩn); ca flow: xin bằng id HOA → 201, `room_id` và `video.room` chữ thường, xin lại bằng chữ thường → vẫn 1 chỗ, audit `subjectId` chữ thường. Mutation: bỏ fold → đỏ.**
- [x] [Review][Patch] Body 201 không được ghim ĐÚNG bốn khoá — `z.object.parse` LỘT khoá lạ thay vì từ chối (đo trên zod 4.4.3 của repo), nên `{...parsed, renewed}` ship lên wire mà cả suite xanh [apps/api/src/rooms/room-token.flow.test.ts] → **ĐÃ ÁP: `Object.keys(raw).sort()` === bốn khoá, rồi mới parse. Mutation: thêm `renewed: seat.renewed` → đỏ.**
- [x] [Review][Patch] `LIVEKIT_URL` mang userinfo (`wss://user:pass@host`) được đưa nguyên văn tới mọi client [packages/config/src/schema.ts] → **ĐÃ ÁP: refine thêm `username === '' && password === ''`, thông báo nêu rõ; 2 ca `load.test` mới. Mutation: bỏ → 2 đỏ.**
- [x] [Review][Patch] `holdForSeconds` là số nguyên dương nhưng đủ lớn để `now + hold*1000` ra Invalid Date: PG ném lỗi driver, in-memory giữ chỗ `NaN` không bao giờ dọn và đếm vào trần mãi (hai lớp cùng nêu) [packages/db/src/pg/room-reservation-adapter.ts, `assertValidReserveSeatInput`] → **ĐÃ ÁP: kiểm `expiryFor(now, hold)` hợp lệ, ném `RoomReservationInputError`; ca contract `Number.MAX_SAFE_INTEGER` chạy trên cả hai adapter.**
- [x] [Review][Patch] `Promise.all` của burst 130 reject thì `burstSettled` không bao giờ đặt, sampler poll tới timeout 120 s [packages/db/src/test-kit.ts] → **ĐÃ ÁP: `try { … } finally { burstSettled = true }`.**
- [x] [Review][Patch] `upgrade()` không xử lý `response` bị `error`/`aborted` trước `end` → promise không bao giờ settle; `listRooms` `fetch` không có timeout [tests/gates/livekit-token.test.ts] → **ĐÃ ÁP: `response.on('error'/'aborted')` reject nêu tên ca; `signal: AbortSignal.timeout(UPGRADE_TIMEOUT_MS)`.**
- [x] [Review][Patch] Gate seam web gọi builder với đúng MỘT tham số → builder cho route hai tham số sau này không được nhận diện [apps/web/src/app/seam-usage.test.ts] → **ĐÃ ÁP: đếm số `{param}` của từng template, gọi builder với đúng bấy nhiêu probe.**
- [x] [Review][Patch] Ca "planted screen" kết thúc bằng `not.toContain('useAuthorizedFetch()')` trên chuỗi chính test vừa viết — không chứng minh sweep sẽ ĐÁNH RỚT file [seam-usage.test.ts] → **ĐÃ ÁP: rút `seamRuleViolations(source)` — một predicate dùng chung cho `it.each(apiCallers)` và cho ca trồng file; ca trồng khẳng định đúng hai vi phạm được nêu tên.**
- [x] [Review][Patch] Gate LiveKit chưa chứng minh server TỪ CHỐI token hết hạn — toàn bộ lập luận ghép chỗ/token dựa vào việc bên kia thực thi `exp` [tests/gates/livekit-token.test.ts] → **ĐÃ ÁP: ca `expired token` (mint bằng chính `mintRoomToken` đã build, `exp` quá 2 phút) → `401` đo thật. Ca "mở đúng phòng token nêu" dùng phòng RIÊNG để nửa dương không bị ca `101` trước đó thoả sẵn.**
- [x] [Review][Patch] Dòng `%2e%2e` trong ma trận 404 thật ra đi qua `roomTokenPath` → `%252e%252e` trên wire, service nhận chuỗi `%2e%2e` — không phải dotted segment; và `/v1/rooms/%2e%2e/token` thô cũng bị WHATWG gập thành `/v1/token` [room-token.flow.test.ts] → **ĐÃ ÁP: đổi tên dòng và comment nói đúng cái đang được kiểm.**
- [x] [Review][Patch] `openapi.ts` có hàm nội bộ `roomTokenPath()` trùng tên export `roomTokenPath(roomId)` của `rooms.ts`; gate seam nay nhận diện builder theo hậu tố `Path` [packages/contracts/src/openapi.ts] → **ĐÃ ÁP: đổi thành `roomTokenPathItem()` + comment; cập nhật docblock `contracts.test.ts`.**
- [x] [Review][Patch] Docblock các câu từ chối ở `rooms.ts` vẫn giữ lý do cũ "caller học được định dạng id từ error message" mà patch 9 vòng 1 đã bỏ ở mọi chỗ khác [packages/contracts/src/rooms.ts] → **ĐÃ ÁP: viết lại cùng lý do "một status cho không-có-phòng, định dạng đã công khai".**
- [x] [Review][Patch] Docblock `renewed` trên port nói "audit row … tell the two apart" trong khi `audit.ts` cố ý KHÔNG ghi [packages/domain/src/ports/room-reservation-port.ts] → **ĐÃ ÁP: docblock nói contract suite là người đọc duy nhất; wire và audit đều không mang.**
- [x] [Review][Patch] `.env.example` không có ví dụ/chú thích cho `LIVEKIT_URL` dù schema giờ từ chối host trần [.env.example] → **ĐÃ ÁP: ba dòng chú thích: cần scheme, ví dụ compose/production, không userinfo.**
- [x] [Review][Patch] Ba file trồng mới không có trong `.gitignore` (khác mọi probe trước); `.tsx` nằm trong `app/` nên Next sẽ nhận làm route nếu run crash; `removePlanted` xoá đệ quy `public/` nếu nó chưa tồn tại lúc load [.gitignore, tests/gates/livekit-token.test.ts] → **ĐÃ ÁP: ba mục ignore kèm lý do; `public/` chỉ bị gỡ bằng `rmdirSync` (không đệ quy) khi RỖNG sau khi bỏ file trồng.**
- [x] [Review][Patch] `request-id.test.ts` dòng "non-string stamped header" dùng `undefined` (= ca vắng); `getHeader` có thể trả `number`/`string[]` — đúng thứ guard `typeof` tồn tại để chặn [apps/api/src/request-id.test.ts] → **ĐÃ ÁP: hai dòng `42` và `['a','b']`.**
- [x] [Review][Patch] Câu đóng băng `exp = now + 120s` không còn đúng tuyệt đối sau patch 6 vòng 1: request trễ với `now` sớm hơn giữ `expires_at` muộn hơn (`GREATEST`) nên `exp > now + 120s` trong đúng cuộc đua đó [spec, Change Log] → **ĐÃ ÁP: ghi Change Log nêu độ lệch để con người thương lượng lại câu đóng băng (cùng cách ca `400/401` đã làm); mã giữ hướng an toàn — hai câu đóng băng chỉ mâu thuẫn trong cuộc đua, và "gia hạn" (không bao giờ rút ngắn) là cách đọc không để token đã cấp sống lâu hơn chỗ.**
- [x] [Review][Patch] Dòng Task còn ghi thứ tự `DELETE → FOR UPDATE` trong khi Change Log và mã là ngược lại [spec, Tasks] → **ĐÃ ÁP: sửa dòng task.**
- [x] [Review][Patch] AGENTS.md chỉ có mục `LIVEKIT_URL`; thiếu ba điều cùng lớp "known gaps / rules with teeth": grant `DELETE` đầu tiên cho một role ứng dụng (`room_reservations`, AD-22) đặt cạnh câu "no role holds DELETE" của `sessions`; `banned_at` có người đọc chưa có người ghi; chỗ còn giữ sau fault hậu-commit [AGENTS.md §6] → **ĐÃ ÁP: ba mục mới ngay sau mục `LIVEKIT_URL`.**
- [x] [Review][Patch] Docblock `wrapReservations`/`wrapAudit` (và `wrapIdentity` gốc) nói `harness.x` "still points at the wrapped adapter" — thực tế trỏ vào adapter GỐC dưới wrapper [apps/api/src/auth/__testing__/auth-harness.ts] → **ĐÃ ÁP: ba docblock nói "BASE adapter underneath the wrapper".**
- [x] [Review][Patch] Heading `## ` trong docblock `RoomsModule.forRuntime` bị gãy thành hai dòng `##` [apps/api/src/rooms/rooms.module.ts] → **ĐÃ ÁP: một dòng.**

- [x] [Review][Defer] `FOR UPDATE` không có `lock_timeout`/`statement_timeout` — quyết định cho cả pool/mọi adapter có transaction (cùng loại `release(error)`); hôm nay không đường nào treo thật. Đã ghi `deferred-work.md`.
- [x] [Review][Defer] `409` hai nghĩa (đóng/đầy) với một `code`, không `details` — thay đổi hợp đồng, `ERROR_CODES` là Ask First; chủ: 2.3. Đã ghi.
- [x] [Review][Defer] Đường `500` không qua `ErrorEnvelope` (Nest default body) — có từ Epic 1, mọi route cùng cảnh; sửa là filter toàn cục. Đã ghi.

Đã KIỂM CHỨNG và loại (`reject`, vòng 2): `default: never` cho switch `seat.kind` (TS đã thu hẹp `seat` sau switch — thêm kind thứ năm là lỗi typecheck tại `seat.reservation`, không cần guard runtime) · guard Invalid Date trong `mintRoomToken` (hai đầu vào là `caller.at` và `reservation.expiresAt`, không có đường nào không hợp lệ) · `roomTokenPath('')` ném (lỗi của client gọi, không tới server) · "`full` ROLLBACK undo reap của step 2" (bất khả thi: dòng chỉ được thêm khi đếm-sau-dọn < trần, nên tổng dòng sống + hết hạn ≤ trần ở mọi thời điểm; `full` ⇒ sống = trần ⇒ không có dòng hết hạn để mất) · metadata `review_loop_iteration: 0` / `last_updated` sprint-status / "ba mục deferred" (đúng theo định nghĩa bước 4: chỉ tăng khi loopback; sprint-status đồng bộ ở bước 5; ba mục story đã thêm đúng ba).

## Spec Change Log

- 2026-09-13 (implementation, không sửa khối đóng băng): Probe ranh giới 1 ghi "cùng token bỏ `video.room` hoặc `roomJoin:false` → `401`". ĐO trên `livekit/livekit-server:v1.13.5` thật: `roomJoin:false` → `401 permissions denied`, ký sai secret → `401 invalid token`, không có `video` → `401`, nhưng **bỏ `video.room` → `400 "no room name"`**, không phải `401`. `tests/gates/livekit-token.test.ts` ghim đúng mã đo được (`400`, và khẳng định `không phải 101`) thay vì con số trong câu đóng băng; ý nghĩa AD-9 không đổi — token không nêu tên phòng thì không mở phòng nào. Con người cần đổi câu đó thành "→ bị từ chối (`401`, hoặc `400` cho trường hợp thiếu `video.room`)" khi thương lượng lại.
- 2026-09-13: Thứ tự trong transaction của adapter PG là **khoá `FOR UPDATE` trước, rồi mới `DELETE` hết hạn** (Tasks ghi `DELETE` → `SELECT … FOR UPDATE`). Cả hai thứ tự đúng dưới READ COMMITTED; khoá trước làm mọi ghi vào reservations của một phòng xếp hàng sau một khoá duy nhất, không cần lập luận về EvalPlanQual của `DELETE`. Docblock `PgRoomReservationAdapter` nêu lý do.
- 2026-09-13: Thêm `isRoomId` vào `packages/contracts/src/rooms.ts` (không có trong danh sách Tasks) — cùng luật `roomSchema.shape.id`, để `apps/api` trả `404` cùng body cho id sai định dạng mà không có pipe nào trả `400` nêu tên tham số.
- 2026-09-13: Code Map ghi "Web — không chạm" và dự đoán `seam-usage.test.ts` tự thêm hằng route mới. Đúng một nửa: hằng được thêm tự động, nhưng ca `knows a route constant from a cookie constant` còn khẳng định mọi tên trong tập kết thúc bằng `_PATH`, mà tên spec chốt là `ROOM_TOKEN_PATH_TEMPLATE`. Giữ tên theo spec; nới đúng một khẳng định trong test web sang `/_PATH(?:_TEMPLATE)?$/` kèm lý do (đường có `{param}` vẫn là đường đã công bố). Không module web nào nhắc tới hằng này.
- 2026-09-13 (QUYẾT ĐỊNH CON NGƯỜI, sửa khối đóng băng theo uỷ quyền tại checkpoint sau bước 3): câu trong `## Probe ranh giới` đổi từ "→ `401`" thành "→ bị từ chối (`401`; `400` khi thiếu `video.room`)" cho khớp mã LiveKit thật trả. Không đổi ranh giới, không đổi probe, không đổi mutation "Sẽ đỏ khi" — mutation đó đã chạy thật ở bước 3: đổi secret container → 3 ca đỏ (`101`, `400-không-phải-101`, `mở đúng phòng token nêu`), 10 ca từ chối vẫn xanh; khôi phục → 13/13.
- 2026-09-13 (review vòng 1, patch 1 — CÁCH ĐỌC ma trận, không sửa khối đóng băng): dòng "Store lỗi giữa chừng → `500`, không token, không dòng lẻ" nói về store GIỮ CHỖ ("pool chết / transaction ném"): adapter rollback nên không gì lẻ. Fault SAU khi transaction đã commit (`mintRoomToken` hoặc `recordRoomTokenIssued` ném) là ca KHÁC: vẫn `500`, không token, không audit, nhưng chỗ đã commit CÒN giữ tới hết TTL và người đó xin lại thì gia hạn. Giữ fail-closed, không bù chỗ trong story này (đường giải phóng thuộc 2.4, mục defer đã ghi). Docblock `issueRoomToken` nói đúng vậy; ca flow ghim.
- 2026-09-13 (review vòng 1, patch 2 — BREAKING cho `.env` có sẵn): `LIVEKIT_URL` đổi từ "chuỗi không rỗng" thành URL parse được với scheme ws/wss/http/https, vì `roomTokenResponseSchema.url` là `z.url()` và một `.env` ghi `livekit-host` boot xanh rồi 500 SAU khi đã giữ chỗ + ghi audit vĩnh viễn. AGENTS.md §6 ghi là breaking change thứ ba.
- 2026-09-13 (review vòng 1, patch 15 — quyết định harness): harness PG của `runRoomReservationPortContract` dùng pool `max: 32` thay vì 10 của production. Lý do đo được: với 10 kết nối, mutation bỏ `FOR UPDATE` đỏ 3/3 khi chạy riêng (109/108/109) nhưng cả file với pool ấm có lần XANH — một mutation "thường đỏ" không phải bằng chứng. Tính chất cần chứng minh phải đúng ở mọi kích thước pool; 32 transaction cùng lúc làm cửa sổ đếm→ghi va chạm mỗi lần (102, 119). Production vẫn 10.
- 2026-09-13 (review vòng 1, patch 12): sweep AC5 mở rộng sang `apps/web/.env*` (Next inline `NEXT_PUBLIC_*` từ đó vào bundle) và `apps/web/public/` (phục vụ nguyên văn). Cả hai chưa tồn tại; walker chịu thiếu, self-check trồng file vào từng root để chứng minh ngày chúng xuất hiện là ngày chúng được quét.
- 2026-09-13 (review vòng 2 — ĐỘ LỆCH với khối đóng băng, cần con người thương lượng lại, KHÔNG sửa khối đóng băng): câu "`exp = now + 120s`" đúng trong mọi thứ tự bình thường, nhưng trong cuộc đua hai request cùng người tới lệch thứ tự với mốc `now` (theo phiên), patch 6 vòng 1 chọn `GREATEST(expires_at, now + 120s)` — request trễ nhận `expires_at` (và `exp`) MUỘN hơn `now + 120s` của nó, tối đa bằng độ lệch giữa hai mốc. Lý do chọn: câu "gia hạn chỗ đang giữ" và bất biến "token LiveKit còn nhận thì luôn có chỗ đứng sau" không cho phép rút ngắn chỗ dưới một token đã cấp. Đề nghị câu mới: "`exp` = `expires_at` của chỗ; chỗ = max(chỗ đang giữ, `now + 120s`)". Contract suite ghim (`never moves the expiry BACKWARDS`); chưa có ca HTTP vì `FixedClock` của harness chỉ tiến, không lùi.
- 2026-09-13 (review vòng 2): `readRoomIdParam` gập `roomId` về chữ thường — không trong Tasks. `z.uuid()` và Postgres chấp nhận cả hai kiểu chữ, nhưng chuỗi đi nguyên văn vào tên phòng LiveKit, nên một id viết HOA là một phòng media thứ hai cho cùng một dòng `rooms`. `rooms.id` được mint chữ thường; đây là chỗ duy nhất chính tả trên wire được gập về chính tả chuẩn.
- 2026-09-13: `requestIdOf` được rút từ `auth.controller.ts` ra `apps/api/src/request-id.ts` để hai controller ghi audit dùng chung một cách đọc request id, thay vì chép.

## Design Notes

**`FOR UPDATE` trên dòng `rooms`, không phải advisory lock, không phải `SERIALIZABLE`.** Khoá dòng phòng là đơn vị đúng: hai phòng khác nhau không chờ nhau, hai người cùng phòng xếp hàng. `stuwith_api` đã có `UPDATE` trên `rooms` (2.1) nên `FOR UPDATE` được phép mà không thêm grant; `SERIALIZABLE` đòi retry ở tầng service, còn advisory lock là một cơ chế thứ hai bên cạnh thứ đã có sẵn trong FK.

**Tên phòng LiveKit = `rooms.id`.** Một tầng ánh xạ tên ↔ id là chỗ hai bên lệch nhau. Token nêu đúng uuid, gateway (2.4) so uuid, không có "slug".

**`banned_at` là timestamp, không phải boolean.** "Bị ban từ lúc nào" là câu hỏi đầu tiên của mọi cuộc điều tra; một `boolean` cần cột thứ hai ngay khi 4.7 tới.

**Cùng người xin lại → gia hạn.** Nút "Vào phòng" bấm hai lần không được ăn hai chỗ; pre-join (2.3) sẽ gọi lại endpoint này mỗi lần người ta đổi ý về thiết bị.

## Verification

- `corepack pnpm run build:packages` — bắt buộc TRƯỚC mọi mutation test.
- `corepack pnpm run typecheck` — xanh; ĐỎ khi bỏ `bannedAt` khỏi một trong hai adapter identity.
- `corepack pnpm run test:unit` · `test:contract` (Gate 3, có ca 130 đồng thời trên PG18) · `dep-check` — xanh; mutation bỏ `FOR UPDATE` → ca đồng thời ĐỎ trên PG (in-memory vẫn xanh — đó là lý do có cả hai).
- `corepack pnpm run test:migrations` — xanh; mutation `GRANT INSERT ON room_reservations TO stuwith_realtime` → probe 2 đỏ → khôi phục.
- `corepack pnpm run test:gates` — xanh, cần Docker; mutation đổi secret trong `LIVEKIT_KEYS` của container → probe 1 đỏ; mutation bỏ `video.room` khỏi claim → đỏ → khôi phục.
- `corepack pnpm exec playwright test` — 74/74, không đổi (không có màn hình).

## Suggested Review Order

**Điểm chốt quyền (AD-9): bốn điều kiện, một phương thức**

- Điểm vào: thứ tự 401 → 403 → 404/409 → mint → audit, và vì sao không có `findRoomById` trước transaction
  [`rooms.service.ts:211`](../../apps/api/src/rooms/rooms.service.ts#L211)

- Hai loại fault để lại hai trạng thái khác nhau; chỗ còn giữ sau fault hậu-commit là cố ý, có ghi defer
  [`rooms.service.ts:181`](../../apps/api/src/rooms/rooms.service.ts#L181)

- Ban và tuổi là câu hỏi về NGƯỜI, sống trong domain; `underage` khai sẵn nhưng chưa tới được
  [`room-admission.ts:51`](../../packages/domain/src/policies/room-admission.ts#L51)

- Gập `roomId` về chữ thường: một dòng `rooms` không được thành hai phòng LiveKit
  [`rooms.service.ts:300`](../../apps/api/src/rooms/rooms.service.ts#L300)

- Controller không quyết gì; `request.params` đi xuống `unknown`, request id đọc qua một hàm chung
  [`rooms.controller.ts:66`](../../apps/api/src/rooms/rooms.controller.ts#L66)

**Giữ chỗ nguyên tử (AD-22): trần quyết trong transaction**

- Hợp đồng port: `full` phải quyết trong cùng bước ghi, không lúc nào > trần dòng sống
  [`room-reservation-port.ts:116`](../../packages/domain/src/ports/room-reservation-port.ts#L116)

- `FOR UPDATE` trên dòng `rooms` là toàn bộ cơ chế; khoá trước, dọn sau
  [`room-reservation-adapter.ts:87`](../../packages/db/src/pg/room-reservation-adapter.ts#L87)

- Gia hạn bằng `GREATEST`: không bao giờ rút ngắn chỗ dưới một token đã cấp
  [`room-reservation-adapter.ts:121`](../../packages/db/src/pg/room-reservation-adapter.ts#L121)

- Đếm rồi ghi, an toàn chỉ vì khoá ở bước 1
  [`room-reservation-adapter.ts:134`](../../packages/db/src/pg/room-reservation-adapter.ts#L134)

- In-memory: cùng luật, không `await` giữa đếm và ghi
  [`room-reservation-adapter.ts:62`](../../packages/db/src/in-memory/room-reservation-adapter.ts#L62)

**Schema và quyền ghi (AD-8)**

- Bảng `room_reservations`: hai FK RESTRICT, UNIQUE (phòng, người), CHECK hết hạn sau đặt
  [`1788480300000_room-reservations.js:64`](../../packages/db/migrations/1788480300000_room-reservations.js#L64)

- `stuwith_api` là chủ ghi duy nhất, kể cả `DELETE` dọn hết hạn; `stuwith_realtime` bị REVOKE
  [`1788480300000_room-reservations.js:105`](../../packages/db/migrations/1788480300000_room-reservations.js#L105)

- `users.banned_at` NULL mặc định, chưa có người ghi tới 4.7
  [`1788480300000_room-reservations.js:47`](../../packages/db/migrations/1788480300000_room-reservations.js#L47)

**Token và ranh giới LiveKit**

- Ký HS256 bằng `jose`, `exp` là `expires_at` của chỗ, chỉ ba grant join/publish/subscribe
  [`room-token.ts:61`](../../apps/api/src/rooms/room-token.ts#L61)

- Probe ranh giới: server thật trả `101`, và mọi mutation phía xa (secret khác, thiếu `video.room`, hết hạn)
  [`livekit-token.test.ts:330`](../../tests/gates/livekit-token.test.ts#L330)

- Ca token hết hạn → `401`: ghép chỗ/token dựa vào việc bên kia thực thi `exp`
  [`livekit-token.test.ts:379`](../../tests/gates/livekit-token.test.ts#L379)

- Audit `room_token.issued`: chỉ id và mốc thời gian, cố ý không mang cờ `renewed`
  [`audit.ts:41`](../../apps/api/src/rooms/audit.ts#L41)

**Hợp đồng và cấu hình**

- TTL 120 giây là một con số cho hai thứ; đổi là Ask First
  [`rooms.ts:352`](../../packages/contracts/src/rooms.ts#L352)

- Body 201 bốn khoá, `url` là `z.url()` — đầu bên kia của seam cấu hình
  [`rooms.ts:398`](../../packages/contracts/src/rooms.ts#L398)

- `LIVEKIT_URL` giờ từ chối host trần và userinfo trước khi mở cổng (breaking cho `.env` cũ)
  [`schema.ts:48`](../../packages/config/src/schema.ts#L48)

- OpenAPI: `roomId` là `format: uuid`, lý do 404 chung một body
  [`openapi.ts:522`](../../packages/contracts/src/openapi.ts#L522)

- Module fail-closed cả ba port lẫn ba biến LiveKit; exhaustive qua `Record<keyof Port, true>`
  [`rooms.module.ts:26`](../../apps/api/src/rooms/rooms.module.ts#L26)

**Kiểm chứng và harness**

- Ca 130 đồng thời có sampler trong lúc burst; pool 32 để mutation đỏ chắc chắn
  [`test-kit.ts:2396`](../../packages/db/src/test-kit.ts#L2396)

- Gia hạn với `now` sớm hơn không lùi hạn
  [`test-kit.ts:2263`](../../packages/db/src/test-kit.ts#L2263)

- Vì sao harness PG dùng pool 32 chứ không 10
  [`room-reservation-contract.pg.test.ts:47`](../../packages/db/src/room-reservation-contract.pg.test.ts#L47)

- Probe GRANT thật: ba động từ dưới `stuwith_realtime` → `42501`
  [`room-reservations-migration.test.ts:156`](../../packages/db/src/room-reservations-migration.test.ts#L156)

- Audit ném sau commit: 500, không token, chỗ vẫn 1
  [`room-token.flow.test.ts:527`](../../apps/api/src/rooms/room-token.flow.test.ts#L527)

- Body 201 ghim đúng bốn khoá trên JSON thô, vì `z.object` lột chứ không từ chối
  [`room-token.flow.test.ts:170`](../../apps/api/src/rooms/room-token.flow.test.ts#L170)

- `wrapAudit` trong harness, cùng khuôn `wrapReservations`
  [`auth-harness.ts:257`](../../apps/api/src/auth/__testing__/auth-harness.ts#L257)

- Sweep AC5 quét thêm `apps/web/.env*` và `public/`, tự trồng file vào từng root
  [`livekit-token.test.ts:496`](../../tests/gates/livekit-token.test.ts#L496)

- Gate seam web nhận diện builder `roomTokenPath(id)` từ tài liệu, không từ danh sách
  [`seam-usage.test.ts:111`](../../apps/web/src/app/seam-usage.test.ts#L111)

- AGENTS.md: breaking change `LIVEKIT_URL`, grant `DELETE` đầu tiên, `banned_at` chưa có người ghi, chỗ còn giữ sau fault
  [`AGENTS.md:628`](../../AGENTS.md#L628)
