---
title: 'Story 1.3 (phần 2) — Rate limit đăng nhập và khoá brute-force'
type: 'feature'
created: '2026-09-04'
baseline_commit: 'eaceeff266bdb8901e25d86e6bb691671fdb918c'
status: 'done'
review_loop_iteration: 4
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Không có lớp chặn nào ở tầng ứng dụng. Ai cũng gọi được `/v1/auth/*` trong vòng lặp: dò phiên, bơm phình `audit_events` — bảng append-only mà **không role nào có `DELETE`** nên chỉ lớn lên. `VALKEY_URL` đã được validate lúc khởi động nhưng chưa gì kết nối tới Valkey.

**Approach:** Bộ đếm cửa sổ trượt trên Valkey, khoá theo **IP** và theo **user**, cộng một khoá brute-force dài hơn khi thất bại lặp lại. Chính TTL của Valkey là nguồn của con số đếm ngược, nên số giây hiện ra là thật chứ không phải hằng số đoán. Chính sách là hàm thuần trong `packages/domain`; Valkey chỉ là adapter.

## Boundaries & Constraints

**Always:**
- **IP thật phải được suy ra đúng, và chỉ tin proxy đã khai.** `X-Forwarded-For` chỉ được đọc khi **peer ở đầu socket nằm trong danh sách địa chỉ/CIDR proxy khai trong env**; kết nối trực tiếp thì header bị bỏ hoàn toàn. Đếm hop mà không kiểm peer là thứ Fastify đã gỡ vì lý do bảo mật — kẻ nối thẳng vào cổng API chỉ cần tự thêm đủ hop là chọn được khoá rate-limit của mình. Biến này **bắt buộc**, fail-fast nếu thiếu hoặc rỗng.
- **Fail open khi Valkey không trả lời** (quyết định của con người, 2026-09-04): cho request đi tiếp, nhưng ghi một dòng log mức `error` nêu rõ lớp chặn đang không hoạt động. Sự cố không bao giờ được im lặng.
- Con số đếm ngược lấy từ **TTL thật** của khoá, không phải hằng số cấu hình.
- Giới hạn và cửa sổ đọc từ env, có giá trị mặc định hợp lý (đây là knob vận hành, không phải bí mật — khác với credential).
- Thông báo cho người dùng **không nêu lý do kỹ thuật**: không nói khoá theo IP hay theo user, không nói ngưỡng, không nói còn bao nhiêu lượt.
- Chặng callback và start trả về trình duyệt thì đi đúng đường của Story 1.3 phần 1: redirect kèm mã kết quả từ enum đóng. Endpoint JSON thì trả `429` + envelope `rate_limited` + header `Retry-After`.
- Áp dụng qua **decorator/metadata**, không chép điều kiện vào từng handler — cùng khuôn mà epic context đã định cho cổng tuổi.
- Giây nhận từ URL là dữ liệu người ngoài kiểm soát: phải là số nguyên trong khoảng hợp lệ, ngoài khoảng thì bỏ.
- Đồng hồ đếm ngược **vẫn chạy dưới `prefers-reduced-motion`** — đó là thông tin, không phải hiệu ứng trang trí.

**Ask First:**
- **Nơi đặt adapter Valkey.** Cây nguồn do spine cố định không có `packages/cache`. Spec này đề xuất `packages/db/src/valkey/` để dùng lại test-kit hợp đồng hai lượt sẵn có, chấp nhận việc tên package hơi lệch nghĩa. Muốn thêm package mới thì phải renegotiate cây nguồn.
- Thêm bất kỳ dependency nào ngoài `iovalkey@0.4.0` đã chốt.
- Đổi `AUDIT_ACTIONS` trong `packages/contracts`.

