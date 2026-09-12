---
title: 'Story 2.1 — Tạo phòng học với chủ đề và quyền'
type: 'feature'
created: '2026-09-07'
status: 'done'
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
- [x] `tests/gates/cors-policy.test.ts` — **thêm ở vòng sửa 1** (hướng c). Gate văn bản giữ hai đầu CORS cùng trải từ `packages/contracts/src/http.ts`.
- [x] `tests/gates/plan-capacity-exhaustive.test.ts` — **thêm ở vòng sửa 1**. Mọi gói đều có trần, và trần nằm trong khoảng schema chấp nhận.
- [x] `apps/api/src/rooms/rooms.module.test.ts` — **thêm ở vòng sửa 2**. Nhánh fail-closed của `forRuntime`, 13 ca.

*(Ba dòng trên không có trong bản đóng sổ đầu tiên: chúng ra đời trong các vòng sửa,
và danh sách "16 deliverable" đã không còn mô tả đúng thay đổi cho tới vòng 2.)*

**Acceptance Criteria:**
- Given một người gói Campus, when tạo phòng, then lưu `max_participants=45`, và giá trị đó không đổi khi có người vào sau này.
- Given migration mới, when chạy dưới role `stuwith_realtime` trên PG18 thật, then `INSERT` và `UPDATE` vào `rooms` đều bị từ chối `42501`.
- Given một người bị xoá khỏi `users` trong lúc còn phòng, when Postgres xử lý, then thao tác bị chặn — không phòng nào biến mất theo.
- Given mã hiện tại, when chạy gate AC5, then xanh; khi thêm một đường xoá cứng phòng, then đỏ.
- Given màn hình tạo phòng ở cả hai locale, when đo ở 320px, then không nhãn nào bị cắt chữ và mọi ô nhập có nhãn liên kết.

### Review Findings

Vòng review 1 (2026-09-12), `bmad-code-review`, phạm vi `309a2c9..a9d2d6d`. Bốn
lớp review chạy song song; không lớp nào lỗi. Kiểm chứng độc lập đã chạy thật:
`typecheck` xanh · `test:unit` 1934/1934 · `test:gates` 495/495 · `dep-check` sạch ·
`test:migrations` 65/65 trên PG18 thật · Playwright 71/71 (gồm 9 ca `tao-phong`).
Mutation cả hai probe cũng đã chạy thật — kết quả ghi ở mục Decision đầu tiên.

**Vòng sửa 1 (2026-09-12).** Con người chốt ba việc: hướng (c) cho probe CORS, `description`
thành TUỲ CHỌN, và phạm vi áp patch dừng ở bốn mục trung bình rẻ. Sáu mục đã đóng ở dưới.
Còn MỞ có chủ ý, không phải bỏ quên: gate AC5 hở bốn cách viết, nhánh `throw` của
`RoomsModule.forRuntime` không ca nào chạy, và sáu patch mức thấp.

Đo lại sau khi sửa, cùng bộ lệnh như vòng review: `typecheck` xanh · `test:unit` 1958/1958
(trước 1934) · `test:gates` 504/504 trong 15 file (trước 495/14 — file mới là
`cors-policy.test.ts`) · `test:contract` 392/392 · `dep-check` 207 module 0 vi phạm ·
`test:migrations` 65/65 trên PG18 thật · Playwright 71/71. Chín mutation đã CHẠY THẬT và
mỗi cái đỏ đúng test đã khai trước khi chạy; chi tiết nằm trong từng mục.

**Vòng sửa 2 (2026-09-12).** Chín mục `[Review][Patch]` còn mở đã đóng hết — không mục nào
được hạ thành Defer, và không mục nào cần quyết định của con người. Hai chỗ đi XA hơn chữ
của finding, cả hai vì bản vá theo chữ sẽ mục lại đúng cách nó vừa mục:

- con số trong docblock i18n nay có `tests/gates/i18n-catalogue.test.ts` **luật 5** đọc ra
  khỏi câu văn rồi đếm lại trên catalogue, thay vì được sửa thành một con số mới cũng không
  ai canh;
- lỗ `fake-api.cjs` đóng ở LỚP (bọc `catch` quanh cả dispatch) chứ không chỉ ở gói lạ, và
  thêm một lớp chặn ngay cửa vào để câu lỗi rơi đúng chỗ người viết spec gây ra nó.

Thêm hai việc phát sinh, cả hai do chính bản vá vòng 1 tạo ra và được ghi ở đây chứ không
im lặng: docblock đầu `tests/e2e/web/tao-phong.spec.ts` vẫn viết "hai cấu hình CORS chỉ khớp
nhau bằng cách ĐỌC", sai kể từ khi hướng (c) dựng `cors-policy.test.ts` — đã viết lại; và
mục CORS trong `deferred-work.md` đã đánh dấu ĐÃ ĐÓNG, giữ lại phần ĐO vì đó là bằng chứng
của lỗ chứ không phải lời hứa.

