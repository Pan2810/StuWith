---
title: 'Story 2.1 — Tạo phòng học với chủ đề và quyền'
type: 'feature'
created: '2026-09-07'
status: 'review'
baseline_commit: '309a2c9f994dbc8256b27f0501b5edf073ae2b00'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bảng `rooms` chưa tồn tại, nhưng ba dòng `COMMENT ON ROLE` từ Story 1.1 đã tuyên `apps/api` là chủ ghi của nó — nửa "lời văn" của AD-8 chạy trước nửa "cưỡng chế" suốt bảy story. Bảy story còn lại của Epic 2 không có gì để cấp token vào, giữ chỗ, hay đếm trần. Trần người "theo gói" cũng chưa có nguồn: không dòng mã nào biết gói của một người.

**Approach:** Một migration dựng `rooms` với trạng thái tường minh gồm `closing`, cộng cột `users.plan`; GRANT ghi chỉ cho `stuwith_api`, chứng minh bằng một câu lệnh bị Postgres từ chối. Một `POST /v1/rooms` và một màn hình tạo phòng, đi đúng các seam đã có: `authorizedFetch`, `useT()`, hàm parse thuần trong contracts.

## Boundaries & Constraints

**Always:**
- Trần **ghi cùng phòng lúc tạo**, lấy từ gói người tạo, không tính lại khi có người vào.
- `stuwith_realtime` chỉ `SELECT` trên `rooms`. Bằng chứng là một `INSERT` thật bị từ chối `42501` trên PG18, không phải assert trên văn bản migration.
- Không `DELETE`, không `DROP`, không endpoint xoá. `owner_user_id` dùng `ON DELETE RESTRICT`.
- Sáu chủ đề đã chốt, mã sở hữu: `ngoai_ngu` · `khoa_hoc_tu_nhien` · `khoa_hoc_xa_hoi` · `lap_trinh_cong_nghe` · `on_thi` · `khac`.
- Mọi chuỗi qua catalogue i18n (VI + EN cùng lúc); mọi màu qua token.
- Từ vựng `/v1` khai ở `packages/contracts`, kể cả `openapi.ts` viết tay.

**Ask First:** thêm dependency · thêm giá trị vào `AUDIT_ACTIONS` hoặc `RATE_LIMIT_ACTIONS`.

**Never:**
- Không vector/embedding (Epic 4) · không giao thức đóng phòng (Story 4.8) · không cấp token, giữ chỗ, đếm người (Story 2.2) · không danh sách/tìm/sửa phòng · không thanh toán hay nâng-hạ gói (Epic 5).
- Không audit và không rate limit cho việc tạo phòng — ngoài AC; ghi vào `deferred-work.md` kèm bằng chứng, không kèm lời hứa trong docblock.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| Hợp lệ | Đã đăng nhập, `plan='study_buddy'`, body đủ 4 trường | `201`, `status='open'`, `max_participants=6`, `owner_user_id` = người gọi | N/A |
| Study Circle | `plan='study_circle'` | `max_participants=25` | N/A |
| Campus | `plan='campus'` | `max_participants=45` (**không** 100 — 100 là trần kỹ thuật, không phải mặc định) | N/A |
| Chưa đăng nhập | Không cookie phiên | `401` `unauthenticated` | Không chạm DB |
| Tên rỗng | `name='  '` | `400` `validation_failed` | Parse thuần trả `null`, chặn trước DB |
| Quá dài | `name`>120, `description`>2000 | `400` `validation_failed` | Cùng đường |
| Chủ đề lạ | `topic='xyz'` | `400` `validation_failed` | Cùng đường |
| Quyền lạ | `visibility='secret'` | `400` `validation_failed` | Cùng đường |
| Body không phải object | `null`, mảng, chuỗi | `400` `validation_failed` | Không ném, không 500 |
| Client tự đặt trần | `max_participants` trong body | Bỏ qua; trần vẫn từ gói | Không báo lỗi — trường không có trong hợp đồng |
| Realtime cố ghi | `INSERT INTO rooms` dưới role realtime | Postgres từ chối `42501` | Không đường vòng |

## Probe ranh giới

**Ranh giới 1 — hai origin (trình duyệt ↔ `apps/api`, CORS kèm cookie).** Form POST cross-origin, phiên trong cookie `HttpOnly`. `fetch` của Node bỏ qua CORS hoàn toàn, nên flow test của API không chạy qua đoạn nào của seam này — đúng hình dạng đã để `retry-after` chết cross-origin suốt Epic 1.

