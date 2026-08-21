---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - docs/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-StuWith-2026-08-20/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/EXPERIENCE.md
---

# StuWith - Epic Breakdown

## Overview

Tài liệu này chứa bản phân rã epic và story đầy đủ cho StuWith, chuyển yêu cầu từ PRD, UX design contract và Architecture spine thành các story làm được.

> **Sửa 2026-08-21** *từ cổng readiness của Sprint Planning*: thêm **Story 4.8** — giao thức đóng phòng hai bước, lấp AD-16 vốn không epic nào nhận · thêm nhóm AC cấm xoá cứng phòng vào **Story 2.1** · thêm nhóm AC **health signal** cho coin scheduler vào **Story 3.5**, lấp AR21 vốn chỉ nằm trong danh sách yêu cầu.

Ghi chú về cách đánh số: PRD viết theo dạng `US-x.y` / `AC-n`. Ở đây chúng được chuẩn hoá thành **FR** có số liên tục để lập bản đồ phủ; cột nguồn giữ mã PRD gốc để truy ngược.

## Requirements Inventory

### Functional Requirements

**Đăng nhập & tài khoản** *(US-0.1, US-0.5)*

- **FR1**: Đăng nhập qua 4 provider OAuth (Google, Facebook, Apple, Microsoft); Microsoft hỗ trợ tài khoản tổ chức qua Azure AD/Entra.
- **FR2**: Lần đầu đăng nhập tự tạo hồ sơ; các lần sau map đúng user theo provider-id.
- **FR3**: Đăng nhập thất bại, bị rate-limit, provider từ chối, hoặc phiên hết hạn đều có thông báo thân thiện; không lộ mã lỗi hay chi tiết kỹ thuật.
- **FR4**: Khai ngày sinh bắt buộc ở bước tạo hồ sơ lần đầu; không bỏ qua được, không sửa tuỳ ý về sau.
- **FR5**: Tài khoản dưới 18 bị chặn **ở tầng API**: không bật được "nhận hỏi riêng", không đặt được giá, không nhận coin từ người dùng khác.
- **FR6**: Tài khoản dưới 18 vẫn dùng bình thường phần còn lại: vào phòng, học, hỏi cả phòng, ẩn mặt, tích uy tín, **và vẫn tiêu coin để hỏi riêng người khác**.

**Phòng học** *(US-1.1, US-1.2)*

- **FR7**: Tạo phòng với tên, mô tả, chủ đề, quyền công khai/riêng, trần người theo gói; mô tả được lưu phục vụ AI match.
- **FR8**: Màn **pre-join bắt buộc** trước khi vào bất kỳ phòng nào: xem trước camera, chọn chế độ khuôn mặt, thử mic, thấy host + huy hiệu.
- **FR9**: Join phòng qua lớp đã từng học, lớp mình tạo, hoặc tìm theo keyword.
- **FR10**: Chặn join khi phòng đã đầy theo trần gói (Study Buddy 6 / Study Circle 25 / Campus 45–100).

**Media & mạng yếu** *(US-1.3)*

- **FR11**: Audio Opus ưu tiên băng thông, bật DTX/RED chống mất gói.
- **FR12**: Video simulcast tự tụt bậc rồi **thay bằng avatar** khi băng thông thấp; audio không bao giờ rớt.
- **FR13**: Chỉ báo trạng thái mạng cho người dùng với ba mức (tốt / yếu / mất kết nối).

**Chat cả phòng** *(US-1.4)*

- **FR14**: Nhắn cả phòng miễn phí, realtime, có rate limit chống spam.
- **FR15**: Lọc nội dung tối thiểu: danh sách từ cấm VI + EN cho nội dung tình dục hoá và quấy rối; chặn link ngoài từ tài khoản dưới 7 ngày tuổi. Tin bị chặn **hiện lý do cho người gửi**, không im lặng nuốt.
- **FR16**: Mọi tin nhắn đều report được.

**Chế độ khuôn mặt** *(US-2.1)*

- **FR17**: Ba chế độ (để nguyên / ẩn mặt / filter), đổi realtime không cần xác nhận, xử lý hoàn toàn client-side.
- **FR18**: Dưới ngưỡng 20 FPS thì tự hạ chất lượng filter một bậc; vẫn dưới thì **tự chuyển sang Ẩn mặt** (không bao giờ tự về Để nguyên) và báo lý do.

**Ví coin** *(US-2.2)*

- **FR19**: Mỗi tài khoản được cấp sẵn 1.000.000 coin khi tạo.
- **FR20**: Số dư hiển thị rõ; lịch sử giao dịch đọc lại được vĩnh viễn.
- **FR21**: Mọi thay đổi số dư mang idempotency key và ghi audit bất biến.

**Hỏi riêng** *(US-2.3)*

- **FR22**: Người được hỏi bật/tắt "nhận hỏi riêng" và đặt đơn giá trong khung 10–500 coin/phút.
- **FR23**: Thẻ xác nhận bắt buộc trước khi trừ đồng coin đầu tiên: đơn giá, độ dài block, ước tính số phút theo số dư, và luật khi mất mạng.
- **FR24**: Trừ coin theo block (mặc định 1 phút), trừ ở **đầu block**; thoát giữa block thì block đó đã trả, không hoàn.
- **FR25**: Đồng hồ đếm ngược hiển thị thời gian còn lại theo số dư và đơn giá.
- **FR26**: Hết coin thì **chỉ người đó** rời phiên; số dư không bao giờ âm; phiên sống chừng nào còn ít nhất một người trả coin.
- **FR27**: Kênh hỏi riêng tách biệt khỏi phòng; trần một phiên là 3 người (1 người được hỏi + tối đa 2 người trả).
- **FR28**: Mỗi người hỏi trả đủ đơn giá; mỗi người một đồng hồ và một chuỗi giao dịch độc lập.
- **FR29**: Người **được hỏi** tắt mic thì đồng hồ dừng; đánh giá tại ranh giới block, không liên tục; người hỏi tắt mic không ảnh hưởng.
- **FR30**: Mất mạng mà audio còn thông thì vẫn tính coin; mất hẳn audio thì phiên tạm dừng và chỉ tính đến block cuối đã dùng.

**Xin tham gia phiên** *(US-2.4)*

- **FR31**: Người trong phòng thấy trạng thái "đang trong phiên hỏi riêng" và gửi được lời xin tham gia.
- **FR32**: Lời xin cần **cả hai người trong phiên đồng ý**; hiển thị dạng dải inline không chặn màn hình, tự hết hạn 30 giây, không phản hồi = từ chối.
- **FR33**: Người trả coin được cảnh báo rõ rằng đồng ý đồng nghĩa để người xin thấy mình đang ở trong phiên.
- **FR34**: Lời từ chối không nêu ai từ chối và không nêu lý do; phiên đủ trần thì từ chối tự động, không làm phiền người trong phiên.
- **FR35**: Người vào sau bị trừ từ block đầu tiên **sau khi vào**, không truy thu phần đã diễn ra.

**AI match** *(US-3.1)*

- **FR36**: Người dùng nhập "nguyện vọng"; hệ thống sinh embedding, so khớp cosine similarity với mô tả lớp, trả lớp điểm cao nhất.
- **FR37**: Nút "vào ngẫu nhiên theo AI" cho người chưa biết học gì.

**Uy tín & huy hiệu** *(US-3.2, US-3.3)*

- **FR38**: Điểm nỗ lực tăng theo trọng số công khai (+1/phút có mặt, trần 120/ngày · +20/phiên ở vai người được hỏi · +5/trả lời hữu ích · −50/báo cáo được xác nhận); trọng số xem được trong app.
- **FR39**: Hạng hiển thị theo bậc thang; reset/tổng kết theo mùa; thưởng hàng tháng theo nỗ lực.
- **FR40**: Huy hiệu học vấn chỉ hiển thị khi **đã xác minh**; không có trạng thái "chờ duyệt" công khai.
- **FR41**: Badge theo lĩnh vực/kỹ năng; hồ sơ hiển thị đồng thời ba trục.

**Xác minh & kiểm duyệt** *(US-3.4)*

- **FR42**: KYC nhẹ chạy hoàn toàn qua nhà cung cấp bên thứ ba; ảnh giấy tờ đi thẳng từ trình duyệt tới nhà cung cấp; ta chỉ lưu mã tham chiếu, kết quả, mốc thời gian. **Không endpoint nào nhận tệp.**
- **FR43**: Report trên user / phòng / tin nhắn; moderator xử lý; block/ban; hồ sơ hành vi + risk registry.
- **FR44**: **Endpoint thu hồi quyền có xác thực**: ban, hạ gói, chặn theo tuổi phải cắt được phiên đang chạy và đuổi khỏi phòng.

**Gói dịch vụ & nạp coin** *(US-4.1, US-4.2)*

- **FR45**: Ba gói (Study Buddy / Study Circle / Campus) với trần người enforce theo gói; nâng/hạ gói cập nhật quyền.
- **FR46**: Nạp coin qua cổng thanh toán; giao dịch idempotent + audit.
- **FR47**: Biên nhận + lịch sử nạp; ba trạng thái khi quay lại từ cổng (thành công / đang xử lý / không hoàn tất), mỗi trạng thái nói rõ tiền đang ở đâu.

### NonFunctional Requirements

- **NFR1** *(Mạng yếu)*: Audio ưu tiên tuyệt đối. Video được phép tụt bậc và tắt hẳn; tiếng không bao giờ rớt.
- **NFR2** *(Hiệu năng)*: Vào phòng **p90 < 5s** trên kết nối 4G phổ thông, tính từ lúc bấm "Vào phòng" đến khi nghe được tiếng đầu tiên.
- **NFR3** *(Kiến trúc)*: Cloud-native, chạy được bằng `docker compose` local; tách API service và Realtime Gateway thành hai process để làm "đầu chờ" cho app phone.
- **NFR4** *(Bảo mật H4)*: Prompt-injection scan mọi input đi vào AI; credential chỉ trong env var/secret store; PII không vào log; sandbox + timeout cho tác vụ.
- **NFR5** *(Governance H5)*: Audit log **bất biến** cho coin và report; approval checkpoint trước deploy; risk registry.
- **NFR6** *(Tool H2)*: Idempotency key cho mọi giao dịch coin và thao tác ghi; audit mỗi call; rate limit + retry.
- **NFR7** *(Chống tấn công)*: Rate limit theo IP và theo user; WAF; chống DDoS ở gateway; khoá brute-force đăng nhập.
- **NFR8** *(Thiết kế)*: Material 3 làm xương, nhận diện riêng theo hệ "Cắm trại"; i18n VI/EN; light và dark **ngang hàng**; WCAG 2.1 AA là sàn.
- **NFR9** *(Lưu trữ)*: MVP **không ghi hình** và **không lưu tệp nhị phân nào** của người dùng; không có object store trong stack.
- **NFR10** *(Riêng tư)*: Khuôn mặt ở chế độ ẩn/filter không rời máy người dùng; trạng thái bận không tiết lộ danh tính đối phương hay thời gian còn lại (vì suy ra được số dư).
- **NFR11** *(Bảo vệ người dưới tuổi)*: Mọi hành vi có tiền đi vào đều bị chặn với tài khoản dưới 18.
- **NFR12** *(Chính xác tiền)*: Giao dịch coin chính xác 100% **cho từng người tham gia** — không trừ trùng, không trừ nhầm người trong phiên nhiều người.
- **NFR13** *(Rò rỉ)*: 0 sự cố rò rỉ credential/PII trong log. Ngày sinh tính là PII.

