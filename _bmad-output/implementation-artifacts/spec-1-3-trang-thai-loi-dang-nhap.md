---
title: 'Story 1.3 (phần 1) — Trạng thái lỗi đăng nhập và huỷ cấp quyền'
type: 'feature'
created: '2026-09-04'
baseline_commit: '1282a556030c836d1fbf429a18eaa48b44634b41'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Khi callback thất bại, `AuthService.failedSignIn` trả **JSON 401 thẳng vào trình duyệt** — nhưng người dùng đang đi bằng redirect từ provider về, nên thứ họ thấy là một cục JSON trên màn hình trắng. Và **huỷ ở bước cấp quyền chưa được nhận diện**: provider trả `error=access_denied`, code rơi vào nhánh `code_missing` và bị tính là lỗi, dù người dùng chỉ đổi ý.

**Approach:** Mọi kết cục của chặng callback trở thành **redirect về trang đăng nhập kèm một mã kết quả không lộ kỹ thuật**, lấy từ một enum đóng khai trong `packages/contracts`. Nhiều lý do nội bộ dồn về ít mã người-đọc-được; trang đăng nhập ánh xạ mã sang câu tiếng Việt. Huỷ là một kết cục riêng, trung tính, không phải lỗi.

## Boundaries & Constraints

**Always:**
- Mã kết quả gửi ra client là enum đóng khai ở `packages/contracts`. `SignInFailureReason` là **từ vựng audit nội bộ** và không bao giờ rời khỏi server — nó chứa những giá trị như `provider_exchange_failed` vốn ám chỉ provider nào đang hỏng.
- Không mã lỗi provider, không tên provider hỏng, không stack trace, không `SignInFailureReason` trong URL, thân phản hồi, hay chữ trên màn hình.
- Mỗi lần thử vẫn sinh **đúng một** dòng audit mang `request_id`, kể cả khi người dùng huỷ. "Không phải lỗi" nói về giao diện, không nói về tính truy vết.
- Câu chữ dùng **nguyên văn** AC: `Không đăng nhập được. Thử lại hoặc chọn cách khác.` và `Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới.`
- Mã kết quả đến từ URL là dữ liệu người ngoài kiểm soát: giá trị lạ phải rơi về trạng thái mặc định an toàn, không bao giờ render thẳng ra màn hình.
- Cả hai chặng callback (`@Get` và `@Post` của Apple) đi chung một đường xử lý kết cục.

**Ask First:**
- Thêm bất kỳ dependency nào. Story này không cần cái nào mới.
- Đổi `AUDIT_ACTIONS` hoặc hình dạng `auditEventSchema` trong `packages/contracts`.

