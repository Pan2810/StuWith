---
title: 'Story 2.0 — Rút chuỗi ra i18n: VI mặc định, EN song song'
type: 'feature'
created: '2026-09-07'
status: 'done'
baseline_commit: 'e52c4bdd0103137449a51c7f3721a79fe694d5c0'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Mọi chuỗi hiển thị hôm nay là literal tiếng Việt nằm trong component — **~51 chuỗi trên 13 file**, cộng 5 hằng thông điệp trong `packages/contracts`. `<html lang="vi">` cứng ở `layout.tsx:100`. `EXPERIENCE.md` đòi VI + EN song song và "mọi chuỗi đều phải qua i18n **ngay từ đầu**". Tám story phòng live của Epic 2 sẽ đẻ thêm chừng ấy literal nữa nếu làm sau — chi phí thật là việc RÚT, và nó nhân đôi nếu hoãn.

**Approach:** Một catalogue có kiểu trong `apps/web/src/app/i18n/`, hai locale, không thư viện. Locale chọn ở server từ cookie rồi tới `Accept-Language`; dictionary đi xuống client **đúng đường mà `apiBaseUrl` đã đi** — prop từ layout → context → hook. Khoá thiếu bản dịch là **lỗi biên dịch**, không phải test.

## Boundaries & Constraints

**Always:**
- VI là mặc định và là fallback. Không locale nào rơi về khoá thô trên màn hình.
- Catalogue là `Record<MessageKey, string>` cho MỖI locale, nên thiếu khoá là lỗi `tsc`.
- Giá trị VI của 5 hằng trong `packages/contracts` được **import**, không chép lại. Một chuỗi, hai người dùng (API gửi lên dây, web hiển thị), không có bản sao để lệch.
- `<html lang>` đúng ngay ở lần render đầu từ server. Không `useEffect`.

**Ask First:**
- ~~Thư viện i18n hay tự dựng catalogue?~~ **ĐÃ QUYẾT 07/09/2026: tự dựng, không thư viện.** Lý do là số đo chứ không phải sở thích: toàn dự án có **đúng một** chuỗi cần số nhiều (`Thử lại sau ${seconds} giây.`), 5 mẫu nội suy, và không cần định tuyến theo locale. `Record<MessageKey, string>` biến "thiếu bản dịch" thành lỗi biên dịch — ràng buộc tầng kiểu, một trong ba hình dạng vá bền mà retrospective Epic 1 xác định. Ghi lại điều CHƯA được giải: Epic 3 có đồng hồ, coin và tiền, tức định dạng số/thời lượng theo locale; nếu `Intl.NumberFormat` và `Intl.DurationFormat` không đủ ở đó thì đây là chỗ xem lại, và xem lại là quyết định của con người chứ không phải của story sau.
- Thêm bất kỳ dependency nào khác.

**Never:**
- **Không thêm segment `app/[lang]/`.** Route là dữ liệu hợp đồng: `SIGN_IN_PATHNAME`/`DATE_OF_BIRTH_PATHNAME` sống trong `packages/contracts`, `apps/api` redirect tới chúng, chúng nằm trong OpenAPI, và `routes.test.ts` gate rằng mỗi hằng trỏ tới một thư mục có thật. `/en/khai-ngay-sinh` vẫn là URL tiếng Việt — mua một link chia sẻ được cho một trang có đường dẫn không dịch, đổi lại phá 43 lượt điều hướng e2e và ba hằng hợp đồng.
- **Không rút những thứ trông như chuỗi mà là dữ liệu:** tham số query `ket-qua`/`giay`/`quay-ve`; enum trên dây `SIGN_IN_OUTCOMES = ['that-bai','da-huy','bi-khoa']`; khoá cookie/storage; DOM id (`ngay-sinh`, `phien-het-han-tieu-de`); `PROVIDER_LABELS` (tên riêng); `'StuWith'`.
- **Không rút `AGE_VOCABULARY`** (`contracts/auth.ts`) và các danh sách từ cấm trong test. Chúng là **luật**, không phải copy — rút ra là vô hiệu hoá gate.
- Không đổi hợp đồng `/v1`. Không đụng `apps/api`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Mặc định | Không cookie, không `Accept-Language` | VI; `<html lang="vi">` | — |
| Ưu tiên EN | `Accept-Language: en-US,en;q=0.9` | EN; `<html lang="en">` | — |
| Cookie thắng header | cookie locale=`vi`, header `en-US` | VI | — |
| Locale lạ | `Accept-Language: fr-FR` | VI (fallback), không lỗi | Không 404, không khoá thô |
| Cookie rác | cookie locale=`../../etc` | VI; giá trị bị bỏ | Không ném, không đưa vào `lang` |
| Số nhiều EN | `seconds = 1` / `seconds = 2` | `Retry in 1 second.` / `Retry in 2 seconds.` | — |
| Nội suy | `Đang đăng nhập: {name} (vai trò: {role})` | `role` qua bảng dịch, không hiện `org_admin` thô | Vai trò lạ → nhãn chung |
| Thiếu bản dịch | Thêm khoá vào VI, quên EN | **`tsc` đỏ** | Build fail, không chạy được |

