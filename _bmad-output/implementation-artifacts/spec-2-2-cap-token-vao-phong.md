---
title: 'Story 2.2 — Cấp token vào phòng kèm giữ chỗ nguyên tử'
type: 'feature'
created: '2026-09-12'
status: 'in-review'
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
- [x] `packages/db/src/pg/room-reservation-adapter.ts` — một transaction: `DELETE` hết hạn của phòng → `SELECT … FROM rooms WHERE id=$1 FOR UPDATE` → `no_room`/`closed` → nếu có dòng của chính người này: `UPDATE expires_at` → `reserved`; else đếm → `full` hoặc `INSERT`. `in-memory/room-reservation-adapter.ts` — cùng luật, **không `await` giữa đếm và ghi**; `test-kit.ts` `runRoomReservationPortContract` gồm ca 130 đồng thời (`Promise.all`, đếm kết quả) và ca gia hạn; `room-reservation-contract.test.ts` + `.pg.test.ts`.
- [x] `packages/db/src/room-reservations-migration.test.ts` — **probe GRANT** (`42501` cho ba câu lệnh dưới `stuwith_realtime`); bảng tồn tại; `users.banned_at` NULL mặc định; UNIQUE và CHECK có thật (câu lệnh vi phạm bị từ chối).
- [x] `apps/api/src/rooms/room-token.ts` — `mintRoomToken` bằng `jose.SignJWT` HS256; `room-token.test.ts` giải mã và pin từng claim, pin **vắng** ba grant admin.
- [x] `apps/api/src/rooms/{rooms.runtime,rooms.module,rooms.service,rooms.controller}.ts` + `auth/auth.runtime.ts` + `app.module.ts` + nơi dựng runtime production — `reservations`, `audit`, `forRuntime(config, runtime)`, `issueRoomToken(cookie, params)`, `@Post(':roomId/token')`; `rooms/audit.ts` `recordRoomTokenIssued`.
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

Phân loại: **0 `intent_gap`, 0 `bad_spec`** → không loopback. 15 `patch`, 3 `defer`, 7 `reject`. Gói patch đã gửi cho subagent thực thi ngày 2026-09-13 nhưng subagent dừng vì giới hạn phiên API (429) **trước khi sửa gì** — mọi mục dưới đây còn MỞ. Phiên sau: áp theo thứ tự, mỗi mục kèm mutation đã khai.

