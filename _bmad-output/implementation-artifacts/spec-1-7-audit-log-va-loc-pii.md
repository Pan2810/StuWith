---
title: 'Story 1.7 — Audit log append-only và lọc PII khỏi log'
type: 'feature'
created: '2026-09-06'
status: 'done'
baseline_commit: '0b23062718b5fb4e4fd0dbd62e43f790a61e2657'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bộ lọc PII hiện là **deny-list** — `LOG_REDACT_PATHS` đưa cho `redact` của pino. Mặc định của nó ngược hẳn thứ spine đòi: một trường mới **được ghi** trừ khi có người nhớ khai tên nó. Danh sách đó đã rò đúng vì lý do ấy **hai lần** (ngày sinh lọt qua vì domain viết `dateOfBirth` còn danh sách chỉ có `date_of_birth`; rồi ba cặp nữa thiếu nửa camelCase). Docblock của chính file, `packages/config/src/logging.ts:6-11`, đã hẹn Story 1.7 thay nó. Song song, `audit_events` có bảng và quyền đúng từ Story 1.2 nhưng **không luật nào** cấm code gọi UPDATE/DELETE lên nó.

**Approach:** Thay `redact` bằng một allow-list đặt ở `formatters.log` — cơ chế duy nhất của pino hiện thực được "trường chưa khai thì không ghi", vì `serializers` đánh theo tên trường và một trường chưa khai không có serializer nào để gọi. Cộng một serializer `err` tự viết, vì đó là đường đang hở thật. Cộng một luật quét cấm UPDATE/DELETE trên `audit_events` trong code.

## Boundaries & Constraints

**Always:**
- Allow-list khai **một lần** trong `packages/config`, cả hai process đọc chung. Hai bản sẽ trôi khỏi nhau ngay khi một bên thêm trường — đó là chính xác cách deny-list đã rò hai lần.
- Cơ chế là `formatters.log`, **không phải** `serializers`. Lý do ở Design Notes; chọn sai chỗ là giao một story không đạt AC4.
- `request_id` phải sống sót qua bộ lọc. Nó là mối nối **duy nhất** giữa một dòng log và một hàng audit — `auth.controller.ts:218-226` lập luận rằng một hàng audit không có request id thì không phải hàng audit.
- `err.code` phải sống sót. `REDACTION_NOTES.bareCodeExcluded` (`packages/config/src/logging.ts:132`) ghi lại rằng `*.code` **cố ý** không bị che vì đó là chỗ mọi sự cố bắt đầu. Bỏ deny-list mà không mang theo quyết định đó là xoá mất trường chẩn đoán.
- `sanitizeLoggedUrl` và hai serializer `req`/`res` giữ nguyên — chúng vốn đã là allow-list, và `sanitizeLoggedUrl` vá một chỗ rò mà `redact` không với tới được.
- Mọi luật mới **phải được mutation-test** trước khi tin. Ở Story 1.6, ba luật trông như chạy và không làm gì cho tới khi bị mutate.

**Ask First:**
- Sửa `AUDIT_ACTIONS`. Nó được soi lại bởi CHECK constraint `audit_events_action_check` trong migration — hai chỗ, không phải một, và migration chỉ tiến.
- Bỏ hẳn `redact` thay vì giữ nó làm đai an toàn. `formatters.log` chạy **trước** `redact`, nên nếu giữ cả hai thì thứ tự phải được kiểm chứ không giả định.
- Cắm pool DB, `AuditPort` provider hay shutdown hook vào `apps/realtime-gateway`.