## Probe ranh giới

**Ranh giới:** trình duyệt ↔ server. Locale được **server** quyết từ một header **trình duyệt** gửi, rồi render vào `<html lang>` và vào HTML của client component. Ba thứ phải khớp nhau qua ranh giới đó: header gửi đi, thuộc tính `lang` server ghi ra, và chuỗi client hiển thị. Một unit test trên `pickLocale('en-US,en;q=0.9')` không chạy qua đoạn nào trong ba đoạn đó — đúng hình dạng đã cho ba suite xanh trên một sản phẩm hỏng ở Epic 1.

**Probe:** một spec Playwright mới chạy hai browser context, `locale: 'en-US'` và `locale: 'vi-VN'`, mở từng màn hình đã có. Với mỗi context assert **cả ba mức**: (1) `document.documentElement.lang` bằng đúng locale mong đợi; (2) một câu chỉ tồn tại ở locale đó hiện trên màn hình; (3) không có lỗi hydration nào trên console — vì `lang` do server ghi và client phải đồng ý.

**Sẽ đỏ khi:** ép hàm phân giải locale phía **server** luôn trả `'vi'` (bỏ qua header). Context `en-US` phải đỏ ở cả ba mức. Chạy thật rồi khôi phục — một probe không làm cho đỏ được là một assertion chưa biết mình canh gì.

</frozen-after-approval>

## Code Map

Số dòng tự đo.

