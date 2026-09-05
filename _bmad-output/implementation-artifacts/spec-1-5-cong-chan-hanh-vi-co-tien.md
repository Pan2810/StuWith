---
title: 'Story 1.5 — Cổng chặn hành vi có tiền theo tuổi'
type: 'feature'
created: '2026-09-05'
baseline_commit: '4d6e144469a8136e8f167ed12a2e129fffa8ca9e'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.4 dựng được nền — ngày sinh ghi một lần, `isAdult` là hàm thuần — nhưng **không có gì áp nó**. Epic 3 sẽ thêm hàng loạt endpoint có tiền đi vào (bật nhận hỏi riêng, đặt đơn giá, nhận coin từ người khác), và nếu mỗi endpoint tự chép một điều kiện tuổi thì đúng một endpoint sẽ quên, không ai biết, và nó sẽ là endpoint nhận tiền của một đứa trẻ.

**Approach:** Một hàm thuần `canReceiveMoney(user, clock)` trong `packages/domain` — **phép chiếu của `isAdult`, không phải luật thứ hai** — cộng một decorator `@MoneyIn()` và một guard đăng ký **toàn cục** trong `apps/api`. Endpoint mới chỉ đánh dấu; nó không bao giờ nhắc lại điều kiện tuổi. Guard giải phiên **một lần** và gắn user đã giải vào request, để không handler nào đọc phiên lần thứ hai.

## Boundaries & Constraints

**Always:**
- **`canReceiveMoney` là phép chiếu của `readStoredDateOfBirth`, không phải luật mới.** Nó gọi `isAdult`; không tự đọc chuỗi ngày, không tự so ngày, không có ngưỡng riêng. Hai luật tuổi trên một cột là đúng lớp lỗi mà `date-of-birth.ts` đã trả giá bốn vòng review để dập.
- **Fail closed.** `not-declared`, `unusable`, không có phiên, user không tồn tại — mọi trạng thái "không biết" đều trả `false`. Một cổng bảo vệ trẻ vị thành niên không được đọc sự thiếu hiểu biết của chính nó thành sự cho phép.
- **Chặn ở tầng API, trong guard, không trong handler.** Chặn phải xảy ra kể cả khi client gọi thẳng API. Một `if` đầu handler là thứ sẽ bị chép thiếu.
- **Guard không có decorator là no-op tuyệt đối.** Đăng ký toàn cục chỉ an toàn nếu route không đánh dấu đi qua mà không chạm DB, không đọc cookie, không đổi hành vi. Đây là điều kiện để không phá bất cứ route nào đang có.
- **Chỉ chiều tiền ĐI VÀO.** Tiêu coin để hỏi riêng, vào phòng, hỏi cả phòng, ẩn mặt, tích uy tín, và coin do **hệ thống** cấp đều không bị chạm.
- **Ngày sinh không rời `apps/api`.** Thân 403 nói "không được phép" — không tuổi, không ngày, không ngày sinh trong log ở bất kỳ mức nào (AD-15).
- **Envelope lỗi dùng lại `forbidden` đã có trong `ERROR_CODES`.** Không mã lỗi mới.
- **Một request, một lần đọc phiên và một instant thời gian.** Guard giải phiên rồi gắn kết quả lên request; `fixedAt` giữ mọi câu hỏi trong request trả lời về cùng một mili-giây.

**Ask First:**
- Thêm bất kỳ giá trị nào vào `ERROR_CODES`.
- Nhớ đệm phán quyết tuổi ở bất cứ đâu ngoài phạm vi một request (phiên, Valkey, cache).
- Bất kỳ thay đổi nào khiến cổng chạm tới chiều tiền **đi ra**.