**Never:**
- Không thêm dependency. pino 10.3.1 / pino-http 11.0.0 / nestjs-pino 4.6.1 đã có sẵn cả `formatters` lẫn `serializers`.
- Không dùng `transport`/worker target. `formatters` **không được hỗ trợ** cùng transport; cả hai process đang ghi thẳng vào stream nên hôm nay an toàn, và phải giữ như vậy.
- Không audit `/healthz`. Nó là probe liveness không xác thực — audit nó là một hàng mỗi lần probe, vĩnh viễn, trong một bảng không xoá được.
- Không bịa hành vi cho gateway. `room_token.issued` chưa có mã nào ở cả hai process và thuộc Epic 2.
- Không chạm `apps/web`. Story này là backend thuần.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Trường đã khai | payload có `request_id`, `service`, `level` | ghi bình thường | N/A |
| Trường chưa khai | payload có `email` | trường vắng mặt; dòng log **vẫn được ghi** | N/A |
| Trường mới hoàn toàn | ai đó thêm `national_id` vào payload, chưa khai | vắng mặt, không cần sửa gì (AC4) | N/A |
| Cả hai cách viết | `date_of_birth` và `dateOfBirth` | cả hai vắng mặt — vì **chưa khai**, không vì được liệt kê | N/A |
| Object miền nguyên khối | `logger.info({ user })` với `User` mang `dateOfBirth`, `email` | không giá trị nào xuất hiện, ở bất kỳ độ sâu nào | N/A |
| Lồng hai tầng | `{ ok: true, user: { email } }` | `email` vắng mặt | N/A |
| `err` có thuộc tính tùy biến | lỗi mang `error.token = '...'` | `token` vắng mặt; `name`, `message`, `stack` theo luật đã khai | N/A |
| `err.code` | lỗi mang `code: 'ECONNREFUSED'` | **có mặt** — trường chẩn đoán | N/A |
| Mọi mức log | cùng payload ở `trace`/`debug`/`info`/`warn`/`error`/`fatal` | lọc áp dụng như nhau ở mọi mức | N/A |
| Đăng nhập thành công | callback hợp lệ | đúng **một** hàng `auth.signed_in`, `request_id` không rỗng | N/A |
| Đăng nhập thất bại | mọi nhánh của `failedSignIn()` | đúng **một** hàng `auth.sign_in_failed` | N/A |
| Code gọi UPDATE audit | thêm `UPDATE audit_events SET ...` vào bất kỳ file nguồn nào | luật quét **đỏ** | N/A |
| Code gọi DELETE audit | thêm `DELETE FROM audit_events` | luật quét **đỏ** | N/A |

</frozen-after-approval>

## Code Map

**Trọng tâm — phải sửa:**
- `packages/config/src/logging.ts:12` -- `LOG_REDACT_PATHS`, deny-list bị thay. `:132` `REDACTION_NOTES.bareCodeExcluded` ghi vì sao `*.code` cố ý không bị che — **quyết định này phải sống tiếp**. `:151` `sanitizeLoggedUrl` giữ nguyên. `:170` `REQUEST_ID_HEADER`, `:205` `resolveRequestId`, `:216` `loggerBaseOptions` trả `{level, redactPaths, requestIdHeader, base}` — `redactPaths` (`:223`) là thứ đổi hình dạng
- `apps/api/src/logging.ts:20` -- nơi ráp options pino. `:23` `redact: {paths, remove: true}`. `:34` `customProps` → `{request_id: req.id}` — **đường sống của `request_id`**. `:35-36` đã có comment "Whitelist, not deny-list: only these request/response fields are ever serialised" cho `req`/`res`; story này tổng quát hoá nó lên object đã merge. `:37-46` serializer `req`, `:47` serializer `res`. `:55` trả **dạng tuple** `[options, destination]`
- `apps/realtime-gateway/src/logging.ts:19` -- bản song sinh, gần như từng byte. **Khác một điểm quan trọng:** `:18-47` trả object trần, **không có seam destination** — api có, gateway không. Muốn test end-to-end phía gateway thì phải thêm seam đó
- `packages/config/src/logging.test.ts` -- xem "luật nào mất đối tượng" bên dưới; đây là file phải viết lại phần lớn

**Luật nào mất đối tượng khi deny-list biến mất** (không xoá và để trống — thay bằng gì phải nói rõ):
- `:22` `describe('LOG_REDACT_PATHS (AD-15)')` -- chết cả khối. `:39` `it.each('redacts %s')` là assertion thành viên thuần
- `:57` `describe('every path is declared in both spellings')` -- luật ghép cặp snake/camel. **Chết, và không có kế thừa** — allow-list làm bài toán đó biến mất về mặt cấu trúc. Nói thẳng điều đó trong docblock: đây là lập luận mạnh nhất của story
- `:73`,`:80`,`:82`,`:84` `split`/`rejoin`/`toCamel`/`toSnake` -- helper thuần, **sống sót**, và `:96` test chúng trực tiếp
- `:87` `it('finds paths to check at all, so an empty sweep cannot pass')` -- **khuôn chống rỗng này là thứ đáng port nhất** sang luật mới
- `:124` `it('covers every field the spine names as never-loggable')` -- kế thừa phải là "allow-list **không chứa** những trường này"
- `:133` `it('is handed to callers intact')` -- `:136-137` (`requestIdHeader`, `base`) sống; `:135` chết
- `:184` `describe('the OAuth handshake never reaches a log line')` -- `:196`, `:200` chết. `:207` `it('deliberately does NOT blanket-redact code, and says why')` chết **nhưng lý do phải sống**
- `:141` `describe('inbound request id is not trusted verbatim')` và `:217` `describe('sanitizeLoggedUrl')` -- **không đụng tới**

