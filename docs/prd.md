---
title: PRD — StuWith (MVP S0–S4)
status: final
created: 2026-08-19
updated: 2026-08-21
owner: IPan
sources:
  - docs/brief.md
  - casan_harness_assessment.md
  - _bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/EXPERIENCE.md
---

# PRD — StuWith (MVP S0–S4)

> BMAD · Project Brief → **PRD** → UX → Architecture
> Tạo 2026-08-19 · Cập nhật **2026-08-21** · Chủ dự án: IPan
> Tham chiếu: `docs/brief.md`, `casan_harness_assessment.md`, và UX spine tại `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/`
>
> **Thay đổi 2026-08-20:** thêm **US-0.5** (khai tuổi & chặn hành vi) · sửa **US-2.3 AC5** và thêm AC6–AC7 (phiên nhiều người, mỗi người trả đủ giá) · thêm **US-2.4** (xin tham gia phiên hỏi riêng) · **gỡ US-4.3 ghi hình khỏi MVP**.
>
> **Thay đổi 2026-08-21** *(từ vòng kiến trúc và 3 lệ review độc lập)*: **US-2.3 AC7** mới — người được hỏi tắt mic thì dừng đồng hồ · **US-3.4 AC1** sửa — KYC qua bên thứ ba, không endpoint nào nhận tệp · **US-3.4 AC4** mới — endpoint thu hồi quyền thuộc S3 · giả định **A-1 đã xác nhận**.

---

## 1. Luận điểm, mục tiêu MVP & thước đo

### 1.1 Luận điểm — thứ StuWith đặt cược

> **Rất nhiều người muốn học cùng người khác nhưng không dám, vì học cùng người lạ đồng nghĩa với lộ mặt, lộ trình độ, lộ chỗ mình đang dốt.** StuWith đặt cược rằng nếu tách được *sự hiện diện* khỏi *danh tính* — cho phép ẩn mặt hoàn toàn mà **vẫn** tích được uy tín thật, đã xác minh — thì sẽ mở khoá một nhóm người học mà cả lớp online lẫn mạng xã hội học tập hiện nay đều không phục vụ: người ngại.

Ba hệ quả trực tiếp của luận điểm, và mọi thứ trong PRD này phải phục tùng chúng:

1. **Ẩn danh không được là chế độ hạng hai.** Ẩn mặt phải mượt bằng để nguyên; uy tín và huy hiệu vẫn tích được khi ẩn mặt. Nếu ẩn danh làm người dùng mất thứ gì, luận điểm sụp.
2. **Uy tín phải thật thì ẩn danh mới an toàn.** Huy hiệu học vấn đã xác minh, báo cáo mạnh, chặn hành vi có tiền với người dưới 18 — đây không phải tính năng phụ, chúng là đối trọng giữ cho ẩn danh không biến thành nơi trú ẩn.
3. **Coin là để làm việc hỏi trở nên khả thi, không phải để kiếm tiền từ người học.** Người ngại thường không dám chiếm thời gian của người khác; trả coin làm việc hỏi trở nên sòng phẳng. Nếu thiết kế biến thành ép tiêu coin, luận điểm cũng sụp.

### 1.2 Mục tiêu MVP

MVP chứng minh vòng giá trị cốt lõi: **đăng nhập → vào phòng học live → học ẩn danh → hỏi cả phòng / hỏi riêng bằng coin → tích uy tín**. Chạy được trên **local (Docker Compose)** và sẵn sàng đẩy cloud.

### 1.3 Tiêu chí nghiệm thu kỹ thuật (điều kiện cần)

Cả ba đều **bắt buộc đạt** trước khi mở cho người dùng thật. Lưu ý: cả ba có thể xanh hoàn toàn ở một sản phẩm không ai dùng — chúng là điều kiện cần, không phải thước đo thành công.

- Vào phòng **p90 < 5s** trên kết nối 4G phổ thông; audio không rớt khi băng thông tụt (video tự degrade → avatar).
- Giao dịch coin chính xác 100% **cho từng người tham gia** (không trừ trùng, không trừ nhầm người trong phiên nhiều người, có audit log bất biến).
- 0 sự cố rò rỉ credential/PII trong log (H4 CASAN). Ngày sinh (US-0.5) tính là PII.

### 1.4 Thước đo thành công — kiểm chứng luận điểm