### Additional Requirements

**🚨 Scaffold từ Architecture — ảnh hưởng trực tiếp Epic 1 Story 1.** Spine không chỉ định một starter template có sẵn (không Create-Next-App-plus-X), nhưng nó **cố định cấu trúc monorepo và chiều phụ thuộc**, nên story đầu tiên là dựng đúng bộ khung này chứ không phải chọn khung:

```
apps/web · apps/api · apps/realtime-gateway
packages/domain · packages/contracts · packages/db · packages/config
infra/docker-compose.yml · infra/livekit.yaml
```

- **AR1** *(AD-1)*: `packages/domain` không được import từ `apps/*`, `packages/db`, hay bất kỳ SDK hạ tầng nào. Vi phạm phải là **lỗi build**, không phải góp ý review.
- **AR2** *(Stack)*: Next.js 16.3.0 · NestJS 11.2.1 trên Fastify v5 · PostgreSQL 18 · pgvector 0.8.6 · **Valkey 9.0.4** (BSD-3, thay Redis) · LiveKit 1.13.5 · coturn · Caddy 2.11.4.
- **AR3** *(TypeScript)*: TS 7.0.2 cho typecheck + web, nhưng **`@typescript/typescript6@6.0.2` cho `nest build`** — NestJS chưa build được dưới TS 7.
- **AR4** *(AD-2)*: LiveKit là mặt phẳng media; client dùng LiveKit SDK trực tiếp. Mọi thứ có tiền, quyền, hoặc phải ghi audit đi qua `api`/`realtime-gateway`. **Cấm** dùng LiveKit data channel cho sự kiện tiền.
- **AR5** *(AD-3)*: Đồng hồ coin server-authoritative; điều kiện tính tiền **kéo** từ `GetParticipant` ở ranh giới block, không tin webhook (best-effort) và không bao giờ tin client.
- **AR6** *(AD-4, AD-7)*: `block_index = floor((now − participant.joined_at) / block_size)`; `UNIQUE(session_id, participant_id, block_index)`; trừ ở đầu block.
- **AR7** *(AD-5)*: Sổ cái append-only là nguồn sự thật; số dư ở bảng **`user_balances` riêng**, ghi trong cùng transaction, không bao giờ ghi trực tiếp.
- **AR8** *(AD-6)*: Trừ coin bằng câu điều kiện `WHERE balance >= :amt`; port `debit()` khai `InsufficientFunds` là nhánh trả về bắt buộc xử lý; **bộ test hợp đồng chung cho mọi adapter**.
- **AR9** *(AD-8)*: Một chủ ghi cho mỗi bảng, cưỡng chế bằng **Postgres `GRANT`** chứ không bằng lời văn. `api` không có INSERT/UPDATE trên `coin_ledger`, `user_balances`.
- **AR10** *(AD-9, AD-22)*: Token vào phòng là JWT ngắn hạn riêng cho một lần vào một phòng; bên cấp token phải **giữ chỗ nguyên tử** cùng lúc kiểm trần.
- **AR11** *(AD-19)*: Sổ cái mang `source` và ràng buộc `UNIQUE(source, idempotency_key)`.
- **AR12** *(AD-20)*: Bốn cổng CI bắt buộc — quét credential · kiểm chiều phụ thuộc · test hợp đồng adapter · migration chạy được trên bản sao có dữ liệu. Deploy cần duyệt thủ công.
- **AR13** *(AD-21)*: Mỗi phiên hỏi riêng là **một phòng LiveKit riêng**; `participant.joined_at` là lúc `realtime-gateway` ghi nhận vào phòng phiên.
- **AR14** *(AD-23)*: Máy trạng thái tường minh `pending → active → suspended → active | ended`; chỉ `active` mới sinh block.
- **AR15** *(AD-24)*: Lệnh xuyên process đi qua **outbox bền** ghi trong cùng transaction; không có HTTP đồng bộ giữa hai process cho việc có hệ quả tiền hoặc quyền.
- **AR16** *(AD-25)*: WebSocket xác thực ngay khi bắt tay và **xác thực lại** khi phiên bị thu hồi; rate limit theo IP và theo user.
- **AR17** *(AD-26)*: Một adapter AI duy nhất; không đường nào gọi model từ `apps/*`; quét prompt-injection + audit + timeout ở đúng adapter đó.
- **AR18** *(AD-27)*: Payload không được để suy ra thứ giao diện đang giấu — kể cả danh sách participant của phòng phiên.
- **AR19** *(AD-29)*: Không endpoint nào nhận tệp; KYC đi thẳng tới bên thứ ba.
- **AR20** *(Triển khai)*: `docker compose` local → một VPS; TLS ở edge bằng Caddy; **coturn bắt buộc**, không phải tuỳ chọn.
- **AR21** *(Quan trắc)*: Coin scheduler **phải phát health signal ngay từ đầu** — không hoãn được.

### UX Design Requirements

**Token & nền tảng thị giác** *(DESIGN.md)*

- **UX-DR1**: Cài đặt bộ token màu đầy đủ **cả light và dark** (tất cả cặp đã kiểm WCAG, thấp nhất 4.73:1), theo quy ước ánh xạ `X` → `X-dark`.
- **UX-DR2**: Thang typography với role `numeric` và `countdown` bắt buộc `font-variant-numeric: tabular-nums`; font Be Vietnam Pro với fallback.
- **UX-DR3**: Token `motion` (duration fast/base/slow, easing, `network-chip-debounce: 3000ms`); tắt chuyển động trang trí dưới `prefers-reduced-motion` nhưng **đồng hồ vẫn cập nhật**.
- **UX-DR4**: Ngôn ngữ độ sâu bằng **bóng lệch cứng** 4 mức (không blur, không alpha), giảm một mức ở dark mode; không trộn với bóng mờ.

**Component có đặc tả kép (thị giác + hành vi) — 16 khoá**

- **UX-DR5**: `tile-participant` — 4 lớp thông tin xếp cố định, tối đa 2 huy hiệu, viền `speaking-ring` **kèm chip chữ**, ba biến thể chip trạng thái hỏi riêng loại trừ nhau.
- **UX-DR6**: `control-bar` — không bao giờ tự ẩn theo thời gian; đứng **trước** lưới trong thứ tự tab.
- **UX-DR7**: `face-mode-panel` — `role="radiogroup"`, đổi tức thì không xác nhận, có ô xem trước chính mình.
- **UX-DR8**: `chip-status` — ba biến thể ok/warn/coin, luôn có **cả** dấu chấm màu **và** chữ.
- **UX-DR9**: `button-primary` / `button-secondary` — cao tối thiểu 48px kể cả trên desktop.
- **UX-DR10**: `badge-credential` — ký hiệu `aria-hidden`, nghĩa nằm ở nhãn văn bản; chỉ render khi đã xác minh.
- **UX-DR11**: `card-ask-confirm` — bắt buộc chứa đơn giá, block, số dư, ước tính, và luật mất mạng in nguyên văn.
- **UX-DR12**: `card-coin` — bề mặt tiền dùng chung; không emoji, không câu chữ nhí nhảnh.
- **UX-DR13**: `transaction-row` — trừ và cộng phân biệt bằng **dấu và nhãn**, không chỉ bằng màu.
- **UX-DR14**: `countdown-display` — màu ink trên nền coin (14.88:1), `aria-live="off"` **bắt buộc**, thông báo chỉ ở các mốc.
- **UX-DR15**: `progress-coin` — không bao giờ đứng một mình, luôn cặp với đồng hồ.
- **UX-DR16**: `chat-panel` — live region `polite` có gom nhóm + công tắc tắt, mặc định bật khi audio người dùng đang tắt.
- **UX-DR17**: `dialog-busy` — không nêu tên đối phương, không nêu thời gian còn lại, luôn có lối đi tiếp.
- **UX-DR18**: `strip-join-request` — dải một dòng, không chặn màn hình, hết hạn 30s, hai nút cùng trọng lượng.
- **UX-DR19**: `snackbar` — **cấm** dùng cho mọi thông báo liên quan coin hoặc thanh toán.

**Bề mặt & trạng thái**

- **UX-DR20**: Dựng **thang suy giảm mạng 4 bậc** với quy định rõ bậc nào báo, bậc nào im lặng, và luật **không tự bật lại camera** cho người đang ẩn mặt.
- **UX-DR21**: Dựng màn **pre-join** gồm trạng thái trình duyệt chặn camera/mic kèm lối thoát "vào phòng chỉ để nghe".
- **UX-DR22**: Dựng đủ **bảng State Patterns**: 4 trạng thái đăng nhập, phòng trống, phòng đầy, mạng yếu, mất kết nối, còn ≤2 phút coin, hết coin, nạp lỗi, chưa xác minh, bị báo cáo, focus, đang tải.
- **UX-DR23**: Cài **29 khoá microcopy** VI + EN: `busy.*` (15), `join.*` (11), `meter.*` (3).
- **UX-DR24**: Voice & Tone chia **hai vùng** — ấm (học/xã hội) và chính xác (tiền/báo cáo/xác minh); mọi câu về tiền phải chứa con số và mốc thời gian.

**Tiếp cận (a11y floor)**

- **UX-DR25**: Lưới người tham gia là **composite widget** WAI-ARIA: một điểm dừng tab, di chuyển bằng phím mũi tên.
- **UX-DR26**: Thứ tự đọc của `tile-participant` chốt cứng: tên → vai trò → đang nói → mic → chế độ mặt → huy hiệu.
- **UX-DR27**: `aria-live` phát ở đổi bậc mạng, vào/ra phòng, và **chỉ các mốc** của đồng hồ — không bao giờ đặt live region lên đồng hồ đang chạy.
- **UX-DR28**: `lang="en"` cho đoạn tiếng Anh nhúng trong câu tiếng Việt.
- **UX-DR29**: Bố cục reflow được ở tương đương 320px CSS width, không cuộn ngang (WCAG 1.4.10).
- **UX-DR30**: Vùng chạm ≥ 44px, nút ≥ 48px; đi được toàn bộ bằng bàn phím; vòng focus luôn nhìn thấy.

**Responsive**

- **UX-DR31**: Bốn breakpoint với hành vi rail khác nhau; dưới 900px rail thành sheet **nhưng thẻ phiên hỏi riêng ghim lại ở đáy** — đồng hồ đang tiêu tiền không bao giờ được khuất.
- **UX-DR32**: Lớp Campus trên mobile chỉ hiện người đang nói + host; danh sách đầy đủ nằm sau một bề mặt riêng.

### FR Coverage Map