- `apps/web/src/app/layout.tsx` — `<html lang="vi">` cứng ở **:100**; brand chẻ hai node JSX ở **:129**; `metadata.description` :12. Đọc `API_BASE_URL` một lần ở **:70** rồi truyền xuống — **đây là khuôn mẫu để bám theo**, docblock :58-69 giải thích vì sao chỉ một chỗ đọc. `themeBootScript()` ở :117 là tiền lệ "quyết định trước lần vẽ đầu".
- `apps/web/src/app/session-expiry-provider.tsx` — `'use client'`. `createContext` :90, `useApiBaseUrl()` :108, prop `apiBaseUrl` :74/:122. Dictionary đi cùng đường này.
- **Ranh giới client**: chỉ `layout.tsx` và `page.tsx` là Server Component. Bốn file kia (`sign-in-outcome`, `date-of-birth-form`, `session-expiry-dialog`, `sign-in-links`) không có `'use client'` riêng nhưng được import từ hai `page.tsx` đều `'use client'`, nên nằm trong đồ thị client — `next/root-params` không chạy ở đó.
- 13 file mang chuỗi: `dang-nhap/{countdown-text.ts,page.tsx,sign-in-outcome.tsx}`, `khai-ngay-sinh/{date-of-birth-form.tsx,page.tsx}`, `{layout,page,profile-load,session-expiry-dialog,sign-in-links,theme-switch,theme}.*`. Loại (c) — chuỗi trong thuộc tính — chỉ có **một**: `aria-label={THEME_SWITCH_LEGEND}` trong `theme-switch.tsx`.
- **5 mẫu nội suy**: `countdown-text.ts` `Thử lại sau ${seconds} giây.` (dùng lại ở `date-of-birth-form.tsx` qua `declarationWaitLabel`) · `theme.ts` `Đang dùng giao diện ${...}.` · `sign-in-outcome.tsx:544` `Đang đăng nhập: {name} (vai trò: {role})` · `page.tsx` `Hợp đồng API: {CONTRACT_VERSION}.` · `sign-in-links.tsx` `Tiếp tục với {provider}`.
- **`sign-in-outcome.tsx:544` render `{user.role}` THÔ** — người dùng đang thấy `org_admin`. Đã kiểm bằng mắt trên file. Cần bảng dịch vai trò, không phải rút chuỗi `'org_admin'`.
- `packages/contracts/src/auth.ts` — `DATE_OF_BIRTH_INVALID_MESSAGE`, `DATE_OF_BIRTH_ALREADY_SET_MESSAGE`, `UNAUTHENTICATED_MESSAGE`, `MONEY_IN_FORBIDDEN_MESSAGE`, `RATE_LIMITED_MESSAGE`. **Đã đo: `apps/web` không bao giờ đọc `error.message` từ thân phản hồi** — ba lời gọi `response.json()` duy nhất parse thân THÀNH CÔNG; câu lỗi chọn tại chỗ từ status (`declarationOutcomeFor` :278-324). Nên chuỗi VI trên dây không tới màn hình nào, và i18n hoàn toàn nằm ở client.
- `packages/contracts/src/error.ts:6` — docblock nói *"`message` is already i18n'd for a human"*. SAI hôm nay. Sửa cho đúng sự thật, đừng để lại lời hứa thứ tư kiểu "EN arrives with Story 1.6".
- **Độ dính của test, đã đếm:** e2e `getByRole|getByLabel|getByText|toHaveText` = 14 (`dang-nhap`) + 11 (`he-thiet-ke`) + 18 (`khai-ngay-sinh`) = **43**, tất cả gõ chuỗi VI cứng. `he-thiet-ke.spec.ts:128` nướng tiếng Việt vào **kiểu TypeScript** (`label: 'Sáng' | 'Tối' | 'Theo hệ điều hành'`). E2E CÓ import hằng từ contracts (`dang-nhap.spec.ts:1` — `AUTH_PROVIDERS`), nên chính sách ở `scenario.ts:22-24` là "không import hằng ĐANG KIỂM", không phải "không import gì".
- Web unit test: ~40 chỗ dùng hằng import (sống sót nếu hằng vẫn là **giá trị**, vỡ nếu đổi thành lời gọi `t(...)`), ~20 chỗ gõ cứng.
- Khuôn gate: `tests/gates/cors-exposed-headers.test.ts` (quét + hằng dùng chung), `design-tokens.test.ts` (so khớp hai chiều).

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/app/i18n/messages.ts` — khai `MessageKey` và catalogue VI; `Record<MessageKey, string>` cho mỗi locale; VI của 5 khoá dùng chung **import** từ `@stuwith/contracts` — một chuỗi, không bản sao.
- [x] `apps/web/src/app/i18n/messages.en.ts` — catalogue EN, cùng kiểu. Thiếu khoá = `tsc` đỏ.
- [x] `apps/web/src/app/i18n/locale.ts` — `resolveLocale(cookie, acceptLanguage)`, thuần, fallback VI, chống giá trị rác. Cùng khuôn `resolveThemeChoice` ở `theme.ts`.
- [x] `apps/web/src/app/i18n/use-t.ts` — context + hook `useT()`, nội suy `{name}`, số nhiều EN bằng `Intl.PluralRules`. Đi cùng đường `useApiBaseUrl()`.
- [x] `apps/web/src/app/layout.tsx` — đọc locale ở server, `<html lang>` động, truyền **locale** xuống provider. *SAI LỆCH 1 so với câu chữ task ("truyền dictionary"), đã kiểm và chấp nhận: truyền cả catalogue serialise nó vào RSC payload của mọi trang, và làm đỏ một assertion sẵn có ở `he-thiet-ke.spec.ts` (nó kiểm HTML phục vụ không mang câu thông báo theme trước hydration — catalogue serialise chứa đúng câu đó như một giá trị). Đường đi kiến trúc không đổi: layout → prop → context → hook. Task nằm NGOÀI frozen block nên đây là sửa hợp lệ.*
- [x] `apps/web/src/app/i18n/server-locale.ts` — *SAI LỆCH 2: file thứ sáu không có trong danh sách task. `locale.ts` không thể import `next/headers` vì client module import nó để lấy `Locale`/`DEFAULT_LOCALE`.*
- [x] 13 file mang chuỗi — thay literal bằng khoá. Giữ các hằng đã export như **giá trị** (không đổi thành lời gọi hàm) để ~40 assertion đơn vị không vỡ vô ích.
- [x] `sign-in-outcome.tsx` — bảng dịch `role` → nhãn; ngừng render `org_admin` thô.
- [x] `packages/contracts/src/error.ts` — sửa docblock :6 cho đúng sự thật.
- [x] `tests/gates/i18n-catalogue.test.ts` — luật quét: cấm literal ngôn ngữ tự nhiên mới trong `apps/web/src/app/**` (trừ danh sách "Never" ở trên); và khẳng định hai catalogue cùng tập khoá. Mutation-test cả hai vế.
- [x] `tests/e2e/web/ngon-ngu.spec.ts` — probe ở mục **Probe ranh giới**.
- [x] `tests/e2e/**` — giữ 43 assertion hiện có chạy ở locale VI (chúng đang chứng minh **tên khả truy cập** đúng, đó là giá trị riêng); probe mới lo phần EN.

**Acceptance Criteria:**
- Given một khoá có ở VI mà thiếu ở EN, when chạy `typecheck`, then build đỏ và nêu đúng khoá thiếu.
- Given trình duyệt đặt `Accept-Language: en-US`, when mở bất kỳ màn hình nào, then toàn bộ nhãn, thông báo lỗi và vùng `role="status"` hiện bằng tiếng Anh và `<html lang="en">`.
- Given người dùng đã chọn locale, when họ mở lại, then lựa chọn đó thắng `Accept-Language`.
- Given một literal ngôn ngữ tự nhiên mới thêm vào component, when chạy gate, then đỏ.
- Given nhãn ở cả hai ngôn ngữ, when đo ở 320px, then không nhãn nào bị cắt chữ.
- Given một đoạn tiếng Anh nhúng trong câu tiếng Việt, when render, then nó mang `lang="en"`.

## Design Notes

Ba giả định ban đầu bị điều tra lật ngược — ghi lại để vòng sau không đi lại. Bằng chứng đã neo trong Code Map, đây chỉ là kết luận:

1. Không tồn tại câu hỏi "bản địa hoá ở API hay ở web". i18n hoàn toàn nằm ở client.
2. Next App Router không có i18n dựng sẵn, và primitive nó có (`next/root-params`) không dùng được vì bề mặt chuỗi nằm trong đồ thị client.
3. Toàn dự án chỉ có MỘT chuỗi cần số nhiều. Đó là dữ liệu chính cho quyết định Ask First.

## Verification

**Commands:**
- `corepack pnpm run build:packages` -- bắt buộc TRƯỚC mọi mutation test; `apps/*` nạp `@stuwith/contracts` từ `dist`.
- `corepack pnpm run typecheck` -- expected: xanh; và ĐỎ khi cố tình xoá một khoá khỏi catalogue EN.
- `corepack pnpm run test:unit` -- expected: xanh.
- `corepack pnpm exec vitest run --project gates` -- expected: xanh; mutation từng vế của gate mới trước khi tin.
- `corepack pnpm exec playwright test` -- expected: 43 ca cũ xanh + probe mới xanh.
- `corepack pnpm run dep-check` -- expected: xanh. `apps/web` chỉ được chạm `packages/contracts`.

## Suggested Review Order

**Cơ chế — bắt đầu từ đây**

- Điểm vào. `MessageKey` suy RA TỪ catalogue VI, nên khoá không thể khai sai.
  [`messages.ts:160`](../../apps/web/src/app/i18n/messages.ts#L160)

- Dòng biến "thiếu bản dịch" thành lỗi biên dịch. Đọc kỹ dòng này trước mọi thứ khác.
  [`messages.ts:173`](../../apps/web/src/app/i18n/messages.ts#L173)

- Nội suy trả về `ReactNode[]`, để `lang="en"` bọc được một mảnh giữa câu tiếng Việt.
  [`messages.ts:283`](../../apps/web/src/app/i18n/messages.ts#L283)

- Bảng vai trò: sửa lỗi người dùng đang thấy `org_admin` thô trên trang tài khoản.
  [`messages.ts:356`](../../apps/web/src/app/i18n/messages.ts#L356)

**Ranh giới trình duyệt ↔ server — chỗ rủi ro nhất**

- Nơi locale được quyết. Một hàm, ba call site, một thứ tự ưu tiên.
  [`server-locale.ts:37`](../../apps/web/src/app/i18n/server-locale.ts#L37)

- `q=` rỗng từng đọc thành "từ chối" vì `Number('')` là `0`. Vá ở vòng review.
  [`locale.ts:118`](../../apps/web/src/app/i18n/locale.ts#L118)

- Cắt header dài về dấu phẩy cuối, để không cắt giữa một tag.
  [`locale.ts:92`](../../apps/web/src/app/i18n/locale.ts#L92)

- `<html lang>` do server ghi, đúng ngay lần vẽ đầu — không `useEffect`.
  [`layout.tsx:132`](../../apps/web/src/app/layout.tsx#L132)

- `generateMetadata` chứ không phải `metadata` tĩnh: mô tả là một câu, nên nó có ngôn ngữ.
  [`layout.tsx:23`](../../apps/web/src/app/layout.tsx#L23)

**Dictionary xuống client — đi đúng đường `apiBaseUrl` đã đi**

- Provider nhận `locale`, không nhận catalogue. Lý do đo được nằm ngay trong docblock.
  [`use-t.ts:53`](../../apps/web/src/app/i18n/use-t.ts#L53)

- Mặc định của context là bản dịch VI, nên không locale nào rơi về khoá thô.
  [`use-t.ts:62`](../../apps/web/src/app/i18n/use-t.ts#L62)

**Cưỡng chế — thứ giữ tám màn hình còn lại của Epic 2**

- Hàm quét thật. Vòng review chứng minh nó xoá được mà không test nào phản đối; giờ thì không.
  [`i18n-catalogue.test.ts:204`](../../tests/gates/i18n-catalogue.test.ts#L204)

- Rule 1: không câu nào sống ngoài catalogue. Self-check nay gọi chính hàm sản xuất.
  [`i18n-catalogue.test.ts:272`](../../tests/gates/i18n-catalogue.test.ts#L272)

- Rule 4 (thêm ở vòng review): không chuỗi tiếng Việt nào sót lại trong catalogue EN.
  [`i18n-catalogue.test.ts:538`](../../tests/gates/i18n-catalogue.test.ts#L538)

**Probe ranh giới — ba mức, bốn mutation đã chạy thật**

- Helper ba mức. Mức 2 kiểm cả CÓ MẶT lẫn VẮNG MẶT, sau khi review bắt được nửa thiếu.
  [`ngon-ngu.spec.ts:139`](../../tests/e2e/web/ngon-ngu.spec.ts#L139)

- Lỗi hydration ở bản build production là mã rút gọn, không phải chữ "hydration".
  [`ngon-ngu.spec.ts:114`](../../tests/e2e/web/ngon-ngu.spec.ts#L114)

**Ngoại vi**

- Docblock từng nói `message` "đã i18n" — không đúng, và đó là kiểu lời hứa làm người sau xây lên chỗ trống.
  [`error.ts:6`](../../packages/contracts/src/error.ts#L6)

- Ghim `locale: 'vi-VN'`: không có dòng này, 43 assertion tên-khả-truy-cập âm thầm đổi nghĩa.
  [`playwright.config.ts`](../../playwright.config.ts)