**Never:**
- **Không đụng `apps/web`.** Ẩn nút là Story 3.3, và AC của nó nói rõ nút *không tồn tại* chứ không phải bị làm mờ. Cổng hồ sơ chưa hoàn tất phía web là nợ của Story 1.4, không phải story này.
- **Không dựng endpoint tiền thật.** Epic 3 sở hữu chúng. "Endpoint mẫu" của AC4 là một fixture chỉ dùng trong test.
- **Không dựng đường thu hồi quyền** (cắt phiên đang chạy, đuổi khỏi phòng) — Epic 4.
- Không `MIN_ADULT_AGE` trong env. 18 là tư thế pháp lý của sản phẩm, không phải núm vặn theo deployment.
- Không đọc phiên lần thứ hai trong cùng một request.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Đủ 18, route có `@MoneyIn()` | phiên hợp lệ, `dateOfBirth` cách nay ≥ 18 năm | Guard cho qua, handler chạy | N/A |
| Chưa đủ 18 | phiên hợp lệ, sinh nhật thứ 18 chưa tới | 403 `forbidden`, handler **không chạy** | Envelope chuẩn, không nhắc tuổi/ngày |
| Chưa khai ngày sinh | `date_of_birth` là `NULL` | 403 `forbidden` | Fail closed, không phải 400 |
| Ngày sinh `unusable` | năm dưới sàn, hoặc ngày ở tương lai | 403 `forbidden` | Fail closed; đã có log của 1.4, không log thêm |
| Không có phiên | không cookie, hoặc cookie hỏng/hết hạn | 401 `unauthenticated` | Chưa xác thực đi trước chưa đủ tuổi |
| Route **không** đánh dấu | mọi route hiện có | Guard trả `true` ngay, không đọc cookie, không chạm DB | N/A |
| Đúng ngày sinh nhật thứ 18 | sinh nhật thứ 18 là hôm nay theo UTC | Cho qua | N/A |
| Client nhận 403 | seam `authorizedCall` thấy 403 | **Không** gia hạn phiên, **không** hiện dialog hết phiên | 403 không phải 401 |

</frozen-after-approval>

## Code Map

**Phải sửa — đọc trước:**
- `packages/domain/src/policies/date-of-birth.ts:190` -- `isAdult(user, clock)`; `:70` `StoredDateOfBirth`; `:200` `fixedAt`. `canReceiveMoney` đặt cạnh đây hoặc trong policy mới và **chỉ gọi `isAdult`**. Docblock `:8-11` đã viết sẵn rằng file này là thứ Story 1.5 đứng lên
- `packages/domain/src/index.ts:7-10` -- phải thêm dòng re-export nếu tạo file policy mới
- `apps/api/src/auth/auth.service.ts:779-794` -- `private async userFromSession`; **trích ra** thành một injectable dùng chung để guard và service không có hai cách trả lời "ai đang gọi". `:634`, `:703` là hai call site hiện tại
- `apps/api/src/rate-limit/rate-limit.decorator.ts:18,34` -- khuôn phải bắt chước **nguyên văn**: `MethodDecorator` (không `ClassDecorator`), `SetMetadata`, hằng metadata có tên. Docblock `:6-9` nói thẳng nó được viết theo hình dạng cổng tuổi
- `apps/api/src/rate-limit/rate-limit.module.ts:33-47` -- khuôn `APP_GUARD` toàn cục + `forRuntime`. Docblock `:23-27` giải thích vì sao toàn cục là an toàn: no-op khi không có metadata
- `apps/api/src/app.module.ts:50-58` -- nơi module mới được nối; runtime dựng **một lần** và chia cho các module
- `apps/api/src/rate-limit/rate-limited.filter.ts` -- khuôn map exception → envelope; `packages/contracts/src/error.ts:8-16` `ERROR_CODES` đã có `forbidden`, `:104` `makeError`

