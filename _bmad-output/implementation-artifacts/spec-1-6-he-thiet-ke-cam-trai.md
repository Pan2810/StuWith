---
title: 'Story 1.6 — Hệ thiết kế "Cắm trại": token light và dark'
type: 'feature'
created: '2026-09-06'
status: 'done'
baseline_commit: 'a9ad4fce0e6a5bc5dd13c4ce9863a3f7a4cb3ccb'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `apps/web` chưa có một dòng CSS nào. Ba màn hình (`/`, `/dang-nhap`, `/khai-ngay-sinh`) là markup ngữ nghĩa trần, và bốn docblock trong đó tự ghi rằng chúng đang chờ Story 1.6. Bộ token "Cắm trại" hiện chỉ tồn tại dưới dạng frontmatter YAML trong `DESIGN.md` — chưa có gì đưa nó tới trình duyệt, và chưa có gì kiểm rằng các tỉ lệ tương phản trong đó là đúng chứ không phải chép tay.

**Approach:** Dựng `tokens.css` là bản dịch 1:1 của frontmatter `DESIGN.md`, ba khối theo khuôn ba trạng thái theme; dựng `globals.css` cho typography, ba component base và vòng focus; áp lên cả ba màn hình. Chống trùng bằng ba mắt xích không mắt nào cho phép tồn tại bản giá trị thứ hai: một luật quét đối chiếu `DESIGN.md` ↔ `tokens.css` theo từng khoá, một test tính lại WCAG từ chính `tokens.css`, và các ca Playwright đọc `getComputedStyle` trong trình duyệt thật ở cả ba trạng thái.

## Boundaries & Constraints

**Always:**
- Tên biến CSS **trùng nguyên văn khoá màu trong `DESIGN.md`** (`--surface-base`, `--border-ink`, `--ink-primary`…). Đây không phải thẩm mỹ: nó là thứ làm luật quét thành so sánh khoá-với-khoá thay vì một bảng ánh xạ — mà bảng ánh xạ chính là bản sao thứ hai.
- Giá trị dark **ghi đè cùng tên biến**, không tạo biến `--x-dark`. Hậu tố `-dark` chỉ tồn tại ở phía `DESIGN.md`.
- Ba trạng thái theme theo đúng khuôn: `:root` (light) · `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` · `:root[data-theme="dark"]`. Không màu nào được định nghĩa **chỉ** bên trong một media query.
- Tên class của component base là **khoá chung với `DESIGN.md`/`EXPERIENCE.md`**: `button-primary`, `button-secondary`, `chip-status`.
- Vòng focus: `outline: 2px solid var(--primary); outline-offset: 2px` (`EXPERIENCE.md § State Patterns`). **`outline: none` không được xuất hiện ở bất kỳ đâu**, kể cả sau `:focus`.
- Mọi ký hiệu tồn tại phải được mã sản phẩm dùng, không chỉ test dùng (`routes.test.ts` rule C quét cả `apps/web`).

**Ask First:**
- Thêm bất kỳ dependency nào. `next/font/google` **không** tính là dependency mới — nó nằm trong `next` — nhưng nó khiến `next build` cần mạng lần đầu; nếu điều đó thành vấn đề thì phương án hai là commit woff2 tự host, và **đó** là quyết định của con người.
- Biến dialog phiên hết hạn thành modal thật (backdrop, `aria-modal="true"`, focus-trap). `session-expiry-dialog.tsx:19-30` cố ý viết `aria-modal="false"` ra để người của 1.6 tìm thấy câu trả lời trong markup. Không tự lật.
- Đổi hoặc bỏ bất kỳ giá trị nào trong `DESIGN.md`.