**Harness đã có — dùng, đừng dựng lại:**
- `apps/api/src/logging.test.ts:54-63` `captureLines()` + `:65-70` `loggerUnderTest()` -- `Writable` đưa vào `pino(options, stream)`, options từ `buildLoggerParams` **thật**. Đây chính là harness allow-list cần
- `apps/api/src/auth/__testing__/auth-harness.ts:388-396` -- `logLines: string[]`, tiêm qua `logDestination` (`:413`), `useLogger` (`:438`), mức ép về `info` (`:328`). Dùng ở `logging.test.ts:241,317,405,566`
- `apps/realtime-gateway/src/logging.test.ts:32-48` -- bản song sinh. `:71` so `redact.paths` với `LOG_REDACT_PATHS` — **chết cùng deny-list**

**Sự thật đã đo, đọc trước khi viết bất kỳ test log nào:**
- `apps/api/src/logging.test.ts:490-499` -- `pino-http` serialise `IncomingMessage` **thô** của Node; guard gắn lên wrapper Fastify. Một serializer `req` viết lại để duyệt `Object.getOwnPropertySymbols(req)` **đã được thử ở đây và không đổi gì** — nó nhìn vào một object khác. Hệ quả: allow-list **phải** tác động lên object đã merge, không phải lên `req`
- `:500-506` -- thu hẹp trung thực: đường sống là bất cứ chỗ nào đọc caller đã giải vào một **message**, một object metadata, hay một **error**

**Bề mặt thật của allow-list — phát hiện quan trọng nhất:**
- Trong mã sản phẩm có **đúng không** lời gọi log nào truyền object làm tham số đầu. Cả sáu đều truyền chuỗi: `auth.service.ts:682`, `rate-limit-health.ts:61` và `:90`, `runtime-shutdown.ts:50`, `:66`, `:73`. Nên allow-list áp lên lời gọi tay lọc đúng con số không
- Bề mặt thật là thứ `pino-http` tự ghi: `req`/`res` (đã allow-list) và **`err` — không process nào ghi đè**. Serializer `err` mặc định của pino duyệt cả thuộc tính tùy biến đếm được. **Đây là đường đang hở**
- `apps/api/src/rate-limit/rate-limit-health.ts:116-127` `diagnosableWithoutTheData(error)` -- tiền lệ đã có trong repo cho đúng cách tiếp cận này: trả `error.name` + tối đa 12 khung stack, **cố ý bỏ message**. Serializer `err` mới nên bắt chước hình dạng đó
- `apps/api/src/auth/auth.service.ts:678` -- `reportUnusableDateOfBirth(user: User, ...)` nhận nguyên `User` nhưng chỉ nội suy `user.id` (`:683`). Cách một lần sửa ẩu là thành ca nguy hiểm; docblock `:675-676` nói vậy

**Đường audit — đã có, đừng dựng lại:**
- `packages/db/migrations/1788480000000_users-and-identities.js:157-169` bảng + CHECK; `:201` `GRANT INSERT`; `:203` `REVOKE UPDATE, DELETE, TRUNCATE`. **Nửa DB của AC1 xong**
- `packages/contracts/src/audit.ts:12` `AUDIT_ACTIONS` (6 giá trị; **ba chưa có người ghi**), `:24` `auditEventSchema` (8 trường, không trường nào optional, `actor_user_id`/`subject_id` nullable), `:10` "PII never belongs in `metadata` — only ids and already-declared fields"
- `packages/domain/src/ports/audit-port.ts:68` `append(event)` — **một** method. `:6-10` lập luận "no update, no delete, on purpose"
- `packages/db/src/pg/audit-adapter.ts:20-33` -- **một** câu lệnh, INSERT. Không UPDATE/DELETE/SELECT ở đâu trong file (`:9-12` nói rõ). `:46` `assertValidAuditEvent`, vòng lặp chỉ-scalar `:71-78`
- `apps/api/src/auth/audit.ts:150` `recordSignedIn` → `auth.signed_in`; `:175` `recordSignInFailed` → `auth.sign_in_failed`; `:8-10` "Exactly one row per attempt"; `:50` `SIGN_IN_FAILURE_REASONS` (14 giá trị)
- Năm call site: `auth.service.ts:312`, `:472`, `:521`, `:554`, `:1039` (`failedSignIn()` khai `:1028`, tới từ năm nhánh `:383`, `:396`, `:409`, `:438`, `:454`)
- `apps/api/src/auth/auth.controller.ts:227-238` `requestIdOf` -- ba nguồn theo thứ tự: header trên `reply.raw`, `request.raw.id`, rồi `resolveRequestId` tự dựng lại