| Thước đo | Đo cái gì | Vì sao |
|---|---|---|
| **Tỉ lệ quay lại 7 ngày** — người vào phòng lần hai trong vòng 7 ngày | Sản phẩm có đáng quay lại không | Không có chỉ số này thì mọi chỉ số còn lại chỉ đo sự tò mò |
| **Tỉ lệ phiên ẩn mặt** trên tổng số lượt vào phòng | Luận điểm §1.1 có đúng không | Nếu gần như không ai ẩn mặt, luận điểm sai và cần xoay hướng — đây là chỉ số quan trọng nhất của MVP |
| **Tỉ lệ phiên hỏi riêng kết thúc bởi người hỏi**, không phải bởi hết coin | Coin có đang phục vụ việc học hay đang cắt ngang nó | Hệ quả §1.1.3 |
| **Tỉ lệ người ẩn mặt có được ít nhất một huy hiệu/điểm uy tín** | Ẩn danh có thật sự không phải hạng hai không | Hệ quả §1.1.1 |

### 1.5 Counter-metric — dấu hiệu đang đi sai hướng

| Counter-metric | Ngưỡng cảnh báo | Nó bắt cái gì |
|---|---|---|
| Số báo cáo trên mỗi 100 phiên hỏi riêng | Tăng liên tục qua 3 tuần | Ẩn danh đang bị lạm dụng nhanh hơn khả năng đối trọng — đặc biệt nguy hiểm khi giao diện moderator đang hoãn (§7) |
| Tỉ lệ người tiêu hết coin trong tuần đầu | > 30% | Thiết kế đang ép tiêu coin thay vì phục vụ việc hỏi |
| Tỉ lệ phiên hỏi riêng bị người được hỏi từ chối / bỏ qua | Cao và tăng | Cơ chế hỏi riêng đang gây phiền, không phải đang kết nối |

---

## 2. Personas

Mỗi persona dưới đây phải ràng buộc ít nhất một quyết định trong PRD; nếu không, nó không thuộc về đây.

| Persona | Nhu cầu chính | Ràng buộc nó đặt lên PRD |
|---|---|---|
| **Người học ngại** — nhóm chính của luận điểm §1.1 | Học cùng người khác mà không phải lộ mặt hay lộ chỗ mình dốt | Pre-join bắt buộc trước khi camera bật (US-2.1) · ẩn mặt xử lý client-side, mặt gốc không rời máy · vẫn tích được uy tín khi ẩn mặt (US-3.2, US-3.3) |
| **Người học chủ động** | Tìm đúng lớp, hỏi được ngay khi kẹt | AI match theo nguyện vọng (US-3.1) · hỏi cả phòng miễn phí (US-1.4) · hỏi riêng trả coin (US-2.3) |
| **Gia sư / người tạo lớp** | Mở phòng, thu coin khi được hỏi, xây uy tín | Tự đặt giá trong khung (US-2.3 AC1) · huy hiệu học vấn đã xác minh (US-3.3) · phiên nhiều người để tăng thu mà không tăng giờ (US-2.3 AC6) |
| **Tổ chức / giáo viên (gói Campus)** | Tổ chức lớp đông người | Trần 45–100 người (US-4.1) · OAuth Microsoft cho tài khoản tổ chức (US-0.1 AC1) · lưới dày cho lớp đông |
| *(Sprint sau)* **Nhà tuyển dụng** | Xem hồ sơ đã xác minh | Không ràng buộc gì trong MVP — hồ sơ 3 trục (US-3.3) là nền cho sau này, và hiển thị phải opt-in |

> **User Journey không nằm trong PRD này.** Năm luồng chính, mỗi luồng có nhân vật đặt tên (Trâm — sinh viên năm hai wifi chập chờn; Khánh — kỹ sư dạy thêm buổi tối), sống ở `EXPERIENCE.md § Key Flows`. PRD sở hữu *cái gì phải đúng*; UX spine sở hữu *chuyện xảy ra theo thứ tự nào*.

### 2.1 Vai trò hệ thống

Khác với persona: persona phục vụ UX, vai trò phục vụ phân quyền và Architecture.

| Vai trò | Ghi chú |
|---|---|
| `guest` | Chưa đăng nhập; chỉ xem được trang công khai |
| `user` | Đã đăng nhập. Có cờ **đủ/chưa đủ 18** (US-0.5) chi phối mọi hành vi có tiền |
| `host` | Chủ một phòng cụ thể; quyền theo phòng, không phải quyền toàn cục |
| `org_admin` | Quản trị gói Campus |
| `moderator` | Xử lý báo cáo, block/ban. **Có endpoint thu hồi từ S3** (US-3.4 AC4); chỉ giao diện hoãn — xem §7 |
| `system_admin` | Toàn quyền vận hành. **MVP chưa có giao diện** — xem §7 |