**Never:**
- Không i18n / EN. `layout.tsx:32` và `sign-in-links.tsx:24` đều đoán "EN arrives with Story 1.6" — `epics.md` Story 1.6 không có chữ nào về i18n. Sửa hai docblock đó, ghi việc i18n thành mục deferred-work vô chủ.
- Không endpoint `GET /v1/auth/providers`, không đọc `AUTH_ENABLED_PROVIDERS` ở web — đó là việc backend, để nguyên trong deferred-work.
- Không port khuôn `.app` / `.app.dark` của hai file trong `mockups/` — chúng scope token vào một class container và xung đột với mô hình `:root`.
- Không port `.field:focus{…outline:none}` (`demo-san-pham.html:184`) — đó là lỗi a11y thật, độ đặc hiệu của nó đè lên luật `:focus-visible` toàn cục.
- Không thêm jsdom/happy-dom/`@testing-library/*`. Cái 1.6 cần là trình duyệt thật, thứ đã có từ Story 1.5.
- Không sửa `returnPath` chốt-lúc-401, không đụng luật rate-limit hay countdown ngoài việc thay markup thành class.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Theo hệ điều hành, OS sáng | không có `data-theme`, `prefers-color-scheme: light` | palette light; `--surface-base` = `#F3F0FF` | N/A |
| Theo hệ điều hành, OS tối | không có `data-theme`, `prefers-color-scheme: dark` | palette dark; `--surface-base` = `#121020` | N/A |
| Chọn tay light trên OS tối | `data-theme="light"`, OS tối | palette **light** — guard `:not()` thắng media query | N/A |
| Chọn tay dark trên OS sáng | `data-theme="dark"`, OS sáng | palette **dark** | N/A |
| Quay lại "theo hệ điều hành" | đã chọn tay, rồi chọn lại `system` | thuộc tính `data-theme` bị **gỡ khỏi DOM**, không đặt thành `"system"` | N/A |
| OS đổi theme khi đang ở `system` | `matchMedia` phát `change` | palette đổi theo, không cần tải lại trang | N/A |
| Tải lại trang sau khi chọn tay | `localStorage` có lựa chọn | palette đúng ngay từ khung hình đầu, không nháy | `localStorage` ném hoặc rỗng → về `system`, không vỡ trang |
| Giá trị lưu bị hỏng | `localStorage` chứa `"purple"` | về `system` | không ném ra ngoài script |
| `prefers-reduced-motion: reduce` | người dùng bật | mọi `transition`/`animation` trang trí tắt | N/A |
| Đồng hồ đếm ngược dưới reduced-motion | rate-limit đang đếm, `reduce` bật | **số vẫn giảm** — đó là thông tin, không phải hiệu ứng | N/A |
| Dialog phiên hết hạn mở | `prompt !== null` | focus chuyển vào dialog; Escape đóng; nền vẫn cuộn được | N/A |
| Cặp màu chịu lực bất kỳ | đọc từ `tokens.css` | ≥ 4.5:1 ở cả hai chế độ; `border-ink` ≥ 3:1 | dưới ngưỡng → test đỏ, **không** hạ ngưỡng |

</frozen-after-approval>

## Code Map

**Nguồn sự thật — đọc, không sửa:**
- `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/DESIGN.md:1-190` -- frontmatter YAML: 24 màu light + 24 màu `-dark`, `typography` (10 bậc), `rounded` (5), `spacing` (11), `motion` (4), `components` (16 khoá). `:224-236` bảng tương phản 8 cặp + câu riêng cho `border-ink` (16.41:1 light / 3.55:1 dark)
- `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/EXPERIENCE.md:218` -- luật vòng focus, nguyên văn: "Vòng focus 2px `{colors.primary}`, cách viền 2px. Không bao giờ tắt outline". `:281` reduced-motion. `:25` light/dark ngang hàng, mặc định theo OS, người dùng đổi được
- `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/demo-san-pham.html:16,38-39,55` -- khuôn ba khối theme, port nguyên. `:79` `:focus-visible{outline:3px solid var(--primary);outline-offset:2px}` — **đổi 3px → 2px** cho khớp EXPERIENCE.md. `:81` tiện ích `.sr` visually-hidden. `:162-171` `.btn`/`.btn.pri`. `:154-160` `.chip`. `:300-302` khối reduced-motion. `:1110-1117` toggle theme — **logic phải viết lại**, xem Design Notes