**Khuôn luật quét, bám theo:**
- `tests/gates/design-tokens.test.ts` -- khuôn mới nhất, có cả self-test cho parser
- `tests/gates/config-cast-ban.test.ts` -- strip comment có neo (`^[ \t]*\/\/.*$/gm`) và mẹo ráp chuỗi dò để file không tự tố chính nó

## Tasks & Acceptance

**Execution:**
- [x] `packages/config/src/log-fields.ts` -- khai allow-list: tên trường được ghi ở gốc, trong `err`, và luật cho khoá lồng; kèm docblock nói vì sao allow-list xoá cả lớp lỗi snake/camel -- một nguồn cho hai process
- [x] `packages/config/src/logging.ts` -- `loggerBaseOptions` trả allow-list thay cho `redactPaths`; giữ `sanitizeLoggedUrl`, `resolveRequestId`, `REQUEST_ID_HEADER`; mang `bareCodeExcluded` sang dạng mới -- nơi hợp đồng đổi
- [x] `packages/config/src/log-filter.ts` -- hàm thuần lọc object đã merge theo allow-list, đệ quy, và serializer `err` -- hàm thuần thì test được không cần pino
- [x] `packages/config/src/log-filter.test.ts` -- phủ mọi hàng Matrix thuộc về hàm thuần: chưa khai, lồng hai tầng, `err` có thuộc tính tùy biến, `err.code` sống -- chạy nhanh, không dựng logger
- [x] `apps/api/src/logging.ts` + `apps/realtime-gateway/src/logging.ts` -- cắm `formatters.log` và serializer `err`; quyết định giữ hay bỏ `redact` (Ask First nếu bỏ) -- hai process cùng một cách
- [x] `apps/realtime-gateway/src/logging.ts` -- thêm seam `destination` như api đã có -- không có seam thì nửa gateway không test end-to-end được
- [x] `packages/config/src/logging.test.ts` -- viết lại: giữ `resolveRequestId` và `sanitizeLoggedUrl` nguyên; thay luật ghép cặp bằng luật "allow-list KHÔNG chứa trường nào spine cấm"; **port khuôn chống rỗng** `:87` -- luật mất đối tượng phải có kế thừa, không để trống
- [x] `apps/api/src/logging.test.ts` và `apps/realtime-gateway/src/logging.test.ts` -- thêm ca hành vi qua pino thật cho mọi hàng Matrix về log; ca `err` là ca mới quan trọng nhất -- harness đã có, dùng lại
- [x] `tests/gates/audit-append-only.test.ts` -- quét toàn repo: không file nguồn nào chứa `UPDATE ... audit_events` hay `DELETE FROM audit_events`; mutation-test cả hai -- vế thứ hai của AC1
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- ghi nửa gateway của AC2 **kèm bằng chứng**: gateway có 5 file nguồn, không hành vi nhạy cảm, không DB, và hai process chưa gọi nhau; `room_token.issued` chưa có mã ở đâu -- trung thực về thứ chưa đóng
- [x] `AGENTS.md` -- ghi tư thế mới: log theo allow-list, trường mới mặc định không vào log -- người sau phải biết luật đã đảo chiều