**Đọc để bám quy ước, không sửa:**
- `apps/api/src/rate-limit/rate-limit.guard.test.ts:22` -- `testApiEnv({...})`; **không được** ép kiểu `ApiEnv`, `tests/gates/config-cast-ban.test.ts` quét cả repo
- `apps/api/src/__testing__/api-env.ts` -- builder cấu hình test
- `apps/api/src/auth/__testing__/auth-harness.ts:281` -- `createAuthHarness`; đường duy nhất để chạy endpoint thật qua HTTP thật với adapter in-memory
- `packages/domain/src/policies/date-of-birth.test.ts` -- khuôn test hàm thuần + `FixedClock`
- `apps/web/src/app/session-expiry.ts:255` -- seam chỉ rẽ nhánh trên 401/429; ca "403 không bật dialog" là một test **mới ở đây**, không phải thay đổi mã
- `packages/contracts/src/auth.ts:197-220` -- nơi khai hằng biên `/v1`, **nếu** cần hằng mới (AD-13)

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/policies/money.ts` -- thêm `canReceiveMoney(user, clock)` gọi `isAdult`, kèm docblock nói rõ nó là phép chiếu chứ không phải luật thứ hai -- AC1 đòi hàm thuần, không import hạ tầng
- [x] `packages/domain/src/index.ts` -- re-export policy mới -- không export thì `apps/api` không thấy
- [x] `packages/domain/src/policies/money.test.ts` -- phủ mọi hàng Matrix thuộc về domain: đủ 18, chưa đủ, chưa khai, `unusable`, đúng ngày sinh nhật -- chạy không cần DB
- [x] `apps/api/src/auth/session-authenticator.ts` -- trích `userFromSession` thành injectable; `AuthService` gọi nó thay vì giữ bản riêng -- một cách trả lời "ai đang gọi", không hai
- [x] `apps/api/src/money/money-in.decorator.ts` -- `@MoneyIn()` `MethodDecorator` + hằng metadata -- đánh dấu là toàn bộ giao diện
- [x] `apps/api/src/money/money-gate.guard.ts` -- guard: không metadata → `true` ngay; có metadata → giải phiên, 401 nếu không có, 403 nếu `canReceiveMoney` sai, gắn user đã giải lên request -- chặn ở tầng API
- [x] `apps/api/src/money/money.module.ts` -- đăng ký `APP_GUARD` toàn cục, theo khuôn `RateLimitModule` -- tự động, không phải nhớ
- [x] `apps/api/src/app.module.ts` -- nối module mới, dùng lại runtime đã dựng -- không tạo kết nối thứ hai
- [x] `apps/api/src/money/money-gate.guard.test.ts` -- guard qua `ExecutionContext` giả: mọi hàng Matrix, kể cả "route không đánh dấu thì không chạm DB" -- chứng minh no-op là thật
- [x] `apps/api/src/money/money-gate.flow.test.ts` -- một controller **fixture** đánh dấu `@MoneyIn()`, chạy qua HTTP thật bằng `createAuthHarness`, **không viết thêm dòng luật tuổi nào** -- đây chính là AC4
- [x] `apps/web/src/app/session-expiry.test.ts` -- thêm ca 403: không gia hạn, không dialog -- xung đột đã biết với 1.3c
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- ghi mọi phát hiện thật không thuộc phạm vi

**Acceptance Criteria:**
- Given `packages/domain`, when hỏi chính sách về một tài khoản, then có `canReceiveMoney(user)` trả `false` với tài khoản dưới 18, và nó không import gì từ hạ tầng và test được không cần DB
- Given một endpoint được đánh dấu là hành vi có tiền đi vào, when tài khoản dưới 18 gọi nó, then bị chặn ở tầng API với envelope chuẩn, kể cả khi gọi thẳng API
- Given guard đã đăng ký, when một endpoint mới được đánh dấu, then guard áp dụng tự động qua metadata, và có test chứng minh endpoint mẫu được bảo vệ mà không viết thêm dòng luật tuổi nào
- Given mọi route hiện có (không đánh dấu), when chạy toàn bộ suite, then không hàng nào đổi hành vi và guard không đọc cookie hay chạm DB trên chúng

## Spec Change Log

## Design Notes

**Vì sao guard giải phiên chứ không nhận user từ handler:** guard chạy **trước** handler — đó là lý do nó tồn tại. Nhưng nếu guard đọc phiên rồi handler đọc lại, một request có hai lần đọc DB và hai câu trả lời có thể lệch nhau. Guard gắn user đã giải lên request để handler tương lai của Epic 3 dùng lại thay vì hỏi lần nữa.

**Vì sao không đệm `is_over_18` vào phiên:** rẻ hơn một round trip, và `date_of_birth` ghi một lần nên giá trị cũ lệch về phía an toàn. Nhưng nó thêm một nguồn sự thật thứ hai cho một câu hỏi bảo vệ trẻ vị thành niên, và đó đúng là lớp lỗi đắt nhất của repo này. Nếu cần tối ưu, làm ở Epic 3 khi có endpoint thật để đo — là mục Ask First, không phải quyết định lặng lẽ.

**401 đi trước 403:** chưa xác thực là câu trả lời đúng hơn chưa đủ tuổi cho một request không có phiên, và trả 403 ở đó sẽ nói với một khách vãng lai rằng họ chưa đủ 18 — một khẳng định về người mà hệ thống chưa biết là ai.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run dep-check` -- expected: không vi phạm; `packages/domain` vẫn không chạm hạ tầng
- `pnpm exec vitest run` -- expected: mọi test xanh, 0 skip; mỗi hàng Matrix có test **đã chạy và pass**
- `pnpm exec playwright test` -- expected: 13 ca hiện có vẫn xanh (story này không thêm ca e2e — không có màn hình nào)
- `pnpm --filter api build` -- expected: exit 0

