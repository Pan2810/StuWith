---
name: StuWith
description: Phòng học live nơi ai cũng có thể ẩn mặt mà vẫn xây được uy tín. Hệ thiết kế "Cắm trại" — tím sâu, coral, viền ink dày và bóng lệch, dựng trên xương Material 3.
status: final
updated: 2026-08-20
sources:
  - docs/prd.md
  - docs/brief.md
experience: ./EXPERIENCE.md
colors:
  # --- LIGHT (mặc định) ---
  surface-base: '#F3F0FF'
  surface-raised: '#FFFFFF'
  surface-sunken: '#E7E1FB'
  ink-primary: '#211A3D'
  ink-secondary: '#5A5375'
  ink-disabled: '#9A93B5'
  border-ink: '#211A3D'
  border-decor: '#DCD5F5'
  primary: '#6C4CF0'
  on-primary: '#FFFFFF'
  ok: '#0C6B46'
  ok-container: '#DFF7EC'
  warn: '#97301A'
  warn-container: '#FFE8E2'
  coin: '#7E5200'
  coin-container: '#FFF3D6'
  coin-fill: '#F5A623'
  danger: '#A32020'
  danger-container: '#FCEDED'
  coral: '#FF6F52'
  tile-video: '#A895F5'
  tile-avatar-bg: '#FFF3D6'
  # --- DARK ---
  surface-base-dark: '#121020'
  surface-raised-dark: '#1C1833'
  surface-sunken-dark: '#0B0917'
  surface-elevated-dark: '#262042'
  ink-primary-dark: '#EDE9FF'
  ink-secondary-dark: '#A9A2C9'
  ink-disabled-dark: '#6E678F'
  border-ink-dark: '#7268B5'
  border-decor-dark: '#332C57'
  primary-dark: '#A78BFA'
  on-primary-dark: '#14092E'
  ok-dark: '#4FDDA6'
  ok-container-dark: '#102E22'
  warn-dark: '#FF9878'
  warn-container-dark: '#331A14'
  coin-dark: '#FFC85C'
  coin-container-dark: '#33290F'
  coin-fill-dark: '#FFC85C'
  danger-dark: '#FF8B8B'
  danger-container-dark: '#2B1616'
  coral-dark: '#FF9878'
  tile-video-dark: '#3A2E6B'
  tile-avatar-bg-dark: '#33290F'
typography:
  base:
    fontFamily: "'Be Vietnam Pro', Roboto, 'Segoe UI', system-ui, sans-serif"
  display:
    fontSize: 34px
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: '-0.02em'
  headline:
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.25
  title:
    fontSize: 17px
    fontWeight: 800
    lineHeight: 1.3
  body:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.55
  body-strong:
    fontSize: 15px
    fontWeight: 800
    lineHeight: 1.55
  label:
    fontSize: 13px
    fontWeight: 800
    lineHeight: 1.4
  meta:
    fontSize: 12.5px
    fontWeight: 600
    lineHeight: 1.45
  numeric:
    fontSize: 15px
    fontWeight: 800
    lineHeight: 1.3
    note: 'font-variant-numeric: tabular-nums — bắt buộc cho mọi số coin, thời gian, đếm ngược'
  countdown:
    fontSize: 44px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: '-0.02em'
    note: 'tabular-nums bắt buộc — chữ số không được đổi bề rộng khi đếm'
rounded:
  sm: 14px
  md: 20px
  lg: 22px
  xl: 28px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 20px
  '6': 24px
  '8': 32px
  '12': 48px
  gutter: 16px
  margin-desktop: 32px
  margin-mobile: 16px
  tile-gap: 14px
  tile-gap-dense: 8px
motion:
  duration-fast: 120ms
  duration-base: 200ms
  duration-slow: 320ms
  easing-standard: 'cubic-bezier(0.2, 0, 0, 1)'
  network-chip-debounce: 3000ms
  note: 'Mọi chuyển động trang trí tắt dưới prefers-reduced-motion; đồng hồ đếm ngược vẫn cập nhật vì đó là thông tin, không phải hiệu ứng.'