- **Probe:** spec Playwright mở `/tao-phong` với phiên có sẵn, điền form thật, bấm nút, khẳng định **ba mức**: (1) một POST tới `ROOMS_PATH` rời trình duyệt; (2) `201` và màn hình vẽ lại với tên phòng vừa tạo; (3) `page.evaluate` đọc lại được phòng qua `fetch` cross-origin kèm `credentials: 'include'` — cookie thật sự đi qua origin.
- **Sẽ đỏ khi:** ở **phía server**, bỏ `credentials: true` khỏi CORS (`apps/api/src/http-setup.ts:131`). Trình duyệt không gửi cookie, endpoint trả `401`, probe đỏ — trong lúc mọi flow test API vẫn xanh. Chạy thật rồi khôi phục.

**Ranh giới 2 — chủ ghi ở tầng DB (`apps/api` ↔ `apps/realtime-gateway` qua GRANT).** Hai process chia quyền bằng role Postgres; test chạy dưới role migration không bao giờ chạm luật đó.

- **Probe:** mở kết nối bằng `connectionStringFor('stuwith_realtime', …)` trên container PG18 thật, `INSERT` và `UPDATE` vào `rooms`, kỳ vọng cả hai `rejects` với `code: '42501'`.
- **Sẽ đỏ khi:** thêm `GRANT INSERT ON TABLE rooms TO stuwith_realtime` vào migration. Chạy thật rồi khôi phục.

</frozen-after-approval>

## Code Map

Bản đồ điều tra, neo tự đo trên `309a2c9`. Đừng tìm lại.

**Migration** — khuôn `1788480100000_user-date-of-birth.js`: `/* eslint-disable */` :1, chỉ `pgm.sql()` thô, **không `exports.down`**. Tên `<epoch_ms>_<kebab>.js` → `1788480200000_rooms-and-plans.js`. CHECK dựng từ mảng `const` + `sqlList` (`…users-and-identities.js:87`), GRANT/REVOKE tường minh :188-196.
⚠️ `rooms` **không thừa hưởng luật quét nào**: `migration-sql.test.ts:16` chỉ nhắm `process-roles.js`; luật cấm `DELETE` (`identity-schema.test.ts:150`, `:304`) chỉ chạy trên nhóm file Story 1.2/1.4.

**Giữ CHECK khớp contracts** — `identity-schema.test.ts:31` `statements()` chạy `migration.up(fakePgm)` để đọc SQL thật; `:47` `checkValues()` bóc literal trong `… IN (…)`; so với enum contracts (:68-93).

**Probe GRANT** — `__testing__/postgres.ts`: Testcontainers pg18 :61, `connectionStringFor(role,pw)` :76, `TEST_ROLE_PASSWORDS` :20, `withClient` :139. Tiền lệ `42501`: `migrations.test.ts:227-236`.
⚠️ **Gate 4 lọc tên file** — `vitest run --project db migration` (`package.json:24`); tên suite phải chứa `migration`.

**Port/adapter** — interface `domain/src/ports/*.ts` (`identity-port.ts:100`, `User` :34); adapter pg nhận `Pool` qua constructor (`pg/identity-adapter.ts:115`); bản in-memory dùng lại hàm assert của bản pg (`in-memory/identity-adapter.ts:9`). Runner chung `test-kit.ts:685`, chạy hai lượt. Project `db` include `src/**/*.test.ts`.

**API** — `/v1` viết thẳng trong `@Controller('v1/auth')`, **không** `setGlobalPrefix`, **không** `@UseGuards`, **không** `ValidationPipe`. `request.body` xuống dạng `unknown` (`auth.controller.ts:186`) → hàm parse thuần của contracts (`auth.service.ts:742`) → lỗi bằng `makeError`, **không ném** (:190-196). Người gọi: `SessionAuthenticator.authenticate(cookieHeader)` (`session-authenticator.ts:76`, dùng ở `auth.service.ts:722`), `@Global()`. Module theo khuôn `auth.module.ts:25` + `app.module.ts:77`; adapter gom vào object runtime (`auth.runtime.ts:30`).

**Contracts** — zod + `as const` (`auth.ts:16`,:35,:84); path là hằng chuỗi (:258); `ERROR_CODES` `error.ts:27`, `makeError` :122. **OpenAPI viết tay**: `REGISTERED_SCHEMAS` (`openapi.ts:37`) + paths (:220-317).