**Never:**
- Chặn `POST /v1/auth/logout`. Đăng xuất bị rate-limit nghĩa là giữ người ta trong phiên họ muốn thoát.
- Dùng Postgres làm kho đếm — đã cân nhắc và loại ngày 2026-09-04.
- Rate limit cho các endpoint ngoài `/v1/auth/*`. Toàn cục là việc của WAF ở gateway.
- Dialog phiên hết hạn và cơ chế quay lại đúng chỗ (AC4) — vẫn nằm trong `deferred-work.md`.
- Token thiết kế, styling — Story 1.6. Trang đăng nhập vẫn khung trần.
- Sửa lược đồ Postgres. Story này không cần migration nào.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Dưới ngưỡng | Vài lần thử từ một IP | Đi tiếp bình thường, không header giới hạn nào cần thiết | N/A |
| Vượt ngưỡng theo IP | Quá số lần cho phép trong cửa sổ, cùng IP | Chặn; endpoint JSON trả `429` + `rate_limited` + `Retry-After`; chặng trình duyệt redirect kèm mã khoá và số giây | Không nêu ngưỡng, không nêu chiều bị khoá |
| Vượt ngưỡng theo user | Cùng user, nhiều IP khác nhau, vượt ngưỡng ở `/v1/auth/refresh` | Chặn theo user dù IP đổi | Như trên |
| Đếm ngược là thật | Bị chặn, chờ một lúc rồi thử lại | Số giây trả về **giảm dần** theo thời gian đã trôi, không phải hằng số lặp lại | N/A |
| Hết cửa sổ | Chờ quá cửa sổ rồi thử lại | Được phép trở lại, bộ đếm đã tự hết hạn | N/A |
| Khoá brute-force | Thất bại liên tiếp vượt ngưỡng riêng | Khoá dài hơn khoá thường; lần thử thành công cũng không mở sớm | N/A |
| Thành công dọn bộ đếm thất bại | Đăng nhập thành công sau vài lần trượt | Bộ đếm **thất bại** của khoá đó được dọn, người dùng không bị phạt tiếp | N/A |
| IP sau proxy | Hai người dùng khác nhau sau cùng một Caddy, peer là địa chỉ proxy đã khai | Được tính là **hai** IP, không bóp chung | N/A |
| `X-Forwarded-For` giả, nối trực tiếp | Client nối **thẳng** tới cổng API kèm `X-Forwarded-For` tự đặt | Header **bị bỏ hoàn toàn**; khoá đếm là địa chỉ socket thật | Peer không nằm trong danh sách proxy thì không tin gì trong header |
| Valkey sập | Valkey không trả lời | Request **đi tiếp** (fail open); một dòng log mức `error` nêu lớp chặn đang hỏng | Không 500, không chặn người dùng |
| Valkey trả chậm | Lệnh vượt quá thời gian chờ | Xử lý như sập: đi tiếp, có log | Không treo request |
| Đăng xuất không bị chặn | Gọi `POST /v1/auth/logout` nhiều lần | Luôn đi tiếp | N/A |
| Giây trong URL bịa | `?giay=abc`, `?giay=-5`, `?giay=99999999` | Hiện thông báo khoá **không kèm** đồng hồ, thay vì hiện số vô lý | Giá trị ngoài khoảng bị bỏ |
| Đếm ngược khi giảm chuyển động | `prefers-reduced-motion: reduce` | Đồng hồ **vẫn đếm**; chỉ hiệu ứng trang trí bị tắt | N/A |
| Thiếu env proxy tin cậy | Khởi động thiếu biến khai proxy, **hoặc để nó rỗng** | Process exit khác 0, nêu đúng tên biến, trước khi mở cổng | Rỗng không được coi là "không có proxy"; không đoán mặc định |

</frozen-after-approval>

## Code Map

**Nơi phải sửa — đọc trước:**
- `apps/api/src/main.ts:13-17` -- `NestFactory.create` với `new FastifyAdapter()` **không tuỳ chọn nào**; đây là chỗ `trustProxy` phải được đặt, và là gốc của cả hàng "IP sau proxy" lẫn hàng "`X-Forwarded-For` giả"
- `apps/api/src/http-setup.ts:13` -- `configureHttpApp`, nơi CORS đã được gom; guard toàn cục hoặc cấu hình chung thuộc về đây
- `apps/api/src/auth/auth.controller.ts:19,28,55,71,76,81` -- sáu route; **`logout` ở `:76` không được chặn**
- `packages/config/src/schema.ts:121` -- `VALKEY_URL` đã validate nhưng chưa ai kết nối. `:183` là mẫu `superRefine` cho ràng buộc liên biến
- `packages/contracts/src/auth.ts:132` -- `SIGN_IN_OUTCOMES` hiện đúng hai giá trị; khoá cần một mã thứ ba, và một tên tham số cho số giây
- `apps/web/src/app/dang-nhap/sign-in-outcome.tsx:45` -- `OUTCOME_NOTICES`; thêm mã mới là thêm một entry, TypeScript sẽ bắt nếu quên
- `apps/web/src/app/dang-nhap/sign-in-outcome.tsx:122,166` -- `resolveSignInOutcome` và `nextLocationAfterOutcome`; tham số giây phải đi qua đúng hai hàm này để được lọc và được dọn khỏi URL