components:
  tile-participant:
    radius: '{rounded.lg}'
    border: '2px solid {colors.border-ink}'
    background-video: '{colors.tile-video}'
    background-avatar: '{colors.surface-raised}'
    avatar-background: '{colors.tile-avatar-bg}'
    aspect-ratio: '4 / 3'
    speaking-ring: '4px solid {colors.primary}'
  control-bar:
    background: '{colors.surface-raised}'
    border-top: '2px dashed {colors.border-decor}'
    gap: '{spacing.3}'
    item-min-height: 48px
  face-mode-panel:
    radius: '{rounded.md}'
    border: '2px solid {colors.border-ink}'
    background: '{colors.surface-raised}'
    shadow: '4px 4px 0 {colors.border-ink}'
    option-radius: '{rounded.sm}'
    option-selected-border: '3px solid {colors.primary}'
  chip-status:
    radius: '{rounded.full}'
    padding: '8px 14px'
    border: '2px solid {colors.border-ink}'
    typography: '{typography.meta}'
    note: 'ok / warn / coin dùng container cùng tên; viền luôn là border-ink, không đổi theo trạng thái'
  button-primary:
    background: '{colors.primary}'
    color: '{colors.on-primary}'
    border: '2px solid {colors.border-ink}'
    radius: '{rounded.full}'
    shadow: '3px 3px 0 {colors.border-ink}'
    padding: '13px 22px'
    typography: '{typography.body-strong}'
    min-height: 48px
  button-secondary:
    background: '{colors.surface-raised}'
    color: '{colors.ink-primary}'
    border: '2px solid {colors.border-ink}'
    radius: '{rounded.full}'
    min-height: 48px
    typography: '{typography.body-strong}'
  badge-credential:
    radius: '{rounded.full}'
    background: '{colors.surface-raised}'
    border: '2px solid {colors.border-ink}'
    typography: '{typography.meta}'
    note: 'tối đa 2 badge trên một tile; badge thứ 3 trở đi gộp thành "+N"'
  card-ask-confirm:
    radius: '{rounded.xl}'
    background: '{colors.surface-raised}'
    border: '2px solid {colors.border-ink}'
    shadow: '6px 6px 0 {colors.border-ink}'
    max-width: 480px
  card-coin:
    background: '{colors.coin-container}'
    border: '2px solid {colors.border-ink}'
    radius: '{rounded.md}'
    shadow: '4px 4px 0 {colors.border-ink}'
    padding: '{spacing.5}'
  transaction-row:
    background: '{colors.surface-raised}'
    border-bottom: '2px solid {colors.border-decor}'
    typography: '{typography.numeric}'
    padding: '{spacing.3} {spacing.4}'
  countdown-display:
    color: '{colors.ink-primary}'
    typography: '{typography.countdown}'
    note: 'màu ink, không màu coin — ở nền coin-container thì ink cho tương phản 14.88:1'
  progress-coin:
    height: 12px
    radius: '{rounded.full}'
    track: '{colors.surface-raised}'
    track-border: '2px solid {colors.border-ink}'
    fill: '{colors.coin-fill}'
  chat-panel:
    background: '{colors.surface-raised}'
    border-left: '2px solid {colors.border-ink}'
    composer-border: '2px dashed {colors.border-decor}'
    composer-radius: '{rounded.md}'
  dialog-busy:
    radius: '{rounded.xl}'
    background: '{colors.surface-raised}'
    border: '2px solid {colors.border-ink}'
    shadow: '6px 6px 0 {colors.border-ink}'
    max-width: 420px
    note: 'vùng giọng ấm — không dùng card-coin bên trong, vì chưa có đồng coin nào bị trừ'
  strip-join-request:
    radius: '{rounded.md}'
    background: '{colors.surface-raised}'
    border: '2px solid {colors.border-ink}'
    max-height: '1 dòng'
    note: 'không bóng lệch — nó nằm trong panel phiên, không nổi lên trên. Hai nút cùng trọng lượng.'
  snackbar:
    radius: '{rounded.sm}'
    background: '{colors.ink-primary}'
    color: '{colors.surface-raised}'
    border: '2px solid {colors.border-ink}'
