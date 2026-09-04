---
title: 'Story 1.4 — Khai ngày sinh khi tạo hồ sơ lần đầu'
type: 'feature'
created: '2026-09-04'
baseline_commit: '8fdb2ce044486398d43126cd6c2176e3102a17c1'
status: 'in-review'
review_loop_iteration: 2
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Hệ thống không biết ai đủ 18 tuổi. Story 1.2 tạo user ngay lúc đăng nhập lần đầu và **không tồn tại khái niệm "hồ sơ chưa hoàn tất"** — không cột, không cờ, không trạng thái. Cổng chặn hành vi có tiền của Story 1.5 không có gì để đứng lên.

**Approach:** Thêm `date_of_birth` vào `users`, **`NULL` nghĩa là chưa khai** — một nguồn sự thật, không cột thứ hai để hai bên nói khác nhau. Ghi **một lần duy nhất**, cưỡng chế bằng chính câu `UPDATE ... WHERE date_of_birth IS NULL` chứ không bằng một phép kiểm đọc-rồi-ghi. Ngày sinh **không bao giờ rời khỏi API**: `/v1/auth/me` chỉ trả cờ đủ/chưa 18 và cờ hoàn tất. Luật tuổi là **hàm thuần trong `packages/domain`**, nhận thời gian qua `ClockPort`.

## Boundaries & Constraints

**Always:**
- **Ngày sinh không bao giờ rời khỏi `apps/api`.** Không vào `CurrentUser`, không vào hồ sơ công khai, không vào `audit_events`, không vào log ở bất kỳ mức nào. Ra ngoài chỉ có boolean.
- **Ghi một lần, và tính một-lần đó là thuộc tính của câu lệnh.** `UPDATE ... WHERE id = $1 AND date_of_birth IS NULL` rồi xét số dòng — hai request đua nhau thì đúng một thắng. Đọc-rồi-ghi là một cửa sổ đua, không phải một luật.
- **Tuổi tính theo ngày lịch UTC.** Quy ước repo là `timestamptz` luôn UTC, và với một cổng bảo vệ trẻ vị thành niên thì UTC là chiều **an toàn**: người ở UTC+7 bị coi là chưa đủ tuổi thêm 7 giờ, không bao giờ đủ sớm. Lệch múi giờ chỉ đổi kết quả đúng một ngày, nhưng hai chỗ tự chọn múi giờ khác nhau là lớp lỗi "hai cách đọc một giá trị" đã tốn bốn vòng review ở story rate-limit.
- **Luật tuổi quyết định ở đúng một nơi** — hàm thuần trong `packages/domain`, nhận thời gian qua `ClockPort`, không `new Date()` bên trong. `apps/web` không được tự tính lại "đủ 18 chưa"; nó chỉ hiển thị thứ API trả về.
- **Parser ngày sinh test theo *lớp*, không theo danh sách ví dụ** (KEEP của Story 1.3c): không phải chuỗi, sai định dạng, ngày không tồn tại, ngày tương lai, năm phi lý, khoảng trắng, có thành phần giờ hoặc múi giờ lẫn vào. Khai ở `packages/contracts` để cả hai process đọc cùng một luật (AD-13).
- **Hằng route mới khai ở `packages/contracts`**, cạnh `SIGN_IN_PATHNAME`, không phải literal trong `apps/web`.
- Trang khai ngày sinh gọi API **qua seam** `useAuthorizedFetch()`/`useApiBaseUrl()`, không `fetch` trần. Mọi quyết định đẩy ra hàm thuần; `useState`/`useEffect` chỉ ở component mỏng.
- Thông báo lỗi cho người dùng **không nêu lý do kỹ thuật** và không tiết lộ ngưỡng tuổi đang áp.

**Ask First:**
- Thêm giá trị vào `AUDIT_ACTIONS`. Danh sách bị nhân bản thủ công trong migration làm CHECK constraint, nên đổi nó là ba nơi cùng lúc.
- Thêm biến môi trường. Ngưỡng 18 là **hằng số nghiệp vụ**, không phải knob vận hành — một tham số env sẽ kéo config vào `packages/domain`.
- Thêm bất kỳ dependency nào, đặc biệt thư viện ngày tháng và bất kỳ thứ gì cho DOM-testing.