**Phải sửa:**
- `apps/web/src/app/layout.tsx:36-44` -- import `globals.css`; `next/font/google`; script chặn nội tuyến trong `<head>`; `suppressHydrationWarning` trên `<html>`; `<header>` chứa nút đổi theme. Docblock `:32` ghi sai về i18n
- `apps/web/src/app/layout.test.tsx:57` -- `id="trang"` ở đó là con fixture của chính test, không phải markup sản phẩm; test cần cập nhật theo header mới
- `apps/web/src/app/page.tsx:11-25` -- `<main><h1><p><Link>`; docblock `:8` ghi "The design system lands in Story 1.6"
- `apps/web/src/app/dang-nhap/sign-in-outcome.tsx:380-449` (`SignInPanel`), `:521-543` (`SignedInPanel`) -- `<p role="status">`, `<button type="button" disabled>`, `<nav>`, `<a>`. Nút thử lại → `button-secondary`
- `apps/web/src/app/khai-ngay-sinh/date-of-birth-form.tsx:448-560` -- năm nhánh trạng thái. `:517-560` form: `<label htmlFor>`, `<input type="date">`, `<p id=… role="alert">`, `<button type="submit">` → `button-primary`. `:539-549` input mang `aria-describedby`/`aria-invalid` sẵn — chỉ thêm class
- `apps/web/src/app/sign-in-links.tsx:38-72` -- `<ul><li><a>` bốn provider; docblock `:24` ghi sai về i18n
- `apps/web/src/app/session-expiry-dialog.tsx:66-88` -- `role="dialog" aria-modal="false"`; thêm `tabIndex={-1}` + ref để chuyển focus, Escape đóng, class. Docblock `:12-30` giải thích vì sao **không** modal — giữ nguyên lập luận đó
- `apps/web/src/app/session-expiry-provider.tsx:129-141` -- dialog là **anh em** của trang, sau nó trong document order. Chỗ gắn `useEffect` chuyển focus