---

## 3. Yêu cầu phi chức năng (NFR)

| Nhóm | Yêu cầu |
|---|---|
| Hiệu năng mạng yếu | Audio ưu tiên (Opus DTX/RED); video simulcast, tự tụt bậc → avatar/icon khi băng thông thấp; không rớt tiếng |
| Kiến trúc | Cloud-native, chạy local Compose; tách **API service** và **Realtime Gateway** để "đầu chờ" cho app phone |
| Bảo mật (H4) | Prompt-injection scan input AI; credential chỉ trong env var/secret; PII không vào log; sandbox+timeout tác vụ |
| Governance (H5) | Audit log **bất biến** cho coin & report; approval trước deploy; risk registry (hành vi cấm) |
| Tool (H2) | Idempotency key cho giao dịch coin & thao tác ghi; audit mỗi call; rate limit + retry |
| Chống tấn công | Rate limit theo IP/user; WAF; chống DDoS ở gateway; khoá brute-force login |
| Thiết kế | Material Design (M3) làm xương; nhận diện riêng theo hệ "Cắm trại" — xem `DESIGN.md`. Dễ dùng cho người non-tech, i18n VI/EN, light + dark ngang hàng, WCAG 2.1 AA |
| Lưu trữ | **MVP không ghi hình và không lưu tệp nhị phân nào của người dùng.** Không có object store trong stack (US-0.2 AC4), không có pipeline recorder, không có retention video. Avatar sinh ở client từ chữ cái; ảnh hồ sơ dùng URL từ OAuth provider |
| Riêng tư | Không có luồng dữ liệu nào ghi lại nội dung buổi học. **Không có endpoint nào nhận tệp** — ảnh giấy tờ KYC đi thẳng tới nhà cung cấp bên thứ ba (US-3.4 AC1). Khuôn mặt ở chế độ ẩn/filter **không rời máy người dùng** (xử lý client-side). Trạng thái bận của phiên hỏi riêng không được tiết lộ danh tính đối phương hay số dư coin (US-2.4 AC6) |
| Bảo vệ người dưới tuổi | Tài khoản dưới 18 bị chặn mọi hành vi liên quan tiền: không nhận hỏi riêng, không đặt giá, không nhận coin (US-0.5) |

---

## 4. EPIC theo Sprint

Ký hiệu: **US** = user story, **AC** = acceptance criteria.

---

### EPIC S0 — Nền móng & Hạ tầng

**US-0.1 — Đăng nhập mạng xã hội**
Là người dùng, tôi muốn đăng nhập bằng Google/Facebook/Apple/Microsoft để vào nhanh không cần tạo mật khẩu.
- AC1: Hỗ trợ 4 provider; **Microsoft** cho phép account tổ chức `@fpt.com` (Azure AD/Entra).
- AC2: Lần đầu login tự tạo hồ sơ; các lần sau map đúng user theo provider-id.
- AC3: Token lưu an toàn (httpOnly/secure), refresh flow chuẩn; brute-force/abuse bị rate-limit.
- AC4: Login thất bại có thông báo thân thiện (UX-copy), không lộ chi tiết kỹ thuật.

**US-0.2 — Khung service tách API + Realtime (đầu chờ phone)**
- AC1: `API service` (REST/gRPC) và `Realtime Gateway` (WebSocket/WebRTC signaling) chạy tách process/container.
- AC2: Web là client thuần; hợp đồng API versioned (`/v1`) để phone dùng lại về sau.
- AC3: Có health-check, config qua env var, chạy `docker compose up` là lên đủ stack: **Postgres, Redis, SFU**.
- AC4: **Object store (MinIO) đã được gỡ khỏi stack MVP** cùng với việc gỡ ghi hình (§5). Avatar sinh từ chữ cái ở client, ảnh hồ sơ lấy URL từ OAuth provider — MVP không lưu tệp nhị phân nào của người dùng. `[ASSUMPTION: A-1]`

**US-0.3 — Design system Material**
- AC1: Theme token (màu/typography/spacing) theo Material; component base (button, card, dialog, snackbar).
- AC2: Responsive; đạt WCAG AA về tương phản & touch target.