**Acceptance Criteria:**
- Given một payload mang một trường chưa khai, when nó đi qua logger của **cả hai** process ở **mọi** mức, then trường đó không xuất hiện và dòng log vẫn được ghi
- Given ai đó thêm một trường mới vào một payload đã có, when không sửa gì khác, then trường đó mặc định không vào log — chứng minh bằng test, không bằng lập luận
- Given một `Error` mang thuộc tính tùy biến chứa token, when nó được log, then thuộc tính đó vắng mặt còn `err.code` vẫn có
- Given một lần đăng nhập, when nó thành công hoặc thất bại theo bất kỳ nhánh nào, then sinh đúng một hàng audit mang `request_id` không rỗng, và cùng `request_id` đó xuất hiện trong dòng log của chính request ấy
- Given bất kỳ file nguồn nào, when nó chứa một câu lệnh UPDATE hoặc DELETE lên `audit_events`, then luật quét đỏ

## Spec Change Log

- **2026-09-06 — SCOPE ADDITION, approved by the human in review round 1: `genReqId`
  fixed inside 1.7 rather than deferred.** The implementation round found and
  recorded that `genReqId` never executed in either process — `pino-http` writes
  `req.id = req.id || genReqId(req, res)` and Fastify assigns an id first — so an
  inbound `x-request-id` was ignored from Story 1.1 onwards, nothing was echoed
  despite `Access-Control-Expose-Headers` advertising it, and every line carried
  Fastify's `req-1` counter, which BOTH processes mint independently and therefore
  collide on. It was written up as deferred; the human decided to close it here.

  What changed: `genReqId` moved to the FASTIFY adapter
  (`apps/api/src/http-setup.ts`, and a new `apps/realtime-gateway/src/http-setup.ts`)
  and was deleted from both pino options; an `onRequest` hook echoes
  `x-request-id` from `request.id` — the value `resolveRequestId` approved, never
  the raw header, because echoing raw makes every endpoint a reflection point.
  `apps/realtime-gateway/src/app.module.ts` gained the `logDestination` seam
  `apps/api` has had since 1.2, and `apps/realtime-gateway/src/http-setup.test.ts`
  boots the real process for the first time.

  The security consequence was TESTED rather than assumed, over a raw socket in both
  processes: space, JSON, quote, empty and over-length values are each replaced, the
  caller's bytes appear in neither the echoed header nor the log, and the record is
  still one parseable JSON line. Measured and recorded: an ANSI escape and a bare
  control byte are refused by NODE'S HTTP PARSER (400) before Fastify sees them, so
  `resolveRequestId` is the second layer for those two shapes, not the only one —
  the unit examples in `packages/config` stay, because a dependency's behaviour is
  not this repository's promise.

- **2026-09-06 — review round 1, the guard rails made to guard.** The mechanism was
  found sound by two independent mutation reviews; the findings were about rules
  that did not yet guard what they claimed. Applied: an exact-set assertion plus a
  never-loggable oracle over `LOG_ALLOWED_ERROR_FIELDS` (adding `detail` had left
  1150 examples green while a `pg` unique violation wrote an email to disk — it is
  now a COMPILE error as well, because the lists dropped their `readonly string[]`
  annotations); the `message` overlap declared as `LOG_ERROR_FIELD_CARVE_OUTS`
  rather than achieved by not looking; `msg` declared, so the object form of a log
  call keeps its sentence; `responseTime` asserted on a real auto-logged line in
  both processes; a cycle guard, a depth cap, an array cap, message and stack length
  caps, per-field try/catch and a `cause` chain in the error serializer; `req`/`res`
  narrowed by value as well as by name (`loggedScalar`); three more spellings in the
  audit gate (`ON CONFLICT DO UPDATE`, `GRANT`, `DROP`/`ALTER`), its roots and
  extensions widened, and its exemptions moved from whole-file to per-statement; the
  two vacuous header examples told honestly and the belt's real ground (a child
  binding `redact` removes and `formatters.log` never sees) given an actual example;
  a shared `loggerWiringProblems` in `packages/config` that both apps' tests call,
  replacing a gateway example that compared the gateway to itself.

  Every new rule was mutation-tested with `packages/config` rebuilt first — which is
  itself a finding from this round and is now written into the Verification block
  and into `AGENTS.md`.