**Vòng review 2 (2026-09-12), ba lớp chạy song song trên `309a2c9..HEAD`, 47 file.**
Không lớp nào lỗi. Không finding nào là `intent_gap` hay `bad_spec` — nghĩa là không
loopback. Ba thứ đổi kết luận, cả ba đã đóng:

1. **Bằng chứng CORS của vòng 1 ghi sai địa chỉ, ở năm chỗ.** `apps/api/src/http-setup.test.ts`
   (151 dòng) kiểm `fastifyAdapterOptions`/`trustProxy` và không chứa chữ `cors` nào; hai
   ca thật sự đỏ nằm trong `apps/api/src/auth/auth.flow.test.ts`. Đo thật, ghi sai địa
   chỉ — tệ hơn không trích dẫn, vì người kiểm tiền đề của gate sẽ mở ra một file rỗng
   và kết luận gate không dựa trên gì. Đã sửa ở `http-setup.ts`, `cors-policy.test.ts`,
   `packages/contracts/src/http.ts`, mục Decision trên kia, và `deferred-work.md`.
2. **`cors-policy.test.ts` phá được bằng một token.** Nó so khớp chuỗi con, nên
   `methods: [...CORS_ALLOWED_METHODS].filter((m) => m !== 'POST')` vẫn qua. ĐÃ ĐO:
   với mutation đó gate vẫn 9/9 xanh, `test:unit`, `test:contract` và Playwright cũng
   xanh, trong khi API triển khai thôi quảng cáo `POST` cross-origin và mọi lần tạo
   phòng từ trình duyệt chết ở preflight. Đóng bằng một EXECUTION, không phải thêm regex:
   ca mới `advertises exactly the methods and request headers the contract declares`
   trong `auth.flow.test.ts` đọc hai header đó trên một preflight thật, so như TẬP HỢP
   token (thứ tự và khoảng trắng là việc của framework). Gate văn bản ở lại làm lớp rẻ.
3. **Mọi nhánh thất bại của submit không test nào chạy.** `fake-api.cjs` chỉ trả được
   201/400/401 cho `POST /v1/rooms`, nên năm trong sáu outcome của `createRoomOutcomeFor`
   chỉ được ghim bởi `renderToStaticMarkup` — thứ không bấm được nút. ĐÃ ĐO: xoá
   `setNotice(outcome.notice)` khỏi `page.tsx` để lại toàn bộ màu xanh. Thêm
   `roomsStatus` + `roomsRetryAfterSeconds` vào `scenario.ts` và `fake-api.cjs`, cùng ba
   ca Playwright: một câu từ chối hiện lên màn hình, một đồng hồ 429 THẬT SỰ CHẠY (hai
   lần đọc, số sau nhỏ hơn số trước), và ca ghim phân biệt hai callback.

Điểm đáng ghi nhất của mục 3: phân biệt `onSubmitWaitFinished` với `onWaitFinished` mà
vòng sửa 2 dựng lên vốn được GHI CHÉP chứ không được BẢO VỆ — đổi một token cho ra markup
giống hệt và cả bộ vẫn xanh. Nay ca e2e đỏ trên đúng mutation đó. Hai mutation khác trên
cùng bản vá thậm chí không biên dịch được (`waiting` hoặc `onSubmitWaitFinished` thành
biến không dùng), tức `tsc` là lớp chặn đứng trước cả test.

Bốn finding đã KIỂM CHỨNG LÀ SAI và loại bỏ: "`catalogueEntries` bỏ sót entry vắt nhiều
dòng" (`\s` của JS khớp cả `\n`; 80/80 khớp đúng bằng `catalogueKeys` của luật 2);
"`deferred-work.md` thiếu khoá `status:` bắt buộc" (header của chính file ghi `status` là
TUỲ CHỌN); và năm mục trùng với quyết định Defer đã có người chốt ở vòng 1.

Sáu mục mới vào `deferred-work.md`, mỗi mục kèm bằng chứng: `tsconfig` loại test file là
nguyên nhân gốc phạm vi toàn repo · gate CASCADE chưa có cơ chế miễn trừ (đã xảy ra thật
trong lúc làm vòng 2) · `updated_at` không ai duy trì · tên phòng toàn ký tự zero-width ·
403/404/409 và 503-kèm-`Retry-After` rơi vào nhánh mặc định · `stripComments` xoá mọi dòng
mở đầu `#`.