**US-0.4 — Nền tảng bảo mật CASAN (baseline)**
- AC1: Secret ra khỏi code (env/secret store); pipeline có bước quét credential.
- AC2: Middleware prompt-injection scan cho mọi input đi vào AI.
- AC3: Audit log ghi mọi hành động nhạy cảm (login, coin, report) — append-only.

**US-0.5 — Khai tuổi và chặn hành vi theo tuổi**
Là nền tảng, tôi cần biết người dùng có đủ 18 tuổi hay không, để chặn trẻ vị thành niên khỏi các hành vi có tiền và có rủi ro lạm dụng.
- AC1: Khai **ngày sinh** ở bước tạo hồ sơ lần đầu (sau OAuth). Không bỏ qua được; không cho phép sửa tuỳ ý về sau (đổi phải qua luồng hỗ trợ).
- AC2: Tài khoản **dưới 18** bị chặn cứng ở tầng API, không chỉ ẩn nút: không bật được "nhận hỏi riêng", không đặt được giá, không nhận được coin **từ người dùng khác**. Coin do **hệ thống** cấp (số dư ban đầu ở US-2.2 AC1, thưởng uy tín ở US-3.2 AC2) **không bị ảnh hưởng** — người dưới 18 vẫn có đủ coin để học và để hỏi.
- AC3: Tài khoản dưới 18 **vẫn dùng bình thường** phần còn lại: vào phòng, học, hỏi cả phòng, ẩn mặt, tích uy tín, huy hiệu học vấn.
- AC4: Tài khoản dưới 18 **vẫn được trả coin để hỏi riêng người khác** — luồng tiền đi ra được phép, luồng tiền đi vào bị chặn. `[ASSUMPTION: A-4]` *(Cần rà lại nếu sau này mở convert coin ↔ tiền thật.)*
- AC5: Ngày sinh là PII: không vào log, không hiển thị công khai trên hồ sơ. Hồ sơ chỉ thể hiện đủ/chưa đủ 18 khi cần thiết cho luật ở AC2.
- AC6: Người dùng bị phát hiện khai gian tuổi rơi vào luồng report/moderation của US-3.4.

> **Ghi chú:** đây là US lấp lỗ hổng mà Brief §7 đã nêu ("che mặt + hỏi riêng + trẻ vị thành niên") nhưng PRD bản đầu bỏ sót. Đặt ở S0 vì nó là thuộc tính tài khoản, phải có **trước** khi tính năng coin của S2 lên.

---

### EPIC S1 — Phòng học live

**US-1.1 — Tạo phòng/lớp**
- AC1: Host đặt tên, mô tả, chủ đề, quyền (công khai/riêng), giới hạn người theo gói.
- AC2: Mô tả lớp được lưu để phục vụ AI match (S3).

**US-1.2 — Join phòng**
- AC1: Join lớp đã từng học, lớp mình tạo, hoặc tìm theo keyword.
- AC2: Vào phòng **p90 < 5s** trên kết nối 4G phổ thông, tính từ lúc bấm "Vào phòng" ở pre-join đến lúc nghe được tiếng đầu tiên; hiển thị danh sách người tham gia (avatar/icon).
- AC3: Chặn join nếu phòng đầy theo trần gói (Study Buddy 6 / Study Circle 25 / Campus 45–100).

**US-1.3 — Audio/Video WebRTC ưu tiên mạng yếu**
- AC1: Audio Opus, ưu tiên băng thông; bật DTX/RED chống mất gói.
- AC2: Video simulcast; khi băng thông thấp tự tụt độ phân giải rồi **thay bằng avatar/icon**, audio vẫn thông suốt.
- AC3: Chỉ báo trạng thái mạng (tốt/yếu) cho user.

**US-1.4 — Chat cả phòng**
- AC1: Nhắn cả phòng miễn phí, realtime; chống spam (rate limit).
- AC2: Lọc nội dung ở mức tối thiểu: chặn theo danh sách từ cấm (tiếng Việt + tiếng Anh) cho nội dung tình dục hoá và quấy rối, và chặn link ngoài từ tài khoản dưới 7 ngày tuổi. Tin bị chặn hiện lý do cho người gửi, **không** im lặng nuốt. Mọi tin đều report được.

---

### EPIC S2 — Khuôn mặt & Coin