---

# StuWith — Design Spine

> Hệ thiết kế "Cắm trại". Kế thừa xương **Material 3** (token, motion, ngưỡng a11y) nhưng thay toàn bộ palette, typography, shape và **ngôn ngữ độ sâu** để StuWith có nhận diện riêng. Cặp với `EXPERIENCE.md` — file đó sở hữu *cách hoạt động*, file này sở hữu *cách trông*. **Spine thắng mọi mock khi có xung đột.**

## Quy ước đọc token

Hai luật này là hợp đồng với mọi consumer phía dưới (code, story, thiết kế). Đọc trước khi dùng bất cứ token nào:

1. **Ánh xạ light → dark.** Mọi token có hậu tố `-dark` là biến thể chế độ tối của token cùng tên. Khối `components` chỉ viết tên token gốc (`{colors.primary}`); trình phân giải tự đổi sang `{colors.primary-dark}` khi ở chế độ tối. Token **không** có cặp `-dark` (toàn bộ `spacing`, `rounded`, `typography`, `motion`) là chung cho cả hai chế độ.
2. **Khoá component là kebab-case tiếng Anh.** `tile-participant`, `card-ask-confirm`, `countdown-display`… là **cùng một khoá** ở cả hai spine. `EXPERIENCE.md § Component Patterns` dùng đúng những khoá này, kèm nhãn tiếng Việt trong ngoặc cho người đọc. Ghép hai file bằng khoá, không bằng nhãn.

## Brand & Style

StuWith không phải phần mềm họp hành. Nó là một thư viện mở lúc nửa đêm mà ai cũng vào được — và điều lạ nhất về nó là bạn được phép giấu mặt trong đó mà vẫn xây được uy tín thật.

"Cắm trại" nhận lấy điều lạ đó và biến nó thành ngôn ngữ hình. Tím sâu, coral, viền đen dày 2px, bóng đổ lệch cứng — thứ ngôn ngữ của đồ chơi, của sticker, của trò chơi. Ẩn mặt ở đây không phải một cài đặt riêng tư nghiêm trọng mà là một lựa chọn vui: bạn chọn hiện lên thế nào, như chọn nhân vật. Huy hiệu học vấn và hạng uy tín trông như thành tựu mở khoá được. Với người học lúc 11 giờ đêm, đang ngại và đang mệt, đó là lời mời dễ nhận hơn nhiều so với một giao diện nghiêm túc.

Sự vui đó được kìm lại ở đúng hai chỗ, và đây là điều mọi quyết định về sau phải phục tùng:

1. **Mạng yếu không phải trạng thái lỗi.** Video tụt xuống avatar là chuyện bình thường của việc học ở phòng trọ, và hệ thiết kế phải làm nó trông *bình thường* — không hoảng loạn, không đỏ rực.
2. **Tiền không được vui.** Coin và đồng hồ đếm ngược dùng hệ màu riêng và chữ số tabular. Bề mặt tiền giữ đúng ngôn ngữ hình (viền dày, bóng lệch) nhưng bỏ hết yếu tố đùa: không emoji thừa, không màu nhảy múa, không câu chữ nhí nhảnh. Người dùng không bao giờ được bất ngờ vì bị trừ coin.

## Colors

Palette có năm nhóm, mỗi nhóm một nhiệm vụ, không được mượn qua lại.