**Never:**
- Rate limit, khoá brute-force, đếm ngược bằng giây — **đã tách khỏi story này** ngày 2026-09-04, nằm trong `deferred-work.md`.
- Dialog phiên hết hạn và cơ chế quay lại đúng chỗ — **đã tách**, cũng trong `deferred-work.md`.
- Token thiết kế, styling, i18n đầy đủ — Story 1.6. Trang đăng nhập vẫn là khung trần, đúng như Story 1.2 để lại.
- Đổi luồng OAuth, hình dạng phiên, cookie, hay lược đồ DB. Story này chỉ đổi **kết cục được kể lại thế nào**.
- Thêm bảng hay migration. Không có cái nào cần.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Thất bại kỹ thuật | Callback với `state` lệch, thiếu `code`, hoặc đổi code hỏng | 302 về `/dang-nhap` kèm mã kết quả `that-bai`; trang hiện đúng câu AC1 | Không mã lỗi, không tên provider, không stack trace |
| Người dùng huỷ | Callback mang `error=access_denied` | 302 kèm mã `da-huy`; trang hiện đúng câu AC2, **không** tô như lỗi | Không tính là lỗi ở giao diện |
| Huỷ kiểu Apple | Callback mang `error=user_cancelled_authorize` | Cùng kết cục `da-huy` | Như trên |
| Provider báo lỗi khác | `error=server_error` hoặc `error=temporarily_unavailable` | Dồn về `that-bai` — người dùng không cần biết provider hỏng kiểu gì | Chi tiết chỉ vào audit và log |
| Huỷ vẫn để lại vết | Bất kỳ luồng huỷ nào | Đúng một dòng `auth.sign_in_failed`, reason `user_cancelled`, mang `request_id` | N/A |
| Thất bại vẫn để lại vết | Bất kỳ luồng thất bại nào | Đúng một dòng `auth.sign_in_failed` với reason nội bộ thật | N/A |
| Từ vựng nội bộ không rò | Mọi kết cục thất bại | URL đích và thân phản hồi **không chứa** giá trị nào của `SignInFailureReason` | N/A |
| Mã kết quả bịa | Người dùng tự mở `/dang-nhap?ket-qua=<chuỗi lạ>` | Trang render như lần vào bình thường, không thông báo nào | Giá trị lạ bị bỏ, không render ra màn hình |
| Mã kết quả là mã độc | `?ket-qua=<script>alert(1)</script>` | Không bao giờ tới màn hình; enum đóng chặn từ đầu | Không phản chiếu input |
| Cookie state vẫn được dọn | Callback thất bại giữa chừng | Cookie state của **chính lần thử đó** bị xoá, tab khác đang đăng nhập không bị ảnh hưởng | N/A |
| Apple form_post thất bại | POST callback với `error=access_denied` trong thân | Cùng kết cục `da-huy` như nhánh `@Get` | N/A |
| Đăng nhập thành công | Callback hợp lệ | 302 về `/dang-nhap` **không kèm** mã kết quả nào | N/A |

</frozen-after-approval>

## Code Map

**Nơi phải sửa — đọc trước:**
- `apps/api/src/auth/auth.service.ts:492` -- `failedSignIn` hiện trả `{kind:'json', status:401}`. Đây **chính là** khiếm khuyết: người dùng đến bằng redirect trình duyệt nên nhận JSON thô. Phải thành `{kind:'redirect'}`
- `apps/api/src/auth/auth.service.ts:270` -- mẫu redirect thành công, kèm cách xoá đúng cookie state của lần thử đó (`:274-277`) — giữ nguyên hành vi đó ở nhánh thất bại
- `apps/api/src/auth/auth.service.ts:213,220,242,250` -- bốn điểm gọi `failedSignIn` ở chặng callback; tất cả phải đi qua ánh xạ mới
- `apps/api/src/auth/auth.service.ts:194` -- `callback()`; **chưa hề đọc tham số `error`** của provider. Đây là chỗ AC2 sinh ra
- `apps/api/src/auth/audit.ts:32-48` -- `SignInFailureReason`. Thêm `user_cancelled`; docblock `:28-31` đã nói rõ danh sách phải đầy đủ, giữ đúng tinh thần đó
- `apps/api/src/auth/auth.controller.ts:28,55` -- hai chặng callback (`@Get` và `@Post` của Apple) cùng gọi `this.auth.callback`, nên sửa ở service là đủ cho cả hai
- `apps/web/src/app/dang-nhap/page.tsx:37` -- `DangNhapPage`; hiện chỉ có ba trạng thái `loading`/`signed-out`/`signed-in`, chưa có chỗ nào kể kết cục lần thử vừa rồi