**Never:**
- Ghi ngày sinh vào `audit_events`. Không role nào có `DELETE` và `metadata` chưa được whitelist khoá, nên một dòng chứa ngày sinh là **không xoá được vĩnh viễn**.
- Đường tự sửa ngày sinh — không endpoint, không màn hình. Đổi phải qua luồng hỗ trợ, và luồng đó không thuộc epic này.
- Bắt `date_of_birth` thành `NOT NULL`. Story 1.2 tạo user trước khi có ngày sinh; ràng buộc đó làm mọi lần đăng nhập lần đầu vỡ.
- Nhét trạng thái hồ sơ vào URL redirect sau callback. Đích redirect chỉ lấy từ state đã ký, và nhánh thất bại chỉ mang đúng một query param (KEEP của Story 1.3c).
- Cổng chặn hành vi có tiền, decorator tuổi, `canReceiveMoney` — Story 1.5.
- Token thiết kế, styling — Story 1.6. Màn khai vẫn khung trần.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Vừa tạo hồ sơ | Đăng nhập lần đầu xong | `/v1/auth/me` báo hồ sơ **chưa hoàn tất**; không có ngày sinh trong phản hồi | N/A |
| Khai hợp lệ | Ngày sinh đúng định dạng, quá khứ, hợp lý | Lưu; `/me` báo **đã hoàn tất** kèm cờ đủ/chưa 18 | N/A |
| Khai lần thứ hai | Hồ sơ đã có ngày sinh | **Từ chối**; giá trị cũ không đổi | Không nói giá trị cũ là gì |
| Hai request đua nhau | Hai lần khai đồng thời cho cùng user | Đúng **một** lần ghi được; lần kia bị từ chối | Không phải lỗi hệ thống |
| Đầu vào không hợp lệ | Sai định dạng, ngày không tồn tại, có giờ/múi giờ, không phải chuỗi | Từ chối, **không lưu gì** | Thông báo không nêu lý do kỹ thuật |
| Ngày trong tương lai | Ngày sinh sau hôm nay | Từ chối | Như trên |
| Đúng ngày sinh nhật 18 | Hôm nay là sinh nhật thứ 18 (UTC) | **Đủ 18** | N/A |
| Trước sinh nhật 18 một ngày | Còn một ngày nữa mới tròn 18 | **Chưa đủ 18** | N/A |
| Ngày sinh không rò ra | Sau khi đã khai, gọi `/me` và chạy log thật | Phản hồi và mọi dòng log **không chứa** giá trị ngày sinh | N/A |
| Chưa khai vẫn dùng được auth | Hồ sơ chưa hoàn tất | `/v1/auth/me` và `/v1/auth/logout` vẫn hoạt động bình thường | Không khoá người ta ra khỏi chính phiên của họ |

</frozen-after-approval>

## Code Map

**Phải sửa — đọc trước:**
- `packages/db/migrations/` -- migration mới, **JavaScript thuần**, forward-only, không `down`. **Không được chứa từ `DELETE`** ở bất kỳ đâu kể cả comment (`identity-schema.test.ts:143` quét chuỗi đó). Thêm cột vào bảng có sẵn **không cần GRANT mới** — quyền ở mức bảng đã có
- `packages/db/src/identity-schema.test.ts:107` -- `it('does not add date_of_birth — that column belongs to Story 1.4')`; đỏ **có chủ đích**
- `packages/db/src/migrations.test.ts:286` -- `it('has no date_of_birth column — that is Story 1.4')`; đỏ **có chủ đích**
- `packages/domain/src/ports/identity-port.ts:34-43` -- `User`; thêm trường. `:63` `IdentityInputError` là khuôn lỗi đầu vào
- `packages/domain/src/policies/` -- policy mới; khuôn ngắn nhất là `liveness.ts` (hằng có tên + `ClockPort` + default parameter). Phải thêm dòng re-export ở `packages/domain/src/index.ts:7-9`
- `packages/db/src/pg/identity-adapter.ts:16-17` (`SELECT_USER_COLUMNS`), `:131` (INSERT) -- và bản in-memory `packages/db/src/in-memory/identity-adapter.ts:37-41`
- `packages/db/src/test-kit.ts:219,252` -- `IdentityPortHarness` + `runIdentityPortContract`; hợp đồng mới chạy **hai lượt**, lượt PG nối bằng role `stuwith_api` chứ không phải owner
- `packages/contracts/src/auth.ts:65-72` -- `currentUserSchema`; docblock `:57-64` đã viết sẵn *"Story 1.4 adds an over-18 flag; it does NOT add the date of birth"*. Thêm trường **optional** (AD-13). `:120` `SIGN_IN_PATHNAME` là chỗ khai hằng route mới. `:219` `parseSignInRetryAfterSeconds` là **mẫu parser nghiêm ngặt phải bắt chước**
- `packages/config/src/logging.ts:19,20,27` -- `LOG_REDACT_PATHS` có `req.body.date_of_birth`, `req.body.dateOfBirth`, `*.date_of_birth` nhưng **thiếu `'*.dateOfBirth'`**, trong khi `User` của domain dùng camelCase. Đây là lỗ rò thật, phải đóng
- `apps/api/src/auth/auth.service.ts:402` -- `findOrCreateByIdentity`; `:1163` `toCurrentUser` parse qua schema **có chủ đích**, nên thêm cột không tự động publish nó
- `apps/web/src/app/` -- route mới; `layout.tsx` phải **giữ nguyên là Server Component**