- **Tím giấy (`surface-base #F3F0FF` / dark `#121020`)** là nền. Ở chế độ tối, nền giữ sắc tím-mực chứ không trung tính: nếu nền tối ngả xám, sản phẩm lập tức thành một app họp hành khác.
- **Tím thương hiệu (`primary #6C4CF0` / `#A78BFA`)** là màu duy nhất mang nghĩa "thương hiệu và hành động chính": nút chính, viền người đang nói, chế độ khuôn mặt đang chọn. **Không** dùng cho coin, **không** dùng cho trạng thái mạng.
- **Ink (`border-ink #211A3D` / `#7268B5`)** là chữ ký hình của hướng này — viền 2px và bóng lệch cứng đều dùng màu này. Nó vừa là đường nét vừa là độ sâu.
- **Coral (`coral #FF6F52`)** là màu nhấn trang trí duy nhất, và **không bao giờ mang chữ** — độ tương phản của nó trên nền trắng chỉ 2.75:1. Khi cần chữ cảnh báo, dùng `warn #97301A` trên `warn-container #FFE8E2`.
- **Vàng coin (`coin` / `coin-container` / `coin-fill`)** thuộc về tiền và chỉ tiền. Lưu ý ba token: `coin` là màu **chữ** (đủ tương phản), `coin-container` là nền, `coin-fill #F5A623` là màu **tô** cho thanh tiến trình và chỉ dùng làm mảng đặc — không bao giờ làm màu chữ.

Mọi cặp tiền cảnh/hậu cảnh chịu lực đã tính theo WCAG 2.1 và đạt tối thiểu **AA 4.5:1**:

| Cặp | Light | Dark |
|---|---|---|
| `ink-primary` trên `surface-base` | 14.63:1 | 15.79:1 |
| `ink-primary` trên `surface-raised` | 16.41:1 | 14.42:1 |
| `ink-secondary` trên `surface-raised` | 7.17:1 | 7.08:1 |
| `on-primary` trên `primary` | 5.34:1 | 6.96:1 |
| `coin` trên `coin-container` | 6.15:1 | 9.33:1 |
| `warn` trên `warn-container` | 6.50:1 | 7.71:1 |
| `ok` trên `ok-container` | 5.82:1 | 8.51:1 |
| `countdown-display` (ink) trên `coin-container` | 14.88:1 | — |