Đo lại lần ba, cùng bộ lệnh: `typecheck` xanh · `test:unit` **1976/1976** (1972 → 1976) ·
`test:gates` **533/533** (528) · `test:contract` 392/392 · `dep-check` 208 module 0 vi
phạm · `test:migrations` 65/65 trên PG18 thật · Playwright **74/74** (71). Ba mutation mới
CHẠY THẬT, mỗi cái đỏ đúng ca đã khai trước: `.filter` trên `methods` → 1 (gate vẫn xanh,
đó là điểm) · đổi callback → 1 · `disabled={submitting || (waiting && false)}` → 1.

Đo lại lần hai, cùng bộ lệnh: `typecheck` xanh · `test:unit` **1972/1972** (trước 1958) ·
`test:gates` **528/528** trong 15 file (trước 504) · `test:contract` 392/392 ·
`dep-check` **208 module, 534 quan hệ, 0 vi phạm** (trước 207) · `test:migrations` 65/65
trên PG18 thật · Playwright **71/71** (gồm ca 320px nay khẳng định cả hai locale, và đo lại
`.choice` sau khi rộng thêm 1px). **Mười mutation đã CHẠY THẬT**, mỗi cái đỏ đúng test đã
khai trước khi chạy: guard `RoomsModule`→8 · TRUNCATE danh sách→2 · GRANT schema-wide→2 ·
`pgm.dropTable`→2 · discovery migration→2 · `onDelete: 'CASCADE'`→3 · nút gửi→1 · đồng hồ
tĩnh→1 · số đếm i18n→2 · tiêu đề EN ở 320px→1.

- [x] [Review][Decision] Mutation khai trong Probe ranh giới 1 KHÔNG làm probe đỏ — AGENTS.md §4 đòi "the named mutation on the far side must actually turn it RED". Spec khai: bỏ `credentials: true` khỏi `apps/api/src/http-setup.ts:131` thì probe đỏ. Nhưng bộ e2e nói chuyện với `tests/e2e/support/fake-api.cjs`, không phải `apps/api` (`tests/e2e/web/tao-phong.spec.ts:37`), nên mutation đó chỉ làm đỏ 2 ca trong `apps/api/src/auth/auth.flow.test.ts` (`allows the configured web origin, with credentials` và `answers the preflight a credentialed POST triggers`) — assert trên header của một response thật, nhưng qua `fetch` của Node chứ không phải trình duyệt. [SỬA Ở VÒNG 2: câu này vốn ghi `http-setup.test.ts`, sai — file đó kiểm `fastifyAdapterOptions`/`trustProxy` và không chứa chữ `cors` nào.] Chính `deferred-work.md` đã ghi nhận trung thực điều này. Đây đúng hình dạng thất bại mà §4 nêu đích danh (`Retry-After`: "the E2E fake API mirrored the omission"). Vì `## Probe ranh giới` nằm trong `<frozen-after-approval>`, §4 xếp nó là `intent_gap` chứ không phải patch — cần con người chọn hướng: (a) chấp nhận nguyên trạng dựa trên mục `deferred-work.md` đã có; (b) trỏ probe vào `apps/api` thật; (c) một hằng CORS dùng chung cho cả hai phía + gate so sánh chúng (đúng khuôn `BROWSER_READABLE_RESPONSE_HEADERS` đã đóng lỗ `Retry-After`); (d) sửa lại câu mutation trong spec đã đóng băng. — mức: cao — **ĐÃ ĐÓNG 2026-09-12, hướng (c)**: `CORS_ALLOW_CREDENTIALS`, `CORS_ALLOWED_METHODS`, `CORS_ALLOWED_REQUEST_HEADERS` vào `packages/contracts/src/http.ts`; `http-setup.ts` và `fake-api.cjs` cùng trải từ đó; gate mới `tests/gates/cors-policy.test.ts` đọc cả hai file. Mutation đã CHẠY THẬT và đỏ: xoá `credentials` khỏi `http-setup.ts` → đỏ `the API takes its credentials answer from the contract`; trả `'true'` vào fake → đỏ `the E2E fake API answers credentials from the same constant`; trả literal methods vào fake → đỏ `both ends take the allowed methods`; thêm `DELETE` vào hằng → đỏ `never advertises a method for deleting anything`. LƯU Ý câu chữ trong `<frozen-after-approval>` nay đọc lệch một bậc: dòng bị mutation không còn là `credentials: true` mà là `credentials: CORS_ALLOW_CREDENTIALS`, và thứ đỏ lên là gate chứ không phải probe trình duyệt. Không sửa khối đóng băng; ghi ở đây.
- [x] [Review][Decision] `description` là trường BẮT BUỘC trên wire nhưng màn hình gọi nó là tuỳ chọn, và không test nào ghim chiều nào — `packages/contracts/src/rooms.ts:220` khai `z.string().max(...)` không `.optional()`, nên thiếu khoá là `400`; trong khi `createRoom.descriptionLabel` là 'Mô tả (không bắt buộc)' / 'Description (optional)' và cột là `NOT NULL DEFAULT ''`. Câu từ chối (`rooms.ts:303`) chỉ nêu "tên, chủ đề và quyền xem". Đổi sang `.optional().default('')` hay ngược lại đều để mọi test xanh — không fixture nào bỏ khoá này. AD-13 nói nới lỏng là tương thích, siết lại là breaking, nên hướng đi là quyết định hợp đồng cần con người. — mức: trung bình — **ĐÃ ĐÓNG 2026-09-12: TUỲ CHỌN, sửa hợp đồng theo UI.** `createRoomRequestSchema.description` thành `.optional()` — KHÔNG `.default('')`, vì `toOpenApiComponents` phát với `io: 'output'` và một trường có default vẫn nằm trong `required` của tài liệu, tức là vẫn nói với integrator đúng điều vừa rút lại. Cột giữ `NOT NULL DEFAULT ''`, `roomSchema` giữ `description` bắt buộc, và `?? ''` nằm ở hai chỗ ghi row (`rooms.service.ts`, `fake-api.cjs`). Năm ca mới trong `contracts.test.ts` ghim cả hai chiều, gồm `null` tường minh VẪN bị từ chối.