- [ ] [Review][Patch] Ném sau khi đã commit chỗ không có test; docblock "reserves nothing" chỉ đúng cho fault của `reserveSeat` [apps/api/src/rooms/rooms.service.ts, sau `case 'reserved'`] — nuốt lỗi `recordRoomTokenIssued` rồi trả 201 vẫn xanh cả bộ (đo). Sửa: giữ fail-closed (500, không token, chỗ tự hết hạn sau TTL — bù chỗ thuộc defer C); docblock nói đúng vậy; thêm `wrapAudit` vào harness (khuôn `wrapReservations`) + một ca flow: audit ném → 500, body không có `token`, không dòng audit, đếm chỗ phòng = 1. Mutation: `.catch(() => undefined)` + 201 → ca đỏ. Change Log ghi cách đọc: dòng ma trận "Store lỗi giữa chừng → không dòng lẻ" nói về store GIỮ CHỖ ("pool chết / transaction ném"); audit lỗi sau commit là ca khác.
- [ ] [Review][Patch] Seam cấu hình: `LIVEKIT_URL` được config nhận với `z.string().min(1)` nhưng `roomTokenResponseSchema.url` đòi `z.url()` [packages/config/src/schema.ts:247] — `LIVEKIT_URL=livekit-host` boot xanh rồi mọi request token 500 SAU khi đã giữ chỗ và ghi audit vĩnh viễn (đo trên gói contracts đã build). Sửa: siết thành URL parse được (ws/wss/http/https; khuôn `httpUrl` :33 nhưng không dùng lại nếu nó chặn ws) + `load.test.ts` (từ chối `livekit-host` nêu tên biến; nhận `ws://localhost:7880`, `wss://host`) + một câu ở AGENTS.md §6 cạnh các ghi chú "breaking change to an existing .env". Mutation: hạ về `min(1)` → ca đỏ.
- [ ] [Review][Patch] `forRuntime` fail-close mọi port nhưng không soi `config` — `forRuntime(undefined as never, runtime)` boot xanh, 500 ở lần đọc `LIVEKIT_API_KEY` đầu tiên [apps/api/src/rooms/rooms.module.ts] — sửa: kiểm ba thành viên `LIVEKIT_URL/API_KEY/API_SECRET` là chuỗi không rỗng, lỗi nêu tên thành viên thiếu; ca test cho `undefined` và từng thành viên. Mutation: bỏ kiểm → đỏ.
- [ ] [Review][Patch] Docblock hứa "thêm method vào port là phải kiểm ở đây" nhưng `satisfies readonly (keyof Port)[]` không exhaustive [apps/api/src/rooms/rooms.module.ts:25] — suy danh sách từ `Record<keyof Port, true>` cho cả ba port; chứng minh bằng cách thêm tạm một method vào interface → typecheck đỏ → revert.
- [ ] [Review][Patch] Ca "provides the config" tìm provider bằng `useValue === config`, không khẳng định `provide === APP_CONFIG` [apps/api/src/rooms/rooms.module.test.ts:191].
- [ ] [Review][Patch] Gia hạn đặt `expires_at = now + hold` vô điều kiện; hai request cùng người với `now` (theo phiên) đến lệch thứ tự làm `expires_at` LÙI, token cấp trước sống lâu hơn chỗ [packages/db/src/pg/room-reservation-adapter.ts:112, in-memory:72] — `GREATEST(expires_at, $3)` / `Math.max`; ca contract cả hai adapter: gia hạn với `now` sớm hơn → `expires_at` không đổi, `renewed: true`. Mutation: bỏ `GREATEST` → đỏ cả hai.
- [ ] [Review][Patch] `deferred-work.md:522` nói metadata có `renewed: true`; `apps/api/src/rooms/audit.ts:22` nói cố ý KHÔNG ghi (đọc qua `reservation_id` lặp) — sửa câu deferred-work theo audit.ts.
- [ ] [Review][Patch] OpenAPI công bố "old enough" là điều kiện đang kiểm, trong khi `room-admission.ts` + PRD US-0.5 AC3 nói vào phòng không có sàn tuổi [packages/contracts/src/openapi.ts:528] — mô tả lại: điều kiện tuổi được xét tại cùng điểm chốt và hôm nay nhận mọi lứa tuổi; Story 3.x thêm luật có tiền ở đó.
- [ ] [Review][Patch] Tham số `roomId` là `type: string` trong khi `room_id`/`Room.id` công bố `format: uuid` [packages/contracts/src/openapi.ts:536] — thêm `format: 'uuid'`, pin ở `contracts.test.ts`; và sửa lý do 404 ở `rooms.ts` (~:368) + `openapi.ts` (~:552): "không công bố định dạng id" là sai vì tài liệu đã công bố; lý do thật là một status cho "không có phòng" bất kể vì sao.
- [ ] [Review][Patch] `seed()` nuốt thiếu `RETURNING` bằng `?? ''`, lỗi lộ ra sau thành `22P02` mù [packages/db/src/room-reservations-migration.test.ts:181,187] — ném Error nêu seed nào không ra dòng, như `room-reservation-contract.pg.test.ts`.
- [ ] [Review][Patch] Dòng Task ghi `issueRoomToken(cookie, params)`, mã nhận thêm `requestId` [spec, Tasks & Acceptance] — sửa dòng task.
- [ ] [Review][Patch] Sweep AC5 chỉ đi `apps/web/src` + `next.config.ts`, bỏ `apps/web/.env*` và `apps/web/public/`; và helper upgrade không có timeout — server nhận TCP mà không trả `upgrade`/`response` thì treo tới 300s [tests/gates/livekit-token.test.ts:377-403, :201-230] — mở rộng walk (tự kiểm trồng file qua đúng hàm sản xuất cho từng root mới) + `request.setTimeout(15_000, …)` huỷ request với Error nêu ca.
- [ ] [Review][Patch] Gate seam web chỉ theo dõi hằng `ROOM_TOKEN_PATH_TEMPLATE`; module web import mỗi `roomTokenPath(id)` lọt `mentionsApi` [apps/web/src/app/seam-usage.test.ts:196] — coi export dạng HÀM tên kết thúc `Path` mà kết quả là đường đã công bố (hoặc khớp template `{param}`) là nhắc API; pin dương `toContain('roomTokenPath')` + ví dụ trồng file. Là file TEST web, không phải màn hình — trong Never.
- [ ] [Review][Patch] `requestIdOf` ba nhánh fallback, không có unit test riêng [apps/api/src/request-id.ts:20] — `request-id.test.ts`: mỗi nhánh một ca + thứ tự ưu tiên.
- [ ] [Review][Patch] Port docblock (:104) và ma trận hứa "không lúc nào > trần dòng hiệu lực", ca 130 chỉ đếm SAU `Promise.all` [packages/db/src/test-kit.ts, runRoomReservationPortContract] — poll `countLive(roomId)` vài ms một lần TRONG lúc burst (PG đọc qua kết nối riêng để chỉ thấy dòng đã commit), mọi mẫu ≤ trần; giữ khẳng định đếm cuối. Mutation: bỏ `FOR UPDATE` → sampler hoặc đếm cuối đỏ (đo trước: 109/130).