| FR | Epic | Tóm tắt |
|---|---|---|
| FR1–FR3 | Epic 1 | Đăng nhập 4 provider, tạo/map hồ sơ, thông báo lỗi thân thiện |
| FR4–FR6 | Epic 1 | Khai tuổi bắt buộc, chặn hành vi có tiền đi vào với tài khoản dưới 18 |
| FR7 | Epic 2 | Tạo phòng, lưu mô tả phục vụ AI match |
| FR8 | Epic 2 | Pre-join bắt buộc — chọn chế độ khuôn mặt trước khi ai thấy mình |
| FR9–FR10 | Epic 2 | Join phòng, chặn khi đầy theo trần gói |
| FR11–FR13 | Epic 2 | Audio ưu tiên, video tụt bậc → avatar, chỉ báo mạng |
| FR14–FR16 | Epic 2 | Chat cả phòng, lọc nội dung, report tin nhắn |
| FR17–FR18 | Epic 2 | Ba chế độ khuôn mặt, tự hạ bậc rồi tự chuyển Ẩn mặt *(chuyển từ S2)* |
| FR19–FR21 | Epic 3 | Ví coin, số dư, lịch sử, idempotency + audit |
| FR22–FR26 | Epic 3 | Đặt giá, thẻ xác nhận, trừ theo block, đồng hồ, hết coin |
| FR27–FR30 | Epic 3 | Kênh tách biệt, trần 3 người, mỗi người trả đủ, tắt mic dừng đồng hồ, luật mất mạng |
| FR31–FR35 | Epic 3 | Trạng thái bận, xin tham gia hai phiếu, cảnh báo lộ diện, từ chối mơ hồ, tính từ block sau khi vào |
| FR36–FR37 | Epic 4 | AI match theo nguyện vọng, vào ngẫu nhiên theo AI |
| FR38–FR39 | Epic 4 | Điểm nỗ lực có trọng số công khai, hạng theo mùa |
| FR40–FR41 | Epic 4 | Huy hiệu học vấn đã xác minh, badge kỹ năng, hồ sơ ba trục |
| FR42–FR44 | Epic 4 | KYC bên thứ ba, report/moderation, endpoint thu hồi quyền |
| FR45 | Epic 5 | Ba gói dịch vụ, trần người theo gói |
| FR46–FR47 | Epic 5 | Nạp coin idempotent, biên nhận, ba trạng thái quay lại từ cổng |

**Phủ: 47/47 FR.** Không FR nào không có epic.

Phụ thuộc giữa các epic:

```
Epic 1 ──► Epic 2 ──► Epic 3 ──┐
              └─────► Epic 4 ──┴──► Epic 5
                        ┆
                  (Epic 3 ┄┄► Epic 4, một phần)
```

Hai phụ thuộc cần nói rõ:

- **Epic 3 ┄┄► Epic 4 (một phần):** FR38 có quy tắc `+20 khi hoàn tất một phiên hỏi riêng ở vai người được hỏi`, cần Epic 3 tồn tại. Ba trọng số còn lại không cần. Epic 4 chạy được trước Epic 3 với quy tắc `+20` là AC có điều kiện (Story 4.5).
- **Epic 4 ──► Epic 5 (cứng):** kênh lệnh bền (Story 4.6) là nơi outbox ra đời, và Story 5.2 dùng nó để cấp coin sau khi nhận webhook thanh toán. Epic 5 **không chạy được** trước Epic 4. *Phát hiện ở bước kiểm định — bản đồ ban đầu bỏ sót phụ thuộc này.*
- **Story 4.8 ◄── Story 4.6 + Epic 3 (cứng):** giao thức đóng phòng cần outbox để phát lệnh xuyên process, và cần phiên hỏi riêng tồn tại để có cái mà chốt sổ. Đó là lý do một story về vòng đời **phòng** lại nằm ở Epic 4 chứ không ở Epic 2 — Epic 2 chỉ giữ nhịp phòng thủ "không xoá cứng" trong Story 2.1. *Phát hiện ở cổng readiness của Sprint Planning — AD-16 trước đó không story nào nhận.*

### FR → Story

| FR | Story | FR | Story |
|---|---|---|---|
| FR1, FR2 | 1.2 | FR25 | 3.5 |
| FR3 | 1.3 | FR26 | 3.6, 3.7 |
| FR4 | 1.4 | FR27 | 3.5, 3.7 |
| FR5 | 1.5, 3.3 | FR28 | 3.7 |
| FR6 | 1.5 | FR29, FR30 | 3.6 |
| FR7 | 2.1 | FR31–FR34 | 3.8 |
| FR8 | 2.3 | FR35 | 3.9 |
| FR9, FR11 | 2.4 | FR36 | 4.1, 4.2 |
| FR10 | 2.2 | FR37 | 4.2 |
| FR12, FR13 | 2.5 | FR38, FR39 | 4.5 |
| FR14–FR16 | 2.8 | FR40, FR41 | 4.4 |
| FR17 | 2.3, 2.7 | FR42 | 4.3 |
| FR18 | 2.7 | FR43, FR44 | 4.7 |
| FR19, FR21 | 3.1 | FR45 | 5.1 |
| FR20 | 3.2 | FR46 | 5.2 |
| FR22 | 3.3 | FR47 | 5.3 |
| FR23 | 3.4 | | |
| FR24 | 3.5, 3.6 | | |

**47/47 FR có ít nhất một story.**

## Epic List

### Epic 1: Vào được StuWith với danh tính của mình

Người dùng đăng nhập bằng tài khoản mạng xã hội sẵn có, có hồ sơ, và hệ thống biết họ được phép làm gì — nền tảng cho mọi thứ về sau. Epic này cũng dựng bộ khung monorepo và bốn cổng CI mà mọi epic sau đứng lên.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6
**NFRs:** NFR3, NFR4, NFR5, NFR7, NFR11, NFR13
**AD chi phối:** AD-1, AD-8, AD-12, AD-13, AD-14, AD-15, AD-20, AD-24
**UX-DR:** UX-DR1, UX-DR2, UX-DR3, UX-DR4, UX-DR9, UX-DR22 *(trạng thái đăng nhập)*, UX-DR24, UX-DR28, UX-DR30

### Epic 2: Học cùng người khác trong phòng live, ẩn mặt được

Người dùng tạo hoặc tìm một phòng, vào học cùng người lạ, **chọn được mình hiện lên thế nào trước khi ai thấy**, và buổi học không gãy khi mạng yếu. Đây là epic tự chứng minh luận điểm của sản phẩm: sau nó, đo được ngay tỉ lệ phiên ẩn mặt — chỉ số quan trọng nhất của MVP theo PRD §1.4.

**FRs covered:** FR7, FR8, FR9, FR10, FR11, FR12, FR13, FR14, FR15, FR16, FR17, FR18
**NFRs:** NFR1, NFR2, NFR8, NFR9, NFR10
**AD chi phối:** AD-2, AD-8, AD-9, AD-11, AD-16 *(chỉ nhịp cấm xoá cứng, ở Story 2.1)*, AD-22, AD-25
**UX-DR:** UX-DR5, UX-DR6, UX-DR7, UX-DR8, UX-DR16, UX-DR20, UX-DR21, UX-DR25, UX-DR26, UX-DR27, UX-DR31, UX-DR32

### Epic 3: Hỏi riêng và trả coin cho nó

Người học hỏi riêng được người mình cần, trả coin theo phút một cách minh bạch, và không bao giờ bị trừ tiền trong sự bất ngờ. Người dạy đặt được giá và thu được coin. Epic nặng nhất — 17 FR và 9 AD, gần một nửa đường tiền của cả spine.

**FRs covered:** FR19, FR20, FR21, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR31, FR32, FR33, FR34, FR35
**NFRs:** NFR6, NFR10, NFR12
**AD chi phối:** AD-3, AD-4, AD-5, AD-6, AD-7, AD-10, AD-17, AD-19, AD-21, AD-23, AD-27, AD-28
**UX-DR:** UX-DR11, UX-DR12, UX-DR13, UX-DR14, UX-DR15, UX-DR17, UX-DR18, UX-DR19, UX-DR23

### Epic 4: Tìm đúng lớp, xây uy tín, và được bảo vệ

Người dùng mô tả nguyện vọng và được đưa tới đúng lớp; tích được uy tín thật qua nỗ lực và huy hiệu đã xác minh; và khi có người lạm dụng thì báo cáo được và bị xử lý. Uy tín và xác minh nằm chung epic vì huy hiệu học vấn **chỉ hiển thị khi đã xác minh** — tách ra thì cả hai đều không chạy độc lập được.

**FRs covered:** FR36, FR37, FR38, FR39, FR40, FR41, FR42, FR43, FR44
**NFRs:** NFR4, NFR5, NFR13
**AD chi phối:** AD-8, AD-12, AD-16, AD-18, AD-24, AD-26, AD-29
**UX-DR:** UX-DR10, UX-DR22 *(chưa xác minh, bị báo cáo)*

### Epic 5: Gói dịch vụ và nạp thêm coin

Người dùng nâng gói để mở phòng đông hơn, và nạp thêm coin khi hết — kể cả đang giữa một phiên hỏi riêng, mà không bao giờ mất dấu tiền của mình.

**FRs covered:** FR45, FR46, FR47
**NFRs:** NFR6, NFR12
**AD chi phối:** AD-5, AD-8, AD-19, AD-24
**UX-DR:** UX-DR12, UX-DR13

---

## Epic 1: Vào được StuWith với danh tính của mình

Người dùng đăng nhập bằng tài khoản mạng xã hội sẵn có, có hồ sơ, và hệ thống biết họ được phép làm gì. Epic này cũng dựng bộ khung monorepo và bốn cổng CI mà mọi epic sau đứng lên.

### Story 1.1: Dựng khung monorepo, hai process và bốn cổng CI

As a người xây StuWith,
I want một bộ khung nơi vi phạm kiến trúc là lỗi build chứ không phải góp ý review,
So that mọi story sau không âm thầm trôi khỏi spine.

**Acceptance Criteria:**

**Given** repo trống
**When** khởi tạo monorepo
**Then** có đúng cấu trúc `apps/web`, `apps/api`, `apps/realtime-gateway`, `packages/domain`, `packages/contracts`, `packages/db`, `packages/config`, `infra/`
**And** `apps/api` và `apps/realtime-gateway` chạy tách process, mỗi cái có health-check riêng

**Given** một lệnh import từ `packages/domain` sang `apps/api`, `packages/db`, hoặc một SDK hạ tầng
**When** chạy build
**Then** build **thất bại** với thông báo chỉ đúng dòng vi phạm
**And** không có cách nào bỏ qua bằng cấu hình cục bộ

**Given** stack local
**When** chạy `docker compose up`
**Then** lên đủ Postgres 18, Valkey 9.0.4, LiveKit 1.13.5, coturn
**And** **không có** object store trong compose
**And** hai DB role riêng biệt được tạo cho `api` và `realtime-gateway`

**Given** thiếu một biến môi trường bắt buộc
**When** khởi động bất kỳ process nào
**Then** process **fail fast** với thông báo nêu đúng tên biến thiếu
**And** không có giá trị mặc định nào cho bí mật