**Hai gate web đã chờ sẵn** — `routes.test.ts`: (A) `*_PATHNAME` khớp thư mục thật; (B) hằng phải được module sản phẩm **ngoài thư mục route của nó** gọi tên; (C) symbol export phải được mã sản phẩm dùng thật, không phải chỉ được test render. `seam-usage.test.ts:59-84`: module nhắc `/v1` hay `*_PATH` phải qua `authorizedFetch`; :64 đã có sẵn tên `ROOMS_PATH`, :77 tự phủ route mới khi nó vào OpenAPI.

**Web** — khuôn form duy nhất `khai-ngay-sinh/`: `page.tsx` giữ hook/effect/`fetch` (:139); `date-of-birth-form.tsx` giữ hàm thuần + JSX không state (:22), câu lỗi theo status `declarationOutcomeFor` :285, pre-flight trả `{kind:'invalid'}` và không gửi :172. `credentials:'include'` nằm trong seam `authorizedFetch` (`session-expiry.ts:350`), không ở call site; `apiBaseUrl` qua `useApiBaseUrl()`. Khoá i18n: `messages.ts:56-157` + `messages.en.ts:37`; thiếu EN là lỗi `tsc` (`messages.ts:173`).
⚠️ **CSS chưa có** `textarea`, `select`, radio/checkbox, `fieldset`/`legend`, lưới form. Có: `.field` :472 (+`[aria-invalid]` :491), `.form-label` :443, `.button-primary` :305, `.button-secondary` :311, `.notice`/`.notice-alert` :405/:414, `.card` :244; mẫu nhóm `.theme-switch button[aria-pressed]` :580. Màu literal bị `design-tokens.test.ts` chặn.

**Unit test web `environment:'node'`, không DOM** (`vitest.config.mts:139`) — component phải **không** `'use client'`, không state, không effect; `renderToStaticMarkup` (`date-of-birth-form.test.tsx:81`), gọi thẳng hàm thuần, đa ngôn ngữ bằng `<I18nProvider locale>` + lặp `LOCALES` (:393).

**E2E** — `fake-api.cjs` validate body bằng schema **thật** từ contracts (:31); route mới là một khối `if (url.pathname === …)` sau `scenarioOf(req)` :215, trước 404 :283. `scenario(page,state)` đặt cookie phiên sẵn (`scenario.ts:36`). Header đọc qua `page.evaluate` (`khai-ngay-sinh.spec.ts:126`).