- **2026-09-06 — `redact` KEPT as a belt; `loggerBaseOptions` gained the allow-list
  rather than swapping it for `redactPaths`.** The Execution line reads "trả
  allow-list **thay cho** `redactPaths`", which taken literally means the deny-list
  stops being handed to the apps and therefore stops being wired. But "Bỏ hẳn
  `redact` thay vì giữ nó làm đai an toàn" is an **Ask First** item, and there was
  no human in the loop to ask, so the non-asking option was taken: `LoggerBaseOptions`
  now carries `logFormatter`, `errorSerializer` and `allowedFields` **in addition to**
  `redactPaths`, and both apps wire `formatters.log` in front of the existing
  `redact`.

  The Boundaries condition attached to that choice was met rather than assumed: the
  order was read out of `pino/lib/tools.js` (`_asJson` runs `formatters.log`, then
  per-key `serializers`, then the redaction stringifiers) and pinned by an example,
  `applies the allow-list before redaction, so the two are ordered not redundant`.
  The belt is also not a rule nobody runs — `asChindings` applies the redaction
  stringifiers to CHILD bindings, which `formatters.log` never sees.

  Consequence for the Code Map: the deny-list rules listed as "losing their object"
  (`LOG_REDACT_PATHS (AD-15)`, the snake/camel pairing rule, `covers every field the
  spine names as never-loggable`, `base.redactPaths`) kept theirs and were kept,
  re-framed as tests of the belt. The allow-list got its own describe block with the
  inheritors the spec asked for: the anti-empty-sweep template, "the allow-list does
  NOT contain any field the spine forbids", and the `err.code` declaration. The
  argument that the pairing rule has no inheritor **because the problem stopped
  existing** is written into `packages/config/src/log-fields.ts` and into the new
  describe block, as instructed.

- **2026-09-06 — three measurements that changed the design, recorded because the
  spec asked for them to be made before designing.**
  1. `formatters.bindings` receives `base` (`service`, `version`); `formatters.log`
     never sees them. So neither is declared in the allow-list — declaring them
     would have been a rule nobody runs.
  2. `req` and `request_id` reach a line as CHILD bindings and pass through neither
     formatter, because pino replaces a child's bindings formatter with an identity
     function. The allow-list therefore neither protects nor endangers `request_id`,
     which is the load-bearing half of AC4.
  3. `formatters.log` runs BEFORE `serializers`, so at filter time `err` is still a
     live `Error`. That is why the three serializer-owned keys are passed through
     untouched at the root instead of being filtered twice.

- **2026-09-06 — `err.message` is KEPT, narrowing the "mimic `diagnosableWithoutTheData`"
  note.** The Matrix names `name`, `message`, `stack` as governed by the declared
  rule, and the rule declares all three plus `code`. Dropping `message` while keeping
  `stack` would remove nothing — a stack begins `"<name>: <message>"` — and would
  turn the existing green assertion on `MONEY_FIXTURE_FAILURE` red for no gain. The
  part of `diagnosableWithoutTheData` that IS mimicked is the frame cap (12) and the
  refusal to enumerate.

## Design Notes

**Vì sao `formatters.log` chứ không phải `serializers`.** `serializers` đánh theo **tên trường**: pino gọi `serializers.foo` khi payload có khoá `foo`. Một trường **chưa khai** thì không có serializer nào để gọi, nên nó đi thẳng ra log. `formatters.log(object)` nhận **cả object đã merge** trên mọi dòng, nên nó là chỗ duy nhất phát biểu được "chỉ những khoá này được đi tiếp". Chọn `serializers` là giao một story trông đúng và không đạt AC4.

**Vì sao allow-list xoá cả một lớp lỗi, không chỉ đổi hình dạng.** Deny-list đã rò hai lần vì cùng một lý do: mỗi trường tồn tại ở hai từ vựng — snake_case trên dây, camelCase trên type của `packages/domain` — và một danh sách nêu một cách viết chỉ bảo vệ một nửa. Với allow-list, `dateOfBirth` không vào log **vì nó chưa được khai**, không phải vì ai đó nhớ liệt kê nó. Bài toán ghép cặp biến mất về mặt cấu trúc. Đó là lý do luật `:57` trong `logging.test.ts` không có kế thừa — và việc nó không có kế thừa là **thành tựu**, không phải thiếu sót. Viết câu đó vào docblock.

**Bề mặt thật không nằm ở nơi trực giác chỉ.** Mã sản phẩm có **không** lời gọi log nào truyền object; cả sáu đều truyền chuỗi. Một allow-list áp lên lời gọi tay lọc đúng con số không, và một story dừng ở đó sẽ xanh mà không bảo vệ gì. Thứ thật sự chảy qua logger là những gì `pino-http` tự ghi vì `autoLogging` để mặc định: `req`, `res`, `responseTime`, `err`. `req`/`res` đã được allow-list từ trước. **`err` thì không** — serializer mặc định của pino duyệt cả thuộc tính tùy biến đếm được, nên một lỗi mang `error.token` hay `error.user` ghi thẳng nó ra đĩa. Đây là đường hở thật, và là phần có giá trị nhất của story.