**Given** một pull request vào nhánh chính
**When** CI chạy
**Then** bốn cổng đều phải xanh: quét credential · kiểm chiều phụ thuộc · test hợp đồng adapter · migration chạy được trên bản sao DB có dữ liệu
**And** deploy lên VPS đòi một bước duyệt thủ công

**Given** TypeScript trong monorepo
**When** chạy typecheck và `nest build`
**Then** typecheck + web dùng TS 7.0.2, còn `nest build` dùng `@typescript/typescript6@6.0.2`
**And** cả hai lệnh đều chạy được trong cùng một repo

### Story 1.2: Đăng nhập bằng bốn provider mạng xã hội

As a người muốn học,
I want đăng nhập bằng tài khoản Google/Facebook/Apple/Microsoft sẵn có,
So that tôi vào được ngay mà không phải nghĩ thêm một mật khẩu nữa.

**Acceptance Criteria:**

**Given** người dùng chưa có tài khoản
**When** đăng nhập lần đầu qua bất kỳ provider nào trong bốn
**Then** hệ thống tự tạo hồ sơ và lưu provider-id
**And** bảng `users` được tạo trong story này, không sớm hơn

**Given** người dùng đã từng đăng nhập
**When** đăng nhập lại bằng cùng provider
**Then** map đúng về tài khoản cũ theo provider-id, không tạo tài khoản trùng

**Given** một tài khoản tổ chức `@fpt.com`
**When** đăng nhập qua Microsoft
**Then** luồng Azure AD/Entra hoạt động và tài khoản tổ chức vào được

**Given** người dùng đã đăng nhập
**When** kiểm tra phiên
**Then** token lưu trong cookie `httpOnly` + `secure`, có refresh flow chuẩn
**And** email và provider-id **không xuất hiện** trong bất kỳ dòng log nào

### Story 1.3: Trạng thái lỗi đăng nhập và chống brute-force

As a người đăng nhập không thành công,
I want biết chuyện gì xảy ra và làm gì tiếp theo,
So that tôi không bị kẹt trước một màn hình không nói gì.

**Acceptance Criteria:**

**Given** đăng nhập thất bại vì bất kỳ lý do kỹ thuật nào
**When** người dùng quay lại giao diện
**Then** hiện "Không đăng nhập được. Thử lại hoặc chọn cách khác."
**And** **không** hiện mã lỗi, tên provider hỏng, hay stack trace

**Given** người dùng huỷ ở bước cấp quyền của provider
**When** quay lại app
**Then** hiện "Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới."
**And** trạng thái này **không** được coi là lỗi

**Given** quá nhiều lần thử đăng nhập từ cùng một IP hoặc cùng một tài khoản
**When** thử tiếp
**Then** bị rate-limit và hiện đếm ngược thật bằng giây
**And** thông báo không nêu lý do kỹ thuật

**Given** phiên đăng nhập hết hạn khi người dùng đang ở trong một phòng
**When** hệ thống phát hiện
**Then** hiện dialog "Phiên đăng nhập đã hết hạn — đăng nhập lại để tiếp tục"
**And** giữ nguyên phòng đang ở để quay lại, **không** đá ra ngoài đột ngột

### Story 1.4: Khai ngày sinh khi tạo hồ sơ lần đầu

As a nền tảng,
I want biết người dùng có đủ 18 tuổi hay không,
So that tôi chặn được trẻ vị thành niên khỏi các hành vi có tiền và có rủi ro lạm dụng.

**Acceptance Criteria:**

**Given** người dùng vừa đăng nhập lần đầu
**When** tạo hồ sơ
**Then** bắt buộc khai ngày sinh, **không bỏ qua được**
**And** không hoàn tất được hồ sơ nếu chưa khai

**Given** hồ sơ đã có ngày sinh
**When** người dùng thử sửa trong phần cài đặt
**Then** không có đường tự sửa; đổi phải qua luồng hỗ trợ

**Given** ngày sinh đã lưu
**When** ghi log bất kỳ ở mức nào, hoặc render hồ sơ công khai
**Then** ngày sinh **không xuất hiện**
**And** hồ sơ chỉ thể hiện đủ/chưa đủ 18 và chỉ khi luật nghiệp vụ cần

### Story 1.5: Cổng chặn hành vi có tiền theo tuổi

As a nền tảng,
I want một cổng chặn dùng chung cho mọi hành vi có tiền đi vào,
So that không endpoint tương lai nào quên áp luật tuổi.

**Acceptance Criteria:**

**Given** `packages/domain`
**When** hỏi chính sách về một tài khoản
**Then** có hàm thuần `canReceiveMoney(user)` trả về false với tài khoản dưới 18
**And** hàm này **không** import gì từ hạ tầng và test được không cần DB

**Given** một endpoint được đánh dấu là hành vi có tiền đi vào
**When** tài khoản dưới 18 gọi nó
**Then** bị chặn **ở tầng API**, trả lỗi theo envelope chuẩn
**And** chặn xảy ra kể cả khi client gọi thẳng API, không chỉ ẩn nút

**Given** tài khoản dưới 18
**When** dùng phần còn lại của sản phẩm
**Then** vào phòng, học, hỏi cả phòng, ẩn mặt, tích uy tín đều bình thường
**And** **vẫn tiêu được coin** để hỏi riêng người khác — chỉ chiều tiền đi vào bị chặn

**Given** guard đã đăng ký trong `apps/api`
**When** một endpoint mới được đánh dấu là hành vi có tiền đi vào
**Then** guard áp dụng **tự động** qua decorator/metadata, không phải chép lại điều kiện tuổi
**And** có test chứng minh một endpoint mẫu được bảo vệ mà không viết thêm dòng luật tuổi nào

### Story 1.6: Hệ thiết kế "Cắm trại" — token light và dark

As a người xây giao diện,
I want một bộ token đã kiểm tương phản cho cả hai chế độ,
So that không màn hình nào phải tự chọn màu và tự đoán độ tương phản.

**Acceptance Criteria:**

**Given** bộ token màu
**When** kiểm mọi cặp tiền cảnh/hậu cảnh chịu lực
**Then** tất cả đạt tối thiểu WCAG AA 4.5:1 ở **cả** light và dark
**And** `border-ink` đạt ≥ 3:1 ở cả hai chế độ (WCAG 1.4.11)

**Given** chế độ hiển thị của người xem
**When** người xem để hệ điều hành quyết định, hoặc chọn tay light, hoặc chọn tay dark
**Then** cả ba trạng thái đều render đúng một bộ màu nhất quán
**And** không màu nào chỉ được định nghĩa bên trong một media query

**Given** một con số biến thiên theo thời gian
**When** render nó
**Then** dùng `font-variant-numeric: tabular-nums`
**And** bề rộng chữ số không đổi khi giá trị đổi

**Given** người dùng bật `prefers-reduced-motion`
**When** trang render
**Then** mọi chuyển động trang trí tắt
**And** đồng hồ đếm ngược **vẫn cập nhật** vì đó là thông tin, không phải hiệu ứng

**Given** component base (`button-primary`, `button-secondary`, `chip-status`)
**When** dựng chúng
**Then** cao tối thiểu 48px, vùng chạm ≥ 44px, kể cả trên desktop
**And** vòng focus luôn nhìn thấy được, không bị tắt outline

### Story 1.7: Audit log append-only và lọc PII khỏi log

As a chủ dự án,
I want một bản ghi không sửa được cho mọi hành động nhạy cảm,
So that khi có tranh chấp hoặc sự cố thì có bằng chứng — nhất là khi MVP không ghi hình.

**Acceptance Criteria:**

**Given** bảng `audit_events`
**When** kiểm quyền DB của cả hai app role
**Then** không role nào có `UPDATE` hoặc `DELETE` trên bảng này
**And** trong code cũng không tồn tại đường gọi hai lệnh đó

**Given** một hành động nhạy cảm (đăng nhập, cấp token phòng)
**When** nó xảy ra
**Then** sinh đúng một dòng audit có `request_id` truy được xuyên hai process
**And** hình dạng dòng audit khai trong `packages/contracts` để hai process không ghi hai kiểu

**Given** logger của cả hai process
**When** một payload chứa email, ngày sinh, access token, hoặc nội dung chat đi qua
**Then** các trường đó **không** xuất hiện trong log ở bất kỳ mức nào
**And** bộ lọc hoạt động theo **danh sách trắng** — chỉ id và trường đã khai được ghi

**Given** một trường mới được thêm vào payload
**When** chưa khai nó vào danh sách trắng
**Then** nó mặc định **không** vào log

---

## Epic 2: Học cùng người khác trong phòng live, ẩn mặt được

Người dùng tạo hoặc tìm một phòng, vào học cùng người lạ, chọn được mình hiện lên thế nào **trước khi ai thấy**, và buổi học không gãy khi mạng yếu. Sau epic này đo được ngay tỉ lệ phiên ẩn mặt — chỉ số quan trọng nhất của MVP theo PRD §1.4.

### Story 2.1: Tạo phòng học với chủ đề và quyền

As a người muốn mở lớp,
I want tạo một phòng có tên, mô tả và chủ đề,
So that người khác tìm thấy và biết phòng này học gì.

**Acceptance Criteria:**

**Given** người dùng đã đăng nhập
**When** tạo phòng
**Then** đặt được tên, mô tả, chủ đề, và quyền công khai hoặc riêng
**And** bảng `rooms` được tạo trong story này, thuộc quyền ghi của `apps/api`

**Given** phòng vừa tạo
**When** lưu
**Then** mô tả được lưu ở dạng dùng lại được cho AI match sau này
**And** chưa cần sinh vector — Epic 4 làm việc đó

**Given** gói hiện tại của người tạo
**When** phòng được tạo
**Then** trần người của phòng lấy theo gói (Study Buddy 6 / Study Circle 25 / Campus 45–100)
**And** trần được lưu cùng phòng, không tính lại mỗi lần có người vào

**Given** DB role của `apps/realtime-gateway`
**When** kiểm quyền trên bảng `rooms`
**Then** role đó **không có** `INSERT`/`UPDATE`, chỉ đọc

**Given** vòng đời một phòng
**When** thiết kế schema `rooms`
**Then** phòng có trạng thái tường minh gồm `closing` — không phải khoảng trống giữa "đang mở" và "đã biến mất"
**And** **không tồn tại** endpoint hay đường code nào xoá cứng một phòng
**And** giao thức đóng phòng đầy đủ nằm ở Story 4.8; story này chỉ chặn cửa hậu ra đời trước

### Story 2.2: Cấp token vào phòng kèm giữ chỗ nguyên tử

As a nền tảng,
I want một điểm duy nhất quyết định ai được vào phòng nào,
So that ba luật chặn khác nhau không rải rác ba chỗ rồi lệch nhau.

**Acceptance Criteria:**

**Given** một yêu cầu vào phòng
**When** `apps/api` xử lý
**Then** kiểm đủ bốn điều kiện trong một thao tác: đã đăng nhập · không bị ban · đủ tuổi cho hành vi đang xin · phòng chưa đầy theo trần gói
**And** chỉ khi cả bốn đạt mới cấp token

