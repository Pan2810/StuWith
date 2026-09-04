---
title: 'Story 1.3 (phần 3) — Phiên hết hạn giữa chừng và quay về đúng chỗ'
type: 'feature'
created: '2026-09-04'
baseline_commit: '60887562c08558cee2e4f4dc762bb7e3f1a332e4'
status: 'in-progress'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Phiên hết hạn giữa chừng thì người dùng bị đá về trạng thái đăng xuất trần và mất chỗ đang đứng. `page.tsx:73` gộp 401 chung với mọi lỗi khác; `apps/web` không có lớp gọi API dùng chung (chỉ hai `fetch` tự viết) và `layout.tsx` không có provider nào, nên hiện **không tồn tại chỗ nào** để một màn hình bất kỳ biết phiên vừa chết.

**Approach:** Một seam duy nhất "lời gọi có xác thực vừa nhận 401" ở `apps/web`, dựng dialog **không chặn thao tác**. Đường dẫn quay về do client **đề nghị** ở chặng `/start`; server kiểm same-origin đúng **một lần** ở đó rồi **ký vào OAuth state**; callback thành công đọc đường dẫn từ state đã ký. Cơ chế tổng quát để màn phòng live của Epic 2 cắm vào, không dựng riêng cho phòng học.

## Boundaries & Constraints