**Đọc để bám quy ước, không sửa:**
- `packages/domain/src/ports/heartbeat-port.ts:30-102` -- hình dạng port chuẩn: refusal là nhánh `{ok:false}` caller buộc phải xử lý, input sai thì `throw`, **fault không bao giờ biến thành refusal**. Rate limit có đúng ba kết cục đó
- `packages/db/src/test-kit.ts` -- `runIdentityPortContract` / `runSessionPortContract` / `runAuditPortContract`; port mới theo cùng khuôn, chạy hai lượt
- `packages/db/src/__testing__/postgres.ts:25-49` -- mẫu harness Testcontainers, gồm cả `testcontainersDisabled` vốn **ném lỗi nếu bị bật trong CI**; harness Valkey theo đúng cách đó
- `infra/docker-compose.yml:40-59` -- Valkey đã có trong stack, image `valkey/valkey:9.0.4-alpine`, dùng đúng tag đó cho Testcontainers
- `packages/contracts/src/error.ts:79-94` -- `detailValueSchema` cho phép `number`, nên `retry_after_seconds` vào được `details`
- `apps/api/src/auth/auth.service.ts:652` -- `failedSignIn`: mẫu redirect kèm mã kết quả của Story 1.3 phần 1
- `.github/workflows/ci.yml:155` -- gate 3 chạy `--project db`, nên test hợp đồng mới tự động được phủ

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/ports/rate-limit-port.ts` -- Port với ba kết cục: cho phép, từ chối kèm **số giây còn lại**, và fault propagate. Không import SDK. -- AD-1; theo khuôn `heartbeat-port.ts`.
- [x] `packages/domain/src/policies/rate-limit.ts` -- Hàm thuần: dựng khoá theo chiều (IP / user / brute-force) và chọn chính sách theo tên hành động. Test không cần mạng. **Việc suy IP tin cậy KHÔNG còn ở đây** — xem mục dưới. -- Chính sách dựng khoá vẫn phải kiểm được ở tầng không có hạ tầng.
- [x] `apps/api/src/rate-limit/request-identity.ts` -- Suy IP tin cậy bằng `@fastify/proxy-addr@5.1.0`, **chính gói mà Fastify 5 dùng**, nên danh sách proxy không thể được hiểu theo hai cách. Không tự parse IP hay CIDR ở bất kỳ đâu. -- Ba vòng review liên tiếp tìm ra lỗ trong bộ parse tự viết (đếm hop, rồi `/0`, rồi `/1`–`/7` và IPv6 dị dạng); đây là loại code không nên tự viết.
- [x] `packages/db/src/valkey/client.ts`, `rate-limit-adapter.ts` -- Kết nối `iovalkey@0.4.0` và cài đặt port bằng **một lệnh nguyên tử** tăng-rồi-đặt-TTL, đọc TTL thật để trả số giây. Timeout ngắn; lỗi kết nối **propagate**, không tự nuốt thành "cho phép". -- Quyết định fail-open thuộc về caller ở `apps/api`, không thuộc adapter; adapter nuốt lỗi là adapter nói dối.
- [x] `packages/db/src/in-memory/rate-limit-adapter.ts` -- Bản in-memory cùng port, có đồng hồ tiêm vào để test tua thời gian. -- TD-5, chạy hai lượt.
- [x] `packages/db/src/__testing__/valkey.ts` -- Harness Testcontainers cho `valkey/valkey:9.0.4-alpine`, theo đúng khuôn `postgres.ts` gồm cả luật cấm skip trong CI. -- Không có nó thì lượt "Valkey thật" chỉ là lời hứa.
- [x] `packages/db/src/test-kit.ts` + `rate-limit-contract.test.ts` + `.valkey.test.ts` -- Suite hợp đồng dùng chung, chạy in-memory và Valkey thật. -- Gate 3 đã chọn theo `--project db` nên tự được phủ.
- [x] `packages/config/src/schema.ts` -- Thêm `TRUSTED_PROXY_ADDRESSES` (**bắt buộc**, không mặc định, **từ chối rỗng**), giới hạn/cửa sổ cho từng chiều, ngưỡng và thời gian khoá brute-force, timeout Valkey. -- AD-14; hàng "thiếu env proxy tin cậy".
- [x] `apps/api/src/main.ts` + `http-setup.ts` -- Đặt `trustProxy` từ config. -- Không có bước này thì mọi con số rate limit đều sai, theo cả hai chiều.
- [x] `apps/api/src/rate-limit/` (guard, decorator, module) -- Decorator đánh dấu hành động; guard đọc metadata, suy IP, gọi port, và **quyết định fail open** khi port ném lỗi — kèm log mức `error`. Trả `429` cho endpoint JSON, redirect kèm mã khoá cho chặng trình duyệt. -- Epic context đòi guard tự động qua decorator/metadata, không chép điều kiện.
- [x] `apps/api/src/auth/auth.controller.ts` + `auth.service.ts` -- Đánh dấu năm route; **`logout` không đánh dấu**. Đăng nhập thành công thì dọn bộ đếm thất bại. -- Hàng "thành công dọn bộ đếm thất bại" và hàng "đăng xuất không bị chặn".
- [x] `packages/contracts/src/auth.ts` -- Thêm mã kết quả cho trạng thái bị khoá và tên tham số cho số giây; ghim khoảng hợp lệ của số giây. -- AD-13: cả hai process đọc chung một khai báo.
- [x] `apps/web/src/app/dang-nhap/sign-in-outcome.tsx` -- Thêm entry cho mã khoá; đọc và **lọc** số giây (số nguyên trong khoảng, ngoài thì bỏ); dọn cả hai tham số khỏi URL. -- Hàng "giây trong URL bịa".
- [x] `apps/web/src/app/dang-nhap/countdown.tsx` (hoặc tương đương) + page -- Đồng hồ đếm ngược mỗi giây tới 0 rồi mời thử lại, `aria-live` lịch sự, **không tắt dưới `prefers-reduced-motion`**. -- AC "đếm ngược thật bằng giây"; epic context nói rõ đồng hồ là thông tin, không phải hiệu ứng.
- [x] `apps/api/src/rate-limit/*.test.ts` + `apps/api/src/auth/auth.flow.test.ts` -- Phủ mọi hàng Matrix: hai chiều khoá, đếm ngược giảm thật, hết cửa sổ, brute-force, dọn sau thành công, IP sau proxy, XFF giả, Valkey sập và chậm, logout không bị chặn. -- Matrix không có test là Matrix không có hiệu lực.
- [x] `apps/web/src/app/dang-nhap/sign-in-outcome.test.tsx` -- Số giây hợp lệ, bịa, âm, quá lớn, không phải số; và mã khoá render đúng câu. -- Project `web` đã là required check từ phần 1.
- [x] `.env.example`, `AGENTS.md` -- Liệt kê biến mới với giá trị rỗng; ghi vào §6 rằng lớp chặn **fail open** và điều đó nghĩa là gì khi Valkey sập. -- Giữ "known gaps" trung thực.

**Acceptance Criteria:**
- Given `pnpm check && pnpm test`, when chạy trên repo sạch, then xanh; suite hợp đồng rate limit chạy đủ **hai lượt** (in-memory + Valkey thật qua Testcontainers).
- Given quá nhiều lần thử từ cùng một IP hoặc cùng một tài khoản, when thử tiếp, then bị chặn và nhận **đếm ngược thật bằng giây**, và thông báo **không** nêu lý do kỹ thuật, ngưỡng, hay chiều bị khoá.
- Given Valkey không trả lời, when người dùng đăng nhập, then vẫn vào được, và có một dòng log mức `error` nói lớp chặn đang không hoạt động.
- Given khởi động thiếu biến khai proxy tin cậy — thiếu hẳn, để rỗng, hoặc chỉ chứa dấu phân cách — when chạy `api`, then exit khác 0 nêu đúng tên biến, trước khi mở cổng. Và một dải rộng tới mức tin mọi peer bị từ chối như cấu hình sai, không phải được chấp nhận im lặng.

## Spec Change Log

### Vòng 4 — 2026-09-04

**Finding kích hoạt:** `compileTrustedProxies` chấp nhận `32.0.0.0/3`, `40.0.0.0/5`,
`96.0.0.0/4`, `132.0.0.0/6`. Chạy thật: peer nối trực tiếp từ `40.1.2.3` đặt
`X-Forwarded-For: 9.9.9.9` và hệ thống trả về `9.9.9.9`. Đây là lần thứ tư của cùng một lớp
lỗi trong cùng một hàm.

**Đã sửa gì trong spec:** thêm mục "Bất biến của danh sách proxy" (ngoài khối frozen), phát
biểu điều kiện chấp nhận theo tập hợp và bắt buộc test phải là property test duyệt không gian
prefix. Ba vòng trước spec chỉ nêu *ví dụ* cần chặn, nên mỗi vòng lập trình viên lại đoán lại
ranh giới và đoán hụt. Cũng sửa bốn liên kết chết trỏ tới `client-address.ts` đã xoá, và một
câu trong Design Notes vẫn khẳng định phép suy IP là hàm thuần trong `packages/domain`.

**Trạng thái xấu đã tránh:** theo đúng chữ của workflow, finding này là `bad_spec` và phải
revert toàn bộ story rồi re-derive. Con người đã hai lần chốt "vá tới, không revert" cho đúng
vùng này (vòng 1 và vòng 3), nên giữ nguyên quyết định đó — nhưng bất biến được ghi vào spec
để lần sau không phải suy ra từ ví dụ.

**KEEP — phải sống sót qua mọi lần re-derive:**
- Không tự parse IP hay CIDR ở bất kỳ đâu trong repo. Chỉ `@fastify/proxy-addr`.
- Luật "quá rộng" quyết định chính xác, không lấy mẫu. Không thêm địa chỉ mẫu để bịt ví dụ mới.
- `trustProxy` nhận **chuỗi**, không bao giờ nhận số.
- Adapter Valkey không có `try/catch`.
- `logout` không bao giờ bị rate limit.
- Đếm ngược lấy từ `PTTL` thật, làm tròn lên.
- Lỗi 4xx của provider **không** mặc nhiên là "ai đó đoán code": 401 và 429 là lỗi cấu hình
  hoặc quota của chính ta và không được tính vào khoá brute-force.

## Design Notes

**Vì sao `trustProxy` là phần nguy hiểm nhất, không phải bộ đếm:** bộ đếm sai thì thấy ngay. `trustProxy` sai thì im lặng và sai theo hai chiều đối nghịch — để mặc định `false` sau Caddy thì **mọi người dùng chung một IP**, một người bị khoá là cả sản phẩm bị khoá; bật `true` thì `X-Forwarded-For` hoàn toàn do client đặt, thêm một hop giả là vượt được giới hạn, tức lớp chặn tồn tại mà không chặn gì. Cả hai đều cho ra CI xanh. Vì vậy phép suy IP phải nằm ở **một chỗ duy nhất, test được**, chứ không phải một cờ boolean chôn trong bootstrap. (Vòng 3 đổi chỗ đó từ một hàm thuần trong `packages/domain` sang `apps/api/src/rate-limit/request-identity.ts` gọi `@fastify/proxy-addr` — xem Change Log.)

**Vì sao adapter không được tự fail open:** cám dỗ là `try/catch` ngay trong adapter Valkey rồi trả "cho phép". Làm vậy thì fault biến thành refusal — chính điều `heartbeat-port.ts` cấm — và caller mất khả năng phân biệt "còn lượt" với "hệ thống mù". Adapter để lỗi bay lên; guard ở `apps/api` bắt, quyết định cho qua, **và ghi log**. Quyết định nằm ở nơi biết đủ ngữ cảnh để ghi lại nó.

**Vì sao đếm ngược lấy từ TTL:** trả về hằng số cấu hình thì người dùng chờ đủ số giây được bảo rồi vẫn bị từ chối, vì cửa sổ thật bắt đầu sớm hơn. AC viết "đếm ngược **thật**", và thứ duy nhất biết sự thật là khoá đang sống trong Valkey.

**Vì sao `logout` được miễn:** mọi endpoint khác bị chặn là bất tiện; `logout` bị chặn là giữ người ta trong một phiên họ đang muốn thoát — nhất là trên máy dùng chung. Đó là lý do bảo mật, không phải ngoại lệ cho tiện.

### Bất biến của danh sách proxy

`compileTrustedProxies` phải từ chối một dải **quá rộng**, và phép kiểm đó phải **quyết định
chính xác**, không được lấy mẫu. Ba vòng review đầu đều vá theo ví dụ được nêu — đếm hop, rồi
`/0`, rồi `/1`–`/7` — và vòng 4 lại tìm ra `32.0.0.0/3`, `40.0.0.0/5`, `96.0.0.0/4`,
`132.0.0.0/6` đi lọt, vì luật khi đó hỏi predicate xem nó có tin **chín địa chỉ mẫu** không.
Dải nào nằm lọt giữa chín điểm đó thì qua. Lấy mẫu không trả lời được câu hỏi bao phủ.

Bất biến, phát biểu theo tập hợp chứ không theo ví dụ: **một dải được chấp nhận khi và chỉ khi
nó nằm trọn trong không gian địa chỉ nội bộ/đặc biệt, HOẶC nó đủ nhỏ để là một đội proxy có
thật.** "Đủ nhỏ" là một trần đếm địa chỉ, không phải một ngưỡng số bit đặt tay — `/12` IPv4
(1.048.576 địa chỉ) đủ chứa dải lớn nhất của Cloudflare, còn `10.0.0.0/8` được nhận nhờ nhánh
thứ nhất chứ không nhờ kích thước.

Test cho luật này phải là **property test duyệt toàn không gian prefix** — mọi độ dài prefix
từ `/0` tới `/24` ở nhiều offset trải khắp IPv4, cộng phần IPv6 tương ứng — chứ không phải một
danh sách ví dụ. Một test liệt kê ví dụ chỉ chứng minh được rằng ví dụ đã biết đã được vá, mà
đó đúng là thứ đã hỏng bốn lần liên tiếp.

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0; `dependency-cruiser` không báo `packages/domain` chạm `iovalkey`
- `pnpm test` -- expected: exit 0; suite rate limit chạy hai lượt, số test tăng, không suite nào bị xoá
- `pnpm test:contract` -- expected: exit 0, có mặt `rate-limit-contract` cả hai lượt
- `pnpm --filter api build && pnpm --filter web build` -- expected: exit 0
- `pnpm test:e2e` -- expected: smoke test cũ vẫn xanh
- Xoá biến khai proxy rồi khởi động `api`; lặp lại với giá trị rỗng, với `,`, và với `0.0.0.0/0` -- expected: cả bốn đều exit khác 0, nêu đúng tên biến, không mở cổng
- `docker compose -f infra/docker-compose.yml up -d valkey` rồi dừng container giữa chừng và thử đăng nhập -- expected: vẫn đăng nhập được, log có dòng `error` về lớp chặn

**Manual checks (if no CLI):**
- Mở trang đăng nhập ở trạng thái bị khoá: đồng hồ giảm từng giây tới 0 rồi mời thử lại; bật `prefers-reduced-motion: reduce` trong devtools và xác nhận đồng hồ **vẫn chạy**
- Đọc `.env.example`: mọi biến mới có mặt, không secret thật nào bị dán vào

**2026-09-04 — vòng review 1: `intent_gap`, con người renegotiate khối đóng băng và chọn vá tới trước.**

**Finding kích hoạt:** khối đóng băng bắt "cấu hình theo **số hop tin cậy** khai tường minh trong env".
Đó là hop-count-only trust, và `fastify@5.12.1` đã **gỡ nó như một bản vá bảo mật** — nguyên văn
trong `lib/request.js`: *"Hop-count-only trust cannot validate the immediate peer. Fail closed so
direct clients cannot spoof X-Forwarded-* values by supplying enough hops."* Cài đặt làm đúng lời
spec, nên `resolveClientIp` nhận `chain = [socket, ...forwarded.reverse()]` rồi lấy
`index = min(hops, chain.length - 1)`: với `hops = 1` và một kết nối **trực tiếp** tới cổng API mang
`X-Forwarded-For: 1.2.3.4` giả, hàm trả về `1.2.3.4`. Kẻ tấn công tự chọn khoá rate-limit và xoay
vòng vô hạn — lớp chặn chặn được người dùng thật nhưng không chặn được kẻ tấn công.

**Phân loại theo luật:** gốc nằm **trong** `<frozen-after-approval>`, tức `intent_gap`, tức phải
revert code và quay lại hỏi con người.

**Con người quyết:** (1) đổi sang **tin theo địa chỉ/CIDR proxy** — chỉ đọc `X-Forwarded-For` khi peer
ở đầu socket đúng là proxy đã khai; (2) **không revert**, vá tới trước.

**Lý do không revert:** ~4.300 dòng đã qua 723 test, trong khi chỗ sai đụng ba file. Cách suy IP là
một hàm thuần trong domain cộng một biến env; toàn bộ Valkey adapter, `RateLimitPort`, guard, filter
và đồng hồ đếm ngược không phụ thuộc vào nó. Dựng lại tất cả để đổi một hàm là phá nhiều hơn sửa —
cùng lập luận đã dùng ở vòng review của Story 1.1.

**Trạng thái xấu đã tránh:** không ship một rate limiter mà kẻ tấn công vượt được bằng một header,
và không mất bộ test hợp đồng hai lượt vốn đã chạy trên Valkey thật.

**KEEP — phải sống sót qua mọi lần dựng lại sau này:**
- Adapter Valkey **không có `try/catch`**. Nuốt lỗi ở đó biến fault thành refusal — đúng thứ
  `heartbeat-port.ts` cấm — và caller mất khả năng phân biệt "còn lượt" với "hệ thống đang mù".
  Quyết định fail-open thuộc về guard, nơi biết đủ ngữ cảnh để ghi lại nó.
- Đếm ngược lấy từ **`PTTL` thật**, không phải hằng số cấu hình, và làm tròn **lên**.
- `INCR` + `PEXPIRE` trong **một** script, không phải hai lệnh: chết giữa hai lệnh để lại bộ đếm
  không hạn dùng, tức khoá vĩnh viễn.
- `logout` **không** bị rate limit. Chặn nó là giữ người ta trong phiên họ muốn thoát.
- `trustProxy` nhận **chuỗi địa chỉ/CIDR**, không bao giờ nhận số. `fastify@5.11.3` và `5.12.1`
  cùng có trong cây phụ thuộc và hiểu dạng số **khác nhau** (5.12.1 trả `() => false` cho mọi
  số, như một bản vá bảo mật), nên một literal số sẽ âm thầm đổi nghĩa sau một lần bump. Cả hai
  bản đưa chuỗi vào `proxy-addr.compile` nguyên vẹn.
  *(Sửa 2026-09-04: mục này ban đầu ghi "dạng predicate". Predicate là cách vá cho hop-count và
  đã bị bỏ cùng hop-count; chuỗi mới là dạng đúng. Lý do thì không đổi.)*

## Suggested Review Order

**Suy IP thật — đọc trước tiên, đây là chỗ cả story sống hoặc chết**

- Điểm vào: header chỉ được đọc khi peer đúng là proxy đã khai; nối trực tiếp thì bỏ hẳn.
  Không tự parse IP — gọi thẳng `@fastify/proxy-addr`, cùng bản Fastify 5 dùng.
  [`request-identity.ts`](../../apps/api/src/rate-limit/request-identity.ts)

- Dải khai quá rộng bị từ chối lúc khởi động, và phép kiểm phải **chính xác** chứ không
  lấy mẫu: xem bất biến ở mục "Bất biến của danh sách proxy" bên dưới.
  [`trusted-proxies.ts`](../../packages/config/src/trusted-proxies.ts)

- Parse ra không proxy nào cũng là lỗi, trừ khi người vận hành viết đúng chữ `none`.
  [`trusted-proxies.ts`](../../packages/config/src/trusted-proxies.ts)

**Chính sách khoá**

- Tập hành động đóng — không có tên nào cho `logout`, nên nó không thể bị chặn do sơ ý.
  [`rate-limit.ts:19`](../../packages/domain/src/policies/rate-limit.ts#L19)

- Một hàm quyết chiều khoá theo kênh, nên nơi *tạo* khoá và nơi *thi hành* khoá không lệch nhau.
  [`rate-limit.ts:161`](../../packages/domain/src/policies/rate-limit.ts#L161)

**Fail open — quyết định của con người, và cái giá của nó**

- Lỗi input là defect nên ném lên; chỉ fault của kho mới được cho qua.
  [`rate-limit.guard.ts:98`](../../apps/api/src/rate-limit/rate-limit.guard.ts#L98)

- Một dòng khi vào trạng thái hỏng, im lặng trong lúc hỏng, một dòng khi hồi phục kèm số request đã lọt.
  [`rate-limit-health.ts:37`](../../apps/api/src/rate-limit/rate-limit-health.ts#L37)

**Bộ đếm**

- `INCR` + `PEXPIRE` một script, và vá lại TTL khi `PTTL < 0` để không ai bị khoá vĩnh viễn.
  [`rate-limit-adapter.ts:1`](../../packages/db/src/valkey/rate-limit-adapter.ts#L1)

**Màn hình**

- Đồng hồ nhận `clock` qua prop, nên render được component thật ở hai thời điểm mà không cần DOM.
  [`countdown.tsx:40`](../../apps/web/src/app/dang-nhap/countdown.tsx#L40)

**2026-09-04 — vòng review 3: bỏ bộ parse IP/CIDR tự viết, dùng `@fastify/proxy-addr`.**

**Finding kích hoạt:** `MIN_TRUSTED_PREFIX_BITS = 1` (đặt ở vòng 2) chặn `/0` nhưng để ngỏ `/1`–`/7`.
Probe trên code đã build: `0.0.0.0/1` với peer `100.64.0.7`, và `128.0.0.0/1` với peer `203.0.113.9`,
đều cho phép giả mạo `X-Forwarded-For` — hai dải `/1` cộng lại phủ trọn IPv4. Tệ hơn,
`client-address.test.ts` **ghim lỗ này mở**, khẳng định `10.0.0.0/1` hợp lệ dưới tên
`'still accepts the narrowest useful ranges'`. Cùng vòng, bộ parse IPv6 tự viết nhận `1.2.3.4::`,
`1.2.3.4::5` và `2001:db8:1.2.3.4::1` — cả ba đều bị `net.isIP` từ chối — nên cấu hình validate
thành công trong khi Fastify và ta hiểu danh sách proxy khác nhau.

**Nguyên nhân sâu hơn, và là lý do đổi hướng:** đây là lần thứ ba cùng một lớp lỗi (vòng 1: đếm hop;
vòng 2: `/0`; vòng 3: `/1`–`/7` và IPv6 dị dạng), và mỗi lần bản vá đóng đúng cái ví dụ được nêu
chứ không đóng cả lớp. Lời tôi viết ở vòng 2 — "từ chối prefix rộng đến mức tin mọi thứ" — chính là
lý do vòng 3 còn lỗ: `/1` không tin *mọi thứ*, chỉ tin một nửa.

**Con người quyết (2026-09-04):** thay ~400 dòng parse tự viết bằng `@fastify/proxy-addr@5.1.0` —
đã có sẵn trong cây phụ thuộc, và là **chính gói Fastify 5 dùng**, nên hai bên không thể hiểu danh
sách proxy theo hai cách. Việc suy IP chuyển sang `apps/api`, nơi được phép chạm hạ tầng;
`packages/domain` giữ phần chính sách dựng khoá nên AD-1 vẫn nguyên.

**Trạng thái xấu đã tránh:** không ship một rate limiter mà một dòng cấu hình `/1` vô hiệu hoá, và
không tiếp tục nuôi một bộ parse địa chỉ tự viết trong đường xác thực.

**KEEP — bổ sung:**
- **Không tự parse địa chỉ IP hay CIDR ở bất kỳ đâu trong repo này.** Ba vòng review đã chứng minh
  chi phí. Dùng đúng gói mà Fastify dùng.