**Đọc để bám quy ước, không sửa:**
- `tests/gates/next-env-distdir.test.ts:1-40` -- khuôn luật quét: `readFileSync` + hằng chia sẻ với mã sản phẩm, docblock nói rõ luật này là backstop của cái gì
- `tests/gates/config-cast-ban.test.ts` -- khuôn strip comment đúng (`^[ \t]*\/\/.*$/gm` có neo) và mẹo ráp chuỗi dò để file không tự tố chính nó
- `apps/web/src/app/routes.test.ts:319` -- rule C: ký hiệu export mà chỉ test dùng là vi phạm
- `vitest.config.mts:104-119` -- project `web`: `environment: 'node'`, `oxc.jsx`, include `src/**/*.test.ts(x)`. **Không DOM, không `useEffect`**
- `playwright.config.ts:96-115` -- project `web`, `testMatch: /web\/.*\.spec\.ts$/`. `page.emulateMedia({ colorScheme, reducedMotion })` là đường duy nhất kiểm ba trạng thái
- `tests/e2e/web/dang-nhap.spec.ts:22-28` -- helper `scenario()`; selector đều theo role/label nên đổi class không làm đỏ

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/app/tokens.css` -- dịch 1:1 frontmatter `DESIGN.md` thành custom property, ba khối theme, **chỉ** custom property, không luật nào khác -- một file để luật quét soi, không lẫn
- [x] `tests/gates/design-tokens.test.ts` -- parse `DESIGN.md` frontmatter và `tokens.css`; đối chiếu hai chiều từng khoá màu; bắt mọi khối `prefers-color-scheme: dark` phải mang guard `:not([data-theme="light"])` -- đóng đường sinh bản giá trị thứ hai và đóng chỗ light-thủ-công dễ vỡ
- [x] `tests/gates/contrast.test.ts` -- tính WCAG từ chính `tokens.css`; 8 cặp chịu lực ≥ 4.5:1 hai chế độ, `border-ink` ≥ 3:1 hai chế độ; đối chiếu luôn với số đã công bố trong `DESIGN.md` -- số trong tài liệu phải là số đo được
- [x] `apps/web/src/app/globals.css` -- import tokens; reset, typography, `button-primary`/`button-secondary`/`chip-status`, `.sr`, `:focus-visible`, khối reduced-motion -- tầng trình bày
- [x] `apps/web/src/app/theme.ts` -- hàm thuần `resolveThemeChoice`, `themeAttributeFor`, và `themeBootScript()` trả về **mã nguồn** script chặn -- script nội tuyến không được là chuỗi không ai kiểm
- [x] `apps/web/src/app/theme.test.ts` -- test hàm thuần **và** `eval` mã script với `localStorage`/`matchMedia` giả, đối chiếu kết quả hai bên -- khúc giữa của seam
- [x] `apps/web/src/app/theme-switch.tsx` -- nút ba lựa chọn `aria-pressed`, ghi `localStorage`, gỡ thuộc tính khi chọn `system`, lắng nghe `matchMedia` change -- AC2
- [x] `apps/web/src/app/layout.tsx` -- import CSS, font, script chặn, `suppressHydrationWarning`, `<header>` chứa nút; sửa docblock i18n sai -- một chỗ duy nhất
- [x] `apps/web/src/app/page.tsx`, `dang-nhap/sign-in-outcome.tsx`, `khai-ngay-sinh/date-of-birth-form.tsx`, `sign-in-links.tsx` -- gắn class, không đổi ký hiệu, không đổi chữ hiển thị -- selector e2e theo role/label phải vẫn xanh
- [x] `apps/web/src/app/session-expiry-dialog.tsx` + `session-expiry-provider.tsx` -- chuyển focus khi mở, Escape đóng, class; **không** focus-trap, **không** backdrop -- mục nợ a11y từ 1.3c
- [x] `apps/web/src/app/layout.test.tsx` + các test `web` hiện có -- cập nhật theo header mới -- không để test cũ đỏ vì lý do không liên quan
- [x] `tests/e2e/web/he-thiet-ke.spec.ts` -- ba trạng thái theme qua `emulateMedia` + `data-theme`, `getComputedStyle` khớp `tokens.css`; reduced-motion; chiều cao 48px và vùng chạm 44px; vòng focus nhìn thấy sau `Tab`; reflow 320px không cuộn ngang; countdown vẫn chạy dưới `reduce` -- phần AC chỉ trình duyệt trả lời được
- [x] `tests/e2e/web/dang-nhap.spec.ts`, `khai-ngay-sinh.spec.ts` -- thêm ca focus của dialog phiên hết hạn; xác nhận 10 ca cũ vẫn xanh -- nợ 1.3c được chứng minh đã đóng
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- ghi i18n vô chủ; cập nhật ba mục còn lại gọi tên 1.6 -- mục nào đóng thì nói rõ đóng bằng gì

**Acceptance Criteria:**
- Given `tokens.css` và frontmatter `DESIGN.md`, when đổi một giá trị ở đúng một trong hai chỗ, then luật quét đỏ — bất kể đổi ở chỗ nào
- Given ba màn hình hiện có, when render sau khi áp hệ thiết kế, then 10 ca e2e của project `web` vẫn xanh mà không sửa selector nào
- Given người dùng bàn phím, when Tab tới bất kỳ nút, liên kết hay ô nhập nào ở cả hai chế độ, then vòng focus nhìn thấy được và `outline` không bằng `none`
- Given dialog phiên hết hạn mở ra, when nó xuất hiện, then focus chuyển vào nó và Escape đóng nó, **và** trang phía sau vẫn cuộn được — không backdrop, không focus-trap
- Given `next build` của `apps/web`, when chạy, then exit 0 và không có bản giá trị token thứ hai nào tồn tại trong repo

## Spec Change Log

Bốn điều đo được trong lúc build khác với những gì spec giả định. Không điều nào
đổi Intent hay Boundaries; cả bốn đổi cách thực hiện, nên chúng nằm ở đây.

**1. Số lượng token: 22 light + 23 dark, không phải "24 + 24".** Code Map nói
frontmatter `DESIGN.md` có "24 màu light + 24 màu `-dark`". Đếm thật: 22 khoá light
và 23 khoá `-dark`. Chênh lệch không phải làm tròn — `surface-elevated-dark` là
token DUY NHẤT không có cặp light. Nó không được bịa một giá trị light (bịa là sửa
`DESIGN.md` bằng một file khác), nên nó khai trong cả hai khối dark và không khai ở
`:root`. Luật "không màu nào định nghĩa CHỈ trong một media query" vẫn giữ vì
`:root[data-theme="dark"]` không phải media query, và `design-tokens.test.ts` khẳng
định danh sách token dark-only đúng bằng `['surface-elevated']` — thêm một cái thứ
hai là một luật đỏ, không phải một ngoại lệ im lặng.

**2. `next/font/google` làm đỏ `layout.test.tsx`, và Design Notes chỉ cảnh báo về
CSS.** Design Notes bảo kiểm bằng cách chạy chứ đừng tin dòng viết sẵn. Đã kiểm cả
hai: `import './globals.css'` KHÔNG làm đỏ gì (project `web` chạy `css: false`, nên
nó thành module rỗng — dòng trong spec đúng). Nhưng
`node_modules/next/font/google/index.js` là file **0 byte** — `next/font` là API
lúc build, và SWC của Next mới là thứ thay thế import. Ngoài một lần build,
`Be_Vietnam_Pro` là `undefined` và `layout.tsx` ném ngay ở module scope. Cách xử
lý: một alias cho riêng project `web` trong `vitest.config.mts` trỏ tới
`tests/support/next-font-google.ts`, có docblock giải thích. Ba lựa chọn còn lại
đều tệ hơn — bỏ font là xoá lý do `DESIGN.md` chọn typeface này để chiều một test
runner; đẩy lời gọi xuống một module lazy là giấu cùng lỗi đó sau một lớp nữa và
đổi thứ được ship. Vì `import './globals.css'` không quan sát được từ project này,
`layout.test.tsx` kiểm nó bằng cách ĐỌC source — cùng câu trả lời `routes.test.ts`
và `seam-usage.test.ts` đã chọn cho các luật một project không DOM không chạy được.

**3. `role="status"` trong layout làm đỏ một ca e2e cũ.** Nút đổi theme cần nói ra
palette đang bật là gì (`system` là một mong muốn, không phải một kết quả). Bản đầu
dùng `<p role="status">`; vì nó nằm trong layout nên nó có mặt trên MỌI màn hình, và
`khai-ngay-sinh.spec.ts:110` dùng đúng `page.getByRole('status')` để tìm thông báo
của chính nó — strict mode đỏ. Đo được chứ không đoán. Sửa bằng `aria-live="polite"`
trần: vẫn là live region, không thêm một `status` thứ hai vào cây. AC "10 ca cũ vẫn
xanh mà không sửa selector nào" giữ nguyên.

**4. So `getComputedStyle` với `tokens.css` phải chuẩn hoá giá trị, không so từng
byte.** Trình rút gọn CSS của Turbopack được phép viết lại một giá trị thành dạng
tương đương: `#FFFFFF` → `#fff`, `120ms` → `.12s`, `'Be Vietnam Pro'` →
`"Be Vietnam Pro"`, `0.02em` → `.02em`. Ba lần đo, ba dạng khác nhau. Ca e2e vì thế
so **giá trị** (một hàm `canonical()` với docblock nói rõ vì sao), còn phép so từng
byte giữa file và tài liệu vẫn nguyên ở `design-tokens.test.ts`. Nếu ca e2e đỏ vì
một dạng viết mới, đó là lỗi của `canonical()` chứ không phải cái cớ để nới lỏng
luật quét.