- [x] [Review][Patch] `POST /v1/rooms` và hai component của nó được publish nhưng không test nào ghim [packages/contracts/src/contracts.test.ts:165] — **ĐÃ SỬA 2026-09-12**: `CreateRoomRequest` + `Room` vào danh sách `publishes %s`, thêm describe `the create-room endpoint` với 5 ca — chỉ có `post`, không bao giờ có `delete`, hai `$ref`, `description` ngoài `required`, và trần nằm ở response chứ không ở request. Mutation: bỏ `Room: roomSchema` → đỏ 2 ca.
- [x] [Review][Patch] Adapter kiểm độ dài tên đã trim nhưng lưu chuỗi thô [packages/db/src/pg/room-adapter.ts:114] — **ĐÃ SỬA 2026-09-12**: thêm `normalizedCreateRoomInput` dùng chung, CẢ HAI adapter lưu bản đã trim; độ dài `description` cũng chuyển sang đo sau trim cho khớp `parseCreateRoomRequest`. Ba ca mới nằm trong `runRoomPortContract` (suite dùng chung) chứ không ở phía PG, vì nửa lớn hơn của lỗi là hai store bất đồng. Mutation từng adapter một → đỏ đúng 3 ca mỗi lần.
- [x] [Review][Patch] `.gitignore` không phủ file probe gate AC5 tự trồng vào `apps/api/src` [.gitignore:44] — **ĐÃ SỬA 2026-09-12**: thêm `**/rooms-gate-probe.generated.ts`. `git check-ignore -v` xác nhận `.gitignore:57` bắt file đó.
- [x] [Review][Patch] Nhánh ném của `RoomsModule.forRuntime` không test nào chạy, và vế `port === null` là thừa [apps/api/src/rooms/rooms.module.ts:48] — **ĐÃ SỬA 2026-09-12**: bỏ vế `port === null` — optional chain đã trả `undefined` cho `null`, nên vế đó không quyết được gì và một disjunct chết trong một kiểm tra fail-closed đọc như một trường hợp ai đó đã nghĩ tới. File mới `apps/api/src/rooms/rooms.module.test.ts`, 11 ca: bảy hình dạng runtime bị từ chối (gồm chính `rooms: null`), câu lỗi có nêu tên `rooms`, và ba ca đối trọng ở chiều dương — trả đúng `module`, truyền NGUYÊN runtime vào `ROOMS_RUNTIME` chứ không dựng bản sao hẹp, và có `RoomsService`. Mutation `if (false)` đã CHẠY THẬT → đỏ 8/11.
- [x] [Review][Patch] `aria-invalid="true"` gắn lên ô tên phòng cho cả lỗi không liên quan tới nó [apps/web/src/app/tao-phong/create-room-form.tsx:493] — **ĐÃ SỬA 2026-09-12**: thêm `createRoomNameInvalid`, chỉ true cho `CREATE_ROOM_INVALID_KEY`. `aria-describedby` CỐ Ý không đổi — vùng lỗi vẫn được mô tả cho mọi thông báo. 8 ca mới; mutation trả về `current === null ? undefined : true` → đỏ 4 ca.
- [x] [Review][Patch] Gate AC5 hở bốn cách viết: `TRUNCATE TABLE users, rooms`, `GRANT DELETE ON ALL TABLES IN SCHEMA`, `pgm.dropTable(...)` / `onDelete: 'CASCADE'`, và `ALTER TABLE public.rooms` có schema [tests/gates/no-hard-delete-rooms.test.ts:77] — **ĐÃ SỬA 2026-09-12, cả bốn.** (1) `ANY_TABLE_OPERAND` cho TRUNCATE nhận danh sách bảng — lặp OPERAND chứ không `[^;]*`, để span không tràn khỏi danh sách. (2) Luật mới cho `GRANT … DELETE|TRUNCATE … ON ALL TABLES IN SCHEMA`, phạm vi toàn repo chứ không `roomsOnly`: nó phủ `rooms` bất kể file có nhắc tên hay không, nên gắn scope vào là một cửa hậu một-chữ. (3) Luật mới cho `pgm.dropTable(...)` — DDL viết bằng lời gọi hàm, không chứa chữ DROP nào cho một text scan tìm. (4) `TOUCHES_ROOMS_TABLE` dùng `ROOMS_OPERAND` cho ALTER và thêm nhánh builder, còn `CASCADE_SPELLINGS` nhận cả `onDelete: 'CASCADE'`. Mười một ví dụ tự kiểm mới (sáu phải đỏ, năm phải để yên) đều chạy qua `roomDeletionOffences`; hai ca cuối trồng file thật nhưng vào thư mục TẠM, không vào `packages/db/migrations` — một `.js` sót lại ở đó là một migration `pnpm test:migrations` sẽ chạy. Năm mutation CHẠY THẬT, mỗi cái đỏ đúng phần đã khai: TRUNCATE→2, GRANT-ALL→2, dropTable→2, discovery→2, CASCADE→3. **Một lỗi tự gây, đã bắt và sửa trong lúc làm**: nhánh builder viết `pgm.<bất kỳ>` lúc đầu khớp cả `pgm.sql(...)`, kéo migration roles — có `COMMENT ON ROLE` nhắc chữ `rooms` trong văn xuôi — vào diện xét, và file đó chứa `ON DELETE CASCADE` hợp lệ cho `user_identities`, nên gate đỏ trên một file nó không có thẩm quyền phán. Nay liệt kê tường minh các hàm builder nhận tên bảng.
- [x] [Review][Patch] `429` lúc submit vẽ đồng hồ đếm ngược đứng yên và vẫn để nút gửi bật [apps/web/src/app/tao-phong/create-room-form.tsx:556] — **ĐÃ SỬA 2026-09-12**: nhánh `ready` nay dựng `SignInCountdown` THẬT — đúng cái nhánh `unavailable` vẫn làm — thay cho chuỗi tĩnh nối vào câu thông báo, và nút gửi `disabled={submitting || waiting}`. `createRoomWaitLabel` bị XOÁ: chính nó là thứ sinh ra đồng hồ đứng yên, và `renderToStaticMarkup` không phân biệt được nó với một đồng hồ chạy, nên nó sống sót qua một vòng review. Thay bằng `createRoomIsWaiting`, MỘT chỗ đọc duy nhất cho cả đồng hồ lẫn `disabled` — hai nửa đó đã từng bất đồng, và đó là cả lỗi. Prop mới `onSubmitWaitFinished`, KHÔNG dùng lại `onWaitFinished`: cái kia đổi state màn hình, đúng cho nhánh `unavailable` và sai ở đây — form sẽ biến mất giữa lúc đang gõ, mang theo mọi thứ đã nhập. Ba ca mới, gồm ca chiều ngược (một thông báo KHÔNG kèm đồng hồ thì nút vẫn sống). Mutation: `disabled={submitting}` → đỏ 1; thay đồng hồ bằng `<span>` tĩnh → đỏ 1.
- [x] [Review][Patch] Docblock `auth.runtime.ts` mâu thuẫn với `rooms.runtime.ts` về nội dung `RoomsRuntime` [apps/api/src/auth/auth.runtime.ts:46] — **ĐÃ SỬA 2026-09-12**: bỏ `và clock`, và ghi luôn rằng sự vắng mặt đó là có chủ đích — một phòng được đóng dấu bằng thời điểm PHIÊN của người gọi được giải, nên một `ClockPort` trong object đó là lần đọc đồng hồ tường thứ hai bên trong một request đã chốt xong "bây giờ", đúng lỗi Story 1.4 tốn một vòng review để bỏ khỏi đường ngày sinh.
- [x] [Review][Patch] Bản ghi quyết định i18n vẫn nói "đúng MỘT chuỗi cần số nhiều" trong khi story này thêm chuỗi thứ hai [apps/web/src/app/i18n/messages.ts:21] — **ĐÃ SỬA 2026-09-12 — sửa LỚP, không sửa con số.** Chỉ sửa số thì nó mục lại ở story sau: một con số trong văn xuôi vô hình với `tsc`, với luật 2 của gate i18n, và với mọi test trong repo — đó đúng là cách "exactly ONE" sống sót suốt hai story sau khi `createRoom.capacity` trở thành cái thứ hai. Câu nay viết bằng chữ số ("this catalogue holds 2 plural strings and 6 interpolation templates") và **luật 5** mới trong `tests/gates/i18n-catalogue.test.ts` ĐỌC hai số đó ra khỏi chính câu văn rồi ĐẾM lại trên catalogue: cặp `.one`/`.other` tính là MỘT, và hai catalogue phải đếm ra cùng kết quả — EN mới là locale có hai phạm trù số nhiều, nên hai file bất đồng về "chuỗi nào là số nhiều" là một `Retry in 1 seconds.` đang chờ ship. Có ca chống rỗng ở cả hai đầu: nếu ai viết lại câu văn làm regex hết khớp thì luật báo đỏ chứ không im lặng bỏ qua, và bộ đếm phải tìm thấy ≥40 entry. Hai docblock lẻ khác ("The one plural in the product", "the one plural … not open-coded") cũng đã sửa. Mutation: đổi câu thành "1 … 5" → đỏ 2 ca.
- [x] [Review][Patch] Ca "accepts every topic the contract declares" lại lặp danh sách chép tay thay vì `ROOM_TOPICS` [apps/api/src/rooms/rooms.flow.test.ts:398] — **ĐÃ SỬA 2026-09-12**: lặp thẳng trên `ROOM_TOPICS` và `ROOM_VISIBILITIES`. Danh sách chép tay là một danh sách VÍ DỤ — thêm chủ đề thứ bảy vào hợp đồng thì ca này vẫn kiểm sáu cái nó sinh ra cùng và báo phủ kín một enum nó không còn khớp, đúng hình dạng mà chính ca này là chiều ngược của. Kèm hai khẳng định chống rỗng: một enum rỗng làm vòng lặp không khẳng định gì mà vẫn xanh.
- [x] [Review][Patch] Ca 320px mở `en-GB` nhưng không khẳng định màn hình thật sự vẽ tiếng Anh [tests/e2e/web/tao-phong.spec.ts:281] — **ĐÃ SỬA 2026-09-12**: kiểm tiêu đề theo từng locale TRƯỚC khi đo bề rộng. `newContext({ locale })` chỉ đặt `Accept-Language`; nó không làm sản phẩm tôn trọng header đó. Thiếu dòng này thì một hồi quy ghim mọi request về tiếng Việt sẽ khiến vòng lặp đo CÙNG một màn hình hai lần trong khi tên ca hứa hai — mà rủi ro tràn chữ nằm ở ngôn ngữ DÀI hơn, nên hỏng sẽ im lặng đúng về phía nguy hiểm. Mutation: đổi tiêu đề EN kỳ vọng thành câu tiếng Việt → ca đỏ.
- [x] [Review][Patch] `fake-api.cjs` ném bên trong handler async khi gặp gói lạ, cho ra request treo thay vì lỗi đọc được [tests/e2e/support/fake-api.cjs:335] — **ĐÃ SỬA 2026-09-12, hai lớp.** Lớp LỚP: `createServer` nay nhận một hàm đồng bộ bọc `dispatch(req, res).catch(...)` — mọi throw thành 500 có nêu lỗi cộng một dòng `stderr`, thay vì một promise không ai `await` (không response nào được ghi, trình duyệt ngồi chờ tới khi Playwright hết giờ, và báo cáo nói "waiting for locator" — một câu trỏ vào màn hình chứ không vào file này). Có nhánh `res.headersSent` cho trường hợp ném SAU khi đã ghi head: không đặt status được nữa, nhưng `res.end()` vẫn là thứ cắt cơn chờ. Lớp CỬA VÀO: `/__e2e__/reset` từ chối gói lạ ngay tại chỗ sai bằng `isUserPlan` — chính hàm mà review vòng 1 ghi nhận là không ai gọi — với câu lỗi nêu tên gói sai và liệt kê `USER_PLANS`, vì một 500 ở `POST /v1/rooms` nằm cách lời gọi `scenario(...)` gây ra nó hai chặng.
- [x] [Review][Patch] `.choice` dùng `padding: 8px 15px`, `15px` không nằm trên thang giãn cách nào [apps/web/src/app/globals.css:566] — **ĐÃ SỬA 2026-09-12**: `var(--spacing-2) var(--spacing-4)`. `8px` vốn đúng bằng `--spacing-2` nên chỉ là cách viết vòng; `15px` thành 16px, rộng thêm 1px mỗi bên, và ca 320px trong `tao-phong.spec.ts` là thứ đo lại — Playwright 71/71 xanh, không nhãn nào bị cắt ở cả hai locale. LƯU Ý còn mở: repo KHÔNG có gate nào đọc thang giãn cách, nên một con số lạc thang vẫn vô hình với mọi suite; mục Defer "sửa gate là việc cắt ngang" giữ nguyên.