**Đọc để bám quy ước, không sửa:**
- `packages/contracts/src/auth.ts:16-21` -- mẫu khai enum đóng kèm type guard; mã kết quả mới theo đúng hình dạng này
- `packages/contracts/src/error.ts:96-109` -- envelope lỗi; vẫn dùng cho các endpoint JSON (`/me`, `/refresh`), **không** dùng cho chặng callback nữa
- `apps/api/src/auth/auth.flow.test.ts:237-312` -- các test "state sai hoặc thiếu" hiện assert 401 JSON; chúng sẽ phải đổi theo hành vi mới, và `:279` ("names no provider and no provider error code") là bất biến phải sống sót
- `apps/api/src/logging.test.ts:181-249` -- mẫu chạy pino thật rồi assert không rò rỉ
- `vitest.config.mts` -- project `api` và `contracts`; test mới rơi vào hai chỗ đó

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/auth.ts` (+ export ở `index.ts`) -- Khai `SIGN_IN_OUTCOMES = ['that-bai','da-huy']`, schema, type guard, và tên tham số truy vấn (`ket-qua`). -- AD-13: mã này qua ranh giới process nên không được khai ở `apps/*`.
- [x] `apps/api/src/auth/audit.ts` -- Thêm `user_cancelled` vào `SignInFailureReason`. -- Huỷ không phải lỗi ở giao diện nhưng vẫn phải để lại vết; docblock hiện có đã đòi danh sách đầy đủ.
- [x] `apps/api/src/auth/auth.service.ts` -- `callback()` đọc tham số `error` của provider trước mọi thứ khác; `failedSignIn` đổi sang redirect kèm mã kết quả; thêm ánh xạ **nội bộ → công khai** ở đúng một chỗ, exhaustive trên `SignInFailureReason`. Giữ nguyên việc chỉ xoá cookie state của lần thử đó. -- Trái tim story: nhiều lý do nội bộ dồn về ít mã công khai, và phép dồn đó là thứ chặn rò rỉ.
- [x] `apps/web/src/app/dang-nhap/page.tsx` -- Đọc `ket-qua` từ URL, ánh xạ qua enum sang câu tiếng Việt nguyên văn AC, hiện huỷ ở giọng trung tính và thất bại ở giọng lỗi. Mã lạ thì bỏ qua im lặng. Dọn tham số khỏi URL sau khi hiện để refresh không lặp lại thông báo. **Vẫn khung trần, không style.** -- AC1 và AC2 là câu chữ trên màn hình; đây là nơi duy nhất chúng tồn tại.
- [x] `apps/api/src/auth/auth.flow.test.ts` -- Sửa các test đang assert 401 JSON sang redirect + mã kết quả; thêm phủ cho mọi hàng Matrix, gồm cả huỷ kiểu Apple qua `@Post` và khẳng định **không giá trị `SignInFailureReason` nào** xuất hiện trong URL đích. -- Matrix không có test là Matrix không có hiệu lực.
- [x] `packages/contracts/src/contracts.test.ts` -- Ghim enum mã kết quả và type guard, gồm cả việc từ chối chuỗi lạ. -- Enum đóng chính là lớp chặn XSS/phản chiếu; nó cần test riêng chứ không chỉ được dùng.
- [x] `apps/api/src/logging.test.ts` -- Nối thêm: chạy một lần callback thất bại và một lần huỷ với pino thật, assert không dòng log nào chứa mã lỗi provider hay tên provider hỏng. -- Hàng "từ vựng nội bộ không rò" phải đúng ở cả log lẫn phản hồi.

**Acceptance Criteria:**
- Given `pnpm check && pnpm test`, when chạy trên repo sạch, then xanh, và không test cũ nào của Story 1.2 bị bỏ đi để cho qua — test nào đổi thì đổi vì **hành vi** đổi.
- Given một lần đăng nhập thất bại vì bất kỳ lý do kỹ thuật nào, when người dùng quay lại giao diện, then thấy đúng câu AC1 và **không** thấy mã lỗi, tên provider, hay stack trace.
- Given người dùng huỷ ở bước cấp quyền, when quay lại app, then thấy đúng câu AC2, giao diện **không** trình bày đây là lỗi, nhưng audit vẫn có đúng một dòng mang `request_id`.

## Spec Change Log

## Design Notes

**Vì sao nhiều-về-ít, không phải một-đổi-một:** cám dỗ là đẩy thẳng `SignInFailureReason` ra URL — đúng một dòng code. Nhưng danh sách đó chứa `provider_exchange_failed`, `state_expired`, `identity_rejected`; ghép lại chúng kể cho người ngoài biết hạ tầng đang hỏng ở đâu và cái gì đang bị từ chối. AC viết *"không hiện mã lỗi, tên provider hỏng"*, và cách duy nhất giữ được điều đó khi danh sách nội bộ dài ra là **phép dồn phải nằm ở một chỗ và exhaustive** — thêm một lý do nội bộ mà quên ánh xạ thì typecheck đỏ, không phải rò rỉ âm thầm.

**Vì sao huỷ vẫn ghi audit:** AC nói huỷ *"không được coi là lỗi"*. Đó là câu về giao diện. Một luồng đăng nhập không để lại vết khi người dùng bỏ ngang là luồng không điều tra được — và "rất nhiều người bỏ ngang ở Facebook từ hôm qua" là đúng loại tín hiệu chỉ thấy được nếu có ghi. Vậy: audit có, màu sắc giao diện thì không.

**Vì sao dọn tham số khỏi URL sau khi hiện:** để lại thì người dùng nhấn F5 sẽ thấy lại "Không đăng nhập được" dù chưa thử lại lần nào — một thông báo nói dối về hiện tại.

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0
- `pnpm test` -- expected: exit 0; số test tăng, không suite nào bị xoá
- `pnpm --filter api build && pnpm --filter web build` -- expected: exit 0
- `pnpm test:e2e` -- expected: smoke test cũ vẫn xanh
- `grep -rn "provider_exchange_failed\|state_mismatch\|identity_rejected" apps/web/src` -- expected: **không kết quả nào**; từ vựng nội bộ không được có mặt ở client

**Manual checks (if no CLI):**
- Mở `/dang-nhap?ket-qua=that-bai` và `?ket-qua=da-huy`: đúng hai câu AC, huỷ không trình bày như lỗi
- Mở `/dang-nhap?ket-qua=%3Cscript%3Ealert(1)%3C/script%3E`: không thông báo nào, không script nào chạy

**2026-09-04 — story bị cắt đôi trước khi lập spec.** `epics.md` viết Story 1.3 gồm bốn AC.
Ở bước multi-goal check, ba deliverable độc lập ship được đã được nhận diện: (1) trạng thái
lỗi và huỷ cấp quyền, (2) rate limit theo IP/user kèm đếm ngược, (3) dialog phiên hết hạn
và cơ chế quay lại đúng chỗ. Con người chọn **[S] tách, làm trạng thái lỗi trước**. Spec này
chỉ phủ (1); (2) và (3) đã ghi vào `deferred-work.md` cùng ngày kèm ràng buộc để không phải
nghĩ lại — trong đó có cảnh báo rằng cơ chế quay-lại của (3) chỉ được nhận đường dẫn
same-origin, nếu không nó là một lỗ open-redirect nằm ngay trong luồng đăng nhập.

**Hệ quả cần nhớ khi đọc sổ sách:** khoá trong `sprint-status.yaml` vẫn mang tên
`1-3-trạng-thái-lỗi-đăng-nhập-và-chống-brute-force`, tức tên nó hứa cả phần chống brute-force
vốn đã bị tách ra. Vì vậy story này **không được đánh dấu `done`** khi phần 1 xong — để `review`
và đọc `deferred-work.md` để biết còn nợ gì.

**2026-09-04 — Matrix Test Audit chặn một lần trước khi vào review.** Hai hàng cuối của
I/O Matrix ("mã kết quả bịa" và "mã kết quả là mã độc") nói về thứ *trang web render*, nhưng
`vitest.config.mts` không có project `web` nào, nên không gì chạy đường render đó. Enum bị
từ chối thì đã có test ở `contracts.test.ts`; việc trang **dùng** enum thì không. Đổi
`if (isSignInOutcome(raw))` thành `raw as SignInOutcome` sẽ để cả 485 test xanh trong khi hai
hàng đó thành sai. Đã đóng bằng một project `web` thật (render bằng `renderToStaticMarkup` của
`react-dom`, vốn đã là dependency — không thêm package nào) và đưa vào `test:unit` để CI chạy.

**KEEP — phải sống sót qua mọi lần dựng lại sau này:**
- `publicOutcomeFor` là `switch` không có `default`. Thiếu một case thì hàm thiếu đường `return`
  và typecheck đỏ. Thêm `default` hay ép kiểu ở đây là xoá đúng cơ chế chặn rò rỉ.
- Test XSS khẳng định giá trị thô **không xuất hiện ở bất kỳ đâu** trong HTML, chứ không dừng ở
  "đã được escape" — vì "đã escape" là mức người ta chấp nhận khi giá trị *có* được phản chiếu.
- Callback thất bại **không** được xoá cookie phiên đang có. Một lần đăng nhập mới hỏng không
  phải lý do để đăng xuất người ta khỏi phiên họ đang dùng.

## Suggested Review Order

**Phép dồn — đọc trước tiên**

- Điểm vào: `switch` không `default`, nên thiếu một ánh xạ là typecheck đỏ chứ không rò rỉ.
  [`auth.service.ts:750`](../../apps/api/src/auth/auth.service.ts#L750)

- Từ vựng nội bộ, khai một chỗ; nó không bao giờ được rời khỏi server.
  [`audit.ts:50`](../../apps/api/src/auth/audit.ts#L50)

- Từ vựng công khai: đúng hai giá trị, enum đóng — cũng chính là lớp chặn XSS.
  [`auth.ts:132`](../../packages/contracts/src/auth.ts#L132)

**Kết cục được kể lại thế nào**

- Khiếm khuyết gốc: JSON 401 vào trình duyệt, nay thành redirect kèm mã kết quả.
  [`auth.service.ts:652`](../../apps/api/src/auth/auth.service.ts#L652)

- 303 chứ không 302: callback của Apple là POST, method phải bị hạ rõ ràng.
  [`auth.service.ts:646`](../../apps/api/src/auth/auth.service.ts#L646)

- Đọc `error` trước mọi thứ khác — provider đã nói không thì `state` chẳng còn gì để quyết.
  [`auth.service.ts:240`](../../apps/api/src/auth/auth.service.ts#L240)

- Tham số lặp về dạng mảng; không chuẩn hoá thì một lần huỷ bị kể thành một lần lỗi.
  [`auth.service.ts:691`](../../apps/api/src/auth/auth.service.ts#L691)

**Cookie handshake — chỉ đụng đúng cái của mình**

- Xoá cookie phải khớp provider, nếu không giết luôn tab khác đang đăng nhập dở.
  [`auth.service.ts:589`](../../apps/api/src/auth/auth.service.ts#L589)

- Quét cookie đã chết để header không phình tới mức 431; cookie còn sống thì để yên.
  [`auth.service.ts:611`](../../apps/api/src/auth/auth.service.ts#L611)

**Câu chữ trên màn hình**

- Một record cho cả câu lẫn vai trò a11y, để hai thứ không lệch nhau.
  [`sign-in-outcome.tsx:45`](../../apps/web/src/app/dang-nhap/sign-in-outcome.tsx#L45)

- Đọc và ghi lại URL trong **một** lời gọi, nên "ghi trước khi đọc" không diễn đạt được.
  [`sign-in-outcome.tsx:166`](../../apps/web/src/app/dang-nhap/sign-in-outcome.tsx#L166)

- Cắt theo đoạn, không dựng lại query — tham số của người khác giữ nguyên từng byte.
  [`sign-in-outcome.tsx:84`](../../apps/web/src/app/dang-nhap/sign-in-outcome.tsx#L84)

- Chốt chặn: giá trị lạ không thành outcome, nên không gì từ URL tới được màn hình.
  [`sign-in-outcome.tsx:122`](../../apps/web/src/app/dang-nhap/sign-in-outcome.tsx#L122)

**Kiểm chứng**

- Ghim trọn URL kèm origin; chỉ ghim path thì đổi sang host API vẫn xanh.
  [`auth.flow.test.ts:61`](../../apps/api/src/auth/auth.flow.test.ts#L61)

- Khẳng định giá trị thô vắng mặt hoàn toàn, không dừng ở "đã được escape".
  [`sign-in-outcome.test.tsx:1`](../../apps/web/src/app/dang-nhap/sign-in-outcome.test.tsx#L1)

- Chạy pino thật rồi soi từng dòng log tìm chi tiết provider.
  [`logging.test.ts:181`](../../apps/api/src/logging.test.ts#L181)

- Test file nằm ngoài đồ thị build của web, và `vitest` được khai ở nơi nó được dùng.
  [`tsconfig.json:31`](../../apps/web/tsconfig.json#L31)