**Given** phép kiểm trần đạt
**When** cấp token
**Then** một dòng `room_reservations` được ghi **trong cùng thao tác nguyên tử** với phép kiểm
**And** bảng `room_reservations` thuộc quyền ghi của `apps/api`, kể cả việc dọn hết hạn

**Given** 130 người bấm vào cùng lúc một phòng Campus trần 100
**When** hệ thống xử lý đồng thời
**Then** đúng 100 người nhận được token, 30 người còn lại bị từ chối
**And** không lúc nào số chỗ đã giữ vượt trần

**Given** một token đã cấp cho phòng A
**When** dùng nó để nối vào phòng B
**Then** LiveKit từ chối
**And** token có thời hạn ngắn, không tái sử dụng được giữa các phòng

**Given** một client thử nối thẳng vào LiveKit
**When** không có token do `apps/api` cấp
**Then** không nối được — không tồn tại credential tĩnh nào ở phía client

### Story 2.3: Màn pre-join — xem trước, chọn khuôn mặt, thử mic

As a người sắp vào một phòng toàn người lạ,
I want quyết định mình hiện lên thế nào trước khi bất kỳ ai thấy tôi,
So that tôi không bị lộ mặt ngoài ý muốn.

**Acceptance Criteria:**

**Given** người dùng bấm vào một phòng
**When** trước khi vào
**Then** luôn đi qua màn pre-join — **không bỏ qua được bằng bất kỳ đường nào**
**And** khung hình xem trước chỉ hiển thị cho chính họ, chưa gửi đi đâu

**Given** màn pre-join
**When** người dùng chọn chế độ hiện diện
**Then** ba lựa chọn là một nhóm chọn-một (`role="radiogroup"`, mỗi mục `aria-checked`), không phải ba nút rời
**And** chế độ Ẩn mặt hoạt động đầy đủ trong story này bằng avatar chữ cái

**Given** người dùng đang ở chế độ Ẩn mặt
**When** xem màn pre-join
**Then** có câu xác nhận rõ điều gì đang bị lộ: "Không ai trong phòng thấy khuôn mặt bạn, kể cả host"
**And** ở chế độ Để nguyên thì câu đó đổi thành cảnh báo tương ứng

**Given** trình duyệt chặn camera hoặc micro
**When** người dùng tới màn pre-join
**Then** hiện hướng dẫn mở lại quyền theo đúng trình duyệt đang dùng
**And** luôn có lối thoát "Vào phòng chỉ để nghe" — người dùng **không bao giờ bị kẹt** ở màn này

**Given** không tìm thấy thiết bị micro
**When** người dùng tới màn pre-join
**Then** hiện "Không thấy micro. Bạn vẫn vào phòng và dùng chat được." kèm nút vào phòng

**Given** buổi học không được ghi lại
**When** người dùng ở màn pre-join
**Then** giao diện nói thẳng điều đó

### Story 2.4: Vào phòng và nghe thấy nhau

As a người học,
I want vào phòng và nghe được mọi người,
So that buổi học bắt đầu được.

**Acceptance Criteria:**

**Given** người dùng có token hợp lệ
**When** bấm "Vào phòng" ở pre-join
**Then** nghe được tiếng đầu tiên trong **p90 dưới 5 giây** trên kết nối 4G phổ thông
**And** thấy danh sách người tham gia

**Given** người dùng muốn tìm phòng
**When** duyệt
**Then** vào được lớp đã từng học, lớp mình tạo, hoặc tìm theo keyword

**Given** đường audio
**When** truyền tiếng
**Then** dùng Opus có bật DTX và RED
**And** audio được ưu tiên băng thông hơn video trong mọi hoàn cảnh

**Given** một người vào hoặc rời phòng
**When** sự kiện xảy ra
**Then** `apps/realtime-gateway` ghi `room_participants` dựa trên tín hiệu từ LiveKit
**And** `apps/api` chỉ đọc bảng này khi cưỡng chế trần

**Given** một kết nối WebSocket tới `apps/realtime-gateway`
**When** bắt tay
**Then** xác thực ngay bằng chính session của `apps/api`
**And** rate limit áp theo cả IP lẫn user

### Story 2.5: Thang suy giảm mạng bốn bậc

As a người học ở nơi mạng chập chờn,
I want buổi học vẫn tiếp tục khi mạng yếu,
So that tôi không phải bỏ dở vì wifi phòng trọ.

**Acceptance Criteria:**

**Given** băng thông đủ
**When** ở bậc 1
**Then** video simulcast độ phân giải cao, chip trạng thái hiện "Mạng tốt"

**Given** băng thông bắt đầu tụt
**When** ở bậc 2
**Then** video tự tụt xuống lớp thấp hơn
**And** **không báo gì cho người dùng** — họ không cần biết

**Given** băng thông không đủ cho video
**When** ở bậc 3
**Then** video **tắt hẳn và thay bằng avatar**, audio vẫn thông suốt
**And** hiện banner một dòng giải thích, chip đổi thành "Mạng yếu"

**Given** mất cả audio
**When** ở bậc 4
**Then** hiện "Mất kết nối — đang thử lại", lưới đóng băng, thử lại trong 30 giây

**Given** mạng hồi phục sau khi đã xuống bậc 3
**When** lên lại bậc tốt
**Then** chip đổi về "Mạng tốt" **trong im lặng**
**And** camera **không tự bật lại** — chỉ hiện nút "Bật lại camera"

**Given** trạng thái mạng dao động liên tục
**When** chip cập nhật
**Then** có hoãn 3 giây để chip không nhấp nháy

**Given** bất kỳ bậc nào
**When** hiển thị trạng thái
**Then** luôn kèm **chữ**, không chỉ màu — cặp xanh-lá/đất-nung là cặp khó nhất với người mù màu đỏ-lục

### Story 2.6: Lưới người tham gia đi được bằng bàn phím

As a người dùng bàn phím hoặc trình đọc màn hình,
I want tới được thanh điều khiển mà không phải tab qua cả trăm ô,
So that tôi dùng được phòng học như mọi người.

**Acceptance Criteria:**

**Given** lưới người tham gia
**When** người dùng tab
**Then** cả lưới là **một điểm dừng tab duy nhất**; di chuyển giữa các ô bằng phím mũi tên (mẫu grid của WAI-ARIA)
**And** thanh điều khiển đứng **trước** lưới trong thứ tự tab

**Given** một phòng Campus 100 người
**When** người dùng bàn phím muốn tới nút Rời phòng
**Then** tới được trong vài lần tab, không phải một trăm

**Given** một ô người tham gia
**When** trình đọc màn hình đọc nó
**Then** đọc đúng thứ tự: tên → vai trò → đang nói → trạng thái mic → chế độ khuôn mặt → huy hiệu

**Given** người đang nói
**When** hiển thị
**Then** có **cả** viền `speaking-ring` **và** chip chữ "Đang nói", không chỉ đổi màu viền

**Given** ký hiệu huy hiệu (🎓 ▲ ●)
**When** trình đọc màn hình gặp
**Then** ký hiệu mang `aria-hidden="true"`, nghĩa nằm ở nhãn văn bản

**Given** thanh điều khiển
**When** người dùng không di chuột một lúc lâu
**Then** thanh **không tự ẩn** — người học không di chuột liên tục

**Given** màn hình hẹp dần
**When** dưới 900px
**Then** rail thành sheet kéo từ đáy; dưới 600px thanh điều khiển rút gọn còn bốn nút chính
**And** bố cục reflow được ở tương đương 320px mà không cuộn ngang

### Story 2.7: Ba chế độ khuôn mặt xử lý client-side

As a người ngại lộ mặt,
I want chọn hiện nguyên mặt, ẩn hẳn, hay đeo filter,
So that tôi học cùng người lạ mà vẫn thoải mái.

**Acceptance Criteria:**

**Given** ba chế độ
**When** người dùng đổi chế độ trong phòng
**Then** có hiệu lực **tức thì**, không cần xác nhận
**And** có ô xem trước chính mình trong bảng chọn

**Given** người dùng bật Ẩn mặt hoặc Filter
**When** khung hình được xử lý
**Then** xử lý **hoàn toàn ở client** trước khi vào WebRTC track
**And** server và LiveKit **không bao giờ** nhận được khung hình gốc
**And** không tồn tại endpoint nào nhận ảnh khuôn mặt

**Given** máy tham chiếu 4 nhân / 8 GB / không GPU rời
**When** đang bật filter
**Then** giữ tối thiểu 20 FPS

**Given** hiệu năng tụt dưới ngưỡng
**When** hệ thống phát hiện
**Then** tự hạ chất lượng filter một bậc
**And** vẫn dưới ngưỡng thì **tự chuyển sang Ẩn mặt** — không bao giờ tự về Để nguyên
**And** báo cho người dùng biết vì sao vừa đổi

**Given** người dùng đang Ẩn mặt
**When** bất kỳ sự kiện hệ thống nào xảy ra (mạng hồi phục, đổi phòng, tự hạ bậc)
**Then** hệ thống **không bao giờ** tự đưa họ về Để nguyên

### Story 2.8: Chat cả phòng với lọc nội dung và report

As a người học ngại bật mic,
I want nhắn cho cả phòng,
So that tôi vẫn hỏi được mà không phải nói.

**Acceptance Criteria:**

**Given** người dùng trong phòng
**When** gửi tin nhắn
**Then** cả phòng nhận realtime, miễn phí
**And** bảng tin nhắn thuộc quyền ghi của `apps/realtime-gateway`

**Given** người dùng gửi quá nhanh
**When** vượt ngưỡng rate limit
**Then** hiện đếm ngược ngắn, **không** hiện lỗi kỹ thuật

**Given** một tin chứa từ trong danh sách cấm (VI + EN, nội dung tình dục hoá và quấy rối)
**When** gửi
**Then** tin bị chặn và **hiện lý do cho người gửi**
**And** không im lặng nuốt tin

**Given** tài khoản dưới 7 ngày tuổi
**When** gửi tin có link ngoài
**Then** link bị chặn kèm lý do

**Given** bất kỳ tin nhắn nào
**When** người dùng mở menu ngữ cảnh
**Then** report được, một bước

**Given** trình đọc màn hình
**When** có tin mới
**Then** đọc qua live region `polite` **có gom nhóm**, không đọc từng tin một
**And** có công tắc tắt thông báo chat, mặc định **bật** khi audio của người dùng đang tắt

---

## Epic 3: Hỏi riêng và trả coin cho nó

Người học hỏi riêng được người mình cần, trả coin theo phút một cách minh bạch, và không bao giờ bị trừ tiền trong sự bất ngờ. Người dạy đặt được giá và thu được coin. Thứ tự story cố ý đi **đường tiền trước, giao diện sau**: filter mặt sai thì xấu, sổ cái sai thì mất tiền của người thật.

### Story 3.1: Sổ cái coin và số dư không ghi trực tiếp được

As a chủ dự án,
I want một sổ cái mà không đường code nào sửa được số dư trực tiếp,
So that số dư không bao giờ trôi khỏi lịch sử giao dịch.

**Acceptance Criteria:**

**Given** schema coin
**When** tạo bảng
**Then** có `coin_ledger` (append-only) và `user_balances` **riêng biệt** — số dư **không** là cột trong `users`
**And** DB role của `apps/api` **không có** `INSERT`/`UPDATE` trên cả hai bảng