**Thứ tự chạy là một cạm bẫy đo được.** `formatters.log` chạy **trước** `redact`. Nếu giữ deny-list làm đai an toàn thì phải kiểm thứ tự bằng test chứ không giả định — và nếu allow-list đã đúng thì deny-list phía sau không bao giờ thấy gì để che, tức nó thành một luật không ai chạy. Đó là quyết định Ask First, không phải quyết định lặng lẽ.

**`err.code` là ngoại lệ có lý do đã ghi.** `REDACTION_NOTES.bareCodeExcluded` tồn tại vì `*.code` từng suýt bị che chung, và `err.code` là chỗ mọi cuộc điều tra sự cố bắt đầu. Allow-list phải khai nó **rõ ràng**, và test phải chứng minh nó có mặt — một trường chẩn đoán biến mất im lặng là thứ chỉ bị phát hiện trong lúc đang có sự cố.

**Nửa gateway của AC2 không đóng được hôm nay, và đó là kết luận có bằng chứng chứ không phải sự lười.** `apps/realtime-gateway` có 5 file nguồn: `bootstrap`, `AppModule`, `GET /healthz`, cấu hình pino. Không WebSocket, không auth, không guard; `@nestjs/websockets` và LiveKit SDK chưa phải dependency. Không có kết nối DB nào — không pool, không runtime, không port — nên ghi một hàng audit cần bốn mảnh mới. `/healthz` là probe không xác thực, audit nó là một hàng mỗi lần probe trong một bảng không xoá được. Và AC2 nói "truy được **xuyên** hai process" trong khi hai process **chưa bao giờ gọi nhau** — kênh lệnh bền thuộc Epic 4. Đóng thật khi Epic 2 dựng `room_token.issued`.

**KHÓA NÀO THẬT SỰ TỚI `formatters.log` — kiểm bằng cách chạy, đừng tin dòng này.** pino tách nhiều đường: `formatters.bindings` xử lý phần `base` (`service`, `version`), `formatters.log` xử lý object của từng dòng, còn `level`/`time`/`msg` do pino tự gắn ngoài cả hai. Thêm vào đó `request_id` không đến từ mã của ta — nó do `customProps` của **pino-http** merge vào (`apps/api/src/logging.ts:34`). Nếu `request_id` đi bằng một đường mà `formatters.log` không nhìn thấy thì allow-list vừa không bảo vệ được nó vừa không làm hỏng nó, và cả hai đều là kết luận sai nếu chỉ suy luận. **Việc đầu tiên của agent hiện thực là in ra object mà `formatters.log` thật sự nhận, ở một dòng log tự viết và một dòng do `autoLogging` sinh, rồi mới thiết kế allow-list theo đó.** Nếu `base` không đi qua `formatters.log` thì `service`/`version` không cần khai — và khai thừa một khoá không tồn tại là một luật không ai chạy.

**Allow-list quá chặt làm log vô dụng, và đó cũng là một cách hỏng.** Mục tiêu là PII không rò, không phải log trống. `msg`, `err.name`, `err.stack`, `err.code`, `req.method`, `req.url` đã lọc, `res.statusCode`, `responseTime` và `request_id` là những thứ khiến một dòng log đáng giữ. Ca `still records the path and the request id, so the log is worth keeping` đã tồn tại ở `apps/api/src/logging.test.ts:290`, `:467`, `:650` — giữ chúng xanh là điều kiện, không phải tuỳ chọn.

## Verification

**Commands:**
- `corepack pnpm run typecheck` -- expected: exit 0
- `corepack pnpm run dep-check` -- expected: không vi phạm
- `corepack pnpm run build:packages && corepack pnpm --filter api build && corepack pnpm exec vitest run` -- expected: mọi test xanh, 0 skip; mỗi hàng Matrix có test **đã chạy và pass**
- `corepack pnpm exec playwright test` -- expected: 46 ca hiện có vẫn xanh (story này không thêm ca e2e — không có màn hình nào)
- `corepack pnpm --filter api build` và `--filter realtime-gateway build` -- expected: exit 0