## Design Notes

**Vì sao tên biến CSS trùng nguyên văn khoá `DESIGN.md`.** Bất kỳ cách viết tắt nào (`--bink` như trong demo) buộc luật quét phải mang một bảng ánh xạ `border-ink → --bink`. Bảng đó chính là bản sao thứ hai — nó trôi được, và khi trôi thì luật quét vẫn xanh trong lúc CSS đã sai. Trùng tên biến khiến so sánh là một phép hợp hai tập khoá.

**Ba mắt xích, và vì sao cần cả ba.** Luật quét chứng minh CSS bằng tài liệu. Test tương phản chứng minh CSS đạt ngưỡng — tính từ chính CSS, nên nó không thể xanh nhờ một bảng số chép tay. Playwright chứng minh trình duyệt thật thấy đúng giá trị đó. Bỏ mắt xích thứ ba là tái lập đúng lỗi 204/200: hai đầu xanh, khúc giữa không ai chạy.

**Script chặn theme là khúc giữa nguy hiểm nhất.** Nó phải là chuỗi nội tuyến trong `<head>` (nếu không sẽ nháy sai màu một khung hình và React sẽ báo lệch hydrate), nên không import được gì. `themeBootScript()` trả về mã nguồn đó, và `theme.test.ts` `eval` chính chuỗi ấy rồi so với hàm thuần tương ứng. Đó là cách duy nhất một chuỗi được kiểm.