**US-2.1 — Chế độ khuôn mặt**
- AC1: 3 chế độ: để nguyên / blur-ẩn / filter biến đổi (mèo, gấu, vui...).
- AC2: Xử lý **client-side** (MediaPipe/SDK), không gửi mặt gốc lên server khi bật ẩn.
- AC3: Chuyển chế độ realtime. Ngưỡng hiệu năng: giữ **≥ 20 FPS** trên máy tham chiếu 4 nhân / 8 GB RAM / không GPU rời. Dưới ngưỡng thì tự hạ chất lượng filter một bậc, vẫn dưới thì **tự chuyển sang Ẩn mặt** (không tự tắt về Để nguyên — xem `EXPERIENCE.md`) và báo cho người dùng biết vì sao. `[ASSUMPTION: A-2]`

**US-2.2 — Ví coin (bản thử)**
- AC1: Mỗi user được cấp sẵn **1.000.000 coin** khi tạo tài khoản (bản thử).
- AC2: Số dư hiển thị rõ; lịch sử giao dịch xem được.
- AC3: Mọi thay đổi số dư có **idempotency key** + ghi audit bất biến (H2/H5).
- AC4: **Chưa** có convert/rút ra tiền thật (TODO pháp lý — ngoài MVP).

**US-2.3 — Hỏi riêng tính coin theo block**
- AC1: Người được hỏi đặt giá trong khung giới hạn (vd 10–500 coin/phút).
- AC2: Khi bắt đầu phiên hỏi riêng, trừ coin theo block (mặc định 1 phút). Thoát giữa một block đang tính thì block đó **đã trả, không hoàn**.
- AC3: **Đồng hồ đếm ngược** hiển thị rõ thời gian còn lại theo số coin hiện có (vd còn 1000 coin, giá 100/phút → 10 phút).
- AC4: Hết coin → tự dừng phiên + gợi ý nạp; không âm số dư.
- AC5: Kênh hỏi riêng **tách biệt khỏi phòng** — người trong phòng không nghe được. Mặc định là 1-1; người thứ ba chỉ vào được qua luồng xin tham gia ở **US-2.4**, và **trần một phiên là 3 người** (1 người được hỏi + tối đa 2 người trả coin).
- AC6: **Mỗi người hỏi trả đủ đơn giá.** Hai người cùng hỏi ở giá 120 coin/phút thì mỗi người bị trừ 120/phút và người được hỏi nhận 240/phút. Mỗi người có **một đồng hồ và một chuỗi giao dịch độc lập**; audit log giữ một dòng cho mỗi người, không phát sinh quan hệ nhiều-nhiều.
- AC7: **Người được hỏi tắt mic thì đồng hồ dừng.** Điều kiện tính tiền của mỗi block gồm cả việc người được hỏi đang bật mic; đánh giá tại **ranh giới block**, không liên tục. Mute lúc block sắp bắt đầu → block đó không trừ, phiên tạm dừng tới ranh giới kế. Người *hỏi* tắt mic thì không ảnh hưởng — họ đang nghe. Giao diện phải nói rõ lý do đồng hồ dừng.
- AC8: Hết coin thì **chỉ người đó rời phiên**, những người còn lại học tiếp. Phiên sống chừng nào còn ít nhất một người trả coin; không có khái niệm "người khởi tạo" cho việc kết thúc phiên.

> **Ghi chú chống lạm dụng (AC5):** trần 3 người tồn tại để khung giá 10–500 coin/phút không bị vô hiệu hoá bằng cách nhân số người. Với trần này, mức thu tối đa của một phiên là 1.000 coin/phút thay vì không giới hạn.

**US-2.4 — Xin tham gia một phiên hỏi riêng đang diễn ra**
Là người trong phòng, tôi muốn xin vào một phiên hỏi riêng đang diễn ra để cùng hỏi, thay vì phải đợi đến lượt.
- AC1: Người trong phòng thấy trạng thái "đang trong phiên hỏi riêng" trên người đó, và có thể gửi lời **xin tham gia**.
- AC2: Lời xin chỉ được chấp nhận khi **cả hai người đang trong phiên đều đồng ý** — cả người được hỏi lẫn người đang trả coin. Một phiếu là không đủ.
- AC3: Lời xin **không được chặn màn hình** người đang trong phiên (họ đang trả tiền theo phút): hiển thị dạng dải inline, tự hết hạn sau 30 giây, và **không phản hồi = từ chối**.
- AC4: Người trả coin được cảnh báo rõ rằng đồng ý đồng nghĩa để người xin thấy mình đang ở trong phiên đó — vì họ có thể đang ẩn mặt.
- AC5: Lời từ chối **không nêu ai từ chối và không nêu lý do**.
- AC6: Giao diện thông báo trạng thái bận **không được tiết lộ** đang hỏi riêng với ai, cũng **không** tiết lộ thời gian còn lại của phiên (thời gian còn lại = số dư ÷ đơn giá, tức là lộ gián tiếp số dư coin).
- AC7: Khi phiên đã đủ trần 3 người, lời xin bị từ chối tự động với thông báo phòng đã đủ, không làm phiền người trong phiên.
- AC8: Người vào sau bắt đầu bị trừ coin **kể từ block đầu tiên sau khi vào**, không truy thu phần phiên đã diễn ra trước đó.