- [ ] [Review][Defer] `finally { client.release() }` sau `ROLLBACK` hỏng trả client có thể còn trong transaction về pool [packages/db/src/pg/room-reservation-adapter.ts:153] — y hệt `identity-adapter.ts:312`, `session-adapter.ts:152`: khuôn sẵn ở ba adapter, sửa là một quyết định cho cả ba (`release(error)` khi fault).
- [ ] [Review][Defer] `sub = user.id` là identity LiveKit; LiveKit ngắt kết nối cũ khi cùng identity nối lần hai — đúng ca "gia hạn mỗi lần đổi thiết bị ở pre-join" (2.3) và nối lại (2.4) [apps/api/src/rooms/room-token.ts:72] — chưa docblock/spec nào ghi. Chủ: 2.3/2.4.
- [ ] [Review][Defer] Bù chỗ sau fault hậu-commit (mục patch 1) cần đường giải phóng trên port; 2.4 sở hữu giải phóng khi rời phòng nên bù chỗ đi cùng thay đổi đó. Hôm nay chỗ tự hết hạn sau `ROOM_TOKEN_TTL_SECONDS`.
- (Ba mục defer trên chưa được ghi vào `deferred-work.md` — việc của phiên sau, đúng format có sẵn, status "CHƯA CÓ CHỦ (2026-09-13, review vòng 1 của spec 2.2)".)

Đã KIỂM CHỨNG và loại (`reject`): in-memory import từ `../pg/` (cả năm adapter cùng khuôn) · không bump `CONTRACT_VERSION` (là phiên bản API, 2.1 thêm `/v1/rooms` cũng không bump) · bốn câu envelope chưa vào catalogue i18n (chưa màn hình nào dùng, 2.3 đưa vào) · `ADD COLUMN` thiếu `IF NOT EXISTS` (trùng Defer "pre-existing shape" 2.1 đã có người quyết) · symlink trong walker (repo không có, walker dùng chung) · "`LIVEKIT_KEYS` từ env" trong khối đóng băng (là env của CONTAINER, gate làm đúng thế) · sprint-status `in-progress` trong khi spec `in-review` (bước 5 mới đồng bộ sang `review`).

## Spec Change Log

- 2026-09-13 (implementation, không sửa khối đóng băng): Probe ranh giới 1 ghi "cùng token bỏ `video.room` hoặc `roomJoin:false` → `401`". ĐO trên `livekit/livekit-server:v1.13.5` thật: `roomJoin:false` → `401 permissions denied`, ký sai secret → `401 invalid token`, không có `video` → `401`, nhưng **bỏ `video.room` → `400 "no room name"`**, không phải `401`. `tests/gates/livekit-token.test.ts` ghim đúng mã đo được (`400`, và khẳng định `không phải 101`) thay vì con số trong câu đóng băng; ý nghĩa AD-9 không đổi — token không nêu tên phòng thì không mở phòng nào. Con người cần đổi câu đó thành "→ bị từ chối (`401`, hoặc `400` cho trường hợp thiếu `video.room`)" khi thương lượng lại.
- 2026-09-13: Thứ tự trong transaction của adapter PG là **khoá `FOR UPDATE` trước, rồi mới `DELETE` hết hạn** (Tasks ghi `DELETE` → `SELECT … FOR UPDATE`). Cả hai thứ tự đúng dưới READ COMMITTED; khoá trước làm mọi ghi vào reservations của một phòng xếp hàng sau một khoá duy nhất, không cần lập luận về EvalPlanQual của `DELETE`. Docblock `PgRoomReservationAdapter` nêu lý do.
- 2026-09-13: Thêm `isRoomId` vào `packages/contracts/src/rooms.ts` (không có trong danh sách Tasks) — cùng luật `roomSchema.shape.id`, để `apps/api` trả `404` cùng body cho id sai định dạng mà không có pipe nào trả `400` nêu tên tham số.
- 2026-09-13: Code Map ghi "Web — không chạm" và dự đoán `seam-usage.test.ts` tự thêm hằng route mới. Đúng một nửa: hằng được thêm tự động, nhưng ca `knows a route constant from a cookie constant` còn khẳng định mọi tên trong tập kết thúc bằng `_PATH`, mà tên spec chốt là `ROOM_TOKEN_PATH_TEMPLATE`. Giữ tên theo spec; nới đúng một khẳng định trong test web sang `/_PATH(?:_TEMPLATE)?$/` kèm lý do (đường có `{param}` vẫn là đường đã công bố). Không module web nào nhắc tới hằng này.
- 2026-09-13 (QUYẾT ĐỊNH CON NGƯỜI, sửa khối đóng băng theo uỷ quyền tại checkpoint sau bước 3): câu trong `## Probe ranh giới` đổi từ "→ `401`" thành "→ bị từ chối (`401`; `400` khi thiếu `video.room`)" cho khớp mã LiveKit thật trả. Không đổi ranh giới, không đổi probe, không đổi mutation "Sẽ đỏ khi" — mutation đó đã chạy thật ở bước 3: đổi secret container → 3 ca đỏ (`101`, `400-không-phải-101`, `mở đúng phòng token nêu`), 10 ca từ chối vẫn xanh; khôi phục → 13/13.
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