## Suggested Review Order

**Luật, ở một chỗ duy nhất**

- Điểm vào. Toàn thân hàm là `isAdult` — không ngưỡng, không số học ngày.
  [`money.ts:60`](../../packages/domain/src/policies/money.ts#L60)

- Ghim rằng nó là phép chiếu: đồng ý với `isAdult` trên 13 giá trị lưu.
  [`money.test.ts`](../../packages/domain/src/policies/money.test.ts)

**Cưỡng chế ở biên API**

- No-op trả về trước `switchToHttp()` — điều kiện để đăng ký toàn cục là an toàn.
  [`money-gate.guard.ts:88`](../../apps/api/src/money/money-gate.guard.ts#L88)

- Đánh dấu là toàn bộ giao diện; `MethodDecorator` nên viết lên class là lỗi biên dịch.
  [`money-in.decorator.ts:59`](../../apps/api/src/money/money-in.decorator.ts#L59)

- Một cách trả lời "ai đang gọi", dùng chung với `AuthService`.
  [`session-authenticator.ts:76`](../../apps/api/src/auth/session-authenticator.ts#L76)

- Một đăng ký duy nhất cho authenticator; module tiền chỉ còn guard.
  [`session-authenticator.module.ts:3`](../../apps/api/src/auth/session-authenticator.module.ts#L3)

**PII: bề mặt rò mới mà story này tạo ra**

- Caller nằm dưới khoá `Symbol` — `Object.keys` và `JSON.stringify` không thấy.
  [`money-gate.request.ts:22`](../../apps/api/src/money/money-gate.request.ts#L22)

- Luật duy nhất bắt được khi khoá symbol bị đổi thành chuỗi.
  [`money-gate.request.test.ts`](../../apps/api/src/money/money-gate.request.test.ts)

- Ba đường 200/403/500 qua pino thật; hàng rào hôm nay là pino không thấy object đó.
  [`logging.test.ts`](../../apps/api/src/logging.test.ts)

**Một request, một instant**

- Ghim tính chất mà trước đó hoàn tác được với 412 test vẫn xanh.
  [`one-instant.test.ts`](../../apps/api/src/auth/one-instant.test.ts)

**AC3: đánh dấu là toàn bộ sự bảo vệ**

- Quét mã nguồn fixture — chứng minh không có dòng luật tuổi nào được viết thêm.
  [`money-gate.flow.test.ts`](../../apps/api/src/money/money-gate.flow.test.ts)

- Fixture không thể rời `__testing__` và `main.ts` không bao giờ truyền nó.
  [`money-fixture-containment.test.ts`](../../tests/gates/money-fixture-containment.test.ts)

**Phụ trợ**

- 403 không phải phiên hết hạn — không gia hạn, không dialog.
  [`session-expiry.test.ts`](../../apps/web/src/app/session-expiry.test.ts)

- Bản build e2e ghi đè file được track; teardown chuẩn hoá lại, gate là chốt chặn.
  [`global-teardown.ts`](../../tests/e2e/global-teardown.ts)