**Trạng thái `system` phải gỡ thuộc tính, không đặt thành `"system"`.** Demo dập `data-theme` vô điều kiện lúc tải (`demo-san-pham.html:1117`), nên trạng thái "theo hệ điều hành" bị huỷ ngay khi script chạy và đổi theme ở OS sau đó không được nhận. Đây là lỗi trong tham chiếu, không phải khuôn để chép.

**Reduced-motion không chạm đồng hồ.** Khối `@media (prefers-reduced-motion: reduce)` tắt `transition`/`animation` của CSS. Đồng hồ đếm ngược chạy bằng `setTimeout` trong React, không bằng CSS, nên nó tự nhiên vẫn cập nhật — AC đòi đúng điều đó. Ca e2e cho việc này cũng chạm được phần dư mà mục nợ 1.3b bảo là không test được; nếu nó thật sự đóng mục đó thì ghi vào deferred-work chứ đừng lặng lẽ.

**Vì sao dialog dùng chuyển focus chứ không live region.** Mục nợ 1.3c đề nghị "một live region luôn mount ở layout". Làm cả hai sẽ đọc hai lần. Với dialog không chặn màn hình, chuyển focus vào nó là cách chuẩn: trình đọc màn hình đọc dialog khi focus tới, và người dùng Tab ra được vì không có bẫy. Mục nợ cũng nói "focus-trap" — cái đó mâu thuẫn với `session-expiry-dialog.tsx:19-30`, và docblock thắng: nhốt focus là modal đội tên khác.

**Font.** `next/font/google` với `Be_Vietnam_Pro`, weight `400/500/600/800` (800 dùng dày đặc: mọi tiêu đề, nút, chip), `subsets: ['latin','vietnamese']` — thiếu subset vietnamese thì dấu rơi về font dự phòng, mà lý do chọn font này chính là chất lượng dấu. Nó tự host lúc build nên không có request bên thứ ba lúc chạy; giá phải trả là `next build` cần mạng lần đầu.

**Hai chi tiết dễ vấp, nói trước.** `theme-switch.tsx` phải mang `'use client'` — `layout.tsx` là server component và luật ranh giới hiện tại đặt biên ở chính provider, không kéo cả layout xuống client. Và project vitest `web` chạy với `css` mặc định (`false`), nên `import './globals.css'` trong `layout.tsx` được stub thành module rỗng thay vì làm đỏ `layout.test.tsx` — **kiểm bằng cách chạy, đừng tin dòng này**; nếu nó sai thì đó là phát hiện chứ không phải cái cớ bỏ import ra khỏi layout.

## Verification

**Commands:**
- `pnpm run typecheck` -- expected: exit 0
- `pnpm run dep-check` -- expected: không vi phạm; nếu `.css` mới bị báo orphan thì sửa `.dependency-cruiser.cjs`, không tắt luật
- `pnpm exec vitest run` -- expected: mọi test xanh, 0 skip; mỗi hàng Matrix có test **đã chạy và pass**
- `pnpm exec playwright test --project=web` -- expected: 10 ca cũ + ca mới đều xanh (`--project=api` giữ 3 ca, tổng 13)
- `pnpm --filter web build` -- expected: exit 0
- `git status` sau khi chạy e2e -- expected: sạch (`globalTeardown` đã lo `next-env.d.ts`)

**Manual checks (if no CLI):**
- Mở `/dang-nhap` ở cả ba trạng thái theme và so bằng mắt với `demo-san-pham.html` — luật quét kiểm giá trị, không kiểm việc chúng được dùng đúng chỗ


## Suggested Review Order

**Nguồn sự thật duy nhất của màu**