---

### EPIC S3 — AI Match & Uy tín

**US-3.1 — AI match theo nguyện vọng**
- AC1: User nhập "nguyện vọng"; hệ thống embedding và so khớp với mô tả các lớp.
- AC2: Trả lớp có **điểm similarity cao nhất**; có nút "join random theo AI".
- AC3: Input đi qua prompt-injection scan trước khi vào AI (H4).

**US-3.2 — Hạng uy tín (theo mùa)**
- AC1: Điểm nỗ lực tăng theo hành vi có trọng số công khai: **+1/phút** có mặt trong phòng có ít nhất 2 người (trần 120 điểm/ngày để chống cày) · **+20** khi hoàn tất một phiên hỏi riêng ở vai người được hỏi · **+5** khi trả lời được đánh dấu hữu ích trong chat · **−50** cho mỗi báo cáo được moderator xác nhận. Hiển thị theo bậc thang; trọng số phải xem được trong app, không giấu. `[ASSUMPTION: A-3]`
- AC2: Reset/tổng kết theo mùa; thưởng gem/coin hàng tháng theo nỗ lực.

**US-3.3 — Huy hiệu học vấn đã xác minh & badge kỹ năng**
- AC1: Huy hiệu học vấn (cử nhân/kỹ sư/thạc sĩ) chỉ hiển thị khi **đã xác minh**.
- AC2: Badge theo lĩnh vực/kỹ năng; hồ sơ hiển thị đồng thời 3 trục (uy tín/học vấn/kỹ năng).

**US-3.4 — Xác minh & Report kiểu Mercari**
- AC1: Xác minh danh tính nhẹ (KYC nhẹ) cho hành vi nhạy cảm, chạy **hoàn toàn qua nhà cung cấp bên thứ ba**. Ảnh giấy tờ đi thẳng từ trình duyệt tới nhà cung cấp, **không qua server của ta**; ta chỉ lưu mã tham chiếu, kết quả, mốc thời gian, và các trường suy ra được phép dùng. **Không có endpoint nào nhận tệp.**
- AC2: Report mạnh trên user/phòng/tin nhắn; moderator xử lý; block/ban.
- AC3: Hồ sơ hành vi + risk registry (H5); hành động moderation ghi audit bất biến.
- AC4: **Có endpoint thu hồi quyền có xác thực ngay trong S3** — ban, hạ gói, chặn theo tuổi phải cắt được phiên đang chạy và đuổi khỏi phòng. Sửa tay bằng `psql` không đạt AC này. Chỉ *giao diện* moderator mới hoãn sang sau (§7).

---

### EPIC S4 — Gói dịch vụ & Nạp coin

**US-4.1 — 3 gói dịch vụ**
- AC1: **Study Buddy** (6 người, miễn phí) / **Study Circle** (25 người, phí/năm) / **Campus** (45 người, trần 100).
- AC2: Trần người/phòng enforce theo gói; nâng/hạ gói cập nhật quyền.

**US-4.2 — Nạp coin qua credit**
- AC1: Nạp coin qua cổng thanh toán (Stripe/VNPay/Momo — chốt ở Architecture); giao dịch idempotent + audit.
- AC2: Biên nhận + lịch sử nạp; xử lý lỗi/timeout an toàn (không mất tiền/không cấp nhầm coin).

> ~~US-4.3 — Ghi hình & lưu 30 ngày~~ — **đã gỡ khỏi MVP** ngày 20/08/2026. Xem §5.

---

## 5. Ngoài phạm vi MVP