> **`vitest run` một mình kiểm chính sách CŨ.** `apps/*` nhập `@stuwith/config` dưới
> dạng `dist` đã build, nên sửa `log-fields.ts` rồi chạy `vitest run` mà không
> `build:packages` trước sẽ chạy lại danh sách cũ — vòng review 1 có một lần mutation
> xanh đúng vì lý do đó. CI an toàn (cổng build trước) và script gốc `pnpm test` cũng
> vậy; chỉ lối tắt là không. Dòng lệnh trên đã sửa lại cho đúng.

**Manual checks (if no CLI):**
- Mutation-test từng luật mới trước khi tin, và **build lại `packages/config` trước mỗi lần**: bỏ một trường khỏi allow-list, thêm một trường chưa khai vào payload, thêm một tên vào `LOG_ALLOWED_ERROR_FIELDS`, cắm `UPDATE audit_events` / `ON CONFLICT DO UPDATE` / `GRANT UPDATE ON audit_events` vào một file nguồn, và cho `resolveRequestId` tin header thô. Luật nào không đỏ là luật không tồn tại.


## Suggested Review Order

**Bộ lọc: khai một lần, và không khai thì không ghi**

- Điểm vào: ba danh sách khai báo — gốc, trường lỗi, và oracle của những thứ không bao giờ được ghi
  [`log-fields.ts:86`](../../packages/config/src/log-fields.ts#L86)

- Bốn tên duy nhất một `Error` được phép mang ra ngoài
  [`log-fields.ts:179`](../../packages/config/src/log-fields.ts#L179)

- `message` nằm ở cả hai danh sách, và đây là chỗ nói vì sao đó không phải mâu thuẫn
  [`log-fields.ts:202`](../../packages/config/src/log-fields.ts#L202)

- Luật ở TẦNG BIÊN DỊCH: thêm một tên bị cấm vào danh sách cho phép là lỗi `tsc`, không phải test đỏ
  [`log-fields.ts:315`](../../packages/config/src/log-fields.ts#L315)

- Hàm thuần lọc object đã merge, cùng luật ở mọi độ sâu, có chặn vòng lặp và trần độ sâu
  [`log-filter.ts:158`](../../packages/config/src/log-filter.ts#L158)

- Serializer `err` — đường đang hở thật, vì serializer mặc định của pino duyệt cả thuộc tính tùy biến
  [`log-filter.ts:229`](../../packages/config/src/log-filter.ts#L229)

**`request_id`: hàm chống giả mạo được test kỹ nhất repo, lần đầu được nối vào**

- `genReqId` thuộc về Fastify chứ không phải pino-http, và docblock giải thích cắm sai chỗ thì hỏng thế nào
  [`http-setup.ts:54`](../../apps/api/src/http-setup.ts#L54)

- Một dòng nối: Fastify hỏi id, `resolveRequestId` trả lời
  [`http-setup.ts:100`](../../apps/api/src/http-setup.ts#L100)

**Audit không thể bị gỡ bỏ**

- Sáu cách viết SQL có thể sửa hoặc xoá một hàng audit, kể cả `ON CONFLICT DO UPDATE` và `GRANT`
  [`audit-append-only.test.ts:125`](../../tests/gates/audit-append-only.test.ts#L125)

- Sáu gốc quét và các đuôi file — `infra` từng nằm trong danh sách mà đóng góp con số không
  [`audit-append-only.test.ts:60`](../../tests/gates/audit-append-only.test.ts#L60)

**Bằng chứng hành vi, qua pino thật**

- 35 ca cho hàm thuần: vòng lặp, trần độ sâu, getter ném lỗi, chuỗi `cause`, mảng
  [`log-filter.test.ts:38`](../../packages/config/src/log-filter.test.ts#L38)

- Đủ sáu mức log, ở cả hai process — lọc không được phụ thuộc vào mức
  [`logging.test.ts:314`](../../apps/api/src/logging.test.ts#L314)

- Mỗi lượt đăng nhập nối hàng audit với đúng dòng log của chính nó
  [`logging.test.ts:1170`](../../apps/api/src/logging.test.ts#L1170)

- Lần đầu process gateway được khởi động thật trong một test
  [`http-setup.test.ts:1`](../../apps/realtime-gateway/src/http-setup.test.ts#L1)