- Điểm vào: ba khối theme, và lý do light thủ công sống nhờ `:not()` chứ không nhờ một khối thứ tư
  [`tokens.css:49`](../../apps/web/src/app/tokens.css#L49)

- Khối dark trong media query — chỗ thiếu guard là chỗ người chọn sáng bị trả về tối
  [`tokens.css:143`](../../apps/web/src/app/tokens.css#L143)

- Luật quét đối chiếu tài liệu ↔ CSS: dark ghi đè cùng TÊN, không sinh biến thứ hai
  [`design-tokens.test.ts:130`](../../tests/gates/design-tokens.test.ts#L130)

- Không màu nào chỉ tồn tại sau một media query, và guard phải viết đúng chữ
  [`design-tokens.test.ts:155`](../../tests/gates/design-tokens.test.ts#L155)

**Tương phản đo được, không phải chép được**

- Tám cặp đọc thẳng từ bảng trong `DESIGN.md`; số trong tài liệu phải là số CSS sinh ra
  [`contrast.test.ts:167`](../../tests/gates/contrast.test.ts#L167)

- Hai mươi cặp `globals.css` tự ghép ra — lỗ mà vòng review 1 đóng lại
  [`contrast.test.ts:315`](../../tests/gates/contrast.test.ts#L315)

- Mọi `color:` trong `globals.css` phải có mặt trong bảng trên, nên cặp mới không lọt im lặng
  [`design-tokens.test.ts:226`](../../tests/gates/design-tokens.test.ts#L226)

**Ba trạng thái theme, và khúc giữa không ai chạy**

- `themeBootScript()` trả về MÃ NGUỒN, vì script trong `<head>` không import được gì
  [`theme.ts:139`](../../apps/web/src/app/theme.ts#L139)

- `system` là SỰ VẮNG MẶT của thuộc tính, không phải giá trị `"system"`
  [`theme.ts:95`](../../apps/web/src/app/theme.ts#L95)

- Test `eval` chính chuỗi đó rồi so với hàm thuần — đây là khúc giữa của seam
  [`theme.test.ts:149`](../../apps/web/src/app/theme.test.ts#L149)

- Script chặn trong `<head>` + `suppressHydrationWarning`, và vì sao cả hai bắt buộc
  [`layout.tsx:107`](../../apps/web/src/app/layout.tsx#L107)

**Sàn tiếp cận — phần chỉ trình duyệt trả lời được**

- Luật cấu trúc chống cắt vòng focus; `getComputedStyle` mù với lớp lỗi này
  [`he-thiet-ke.spec.ts:448`](../../tests/e2e/web/he-thiet-ke.spec.ts#L448)

- Sáu loại control × hai palette, dùng `.focus()` chứ không đếm số lần Tab
  [`he-thiet-ke.spec.ts:400`](../../tests/e2e/web/he-thiet-ke.spec.ts#L400)

- Mọi token của cả ba trạng thái được so với giá trị Chromium thật sự phân giải
  [`he-thiet-ke.spec.ts:133`](../../tests/e2e/web/he-thiet-ke.spec.ts#L133)

- Vòng focus 2px/offset 2px, và `outline: none` bị cấm ở sáu cách viết
  [`globals.css:189`](../../apps/web/src/app/globals.css#L189)

**Nợ a11y của Story 1.3c, đóng bằng chuyển focus chứ không nhốt focus**

- Escape nghe ở `document` khi dialog mở — nhốt focus là modal đội tên khác
  [`session-expiry-provider.tsx:270`](../../apps/web/src/app/session-expiry-provider.tsx#L270)

- Focus chỉ chuyển ở chuyển tiếp đóng→mở, không mỗi lần `prompt` đổi nhận dạng
  [`session-expiry-provider.tsx:249`](../../apps/web/src/app/session-expiry-provider.tsx#L249)

**Component base và ba màn hình**

- Viền `border-ink` nét đứt: giữ tín hiệu "chỗ để điền", bỏ màu 1,41:1
  [`globals.css:472`](../../apps/web/src/app/globals.css#L472)

- Sàn 48px, bóng lệch mức 1, và không một mã hex nào trong cả file
  [`globals.css:305`](../../apps/web/src/app/globals.css#L305)

**Phụ trợ**

- Alias `next/font/google` cho riêng project `web`; module thật là file 0 byte
  [`vitest.config.mts:131`](../../vitest.config.mts#L131)

- Parser dùng chung của cả ba mắt xích — ném khi một nhóm parse rỗng, để không xanh rỗng
  [`design-tokens.ts:1`](../../tests/support/design-tokens.ts#L1)