**Đọc để bám quy ước, không sửa:**
- `apps/api/src/logging.test.ts:103` -- khuôn pino thật, đã có sẵn hàng `['date_of_birth', '1999-04-02']`; `:182-250` khuôn chạy process thật rồi đọc `harness.logLines`. **Luật vàng**: mỗi suite "không chứa X" bắt buộc kèm một assertion dương chứng minh log không rỗng (`:211`)
- `apps/api/src/rate-limit/rate-limit.decorator.ts:18,34` -- khuôn `MethodDecorator` + `SetMetadata`; Story 1.5 dùng lại, story này chỉ cần không phá
- `apps/web/src/app/session-expiry-provider.tsx:101,106` -- `useAuthorizedFetch()` / `useApiBaseUrl()`
- `apps/web/src/app/seam-usage.test.ts:45,101` -- luật cấm `fetch` trần; file mới **tự động** bị quét
- `apps/web/src/app/dang-nhap/sign-in-outcome.test.tsx:42-52` -- khuôn `renderToStaticMarkup`
- `apps/web/src/app/dang-nhap/countdown.tsx:44-45` -- khuôn tiêm đồng hồ qua prop để render được không DOM; tính tuổi cần "hôm nay" nên đây là mẫu đã có
- `packages/db/src/__testing__/postgres.ts` -- `startPostgres()`, `applyMigrations()`, `TEST_ROLE_PASSWORDS`

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/auth.ts` -- Parser ngày sinh nghiêm ngặt theo khuôn `parseSignInRetryAfterSeconds` (trả `null`, không ném), hằng route mới, và trường **optional** trên `currentUserSchema` -- một luật cho cả hai process (AD-13)
- [x] `packages/contracts/src/auth.test.ts` -- Test parser **theo lớp**: không phải chuỗi, sai định dạng, ngày không tồn tại, có giờ hoặc múi giờ, khoảng trắng, năm phi lý, tương lai -- danh sách ví dụ là thứ đã hỏng bốn lần ở story rate-limit
- [x] `packages/domain/src/policies/` + `index.ts` -- Policy thuần: hồ sơ đã hoàn tất chưa, và đủ 18 chưa theo ngày lịch UTC, nhận thời gian qua `ClockPort` -- Story 1.5 đứng lên đây
- [x] `packages/domain/src/ports/identity-port.ts` -- Mở rộng `User` và khai phép ghi một-lần trên port
- [x] `packages/db/migrations/<ts>_*.js` -- Thêm cột; forward-only, JS thuần, không chứa từ `DELETE`
- [x] `packages/db/src/pg/identity-adapter.ts` -- Đọc cột mới; ghi bằng `UPDATE ... WHERE date_of_birth IS NULL` và xét số dòng
- [x] `packages/db/src/in-memory/identity-adapter.ts` -- Cùng hợp đồng, kể cả nhánh ghi lần hai
- [x] `packages/db/src/test-kit.ts` -- Mở rộng hợp đồng identity: ghi được lần đầu, lần hai bị từ chối, hai lần đua nhau thì đúng một thắng
- [x] `packages/db/src/identity-schema.test.ts`, `packages/db/src/migrations.test.ts` -- Cập nhật hai test đang khẳng định cột không tồn tại; **đỏ có chủ đích**, không phải hồi quy
- [x] `packages/config/src/logging.ts` -- Đóng lỗ `'*.dateOfBirth'`
- [x] `apps/api/src/auth/` -- Endpoint khai ngày sinh và cờ trạng thái trên `/v1/auth/me`; ngày sinh không đi ra ngoài
- [x] `apps/api/src/logging.test.ts` -- Chạy process thật, khai một ngày sinh qua HTTP, khẳng định không dòng log nào chứa giá trị đó **kèm** assertion dương chứng minh log không rỗng
- [x] `apps/web/src/app/<route>/` -- Màn khai ngày sinh: hàm thuần giữ mọi quyết định, component không effect, gọi qua seam
- [x] `apps/web/src/app/dang-nhap/` -- **Dẫn người chưa khai tới màn khai.** Một màn hình tồn tại mà không ai tới được thì AC "không có đường bỏ qua bước khai" không đạt — và không cổng nào thấy, vì màn hình render hoàn hảo khi test riêng
- [x] `apps/web/src/app/` -- Test buộc hằng `DATE_OF_BIRTH_PATHNAME` khớp thư mục route có thật; một hằng chỉ được so với hằng khác là một hằng trỏ vào 404 mà không ai biết
- [x] `apps/web/src/app/<route>/*.test.ts(x)` -- Phủ các hàng Matrix phía web bằng `renderToStaticMarkup` và hàm thuần
- [x] `.env.example` -- Chỉ chạm nếu thực sự thêm biến; mặc định story này **không** thêm

**Acceptance Criteria:**
- Given một người vừa đăng nhập lần đầu, when họ chưa khai ngày sinh, then hồ sơ ở trạng thái chưa hoàn tất và không có đường nào bỏ qua bước khai — nhưng họ vẫn gọi được `/v1/auth/me` và `/v1/auth/logout`.
- Given hồ sơ đã có ngày sinh, when gọi lại endpoint khai, then bị từ chối và giá trị cũ không đổi — và điều đó đúng cả khi hai request tới cùng lúc.
- Given ngày sinh đã lưu, when chạy `apps/api` thật rồi đọc từng dòng log, then không dòng nào chứa giá trị ngày sinh, và `/v1/auth/me` chỉ trả boolean.
- Given `pnpm run dep-check`, when chạy, then không vi phạm nào — `packages/domain` vẫn không chạm hạ tầng, `apps/web` vẫn chỉ chạm `packages/contracts`.

## Spec Change Log

### Vòng 1 — 2026-09-04

**Finding kích hoạt:** không có gì trong `apps/web/src` hay `apps/api/src` trỏ tới `/khai-ngay-sinh`. Màn hình tồn tại, render đúng, API chạy đúng, 1460 test xanh — và cách duy nhất tới được nó là tự gõ URL. AC "bắt buộc khai ngày sinh, không bỏ qua được" do đó không đạt. Cả ba lớp review độc lập cùng chỉ ra.

**Đã sửa gì trong spec:** thêm hai task vào mục Tasks (ngoài khối frozen) — dẫn người chưa khai tới màn khai, và một test buộc hằng route khớp thư mục thật. Mục Tasks cũ chỉ nói "màn khai ngày sinh" mà không nói ai dẫn người dùng tới đó, nên agent làm đúng chữ và thiếu ý.

**Trạng thái xấu đã tránh:** một story đóng lại với mọi cổng xanh trong khi tính năng chính không tới được — và Story 1.5 sau đó dựng cổng chặn tuổi trên một trường mà không ai có đường điền.

**KEEP — phải sống sót qua mọi lần re-derive:**
- `NULL` là biểu diễn duy nhất của "chưa khai"; không thêm cột `profile_completed`.
- Ghi một lần nằm trong chính câu `UPDATE ... WHERE date_of_birth IS NULL`, không phải ở tầng ứng dụng.
- Tuổi tính theo ngày lịch UTC qua `ClockPort`; sai muộn là chiều an toàn, và cả ca 29/02 lẫn ca UTC+7 đều phải giữ test.
- Ngày sinh lưu dạng `date`, đọc lại bằng `to_char`; không bao giờ rời khỏi `apps/api`.
- Parser test theo **lớp**, kèm đối chứng dương để luật không quá rộng.
- Ngưỡng tuổi là hằng có tên và phép tính không đặc biệt hoá cho số 18.


- **2026-09-04 — thêm `auth_date_of_birth` vào `RATE_LIMIT_ACTIONS`.** Không nằm trong danh sách Ask First, và là điều kiện để "chỉ cần không phá" decorator rate-limit thành sự thật: `rate-limit.flow.test.ts` khẳng định *mọi* route của `AuthController` trừ `logout` mang một action. Một route mới không có decorator sẽ làm test đó đỏ, và cách duy nhất khác — đặt endpoint ở controller khác — chỉ là né phép kiểm chứ không giữ được bất biến. Kênh là `json` (client gọi bằng `fetch`, đọc được envelope). Không thêm biến môi trường; ngưỡng và cửa sổ dùng lại các knob sẵn có.
- **2026-09-04 — đóng cả *lớp* lỗ rò camelCase trong `LOG_REDACT_PATHS`, không chỉ `'*.dateOfBirth'`.** Task chỉ yêu cầu một đường, nhưng khi viết test theo lớp ("mỗi trường PII phải có cả hai cách viết") thì `'*.accessToken'`, `'*.refreshToken'`, `'*.providerId'` cùng thiếu — cùng một khiếm khuyết, cùng một nguyên nhân. Vá đúng ví dụ được báo là đúng kiểu thất bại `AGENTS.md` ghi lại ở danh sách trusted proxy. Thay đổi thuần cộng thêm: chỉ xoá thêm trường khỏi log, không thêm trường nào.
- **2026-09-04 — màn khai có trạng thái thứ năm `unavailable`.** `/v1/auth/me` bị rate-limit nên `429` là câu trả lời có thật; gộp nó vào "chưa đăng nhập" sẽ bảo người đang đăng nhập đi đăng nhập lại, và mỗi cú bấm ở trang đó tốn thêm một lượt và kéo dài thời gian chờ — đúng lỗi Story 1.3 đã sửa ở `/dang-nhap`, đi vào bằng cửa khác. Chỉ `401` mới là "chưa đăng nhập".

### Vòng 2 — 2026-09-05

**Finding kích hoạt:** bản vá của vòng 1 mắc đúng lỗi mà vòng 1 sửa. `SignedInPanel` — thứ duy nhất dẫn tới màn khai — chỉ được test bằng cách render trực tiếp; không gì ghim rằng `page.tsx` gọi nó. Hoàn tác một dòng là route chết trở lại với 1572 test vẫn xanh. Đây là lần thứ ba của cùng lớp lỗi trong dự án: seam của 1.3c, route chết của 1.4, và bản vá cho chính route đó.

**Đã sửa gì trong spec:** không sửa Boundaries hay Matrix. Ghi lại đây rằng **"đã có test cho component" không phải bằng chứng "sản phẩm dùng component đó"**, và mọi bản vá cho một lỗi thuộc lớp này phải kèm một luật quét được, không phải một test render.

**Trạng thái xấu đã tránh:** đóng story với niềm tin rằng lỗ đã bịt, trong khi cái bịt nó có thể bị gỡ mà không ai biết.

**KEEP bổ sung cho vòng sau:**
- `isProfileComplete` và `isAtLeastYearsOld` phải đọc giá trị lưu bằng **cùng một luật**; hai luật trên một cột là cách sinh ra trạng thái kẹt không lối ra.
- Không đặt giá trị mặc định cho tham số mà việc nối dây phụ thuộc vào — để trình biên dịch giữ luật thay cho test.

## Design Notes

**Vì sao `NULL` là "chưa khai" chứ không thêm cột `profile_completed`:** hai cột nói về cùng một sự thật là hai cột có thể nói khác nhau, và không có ràng buộc DB nào giữ chúng khớp. Một nguồn sự thật thì không có trạng thái lệch để mà sửa.

**Vì sao ghi-một-lần nằm trong câu `UPDATE` chứ không ở tầng ứng dụng:** kiểm rồi ghi có một cửa sổ giữa hai bước, và hai request đồng thời đều thấy `NULL`. `WHERE date_of_birth IS NULL` đẩy phép kiểm vào chính lần ghi, nên câu trả lời "ai thắng" do Postgres quyết, không do thứ tự may rủi. Hợp đồng adapter chạy hai lượt nên bản in-memory buộc phải cư xử y hệt.

**Vì sao UTC:** một cổng bảo vệ trẻ vị thành niên nên sai về phía chặt hơn. UTC chậm hơn UTC+7 bảy giờ, nên người ở Việt Nam bị coi là chưa đủ tuổi thêm bảy giờ chứ không bao giờ đủ sớm. Đây là quyết định phải viết ra, vì nếu không thì `apps/api` và `apps/web` sẽ mỗi nơi chọn một kiểu.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run dep-check` -- expected: no dependency violations
- `pnpm test` -- expected: mọi test xanh, 0 skip; mỗi hàng Matrix có test **đã chạy và pass**
- `pnpm run build` -- expected: exit 0
- `pnpm run test:e2e` -- expected: mọi test xanh
- `pnpm --filter @stuwith/db migrate` trên DB **đã có dữ liệu** -- expected: chạy được, không khoá bảng lâu (CI gate 4 kiểm điều này)