**Given** một thay đổi số dư bất kỳ
**When** thực hiện
**Then** một dòng `coin_ledger` được chèn và `user_balances` cập nhật **trong cùng một transaction**
**And** không tồn tại hàm nào sửa số dư mà không chèn dòng sổ cái

**Given** một tài khoản vừa được tạo
**When** khởi tạo ví
**Then** cấp 1.000.000 coin qua một dòng sổ cái `source = system_grant`
**And** tài khoản dưới 18 **vẫn nhận đủ** — coin hệ thống cấp không bị luật tuổi chặn

**Given** hai lệnh trừ cùng khoá
**When** cả hai chạy
**Then** ràng buộc `UNIQUE(source, idempotency_key)` chặn lệnh thứ hai ở tầng DB
**And** `source` nhận một trong: `session_tick`, `topup`, `system_grant`, `reputation_reward`, `refund`

**Given** một tài khoản có 100 coin
**When** trừ 150 coin
**Then** câu lệnh dạng `UPDATE user_balances SET balance = balance − :amt WHERE user_id = :u AND balance >= :amt` không tác động dòng nào
**And** port `debit()` trả nhánh `InsufficientFunds` **bắt buộc xử lý**, không ném exception tuỳ chọn
**And** số dư không bao giờ âm

**Given** bất kỳ adapter nào cài port `debit()`
**When** chạy bộ test hợp đồng dùng chung
**Then** adapter phải qua hết, kể cả adapter in-memory dùng cho test

**Given** sổ cái và số dư của một người
**When** chạy job đối soát
**Then** `SUM(coin_ledger) == user_balances.balance` với mọi tài khoản

### Story 3.2: Ví coin — số dư và lịch sử giao dịch

As a người dùng,
I want thấy mình còn bao nhiêu coin và đã tiêu vào đâu,
So that tôi tin được con số trên màn hình.

**Acceptance Criteria:**

**Given** người dùng mở ví
**When** xem
**Then** thấy số dư hiện tại, hiển thị bằng chữ số tabular
**And** thấy lịch sử giao dịch đọc lại được, không giới hạn thời gian

**Given** một dòng giao dịch
**When** hiển thị
**Then** trừ và cộng phân biệt bằng **dấu và nhãn**, không chỉ bằng màu
**And** có mốc thời gian cho mọi dòng

**Given** một người dùng
**When** gọi API xem số dư của người khác
**Then** bị từ chối — số dư chỉ trả về cho **chính chủ**

### Story 3.3: Bật nhận hỏi riêng và đặt giá trong khung

As a người có thể giúp người khác,
I want bật nhận hỏi riêng và tự đặt giá,
So that tôi được trả công cho thời gian của mình.

**Acceptance Criteria:**

**Given** người dùng đủ 18 tuổi
**When** vào cài đặt hỏi riêng
**Then** bật/tắt được "nhận hỏi riêng" và đặt đơn giá
**And** khung 10–500 coin/phút hiện **ngay cạnh ô nhập** kèm lý do "để tránh đặt giá lừa đảo", không phải chỉ báo lỗi khi nhập sai

**Given** người dùng dưới 18
**When** thử bật nhận hỏi riêng hoặc đặt giá
**Then** bị chặn ở tầng API bởi guard đã có từ Story 1.5
**And** giao diện **không hiện nút ở trạng thái mờ** — nút đơn giản không tồn tại

**Given** một người chưa bật nhận hỏi riêng
**When** người khác xem ô của họ trong phòng
**Then** **không có** nút "Hỏi riêng" và không có chip đơn giá
**And** không có cơ chế nào để người lạ gõ cửa

### Story 3.4: Thẻ xác nhận trước khi trừ đồng coin đầu tiên

As a người sắp trả tiền,
I want biết chính xác mình sẽ bị trừ thế nào trước khi đồng hồ chạy,
So that tôi không bao giờ bị trừ coin trong sự bất ngờ.

**Acceptance Criteria:**

**Given** người dùng bấm "Hỏi riêng" trên ô của người đã bật nhận
**When** thẻ xác nhận mở
**Then** hiện đủ: đơn giá · độ dài block · số dư hiện tại · ước tính số phút theo số dư
**And** hiện huy hiệu đã xác minh của người được hỏi

**Given** thẻ xác nhận
**When** hiển thị
**Then** **in nguyên văn** luật mất mạng: "Nếu mạng yếu, video sẽ tắt nhưng phiên vẫn tính coin vì tiếng vẫn thông. Phiên chỉ dừng khi mất hẳn kết nối."
**And** đây là bề mặt tiền: không emoji, không câu chữ nhí nhảnh

**Given** người dùng chưa bấm xác nhận
**When** đang xem thẻ
**Then** đồng hồ **chưa chạy** và **chưa có đồng coin nào bị trừ**

**Given** người dùng bấm Huỷ
**When** thẻ đóng
**Then** không có dòng sổ cái nào được sinh

### Story 3.5: Phiên hỏi riêng với đồng hồ chạy ở server

As a người học,
I want hỏi riêng trong một kênh tách biệt và thấy rõ mình còn bao nhiêu thời gian,
So that tôi hỏi được điều mình cần mà không sợ mất kiểm soát tiền.

**Acceptance Criteria:**

**Given** schema phiên
**When** tạo bảng
**Then** `private_sessions` và `session_participants` được tạo trong story này, thuộc quyền ghi của `apps/realtime-gateway`
**And** DB role của `apps/api` chỉ có quyền đọc

**Given** người dùng xác nhận bắt đầu
**When** phiên khởi tạo
**Then** một **phòng LiveKit riêng** được tạo cho phiên; người tham gia giữ đồng thời hai kết nối
**And** người trong phòng học **không nghe được** phiên — cách ly do LiveKit bảo đảm, không do code lọc
**And** `apps/realtime-gateway` cấp token phòng phiên

**Given** phiên đang chạy
**When** một block bắt đầu
**Then** trừ coin **ở đầu block**, không phải cuối
**And** `block_index = floor((now − participant.joined_at) / block_size)` với `joined_at` là lúc `realtime-gateway` ghi nhận vào phòng phiên

**Given** ranh giới một block
**When** scheduler chuẩn bị trừ
**Then** **kéo** trạng thái thật qua `GetParticipant` của LiveKit server SDK
**And** **không** trừ dựa trên webhook chưa xác nhận lại, và **không bao giờ** dựa trên báo cáo của client

**Given** scheduler khởi động lại giữa chừng
**When** chạy lại một tick đã xử lý
**Then** DB từ chối vì trùng khoá; không trừ hai lần

**Given** phiên đang chạy
**When** hiển thị đồng hồ
**Then** đếm ngược theo số dư thật và đơn giá đã chụp
**And** luôn kèm một dòng giải thích con số đến từ đâu
**And** `countdown-display` mang `aria-live="off"`; thông báo chỉ phát ở các mốc bắt đầu, còn 2 phút, còn 1 phút, kết thúc

**Given** phiên có trạng thái
**When** theo dõi vòng đời
**Then** đi đúng máy trạng thái `pending → active → suspended → active | ended`
**And** chỉ trạng thái `active` mới sinh block

**Given** coin scheduler đang chạy
**When** quan trắc nó
**Then** scheduler phát **health signal** ngay từ story này — không hoãn sang tầng quan trắc đầy đủ sau
**And** tín hiệu nói được ba điều: tick cuối chạy lúc nào, đang phục vụ bao nhiêu phiên `active`, và bao nhiêu tick thất bại gần đây
**And** ngừng phát nhịp quá một chu kỳ block thì tín hiệu chuyển sang **không lành mạnh**
**And** một đồng hồ tiền chết âm thầm là chế độ hỏng tệ nhất của hệ thống — im lặng **không** được coi là bình thường

### Story 3.6: Ba cách một phiên dừng — hết coin, mất mạng, tắt mic

As a người trả tiền,
I want đồng hồ dừng đúng lúc nó phải dừng,
So that tôi không trả cho thời gian mình không nhận được gì.

**Acceptance Criteria:**

**Given** người dùng còn ít hơn một block coin
**When** block kế sắp bắt đầu
**Then** phiên dừng cho **riêng người đó**, số dư không âm
**And** hiện thẻ tổng kết: dừng lúc mấy giờ, đã trừ bao nhiêu, số dư còn lại
**And** thẻ tổng kết đọc lại được trong Ví coin, **không** chỉ hiện bằng snackbar

**Given** còn 2 phút và còn 1 phút coin
**When** tới ngưỡng
**Then** đồng hồ đổi màu cảnh báo **và** hiện dòng chữ giải thích
**And** live region phát đúng một lần ở mỗi mốc, không đọc lặp mỗi giây

**Given** mạng yếu tới mức video tắt nhưng audio còn thông
**When** block kế bắt đầu
**Then** **vẫn trừ coin bình thường**
**And** người dùng không bị bất ngờ vì luật này đã in trên thẻ xác nhận ở Story 3.4

**Given** mất hẳn kết nối
**When** người dùng rơi vào cửa sổ thử lại 30 giây
**Then** chuyển sang trạng thái `suspended`, đồng hồ của riêng họ dừng
**And** **không block nào được sinh** trong lúc suspended
**And** quay lại kịp thì tiếp tục; hết 30 giây thì `ended` kèm chốt sổ

**Given** người **được hỏi** tắt mic
**When** một block sắp bắt đầu
**Then** trạng thái mute lấy bằng cách **kéo** `GetParticipant`, không chờ webhook
**And** block đó **không được trừ**; người trả rơi vào `suspended` tới ranh giới kế

**Given** người **hỏi** tắt mic
**When** block kế bắt đầu
**Then** vẫn trừ bình thường — họ đang nghe

**Given** đồng hồ dừng vì mic
**When** hiển thị
**Then** người trả thấy "Đồng hồ đang tạm dừng — {name} đang tắt mic. Bạn không bị trừ coin lúc này."
**And** người được hỏi thấy "Bạn đang tắt mic. Người hỏi tạm thời không bị trừ coin."

**Given** thoát giữa một block đang tính
**When** phiên kết thúc
**Then** block đó **đã trả, không hoàn**

### Story 3.7: Phiên nhiều người — mỗi người một đồng hồ

As a gia sư,
I want dạy hai người cùng lúc mà mỗi người trả đủ,
So that tôi tăng thu mà không phải tăng giờ.

**Acceptance Criteria:**

**Given** một phiên có hai người hỏi ở đơn giá 120 coin/phút
**When** mỗi block trôi qua
**Then** mỗi người bị trừ 120, người được hỏi nhận 240/phút
**And** mỗi người có **một chuỗi giao dịch độc lập** — sổ cái giữ một dòng cho mỗi người, không phát sinh quan hệ nhiều-nhiều

**Given** một người vào phiên
**When** ghi `session_participants`
**Then** đơn giá được **chụp ảnh** vào dòng đó tại thời điểm vào
**And** mọi lần tính tiền đọc giá từ bản chụp, **không** từ hồ sơ hiện tại của host