| Hạng mục | Ghi chú |
|---|---|
| **Ghi hình buổi học** | 🆕 **Gỡ khỏi MVP ngày 20/08/2026 — TODO phase sau.** MVP không ghi lại nội dung buổi học dưới bất kỳ hình thức nào. Kéo theo: không cần recorder pipeline, không cần retention policy, không cần luồng consent ghi hình, và **object store bị gỡ khỏi stack MVP** (US-0.2 AC4, `[A-1]`). Khi làm lại ở phase sau phải dựng lại từ đầu cả object store lẫn luồng đồng thuận — đừng để nó thành tính năng bật lén |
| Convert/rút coin ↔ tiền thật | **TODO pháp lý** — cần giấy phép trung gian thanh toán, KYC, thuế |
| Trang CV cho nhà tuyển dụng | Sprint sau; hiển thị phải opt-in |
| App phone native | Đã để sẵn "đầu chờ" ở US-0.2 |
| Giao diện moderator | Hoãn có chủ đích — MVP xử lý thủ công qua admin/DB (xem §7) |
| Phụ đề trực tiếp | Ngoài MVP (xem §7) |

---

## 6. Phụ thuộc & rủi ro
- Chọn SFU (LiveKit vs Mediasoup) và SDK face-filter → quyết ở Architecture.
- Cổng thanh toán phụ thuộc pháp nhân/tài khoản merchant.
- An toàn nội dung (che mặt + hỏi riêng): phụ thuộc chất lượng report/moderation.
- **Phiên hỏi riêng 3 người (US-2.4) làm tăng bề mặt rủi ro, không giảm.** Kênh riêng hai người khó lạm dụng hơn kênh ba người: người thứ ba có thể là nhân chứng, cũng có thể là đồng phạm. Trần 3 người và đồng thuận hai phiếu là hai lớp chặn hiện có; cần theo dõi trong vận hành xem có đủ không.
- **Việc gỡ ghi hình làm nhẹ stack nhưng mất một nguồn bằng chứng.** Khi có báo cáo lạm dụng xảy ra trong phòng hoặc trong phiên hỏi riêng, moderation chỉ còn dựa vào lời khai và log hành vi — không có nội dung để đối chiếu. Kết hợp với việc giao diện moderator cũng hoãn, đây là hai lớp phòng vệ cùng mỏng đi một lúc.
- **Schema audit coin phải chịu được nhiều người trả song song trong một phiên.** US-2.3 AC6 giữ một dòng cho mỗi người, nhưng khoá phiên phải liên kết được các dòng đó để đối soát. Chi tiết ở Architecture.

---

## 7. Câu hỏi còn mở (cần quyết trước khi vào sprint tương ứng)

| # | Câu hỏi | Chặn sprint | Trạng thái |
|---|---|---|---|
| 1 | ~~Chặn theo tuổi~~ | S0 | ✅ **Đã quyết 20/08** → US-0.5 |
| 2 | ~~Ghi hình phiên hỏi riêng~~ | — | ✅ **Moot** — ghi hình đã gỡ khỏi MVP (§5) |
| 3 | **Giao diện moderator.** Chỉ *giao diện* hoãn sang S5+; **bề mặt lệnh thu hồi thuộc S3** (US-3.4 AC4). Vận hành bằng dòng lệnh gọi endpoint, không sửa DB tay | S5+ | 🟡 Hoãn một nửa có chủ đích |
| 4 | **Phụ đề trực tiếp** cho người khiếm thính. Hiện chat là kênh song song duy nhất | S5+ | 🟡 Ngoài MVP |
| 5 | **Tên gọi "coin" trong giao diện** khi tính năng quy đổi còn treo pháp lý — dùng thẳng "coin" hay tên trung tính hơn | S2 | 🟡 Chưa quyết |
| 6 | ~~Bằng chứng KYC lưu ở đâu~~ | S3 | ✅ **Đã quyết 21/08** — bên thứ ba, chỉ lưu kết quả (US-3.4 AC1) |
| 7 | ~~Tắt mic có tính coin không~~ | S2 | ✅ **Đã quyết 21/08** — người được hỏi mute thì dừng đồng hồ (US-2.3 AC7) |

---

## 8. Glossary

Danh từ miền dùng **nguyên văn** ở mọi nơi: PRD, `EXPERIENCE.md`, `DESIGN.md`, story, và giao diện. Biến thể trong bảng này là lỗi, không phải phong cách.