**Chưa có gì về phòng.** `RATE_LIMIT_ACTIONS` (`domain/src/policies/rate-limit.ts:43`) chỉ 5 action `auth_*`; `AUDIT_ACTIONS` (`contracts/src/audit.ts:12`) có `room_token.issued`, không có action tạo phòng.

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/rooms.ts` — `USER_PLANS`, `PLAN_PARTICIPANT_LIMITS` (6/25/45), `ROOM_TOPICS` (sáu giá trị đã chốt), `ROOM_VISIBILITIES`, `ROOM_STATUSES` (`open`/`closing`/`closed`), `ROOMS_PATH`, `CREATE_ROOM_PATHNAME='/tao-phong'`, `roomSchema`, `parseCreateRoomRequest(body)` trả `null` khi hỏng. Trần **không** nhận từ body.
- [x] `packages/contracts/src/{index.ts,openapi.ts}` — export + `REGISTERED_SCHEMAS` + `POST /v1/rooms`.
- [x] `packages/db/migrations/1788480200000_rooms-and-plans.js` — `users.plan` (`NOT NULL DEFAULT 'study_buddy'` + CHECK); `rooms` (`id uuidv7`, `owner_user_id` **ON DELETE RESTRICT**, `name`, `description`, `topic`, `visibility`, `max_participants`, `status DEFAULT 'open'`, `created_at`, `updated_at`) + CHECK từng enum + chặn tên rỗng + giới hạn độ dài; `GRANT INSERT, UPDATE … TO stuwith_api`; `REVOKE INSERT, UPDATE, DELETE, TRUNCATE … FROM stuwith_realtime`; `COMMENT ON TABLE`; cập nhật hai `COMMENT ON ROLE`.
- [x] `packages/domain/src/ports/room-port.ts` + `index.ts` — `RoomPort.createRoom` / `findRoomById`, kiểu `Room`; thêm `plan` vào `User`.
- [x] `packages/db/src/{pg,in-memory}/room-adapter.ts` + `index.ts` — cặp adapter dùng chung hàm assert; `plan` vào hai adapter identity.
- [x] `packages/db/src/test-kit.ts` + `room-contract{,.pg}.test.ts` — `runRoomPortContract`, hai lượt.
- [x] `packages/db/src/rooms-migration.test.ts` — **probe ranh giới 2** (`42501`); bảng tồn tại; posture mặc định; CHECK khớp enum contracts qua `checkValues()`.
- [x] `apps/api/src/rooms/{rooms.module,rooms.runtime,rooms.service,rooms.controller}.ts` + `app.module.ts` — `@Controller('v1/rooms')`, `@Post()`, `@Res()`; trần từ `PLAN_PARTICIPANT_LIMITS[user.plan]`.
- [x] `apps/api/src/rooms/rooms.flow.test.ts` — mọi dòng I/O Matrix ở tầng HTTP.
- [x] `apps/web/src/app/tao-phong/{page.tsx,create-room-form.tsx,create-room-form.test.tsx}` — page giữ state/`fetch`; form giữ hàm thuần + JSX không state; gửi qua `authorizedFetch`.
- [x] `apps/web/src/app/page.tsx` — một đường đi tới `/tao-phong`; luật B/C của `routes.test.ts` đỏ nếu thiếu.
- [x] `apps/web/src/app/i18n/{messages.ts,messages.en.ts}` — nhóm `createRoom.*` gồm nhãn sáu chủ đề, VI + EN.
- [x] `apps/web/src/app/globals.css` — class cho `textarea`, `fieldset`/`legend`, nhóm radio; chỉ token.
- [x] `tests/gates/no-hard-delete-rooms.test.ts` — cấm `DELETE FROM rooms`/`DROP TABLE rooms`/`TRUNCATE` trong migration và route `@Delete` chạm phòng. Self-check phải gọi **chính hàm sản xuất** của gate (bài học Story 2.0).
- [x] `tests/e2e/support/fake-api.cjs` + `tests/e2e/web/tao-phong.spec.ts` — **probe ranh giới 1**.
- [x] `deferred-work.md` — hai mục kèm bằng chứng: chưa audit, chưa rate limit việc tạo phòng.

**Acceptance Criteria:**
- Given một người gói Campus, when tạo phòng, then lưu `max_participants=45`, và giá trị đó không đổi khi có người vào sau này.
- Given migration mới, when chạy dưới role `stuwith_realtime` trên PG18 thật, then `INSERT` và `UPDATE` vào `rooms` đều bị từ chối `42501`.
- Given một người bị xoá khỏi `users` trong lúc còn phòng, when Postgres xử lý, then thao tác bị chặn — không phòng nào biến mất theo.
- Given mã hiện tại, when chạy gate AC5, then xanh; khi thêm một đường xoá cứng phòng, then đỏ.
- Given màn hình tạo phòng ở cả hai locale, when đo ở 320px, then không nhãn nào bị cắt chữ và mọi ô nhập có nhãn liên kết.

## Design Notes

**`ON DELETE RESTRICT` chứ không `CASCADE`.** `user_identities` và `sessions` dùng `CASCADE` và đúng cho chúng. Với `rooms`, `CASCADE` **chính là** một đường xoá cứng phòng, chỉ nằm trong schema thay vì trong controller — AC5 cấm "endpoint **hay đường code nào**".

**`on_thi` chồng lấn bốn chủ đề kia** — nó là mục đích, không phải môn. Giữ có chủ đích: người tìm phòng sẽ tìm bằng chính từ đó. `khac` là lối thoát để không ai bị chặn không tạo được phòng.

## Verification

- `corepack pnpm run build:packages` — bắt buộc TRƯỚC mọi mutation test.
- `corepack pnpm run typecheck` — xanh; ĐỎ khi xoá một khoá khỏi `EN_MESSAGES`.
- `corepack pnpm run test:unit` · `test:contract` (Gate 3) · `dep-check` — xanh.
- `corepack pnpm run test:migrations` — xanh; mutation `GRANT INSERT … TO stuwith_realtime` → probe đỏ → khôi phục.
- `corepack pnpm run test:gates` — xanh; mutation từng vế của gate AC5 trước khi tin.
- `corepack pnpm exec playwright test` — 62 ca cũ + probe mới; mutation bỏ `credentials: true` (`http-setup.ts:131`) → probe đỏ → khôi phục.