**Always:**
- **Đích redirect chỉ được lấy từ state ĐÃ KÝ.** Chặng callback không bao giờ đọc đường dẫn từ query, cookie hay header. Client chỉ được đề nghị ở `/start`; server kiểm rồi ký. Kẻ tấn công không ký được payload nên không đặt được đích.
- **Đường dẫn nội bộ, kiểm bằng một hàm dùng chung khai ở `packages/contracts`** (AD-13, cả hai process cùng đọc): phải bắt đầu bằng đúng một `/`, không `//`, không `/\`, không scheme, không host, không `..`. Mọi thứ không hợp lệ bị **bỏ im lặng** về mặc định, không phải lỗi.
- **Origin của mọi redirect vẫn là `WEB_BASE_URL`**, không bao giờ `OAUTH_REDIRECT_BASE_URL`. Bất biến này đã được `auth.flow.test.ts:67-69` khoá và phải sống sót.
- **Redirect thất bại vẫn mang đúng MỘT query param `ket-qua`.** Đường dẫn quay về bị bỏ ở nhánh thất bại — người ta đang đứng ở trang đăng nhập rồi.
- **Đóng dialog không làm phiên sống lại.** Seam vẫn nằm đó; lời gọi 401 kế tiếp mở lại dialog. Đóng một lần rồi im mãi là đúng cái bẫy tính năng này sinh ra để tránh.
- Thông báo trên dialog **không nêu lý do kỹ thuật**: không mã lỗi, không tên provider, không nói token hay cookie.
- Quyết định nằm ở **hàm thuần**; `useEffect`/`window` chỉ ở component mỏng — repo không có DOM để test (`vitest.config.mts:119`).
- `apps/web` chỉ được import `packages/contracts` (luật `ad1-web-touches-contracts-only`, severity error).

**Ask First:**
- Thêm giá trị mới vào `SIGN_IN_OUTCOMES`. Enum đó cố ý rất nhỏ và **chính nó** là hàng rào chống injection (docblock `contracts/src/auth.ts:109-139`).
- Bất kỳ dependency mới nào — đặc biệt `jsdom`, `happy-dom`, `@testing-library/*`.
- Đổi hành vi `404` của provider chưa bật ở chặng `/start`.

**Never:**
- Nhận URL tuyệt đối, hoặc bất kỳ thứ gì mang host, ở bất kỳ đâu trong luồng này.
- Mang đường dẫn quay về qua `rate-limited.filter.ts`: filter chạy **trước** handler nên không có state đã ký. Ghi vào `deferred-work.md`, đừng dựng đường vòng.
- Token thiết kế, styling, focus-trap — Story 1.6. Dialog vẫn khung trần.
- Sửa lược đồ Postgres. Story này không cần migration nào.
- Dựng riêng cho phòng học, hoặc đoán trước hình dạng route của Epic 2.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Phiên chết giữa chừng | Lời gọi có xác thực trả `401` | Dialog hiện, **màn hình phía sau giữ nguyên và vẫn cuộn được** | Không nêu lý do kỹ thuật |
| Quay về đúng chỗ | `/start` kèm đường dẫn nội bộ hợp lệ, đăng nhập thành công | Redirect tới `WEB_BASE_URL` + đúng đường dẫn đó | N/A |
| URL tuyệt đối | Đề nghị `https://evil.com/x` | Bị bỏ; về `/dang-nhap` như hôm nay | Không phải lỗi, chỉ bỏ |
| Dạng lách same-origin | `//evil.com`, `/\evil.com`, `/../x`, dạng đã encode | Bị bỏ; về `/dang-nhap` | Như trên |
| Không đề nghị gì | `/start` như hôm nay | Về `/dang-nhap` | N/A |
| Thất bại dù có đường dẫn | State hợp lệ, `code` sai | `/dang-nhap?ket-qua=that-bai`, **đúng một** query param | Đường dẫn bị bỏ |
| State quá hạn | Quay lại sau `OAUTH_STATE_TTL_SECONDS` | Đi đúng đường thất bại sẵn có | N/A |
| Đóng rồi gặp lại | Đóng dialog, sau đó một `401` nữa | Dialog mở lại | N/A |
| Đang ở trang đăng nhập | `401` khi người dùng đã ở `/dang-nhap` | **Không** hiện dialog | N/A |

</frozen-after-approval>

## Code Map

**Phải sửa — đọc trước:**
- `apps/api/src/auth/auth.service.ts:97-104` -- `OAuthStatePayload`; thêm trường đường dẫn (chèn sau `:182` nơi payload được dựng ở `:177-183`)
- `apps/api/src/auth/auth.service.ts:384` -- đích redirect **thành công**, hiện ghép chuỗi thẳng `${WEB_BASE_URL}/dang-nhap`. Đây là dòng đổi
- `apps/api/src/auth/auth.service.ts:166` -- chữ ký `start()`; `:219` là chỗ ký payload
- `apps/api/src/auth/auth.service.ts:311-312` -- mẫu đọc `stateCheck.payload` ở callback; đường dẫn lấy ở đây
- `apps/api/src/auth/auth.controller.ts:42-48` -- `/start` **hiện không đọc query nào**; `:52-65` là mẫu đọc query đã có
- `packages/contracts/src/auth.ts:219` -- `parseSignInRetryAfterSeconds`, **mẫu parser nghiêm ngặt phải bắt chước**; validator đường dẫn đặt cạnh đây
- `apps/web/src/app/dang-nhap/page.tsx:55,115` -- hai `fetch` duy nhất của cả app; `:60-75` gộp mọi lỗi, `:73` là nơi 401 rơi vào `signed-out`
- `apps/web/src/app/layout.tsx:16-19` -- Server Component, **chưa có provider nào**; provider mới phải là client component riêng để layout không thành client
- `apps/web/src/app/dang-nhap/sign-in-outcome.tsx:388` -- anchor `/start`, nơi gắn đề nghị đường dẫn; `:421-431` `signInNoticeFromMe`

**Đọc để bám quy ước, không sửa:**
- `apps/api/src/auth/auth.flow.test.ts:55-89` -- `expectOutcomeRedirect`; `:75` cấm query param thừa, `:61-66` **nêu đích danh AC4 và rủi ro open-redirect**
- `apps/api/src/auth/auth.flow.test.ts:108` -- assert đích thành công; sẽ đỏ **có chủ đích**
- `apps/api/src/auth/__testing__/auth-harness.ts:391-421` -- `harness.login()` đi trọn vòng `/start`→`/callback`; `:391-395` là chữ ký cần mở rộng
- `apps/web/src/app/dang-nhap/countdown.tsx:26-36,44-45` -- khuôn tiêm `clock` để render không DOM
- `apps/web/src/app/dang-nhap/sign-in-outcome.test.tsx:42-52` -- khuôn `renderToStaticMarkup`
- `vitest.config.mts:92-123` -- project `web`, `environment: 'node'`, không DOM
- `packages/config/src/schema.ts:239,243` -- `SESSION_TTL_SECONDS` 3600 là "giữa chừng"; `OAUTH_STATE_TTL_SECONDS` 600 là trần sống của đường dẫn

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/auth.ts` -- Thêm tên query param và hàm parse đường dẫn nội bộ, theo đúng khuôn `parseSignInRetryAfterSeconds`: trả `null` cho mọi thứ không hợp lệ, không ném -- cả `apps/api` và `apps/web` cùng đọc một luật (AD-13)
- [x] `packages/contracts/src/auth.test.ts` -- Bảng ca lách: `//host`, `/\host`, `http://x`, `/../x`, dạng đã encode, chuỗi rỗng, chỉ `/` -- một validator đường dẫn chỉ đáng tin khi test đi theo **lớp** chứ không theo ví dụ
- [x] `apps/api/src/auth/auth.service.ts` -- `start()` nhận đề nghị, kiểm bằng hàm chung rồi ký vào state; callback thành công dựng đích từ state đã ký bằng `new URL` chứ không ghép chuỗi
- [x] `apps/api/src/auth/auth.controller.ts` -- Đọc query ở `/start` và chuyển xuống service; giữ nguyên hành vi `404` của provider chưa bật
- [x] `apps/api/src/auth/__testing__/auth-harness.ts` -- `login()` nhận đường dẫn tuỳ chọn để test đi được trọn vòng
- [x] `apps/api/src/auth/auth.flow.test.ts` -- Phủ các hàng Matrix phía server; cập nhật `:108` **có chủ đích** và giữ nguyên bất biến `:75`
- [x] `apps/web/src/app/session-expiry.ts` -- Hàm thuần: từ status của một lời gọi và đường dẫn hiện tại, quyết định có mở dialog không và đề nghị đường dẫn nào -- đây là nơi mọi quyết định sống, để test được không cần DOM
- [x] `apps/web/src/app/session-expiry-dialog.tsx` -- Dialog không chặn, không effect, không state -- nhận mọi thứ qua prop, đúng khuôn `SignInPanel`
- [x] `apps/web/src/app/session-expiry-provider.tsx` -- Client component mỏng giữ state và cắm seam; **chỉ** ở đây mới có `useState`/`useEffect`
- [x] `apps/web/src/app/layout.tsx` -- Bọc `children`; layout vẫn là Server Component
- [x] `apps/web/src/app/dang-nhap/page.tsx` -- Hai `fetch` đi qua seam chung thay vì tự đọc `response.ok`
- [x] `apps/web/src/app/session-expiry.test.ts` -- Phủ các hàng Matrix phía web, gồm hàng "đang ở trang đăng nhập thì không hiện" và hàng "đóng rồi gặp 401 lần nữa"
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- Ghi khoảng trống `rate-limited.filter.ts` không mang được đường dẫn quay về

**Acceptance Criteria:**
- Given một người đang ở một đường dẫn nội bộ bất kỳ và phiên vừa hết hạn, when một lời gọi có xác thực trả `401`, then dialog hiện mà **màn hình phía sau vẫn thấy và vẫn cuộn được**, và không câu chữ nào nêu lý do kỹ thuật.
- Given người đó bấm đăng nhập lại và đăng nhập thành công, when callback chạy xong, then trình duyệt về đúng đường dẫn cũ trên `WEB_BASE_URL`, và cookie state của lần thử đó đã bị xoá.
- Given một đề nghị đường dẫn không phải nội bộ, when `/start` xử lý, then giá trị bị bỏ và luồng chạy tiếp bình thường về `/dang-nhap` — không lỗi, không dòng log nào chứa giá trị đó.
- Given `pnpm run dep-check`, when chạy, then không vi phạm nào — `apps/web` vẫn chỉ chạm `packages/contracts`.

## Spec Change Log

## Design Notes

**Vì sao kiểm một lần ở `/start` rồi ký, chứ không kiểm lúc callback:** hai chỗ kiểm là hai chỗ có thể lệch nhau, và đúng kiểu lệch đó vừa tốn của story rate-limit bốn vòng review. Ký ở `/start` biến "đích redirect có an toàn không" thành câu hỏi đã được trả lời một lần, ở một nơi, trên dữ liệu chưa tin được — sau đó chữ ký làm phần còn lại. Kẻ tấn công muốn đổi đích phải ký được payload, tức phải có `SESSION_COOKIE_SECRET`.

**Vì sao nhánh thất bại bỏ đường dẫn:** `auth.flow.test.ts:75` khoá "chỉ đúng một query param rides back", và docblock ở đó nói rõ lý do — thêm param là cách một chi tiết chẩn đoán được tuồn ra client "chỉ để debug". Giữ bất biến đó đáng giá hơn việc giữ chỗ đứng cho một lần đăng nhập đã hỏng.

**Vì sao `new URL` chứ không ghép chuỗi:** `:384` hiện ghép thẳng. Ghép chuỗi với một đường dẫn biến thiên là cách `//evil.com` biến thành origin mới ngay cả khi validator đã chạy.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run dep-check` -- expected: no dependency violations
- `pnpm test` -- expected: mọi test xanh, 0 skip; các hàng Matrix đều có test **đã chạy và pass**
- `pnpm exec vitest run --project web` -- expected: test mới chạy trong `environment: node`, không cần DOM