| Thuật ngữ | Nghĩa | Không dùng |
|---|---|---|
| **Phòng học** | Không gian live nhiều người, có host, có chat cả phòng | "lớp", "room", "phòng" đứng một mình |
| **Phiên hỏi riêng** | Kênh audio tách biệt khỏi phòng, tính coin theo block, tối đa 3 người | "phiên riêng", "chat riêng", "hỏi 1-1" |
| **Hỏi cả phòng** | Nói hoặc nhắn cho toàn phòng, miễn phí | "chat chung", "public chat" |
| **Đơn giá** | Số coin mỗi phút do người được hỏi đặt, trong khung 10–500 | "giá", "phí", "rate" |
| **Block** | Đơn vị tính coin, mặc định 1 phút. Đã bắt đầu là đã trả | "chu kỳ", "vòng" |
| **Số dư** | Coin còn lại của một người | "ví", "balance" (ví là bề mặt, số dư là con số) |
| **Ví coin** | Bề mặt hiển thị số dư + lịch sử giao dịch | — |
| **Chế độ khuôn mặt** | Ba lựa chọn: Để nguyên / Ẩn mặt / Filter | "chế độ ẩn danh", "camera mode" |
| **Ẩn mặt** | Chế độ thay khuôn mặt bằng avatar, xử lý client-side | "blur", "giấu mặt", "ẩn danh" |
| **Điểm nỗ lực** | Con số tích luỹ theo hành vi (US-3.2 AC1) | "điểm", "XP" |
| **Hạng uy tín** | Bậc thang suy ra từ điểm nỗ lực, reset theo mùa | "rank", "level", "uy tín" đứng một mình |
| **Huy hiệu học vấn** | Bằng cấp **đã xác minh**, hiển thị tĩnh | "bằng cấp", "chứng chỉ" |
| **Badge kỹ năng** | Nhãn theo lĩnh vực học | "tag", "skill" |
| **Study Buddy / Study Circle / Campus** | Ba gói dịch vụ. Luôn viết đủ tên | "Buddy", "Circle" đứng một mình |

---

## 9. Chỉ mục giả định

Mọi suy luận chưa được chủ dự án xác nhận trực tiếp. Cần rà trước khi Architecture khoá thiết kế.

| ID | Giả định | Ở đâu | Rủi ro nếu sai |
|---|---|---|---|
| **A-1** ✅ | ~~Giả định~~ → **đã xác nhận 21/08/2026.** MVP không cần object store: avatar sinh ở client, ảnh hồ sơ lấy URL từ OAuth, và **bằng chứng KYC không bao giờ chạm hạ tầng của ta** (US-3.4 AC1 sửa). Rủi ro còn lại: nếu sau này cần upload thật (ảnh bài tập, tệp đính kèm chat) thì phải thêm lại object store + quét mã độc + retention — không phải thay đổi nhỏ |
| **A-2** | Máy tham chiếu cho ngưỡng filter là 4 nhân / 8 GB / không GPU rời, ngưỡng 20 FPS | US-2.1 AC3 | Đặt sai thì hoặc filter giật trên máy phổ thông, hoặc tự tắt oan trên máy đủ khoẻ |
| **A-3** | Trọng số điểm nỗ lực (+1/phút, +20/phiên, +5/trả lời hữu ích, −50/báo cáo xác nhận) và trần 120 điểm/ngày | US-3.2 AC1 | Cân sai thì hạng uy tín đo sự chăm chỉ ngồi lì thay vì đo giá trị đóng góp — trực tiếp phản lại luận điểm §1.1.2 |
| **A-4** | Tài khoản dưới 18 **vẫn được tiêu coin** để hỏi riêng người khác; chỉ chặn chiều tiền đi vào | US-0.5 AC4 | Cần rà lại nếu mở convert coin ↔ tiền thật; có thể có nghĩa vụ pháp lý về giao dịch của trẻ vị thành niên |

---

## 10. Bước tiếp theo (BMAD)

- ✅ **Product Brief** → `docs/brief.md`
- ✅ **PRD** → tài liệu này
- ✅ **UX Design** → `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/` (`DESIGN.md` + `EXPERIENCE.md`, hệ thiết kế "Cắm trại", 4 mockup)
- ⬜ **Architecture Document**: sơ đồ service, chọn SFU/DB/queue, schema coin & audit (chịu được nhiều người trả song song), thiết kế "đầu chờ" phone, docker-compose local, kế hoạch đóng gap CASAN H4/H5/H6.
- ⬜ Epics & Stories → Sprint Planning → Build.