- [x] [Review][Defer] `stuwith_api` giữ `UPDATE` trên `rooms` mà không gì ghim được phép sửa cột nào [packages/db/migrations/1788480200000_rooms-and-plans.js:177] — deferred, thuộc Story 4.8
- [x] [Review][Defer] `PgIdentityAdapter` ép kiểu `plan` không kiểm, trong khi `isUserPlan` đã có sẵn và không ai gọi [packages/db/src/pg/identity-adapter.ts:83] — deferred, CHECK constraint chặn từ phía DB
- [x] [Review][Defer] Controller không có `try/catch`, một throw bất ngờ trả 500 không đúng phong bì lỗi [apps/api/src/rooms/rooms.controller.ts:43] — deferred, pre-existing (AuthController cùng tư thế)
- [x] [Review][Defer] Một phòng đã ghi vẫn có thể trả 500 qua `roomSchema.parse` chạy sau INSERT [apps/api/src/rooms/rooms.service.ts:136] — deferred, cần schema drift mới với tới
- [x] [Review][Defer] Migration trộn `IF NOT EXISTS` với `ADD COLUMN`/`ADD CONSTRAINT` không idempotent [packages/db/migrations/1788480200000_rooms-and-plans.js:114] — deferred, pre-existing shape
- [x] [Review][Defer] Độ dài tên đo bằng đơn vị UTF-16 còn Postgres đo bằng `char_length` [packages/contracts/src/rooms.ts:193] — deferred, cần quyết định hợp đồng
- [x] [Review][Defer] `EXPERIENCE.md` đòi `role="radiogroup"` cho nhóm tương tự trong khi CSS này gọi `fieldset` là khuôn dùng lại [apps/web/src/app/globals.css:513] — deferred, thuộc Story 2.7
- [x] [Review][Defer] `.choice` vô hình với vòng quét COMPOSED của gate tương phản [apps/web/src/app/globals.css:561] — deferred, sửa gate là việc cắt ngang
- [x] [Review][Defer] AC1 "không tính lại" được khẳng định trên một store không có cơ chế tính lại nào [apps/api/src/rooms/rooms.flow.test.ts:260] — deferred, Story 2.2 mới có môi trường thật
- [x] [Review][Defer] `fake-api.cjs` trả 405 ở chỗ `apps/api` trả 404 [tests/e2e/support/fake-api.cjs:314] — deferred, chưa spec nào khẳng định bên nào