**Given** host đổi giá trong lúc một phiên đang chạy
**When** block kế bắt đầu
**Then** phiên đang chạy vẫn dùng giá cũ đã chụp
**And** giá mới chỉ áp cho phiên mở sau đó

**Given** một phiên đã có 3 người
**When** người thứ tư xin vào
**Then** bị từ chối — trần cưỡng chế ở `apps/realtime-gateway`, không phải bằng cách ẩn nút

**Given** một người hết coin
**When** phiên tiếp tục
**Then** **chỉ người đó** rời; những người còn lại học tiếp
**And** phiên sống chừng nào còn ít nhất một người trả coin — không có khái niệm "người khởi tạo"

**Given** hai người cùng trong một phiên
**When** một người xem giao diện
**Then** **không** thấy số dư hay thời gian còn lại của người kia

### Story 3.8: Trạng thái bận và xin tham gia hai phiếu

As a người trong phòng,
I want xin vào một phiên đang diễn ra thay vì đợi vô định,
So that tôi hỏi được cùng lúc với người khác.

**Acceptance Criteria:**

**Given** schema lời xin
**When** tạo bảng
**Then** `join_requests` được tạo trong story này, thuộc quyền ghi của `apps/realtime-gateway`

**Given** một người đang trong phiên hỏi riêng
**When** người khác xem ô của họ
**Then** chip đơn giá đổi thành 🔒 "Đang hỏi riêng"; nút trong hồ sơ rút gọn đổi thành "Báo tôi khi rảnh"
**And** giao diện **không** nêu đang hỏi riêng với ai, và **không** nêu thời gian còn lại

**Given** payload API trả về trạng thái bận
**When** kiểm nội dung
**Then** chỉ mang cờ `busy` — **không** mang định danh đối phương, **không** mang thời gian còn lại
**And** người ngoài phiên **không** truy vấn được danh sách participant của phòng phiên

**Given** người dùng vẫn bấm Hỏi riêng vào người đang bận
**When** popup mở
**Then** hiện tiêu đề, phần thân giải thích, và **ba lối đi**: Báo tôi khi rảnh · Hỏi cả phòng · Để sau
**And** không bao giờ chỉ có nút Đóng

**Given** người dùng gửi lời xin tham gia
**When** lời xin tới hai người trong phiên
**Then** hiển thị dạng **dải inline một dòng**, không âm thanh, không chặn màn hình
**And** tự hết hạn sau 30 giây; **không phản hồi = từ chối**

**Given** lời xin tham gia
**When** chỉ một người đồng ý
**Then** người xin **chưa** vào được — cần **cả hai** phiếu
**And** người xin thấy "Đang chờ người còn lại đồng ý", **không** biết ai đã đồng ý

**Given** người đang **trả coin** nhận lời xin
**When** hiển thị
**Then** câu hỏi của họ khác: "Nếu bạn đồng ý, {asker} sẽ thấy bạn đang ở đây" — vì họ có thể đang ẩn mặt

**Given** lời xin bị từ chối
**When** báo cho người xin
**Then** **không nêu ai từ chối và không nêu lý do**

**Given** phiên đã đủ 3 người
**When** có lời xin
**Then** từ chối tự động bằng thông báo phiên đã đủ, **không làm phiền** người trong phiên

**Given** một người đang **trong** phiên
**When** có người muốn hỏi họ
**Then** **tuyệt đối không popup, không âm thanh, không rung** — chỉ tăng một chấm đếm, xem sau khi phiên kết thúc

### Story 3.9: Người vào sau tính từ block sau khi vào

As a người vào phiên muộn,
I want chỉ trả cho phần tôi thật sự tham gia,
So that tôi không bị truy thu phần chưa nghe.

**Acceptance Criteria:**

**Given** một phiên đã chạy được 7 phút
**When** người thứ hai vào
**Then** `block_index` của họ neo theo **`joined_at` của chính họ**, không theo `session.started_at`
**And** họ **không** bị trừ cho 7 phút đã trôi

**Given** người vào sau
**When** block đầu tiên của họ bắt đầu
**Then** trừ đúng một block theo giá đã chụp lúc vào
**And** giao diện đã hiện thẻ xác nhận trước đó, đúng luật "không trừ coin nếu chưa qua thẻ xác nhận"

**Given** người vào sau và người vào trước
**When** cả hai đang trong phiên
**Then** hai đồng hồ chạy lệch pha nhau và điều đó là **đúng**, không phải lỗi

---

## Epic 4: Tìm đúng lớp, xây uy tín, và được bảo vệ

Người dùng mô tả nguyện vọng và được đưa tới đúng lớp; tích được uy tín thật qua nỗ lực và huy hiệu đã xác minh; và khi có người lạm dụng thì báo cáo được và bị xử lý. Uy tín và xác minh nằm chung epic vì huy hiệu học vấn chỉ hiển thị khi đã xác minh.

### Story 4.1: Một cửa duy nhất cho mọi input đi vào AI

As a chủ dự án,
I want mọi lời gọi model đi qua đúng một chỗ,
So that không tính năng AI nào tự quét prompt-injection theo cách riêng, hoặc quên quét.

**Acceptance Criteria:**

**Given** codebase
**When** tìm mọi lời gọi tới model
**Then** **không có** lời gọi nào phát ra từ `apps/*`
**And** tất cả đi qua một adapter AI duy nhất

**Given** một input của người dùng đi vào adapter
**When** trước khi gửi tới model
**Then** chạy prompt-injection scan
**And** input bị đánh dấu nguy hiểm thì không được gửi, và sự kiện ghi audit

**Given** mỗi lời gọi model
**When** hoàn tất hoặc thất bại
**Then** ghi một dòng audit
**And** có timeout; lời gọi treo không làm treo request của người dùng

**Given** nguyện vọng người dùng nhập
**When** dùng nó
**Then** coi là input **không tin được**, kể cả khi chỉ dùng để sinh embedding

### Story 4.2: AI match theo nguyện vọng

As a người chưa biết học ở đâu,
I want mô tả điều mình đang cần bằng câu của mình,
So that tôi được đưa tới đúng lớp thay vì phải đoán từ khoá.

**Acceptance Criteria:**

**Given** người dùng nhập nguyện vọng bằng câu đầy đủ
**When** gửi
**Then** hệ thống sinh embedding qua adapter ở Story 4.1 và so khớp cosine similarity với mô tả các lớp
**And** trả lớp có điểm cao nhất lên đầu, kèm điểm khớp

**Given** schema
**When** lưu vector
**Then** bảng `room_embeddings` được tạo trong story này với cột `vector(n)` cố định số chiều
**And** đổi model khác số chiều về sau **là** một migration cộng sinh lại toàn bộ vector — không phải thay đổi nhỏ

**Given** không lớp nào khớp
**When** trả kết quả
**Then** hiện "Chưa có lớp nào khớp. Thử mô tả nguyện vọng bằng câu đầy đủ, hoặc vào một lớp ngẫu nhiên do AI chọn."
**And** kèm nút "Vào ngẫu nhiên theo AI"

**Given** người dùng chưa biết học gì
**When** bấm "Vào ngẫu nhiên theo AI"
**Then** được đưa vào một lớp đang hoạt động phù hợp

### Story 4.3: Xác minh danh tính qua nhà cung cấp bên thứ ba

As a người muốn nhận coin,
I want xác minh danh tính một lần,
So that người khác tin được tôi là ai trước khi trả tiền cho tôi.

**Acceptance Criteria:**

**Given** luồng xác minh
**When** người dùng tải ảnh giấy tờ
**Then** ảnh đi **thẳng từ trình duyệt tới nhà cung cấp bên thứ ba**, không qua server của ta
**And** **không tồn tại endpoint nào nhận tệp** trong toàn bộ hệ thống

**Given** kết quả xác minh trả về
**When** lưu
**Then** chỉ lưu mã tham chiếu của nhà cung cấp, kết quả đạt/không, mốc thời gian, và các trường suy ra được phép dùng
**And** **không** lưu ảnh, không lưu số giấy tờ

**Given** người dùng đã xác minh
**When** hệ thống cần biết họ đủ 18 hay chưa
**Then** dùng được kết quả từ luồng này thay cho khai tự nguyện ở Story 1.4

**Given** một hành vi nhạy cảm (bật nhận hỏi riêng, nhận coin)
**When** người dùng chưa xác minh
**Then** bị chặn kèm lối đi tới luồng xác minh

**Given** mọi bước của luồng xác minh
**When** xảy ra
**Then** ghi audit bất biến

### Story 4.4: Huy hiệu học vấn và badge kỹ năng

As a người dạy,
I want khoe bằng cấp đã được xác minh,
So that người học biết vì sao nên hỏi tôi.

**Acceptance Criteria:**

**Given** schema huy hiệu
**When** tạo bảng
**Then** `credentials` được tạo trong story này, chỉ có dòng khi đã xác minh
**And** thuộc quyền ghi của `apps/api`

**Given** một huy hiệu học vấn
**When** hiển thị ở bất kỳ đâu
**Then** chỉ render khi **đã xác minh** qua Story 4.3
**And** **không tồn tại** trạng thái "đang chờ duyệt" hiển thị công khai

**Given** hồ sơ một người
**When** xem
**Then** hiện đồng thời ba trục: hạng uy tín mùa · huy hiệu học vấn đã xác minh · badge kỹ năng

**Given** một ô người tham gia trong phòng live
**When** hiển thị huy hiệu
**Then** tối đa **2 huy hiệu**; từ huy hiệu thứ ba gộp thành "+N"
**And** ở lưới dày (Campus) rút còn 1

**Given** ký hiệu huy hiệu
**When** trình đọc màn hình đọc
**Then** ký hiệu mang `aria-hidden`, nghĩa nằm ở nhãn văn bản đầy đủ

**Given** người dùng chưa xác minh
**When** xem hồ sơ của chính mình
**Then** ô huy hiệu học vấn hiện "Chưa xác minh", **không** hiện huy hiệu ở dạng mờ

### Story 4.5: Điểm nỗ lực và hạng theo mùa

As a người học chăm chỉ,
I want nỗ lực của mình được ghi nhận,
So that tôi xây được uy tín ngay cả khi luôn ẩn mặt.

**Acceptance Criteria:**

**Given** người dùng có mặt trong một phòng có ít nhất 2 người
**When** mỗi phút trôi qua
**Then** cộng 1 điểm nỗ lực
**And** trần 120 điểm/ngày từ nguồn này để chống cày

**Given** một câu trả lời được đánh dấu hữu ích trong chat
**When** ghi nhận
**Then** cộng 5 điểm cho người trả lời

**Given** một báo cáo được moderator xác nhận
**When** xử lý xong
**Then** trừ 50 điểm của người bị báo cáo

**Given** Epic 3 đã có phiên hỏi riêng
**When** một phiên hoàn tất
**Then** cộng 20 điểm cho người ở vai được hỏi
**And** nếu Epic 3 chưa có, ba quy tắc trên vẫn chạy độc lập — quy tắc này bật sau

**Given** người dùng xem hạng của mình
**When** mở hồ sơ
**Then** thấy hạng theo bậc thang **và** xem được bảng trọng số đầy đủ trong app — trọng số không được giấu