**Viền cũng đạt ngưỡng thành phần giao diện (WCAG 1.4.11, ≥ 3:1):** `border-ink` đạt **16.41:1** ở light và **3.55:1** ở dark. Đây là lợi thế thật của hướng "Cắm trại" — ô người tham gia và nút phụ phân biệt bằng viền, nên viền phải là thành phần chịu lực chứ không phải trang trí. `border-decor` (#DCD5F5 / #332C57) **chỉ** dùng cho vạch phân cách trang trí, không bao giờ là ranh giới duy nhất của một thành phần bấm được.

Cặp tím/coral vẫn nguy hiểm với người mù màu: **màu không bao giờ được là kênh duy nhất**, xem `Do's and Don'ts`.

Tránh: gradient trên bề mặt nội dung (chỉ ô video được phép), màu thứ sáu ngoài năm nhóm trên, và mọi biến thể nhạt của `primary` dùng làm nền chữ.

## Typography

Font nền là **Be Vietnam Pro** — chọn vì chất lượng dấu tiếng Việt, không vì thẩm mỹ. Dấu ngã, dấu hỏi và các tổ hợp hai dấu (ế, ượ, ỗ) phải đọc được ở cỡ `meta` 12.5px trên laptop cũ; phần lớn font sans phổ biến đặt dấu quá sát ở cỡ nhỏ. Hướng "Cắm trại" còn cần các trọng lượng rất đậm (800) mà Be Vietnam Pro có sẵn và vẫn giữ dấu rõ. Fallback: Roboto → Segoe UI → system-ui.

Thang chữ nghiêng hẳn về đậm: `body` là 500 chứ không phải 400, tiêu đề là 800. Đó là một phần nhận diện, và cũng phục vụ ngữ cảnh — đọc trong phòng tối, mắt mỏi, người dùng gồm cả người không rành công nghệ.

**Luật cứng về số:** mọi con số biến thiên theo thời gian — đồng hồ đếm ngược, số dư coin, số coin đã trừ, số người trong phòng — phải dùng `font-variant-numeric: tabular-nums`. Chữ số đổi bề rộng khi đếm ngược làm layout giật, và với một đồng hồ đang tiêu tiền của người dùng thì sự giật đó đọc như một trục trặc.

Không dùng chữ in hoa toàn phần cho câu tiếng Việt — dấu bị dồn và khó đọc. In hoa chỉ cho nhãn một hai từ.

## Layout & Spacing

Thang cách: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48. Khoảng lớn nhất giữa các vùng chức năng (sân khấu ↔ rail phải), nhỏ nhất trong một thẻ.

Bố cục chủ đạo **desktop-first**: sân khấu co giãn + rail phải cố định 330px chứa hỏi riêng và chat.

| Ngưỡng | Lưới người | Rail |
|---|---|---|
| ≥ 1280px | 3–4 cột, `tile-gap` 14px | Cố định 330px, luôn hiện |
| 900–1279px | 3 cột | Thu còn 300px |
| 600–899px | 2 cột | Rời khỏi luồng, thành panel trượt từ phải |
| < 600px | 1–2 cột, `tile-gap-dense` 8px | Thành sheet kéo lên từ đáy |

Với lớp Campus 45–100 người, lưới chuyển sang chế độ dày: `tile-gap-dense`, ô nhỏ hơn, huy hiệu trên ô rút gọn. Không hiển thị quá 12 ô cùng lúc trên desktop — phần còn lại sau "Xem tất cả N người".

Bố cục phải **reflow được ở tương đương 320px CSS width** (WCAG 1.4.10) — kể cả khi người dùng zoom 200% trên desktop, không được sinh cuộn ngang.

Lề: `margin-desktop` 32px, `margin-mobile` 16px.

## Elevation & Depth

Đây là chỗ "Cắm trại" khác hẳn Material mặc định. Độ sâu **không** đến từ bóng mờ toả đều mà từ **bóng lệch cứng**: một khối màu `border-ink` dịch 3–6px theo trục chéo, không blur, không alpha. Nó đọc như một miếng dán được nhấc lên khỏi giấy.

| Mức | Bóng | Dùng cho |
|---|---|---|
| 0 | không | ô người tham gia, hàng danh sách, nền |
| 1 | `3px 3px 0 {colors.border-ink}` | `button-primary` |
| 2 | `4px 4px 0 {colors.border-ink}` | `card-coin`, `face-mode-panel` |
| 3 | `6px 6px 0 {colors.border-ink}` | `card-ask-confirm` |

Ở chế độ tối, bóng lệch dùng `border-ink-dark` và **giảm một mức** (mức 3 → 4px) vì tương phản nền đã tự tạo chiều sâu. Không bao giờ trộn bóng lệch với bóng mờ.

## Shapes

Bo góc rộng và không đều nhau là một phần của chất đồ chơi: `sm` 14px cho ô nhập, `md` 20px cho thẻ, `lg` 22px cho ô người tham gia, `xl` 28px cho dialog. `full` cho **mọi nút**, chip, huy hiệu và avatar — nút hình viên thuốc là chữ ký của hướng này, khác hẳn nút bo nhẹ của Material mặc định.

Avatar trong ô người tham gia dùng bo `lg` và xoay nhẹ −3° — chi tiết duy nhất được phép "nghịch", và chỉ ở avatar chữ cái, không bao giờ ở luồng video thật.

Hình ảnh và luồng video bám đúng bo góc của khung chứa, không tràn.

## Components

Khoá component dưới đây là **khoá chung với `EXPERIENCE.md`**. Mục này đặc tả *cách trông*; luật hành vi nằm ở `EXPERIENCE.md § Component Patterns` dưới đúng khoá đó.

**`tile-participant`** *(Ô người tham gia)* — Tỉ lệ 4:3, `rounded.lg`, viền `border-ink` 2px. Bốn lớp thông tin xếp cố định:
- Trên-trái: mic tắt (chip `warn-container`).
- Trên-phải: chế độ khuôn mặt, và **một** chip trạng thái hỏi riêng, ba biến thể loại trừ nhau: chip `coin-container` ghi đơn giá (đang rảnh, nhận hỏi) · chip `surface-sunken` ghi 🔒 "Đang hỏi riêng" (đang bận) · chip `surface-sunken` ghi "Đang chờ" (bạn đã đăng ký báo). Không bao giờ hiện hai chip cùng lúc — trạng thái bận **thay chỗ** đơn giá chứ không xếp cạnh.
- Dưới-trái: tên + tối đa **2** `badge-credential`; badge thứ 3 trở đi gộp thành `+N`.
- Toàn ô: khi đang nói, thêm `speaking-ring` 4px `primary` — **kèm** chip chữ "Đang nói".

Ở lưới dày (Campus), huy hiệu rút còn 1 và chip đơn giá ẩn; thông tin đầy đủ nằm sau khi bấm vào ô.

**`control-bar`** *(Thanh điều khiển phòng)* — Dải ngang dưới sân khấu, nền `surface-raised`, ngăn cách bằng viền `border-decor` 2px nét đứt. Các nút dùng `button-secondary` trừ nút Khuôn mặt dùng `button-primary`. Nút Rời phòng dùng nền `danger-container`. Mọi mục cao tối thiểu 48px.

**`face-mode-panel`** *(Bảng chế độ khuôn mặt)* — Popover neo từ `control-bar`, `rounded.md`, viền ink 2px, bóng lệch mức 2. Ba lựa chọn xếp ngang, mỗi lựa chọn có ô biểu tượng lớn + nhãn; lựa chọn đang bật viền `primary` 3px. Có ô xem trước chính mình ở trên cùng.

**`chip-status`** — Ba biến thể `ok` / `warn` / `coin` dùng container cùng tên. Viền luôn là `border-ink` 2px, **không** đổi màu theo trạng thái — trạng thái thể hiện bằng nền và chữ. Luôn có cả dấu chấm màu **và** chữ; không bao giờ chỉ icon.

**`button-primary` / `button-secondary`** — Cao tối thiểu 48px, `rounded.full`, viền ink 2px, chữ `body-strong`. Primary thêm bóng lệch mức 1. Ngưỡng 48px là sàn cứng, không ngoại lệ cho nút phụ.

**`badge-credential`** — Chip `full`, viền ink 2px. Ba loại phân biệt bằng **chữ và ký hiệu**, không chỉ bằng màu: 🎓 học vấn đã xác minh · ▲ hạng uy tín mùa · ● badge kỹ năng. Huy hiệu học vấn **chỉ** render khi đã xác minh — không có biến thể "đang chờ duyệt" hiển thị công khai.

**`card-ask-confirm`** *(Thẻ xác nhận hỏi riêng)* — Dialog rộng tối đa 480px, `rounded.xl`, bóng lệch mức 3. Bên trong bắt buộc có một khối `card-coin` chứa đơn giá, block, số dư và ước tính. Đây là bề mặt tiền: không emoji, không câu chữ nhí nhảnh.

**`card-coin`** — Nền `coin-container`, viền ink 2px, bóng lệch mức 2. Dùng cho khối tiền bên trong `card-ask-confirm`, thẻ phiên đang chạy, và biên nhận nạp. Không dùng cho bất kỳ nội dung nào không liên quan tiền.

**`transaction-row`** *(Thẻ giao dịch)* — Hàng trong lịch sử ví. Nền `surface-raised`, phân cách bằng `border-decor` 2px. Cột phải là số tiền dùng `typography.numeric` (tabular). Số âm và dương phân biệt bằng **dấu và nhãn**, không chỉ bằng màu.

**`countdown-display`** — 44px/800, tabular-nums. Màu là `ink-primary`, **không** phải `coin` — vì nó luôn nằm trên `coin-container`, và ink cho 14.88:1 thay vì 6.15:1. Luôn đi kèm một dòng `meta` giải thích *tại sao* con số đó là con số đó.

**`progress-coin`** — Thanh 12px, viền ink 2px, tô bằng `coin-fill`. Không bao giờ đứng một mình: luôn cặp với `countdown-display`, vì thanh tiến trình một mình không nói được còn bao nhiêu phút.

**`chat-panel`** *(Chat cả phòng)* — Cột phải hoặc sheet đáy. Ngăn với sân khấu bằng viền ink 2px. Tên người gửi màu `primary`, nội dung `ink-primary`. Ô soạn tin viền `border-decor` nét đứt `rounded.md` — nét đứt báo hiệu "chỗ để điền", dùng nhất quán cho mọi ô nhập rỗng.

**`strip-join-request`** — Dải ngang trong panel phiên hỏi riêng, `rounded.md`, viền ink 2px, **không** bóng lệch (nó không nổi lên trên, nó nằm trong). Cao tối đa một dòng. Nút đồng ý và nút bỏ qua **cùng trọng lượng thị giác** — không nút nào được tô `primary`.

**`snackbar`** — Nền `ink-primary`, chữ `surface-raised`, viền ink 2px. Xác nhận nhẹ. **Không** dùng cho bất kỳ thông báo nào liên quan tiền — tiền luôn ở thẻ đọc lại được, không ở thứ biến mất sau 4 giây.

→ Tham chiếu thị giác 1:1: [`mockups/phong-hoc-live.html`](mockups/phong-hoc-live.html) · [`mockups/pre-join.html`](mockups/pre-join.html) · [`mockups/xac-nhan-hoi-rieng.html`](mockups/xac-nhan-hoi-rieng.html) · [`mockups/kham-pha-ai-match.html`](mockups/kham-pha-ai-match.html). Ba hướng thiết kế đã cân nhắc rồi loại nằm ở `.working/direction-*.html`. **Spine thắng khi xung đột.**

## Do's and Don'ts

**Làm**
- Luôn ghép màu với chữ hoặc ký hiệu. "Mạng yếu" là chữ; chấm màu chỉ phụ trợ.
- Dùng `tabular-nums` cho mọi số biến thiên.
- Giữ nút ≥ 48px và vùng chạm ≥ 44px kể cả trên desktop.
- Dùng `border-ink` cho mọi ranh giới của thành phần bấm được — nó đạt ngưỡng 3:1 ở cả hai chế độ.
- Vẽ mọi màn hình có người-trong-phòng ở **cả hai** trạng thái: có video và chỉ avatar.
- Giữ nền dark ngả tím-mực.

**Không làm**
- Không dùng `coral` hay `coin-fill` làm màu chữ — cả hai đều dưới ngưỡng tương phản.
- Không dùng `coin` (vàng) cho bất cứ thứ gì không phải tiền.
- Không dùng `danger` (đỏ) cho mạng yếu. Mạng yếu là `warn`.
- Không đưa yếu tố đùa (emoji thừa, câu chữ nhí nhảnh, màu nhảy múa) vào bề mặt tiền.
- Không thông báo việc trừ coin bằng `snackbar`.
- Không dùng `border-decor` làm ranh giới duy nhất của thành phần bấm được.
- Không trộn bóng lệch cứng với bóng mờ.
- Không in hoa toàn phần câu tiếng Việt.
- Không hiển thị huy hiệu học vấn chưa xác minh.
- Không để hơn 2 huy hiệu trên một ô người tham gia.