## Design Notes

**`ON DELETE RESTRICT` chứ không `CASCADE`.** `user_identities` và `sessions` dùng `CASCADE` và đúng cho chúng. Với `rooms`, `CASCADE` **chính là** một đường xoá cứng phòng, chỉ nằm trong schema thay vì trong controller — AC5 cấm "endpoint **hay đường code nào**".

**`on_thi` chồng lấn bốn chủ đề kia** — nó là mục đích, không phải môn. Giữ có chủ đích: người tìm phòng sẽ tìm bằng chính từ đó. `khac` là lối thoát để không ai bị chặn không tạo được phòng.

## Verification

- `corepack pnpm run build:packages` — bắt buộc TRƯỚC mọi mutation test.
- `corepack pnpm run typecheck` — xanh; ĐỎ khi xoá một khoá khỏi `EN_MESSAGES`.
- `corepack pnpm run test:unit` · `test:contract` (Gate 3) · `dep-check` — xanh.
- `corepack pnpm run test:migrations` — xanh; mutation `GRANT INSERT … TO stuwith_realtime` → probe đỏ → khôi phục.
- `corepack pnpm run test:gates` — xanh; mutation từng vế của gate AC5 trước khi tin.
- `corepack pnpm exec playwright test` — 74 ca.

**Câu mutation cũ ở dòng cuối đã SAI và được sửa ở vòng review 2.** Nó viết: "mutation
bỏ `credentials: true` (`http-setup.ts:131`) → probe đỏ → khôi phục". Vòng 1 đã chạy
và probe trình duyệt KHÔNG đỏ — fake API mang bản sao CORS của riêng nó. Đây là dòng
lệnh duy nhất người sau thật sự gõ theo, nên để nguyên là để lại một hướng dẫn sai.
Thay bằng ba mutation có thật, mỗi cái kèm thứ nó làm đỏ:

- xoá `credentials` khỏi `apps/api/src/http-setup.ts` → đỏ `the API takes its credentials
  answer from the contract` (`tests/gates/cors-policy.test.ts`) và hai ca trong
  `apps/api/src/auth/auth.flow.test.ts`. **KHÔNG** đỏ bộ Playwright.
- `methods: [...CORS_ALLOWED_METHODS].filter((m) => m !== 'POST')` trong `http-setup.ts`
  → gate văn bản vẫn XANH 9/9; đỏ đúng một ca, `advertises exactly the methods and
  request headers the contract declares` trong `auth.flow.test.ts`. Đây là lý do ca đó
  tồn tại.
- `onSubmitWaitFinished` → `onWaitFinished` trong `apps/web/src/app/tao-phong/page.tsx`
  → markup giống hệt từng byte, mọi test đơn vị xanh; đỏ đúng ca e2e `when the wait ends
  the form is still there`.

## Suggested Review Order

**Hợp đồng CORS, và chỗ nó thật sự bị kiểm**

- Điểm vào. Ba hằng cả hai đầu cùng trải từ đây; đọc trước mọi thứ khác.
  [`http.ts:91`](../../packages/contracts/src/http.ts#L91)

- Khẳng định trên preflight THẬT. Đây là thứ gate văn bản không làm được.
  [`auth.flow.test.ts:873`](../../apps/api/src/auth/auth.flow.test.ts#L873)

- Gate văn bản, cùng lời tự thú về giới hạn của chính nó.
  [`cors-policy.test.ts:38`](../../tests/gates/cors-policy.test.ts#L38)

- Nơi bằng chứng vòng 1 ghi sai địa chỉ, nay đã sửa.
  [`http-setup.ts:136`](../../apps/api/src/http-setup.ts#L136)

**Gate AC5 — không đường xoá cứng phòng**

- Câu lệnh empty `rooms` mà không nhắc tên `rooms`. `RESTRICT` không cứu được.
  [`no-hard-delete-rooms.test.ts:177`](../../tests/gates/no-hard-delete-rooms.test.ts#L177)

- Grant không nêu bảng nào mà vẫn phủ `rooms`.
  [`no-hard-delete-rooms.test.ts:154`](../../tests/gates/no-hard-delete-rooms.test.ts#L154)

- Discovery: thiếu một cách viết ở đây là một file không ai xét.
  [`no-hard-delete-rooms.test.ts:631`](../../tests/gates/no-hard-delete-rooms.test.ts#L631)

- Cascade viết bằng option của builder, không phải SQL.
  [`no-hard-delete-rooms.test.ts:665`](../../tests/gates/no-hard-delete-rooms.test.ts#L665)

**Màn tạo phòng: chờ, và từ chối**

- Một chỗ đọc duy nhất cho cả đồng hồ lẫn nút — hai nửa này từng bất đồng.
  [`create-room-form.tsx:287`](../../apps/web/src/app/tao-phong/create-room-form.tsx#L287)

- Callback riêng: cái kia đổi state và sẽ xoá form giữa lúc đang gõ.
  [`page.tsx:187`](../../apps/web/src/app/tao-phong/page.tsx#L187)

- Đồng hồ chạy thật, quan sát qua hai lần đọc số.
  [`tao-phong.spec.ts:328`](../../tests/e2e/web/tao-phong.spec.ts#L328)

- Ca ghim phân biệt hai callback — markup của chúng giống hệt nhau.
  [`tao-phong.spec.ts:353`](../../tests/e2e/web/tao-phong.spec.ts#L353)

**Wiring fail-closed**

- Cả hai phương thức của port, không chỉ cái story này gọi.
  [`rooms.module.ts:59`](../../apps/api/src/rooms/rooms.module.ts#L59)

- Nhánh ném, nay có 13 ca chạy nó.
  [`rooms.module.test.ts:34`](../../apps/api/src/rooms/rooms.module.test.ts#L34)

**Số đếm i18n, đếm lại thay vì nhớ**

- Đọc hai con số ra khỏi câu văn rồi đếm lại trên catalogue.
  [`i18n-catalogue.test.ts:744`](../../tests/gates/i18n-catalogue.test.ts#L744)

- Câu văn bị đọc, viết bằng chữ số cho máy đọc được.
  [`messages.ts:19`](../../apps/web/src/app/i18n/messages.ts#L19)

**Chu biên — fixture, và những gì đã ghi sai**

- Fixture nay dựng được nhánh từ chối; thứ tự sau parser là có chủ đích.
  [`fake-api.cjs:413`](../../tests/e2e/support/fake-api.cjs#L413)

- `UserPlan` thay cho `string`; gói sai nay là lỗi `tsc`.
  [`scenario.ts:44`](../../tests/e2e/support/scenario.ts#L44)

- Mọi throw thành 500 đọc được thay vì một socket treo.
  [`fake-api.cjs:196`](../../tests/e2e/support/fake-api.cjs#L196)

- Docblock nói `FLOOR` trong khi hằng tên là `CEILING`.
  [`rooms.ts:79`](../../packages/contracts/src/rooms.ts#L79)

- `.choice` nay đi qua token; ca 320px là thứ đo lại 1px đó.
  [`globals.css:573`](../../apps/web/src/app/globals.css#L573)