**Given** một người luôn ẩn mặt
**When** tích điểm
**Then** tích được đầy đủ như người để nguyên mặt — ẩn danh không phải chế độ hạng hai

**Given** kết thúc một mùa
**When** tổng kết
**Then** hạng reset và có thưởng theo nỗ lực, ghi vào sổ cái với `source = reputation_reward`
**And** bảng `reputation_scores` thuộc quyền ghi của `apps/realtime-gateway`

### Story 4.6: Kênh lệnh bền giữa hai process

As a chủ dự án,
I want một đường duy nhất để hai process ra lệnh cho nhau,
So that lệnh ban và lệnh cấp coin không bao giờ bị mất giữa đường.

**Acceptance Criteria:**

**Given** schema
**When** tạo bảng
**Then** mỗi process có bảng outbox của **riêng nó**, và một bảng đánh dấu đã-xử-lý của riêng bên nhận
**And** bên phát chỉ ghi outbox của mình; bên nhận chỉ ghi bảng đánh dấu của mình

**Given** một thay đổi nghiệp vụ cần ra lệnh cho process kia
**When** thực hiện
**Then** lệnh được ghi vào outbox **trong cùng transaction** với thay đổi đó
**And** không có trường hợp thay đổi thành công mà lệnh mất

**Given** một lệnh trong outbox
**When** bên nhận tiêu thụ
**Then** xử lý **idempotent theo khoá lệnh** — cùng lệnh chạy hai lần chỉ có hiệu lực một lần
**And** đánh dấu đã xử lý sau khi hoàn tất

**Given** bên nhận đang tắt hoặc lỗi
**When** lệnh được phát
**Then** lệnh nằm lại trong outbox và được xử lý khi bên nhận sống lại
**And** không lệnh nào bị bỏ qua âm thầm

**Given** codebase
**When** tìm lời gọi HTTP đồng bộ giữa `apps/api` và `apps/realtime-gateway`
**Then** **không có** lời gọi nào cho việc có hệ quả tiền hoặc quyền

**Given** outbox có lệnh tồn đọng quá lâu
**When** vượt ngưỡng
**Then** phát tín hiệu cảnh báo — một kênh lệnh chết âm thầm là chế độ hỏng nguy hiểm nhất của thiết kế này

### Story 4.7: Report, xử lý vi phạm, và thu hồi quyền

As a người bị quấy rối,
I want báo cáo được trong một bước và tin rằng có người xử lý,
So that việc ẩn danh không biến phòng học thành nơi trú ẩn.

**Acceptance Criteria:**

**Given** schema báo cáo
**When** tạo bảng
**Then** `reports` được tạo trong story này, thuộc quyền ghi của `apps/api`

**Given** một người dùng, một phòng, hoặc một tin nhắn
**When** mở menu ngữ cảnh
**Then** report được trong **một bước**
**And** người bị báo cáo **không bao giờ** biết ai đã báo cáo

**Given** một báo cáo đã gửi
**When** người gửi theo dõi
**Then** thấy được trạng thái xử lý

**Given** moderator xử lý một báo cáo
**When** ra quyết định block hoặc ban
**Then** hành động ghi audit bất biến kèm hồ sơ hành vi và risk registry

**Given** một endpoint thu hồi quyền có xác thực
**When** gọi để ban một người
**Then** lệnh đi qua kênh bền (outbox) tới `apps/realtime-gateway`
**And** phiên hỏi riêng đang chạy của người đó **kết thúc kèm chốt sổ block đang chạy**
**And** người đó bị đuổi khỏi phòng LiveKit qua server SDK

**Given** MVP chưa có giao diện moderator
**When** vận hành
**Then** thu hồi quyền vẫn phải gọi **qua endpoint**, kể cả bằng công cụ dòng lệnh
**And** sửa tay bằng `psql UPDATE` **không đạt** AC này

**Given** một người vừa bị ban
**When** họ đang giữ một WebSocket đang mở
**Then** kết nối bị xác thực lại và đóng — token ngắn hạn không thay thế được thu hồi

**Given** người dùng bị phát hiện khai gian tuổi
**When** báo cáo được xác nhận
**Then** rơi vào cùng luồng xử lý này

### Story 4.8: Đóng phòng theo giao thức hai bước

As a nền tảng,
I want một phòng không bao giờ biến mất trong lúc bên trong nó còn phiên đang tính tiền,
So that không ai bị trừ coin cho một phiên không còn ngữ cảnh, và không ai học miễn phí vì tick thất bại im lặng.

**Acceptance Criteria:**

**Given** một phòng còn ít nhất một phiên hỏi riêng đang sống
**When** host hoặc hệ thống yêu cầu đóng phòng
**Then** **không** có đường nào xoá cứng phòng đó
**And** `apps/api` đặt phòng sang `closing` và **ngừng cấp token vào phòng mới** ngay từ nhịp này

**Given** phòng đã sang `closing`
**When** `apps/api` cần báo cho `apps/realtime-gateway`
**Then** lệnh đi qua **outbox bền** của Story 4.6, ghi trong cùng transaction với việc đổi trạng thái
**And** **không** có lời gọi HTTP đồng bộ nào giữa hai process cho việc này

**Given** `apps/realtime-gateway` nhận lệnh đóng phòng
**When** xử lý
**Then** kết thúc mọi phiên hỏi riêng bên trong và **chốt sổ block cuối** của từng người theo đúng luật Story 3.6
**And** mỗi người nhận thẻ tổng kết như khi phiên dừng bình thường, đọc lại được trong Ví coin
**And** báo kết quả lại cho `apps/api` qua cùng kênh bền

**Given** `apps/realtime-gateway` đã báo xong
**When** `apps/api` nhận xác nhận
**Then** phòng mới chuyển sang đóng hẳn
**And** trước thời điểm đó phòng vẫn tồn tại, chỉ là không nhận người mới

**Given** lệnh đóng phòng bị xử lý lại
**When** consumer chạy lần hai
**Then** idempotent theo khoá lệnh — không chốt sổ hai lần, không trừ thêm block nào

**Given** một phòng không còn phiên nào bên trong
**When** đóng
**Then** vẫn đi đúng ba nhịp trên, không có đường tắt
**And** quy tắc chung: **thực thể của một chủ không được biến mất khi thực thể sống của chủ kia đang phụ thuộc vào nó**

---

## Epic 5: Gói dịch vụ và nạp thêm coin

Người dùng nâng gói để mở phòng đông hơn, và nạp thêm coin khi hết — kể cả đang giữa một phiên hỏi riêng, mà không bao giờ mất dấu tiền của mình.

### Story 5.1: Ba gói dịch vụ và trần người theo gói

As a người tổ chức lớp đông,
I want nâng gói để mở phòng lớn hơn,
So that lớp của tôi chứa đủ người.

**Acceptance Criteria:**

**Given** ba gói dịch vụ
**When** hiển thị
**Then** đúng tên đầy đủ: **Study Buddy** (6 người, miễn phí) · **Study Circle** (25 người, phí/năm) · **Campus** (45 người, trần 100)
**And** tên gói viết nguyên văn ở mọi nơi, không rút gọn thành "Buddy" hay "Circle"

**Given** một người tạo phòng
**When** phòng được tạo
**Then** trần người lấy theo gói hiện tại của họ và lưu cùng phòng

**Given** người dùng nâng gói
**When** hoàn tất
**Then** quyền cập nhật ngay; phòng tạo sau đó dùng trần mới
**And** phòng đang chạy giữ nguyên trần cũ

**Given** người dùng **hạ** gói trong lúc đang có phòng vượt trần mới
**When** hệ thống xử lý
**Then** không ai bị đá ra giữa buổi học
**And** trần mới áp cho phòng tạo sau đó

**Given** một người bị hạ gói
**When** lệnh thu hồi quyền chạy
**Then** đi qua cùng kênh outbox của Story 4.6

### Story 5.2: Nạp coin qua cổng thanh toán

As a người hết coin,
I want nạp thêm bằng thẻ,
So that tôi hỏi tiếp được.

**Acceptance Criteria:**

**Given** người dùng chọn một gói nạp
**When** bắt đầu giao dịch
**Then** chuyển sang cổng thanh toán ngoài
**And** bề mặt này dùng giọng chính xác: có số tiền, có số coin nhận được, **không** có chữ "chỉ", không emoji

**Given** cổng thanh toán báo thành công qua webhook
**When** `apps/api` nhận
**Then** `apps/api` **không tự ghi sổ cái** — nó phát một lệnh có khoá idempotent qua outbox
**And** lệnh ghi trong **cùng transaction** với việc lưu trạng thái giao dịch

**Given** `apps/realtime-gateway` nhận lệnh từ outbox
**When** xử lý
**Then** chèn một dòng `coin_ledger` với `source = topup`
**And** xử lý **idempotent** — cùng lệnh chạy hai lần chỉ sinh một dòng

**Given** webhook của cổng thanh toán gửi lại nhiều lần
**When** cả ba lần đều tới
**Then** người dùng nhận đúng một lần coin

**Given** người dùng đang trong một phiên hỏi riêng
**When** bấm "Nạp thêm coin"
**Then** phiên **không bị ngắt**; đồng hồ vẫn chạy và vẫn nhìn thấy
**And** coin về kịp thì đồng hồ tự cộng thời gian, **không** cần bấm gì thêm

**Given** một giao dịch nạp hoàn tất
**When** người dùng xem ví
**Then** có biên nhận đọc lại được và một dòng trong lịch sử nạp

### Story 5.3: Ba trạng thái khi quay lại từ cổng thanh toán

As a người vừa trả tiền,
I want biết tiền của mình đang ở đâu,
So that tôi không phải đoán xem đã bị trừ chưa.

**Acceptance Criteria:**

**Given** người dùng quay lại app từ cổng thanh toán
**When** màn hình render
**Then** **không bao giờ** để trống, và **không bao giờ** quay vòng vô định
**And** luôn rơi vào đúng một trong ba trạng thái dưới đây

**Given** giao dịch thành công
**When** hiển thị
**Then** "Đã nhận 500.000 coin lúc 21:37. Số dư: 512.400."
**And** có số tiền **và** mốc thời gian — luật cứng của mọi câu nói về tiền

**Given** giao dịch đang được xác nhận
**When** hiển thị
**Then** "Giao dịch đang được xác nhận. Chưa trừ coin nào của bạn."
**And** kèm mã tham chiếu để đối chiếu
**And** nói rõ kết quả sẽ hiện trong Ví coin

**Given** giao dịch thất bại hoặc timeout
**When** hiển thị
**Then** "Chưa trừ tiền của bạn. Giao dịch không hoàn tất lúc 21:37."
**And** người dùng bấm lại **không** bị cấp coin trùng

**Given** bất kỳ trạng thái nào trong ba
**When** thông báo cho người dùng
**Then** **không** dùng snackbar — tiền phải nằm ở bề mặt đọc lại được

**Given** coin về sau khi phiên hỏi riêng đã dừng vì hết coin
**When** người dùng quay lại phòng
**Then** bắt đầu một phiên mới với thẻ xác nhận mới, **không** tự nối lại phiên cũ
