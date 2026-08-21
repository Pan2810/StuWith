---
name: StuWith
status: final
updated: 2026-08-21
sources:
  - docs/prd.md
  - docs/brief.md
design: ./DESIGN.md
---

# StuWith — Experience Spine

> Sở hữu *cách hoạt động*: kiến trúc thông tin, hành vi, trạng thái, tương tác, ngưỡng tiếp cận, và các luồng chính. Nhận diện thị giác nằm ở `DESIGN.md`; file này tham chiếu token của nó bằng cú pháp `{colors.coin}`. **Hai spine thắng mọi mock, wireframe hay bản import khi có xung đột.**

## Foundation

Web **desktop-first, responsive** xuống mobile. Web là client thuần — hợp đồng API `/v1` versioned để app phone (S5+) dùng lại; spine này **không** đặc tả app native, nhưng mọi quyết định hành vi dưới đây phải diễn đạt được lại trên một bề mặt cảm ứng.

Hệ UI kế thừa: **Material 3** — điều hướng, motion, ngưỡng tiếp cận theo M3. `DESIGN.md` là nguồn nhận diện thị giác: hệ **"Cắm trại"** đã thay toàn bộ palette, typography, shape và cả ngôn ngữ độ sâu (bóng lệch cứng thay cho tonal elevation của M3). Spine này chỉ đặc tả **phần lệch về hành vi** so với M3.

Khoá component là kebab-case tiếng Anh, dùng chung với `DESIGN.md.Components`; token tham chiếu theo `{path.to.token}` và tự phân giải sang biến thể `-dark` ở chế độ tối — luật đầy đủ ở `DESIGN.md § Quy ước đọc token`.

Ngôn ngữ: **VI mặc định, EN song song**. Mọi chuỗi đều phải qua i18n ngay từ đầu — không có chuỗi cứng, kể cả trong thông báo lỗi. Chuỗi tiếng Việt trung bình dài hơn tiếng Anh ~15–25%, nên mọi nút và chip phải chịu được text dài mà không cắt chữ.

Light và dark là **hai chế độ ngang hàng**, không phải một chế độ với biến thể. Mặc định theo hệ điều hành, người dùng đổi được.

## Information Architecture

| Bề mặt | Vào từ | Mục đích |
|---|---|---|
| Đăng nhập | Vào lần đầu / hết phiên | 4 OAuth: Google, Facebook, Apple, Microsoft (hỗ trợ Entra cho tài khoản tổ chức) |
| Khám phá | Sau đăng nhập (màn gốc) | Tìm lớp theo keyword · nhập nguyện vọng để AI match · "Vào ngẫu nhiên theo AI" · lớp đã học |
| Tạo phòng | Khám phá → nút chính | Tên, mô tả, chủ đề, công khai/riêng, trần người theo gói |
| **Pre-join** | Trước khi vào bất kỳ phòng nào | Xem trước camera, chọn chế độ khuôn mặt, thử mic, thấy tên phòng + host + huy hiệu |
| Phòng học live | Pre-join → Vào phòng | Lưới người · chat cả phòng · thanh điều khiển · chỉ báo mạng |
| Bảng chế độ khuôn mặt | Phòng live → nút Khuôn mặt | Để nguyên / Ẩn mặt / Filter — đổi tức thì, có xem trước |
| Nhận hỏi riêng & đặt giá | Hồ sơ, hoặc phòng live → menu của mình | Bật/tắt nhận hỏi riêng · đặt đơn giá trong khung 10–500 coin/phút |
| Xác nhận hỏi riêng | Bấm "Hỏi riêng" trên ô người đã bật nhận | Thẻ giá + huy hiệu + luật trừ coin, trước khi đồng hồ chạy |
| Phiên hỏi riêng | Sau xác nhận | Kênh 1-1 tách biệt · đồng hồ đếm ngược · dừng bất cứ lúc nào |
| Ví coin | Menu tài khoản | Số dư · lịch sử giao dịch · lối vào Nạp coin |
| Nạp coin | Ví coin, hoặc khi hết coin giữa phiên | Chọn gói · thanh toán · biên nhận |
| Hồ sơ | Bấm tên/avatar bất kỳ đâu | 3 trục: hạng uy tín mùa · huy hiệu học vấn đã xác minh · badge kỹ năng |
| Xác minh danh tính | Hồ sơ → Xác minh | KYC nhẹ, mở khoá hành vi nhạy cảm và huy hiệu học vấn |
| Báo cáo & xử lý | Menu ngữ cảnh trên người/phòng/tin nhắn | Gửi báo cáo · theo dõi trạng thái · moderator xử lý, block/ban |
| Gói dịch vụ | Menu tài khoản | Study Buddy 6 (miễn phí) · Study Circle 25 · Campus 45–100 |

> **MVP không ghi hình.** Bề mặt "Ghi hình" đã bị gỡ khỏi IA ngày 20/08/2026 theo quyết định ở `docs/prd.md` §5 — không có bản ghi, không có retention, không có luồng đồng thuận ghi hình. Đây là một cam kết riêng tư **mạnh hơn** phương án cũ, và giao diện được phép nói thẳng điều đó.

**Pre-join là bắt buộc, không bỏ qua được.** Người dùng không bao giờ được rơi thẳng vào một phòng có camera đang bật mà chưa kịp quyết định lộ mặt hay không. Đây là hệ quả trực tiếp của định vị "học ẩn danh".

→ Tham chiếu bố cục (light + dark cho mỗi màn):
- [`mockups/phong-hoc-live.html`](mockups/phong-hoc-live.html) — lưới phòng live ở cả bậc mạng tốt và bậc mạng yếu, kèm bảng token màu đã kiểm tương phản
- [`mockups/pre-join.html`](mockups/pre-join.html) — ba chế độ khuôn mặt, câu xác nhận điều gì đang bị lộ, **và trạng thái trình duyệt chặn camera/mic kèm lối thoát "vào phòng chỉ để nghe"**
- [`mockups/xac-nhan-hoi-rieng.html`](mockups/xac-nhan-hoi-rieng.html) — thẻ xác nhận trước khi trừ coin, phiên đang chạy, ngưỡng còn 2 phút, thẻ tổng kết, **và ba trạng thái khi quay lại từ cổng thanh toán**
- [`mockups/kham-pha-ai-match.html`](mockups/kham-pha-ai-match.html) — màn đăng nhập kèm state lỗi + rate-limit, ô nguyện vọng làm chủ đạo, kết quả AI match, trạng thái không có kết quả

**Spine thắng khi xung đột với bất kỳ mock nào.**

## Voice and Tone

Microcopy. Giọng thương hiệu và tư thế thẩm mỹ nằm ở `DESIGN.md.Brand & Style`.

StuWith nói bằng **hai giọng theo vùng**. Nhầm vùng là lỗi, không phải khác biệt phong cách.

| Vùng | Bề mặt | Giọng | Xưng hô |
|---|---|---|---|
| **Ấm** | Khám phá, pre-join, phòng live, chat, hồ sơ, huy hiệu, hạng mùa | Ngang hàng, ngắn, không khách sáo | "bạn / mình" |
| **Chính xác** | Ví coin, nạp coin, xác nhận hỏi riêng, phiên đang tính tiền, báo cáo, xác minh | Trung tính, có số liệu và mốc thời gian, không đùa, không trấn an | "bạn / hệ thống" |

| Nên | Không nên |
|---|---|
| "Chưa ai ở đây. Bật mic chào một câu?" *(vùng ấm)* | "Phòng trống!" |
| "Bạn sẽ bị trừ 120 coin cho mỗi phút, tính theo block 1 phút." *(vùng chính xác)* | "Chỉ 120 coin/phút thôi!" |
| "Phiên đã dừng lúc 23:14. Đã trừ 360 coin. Số dư còn 999.640." | "Hết coin rồi 😢 Nạp thêm nhé!" |
| "Mạng yếu — đã tắt video để giữ tiếng." | "Lỗi kết nối" |
| "Không đăng nhập được. Thử lại hoặc chọn cách khác." | "Authentication failed: invalid_grant" |
| "Huy hiệu Thạc sĩ đã được xác minh." | "Đã duyệt thành công!!!" |

**Luật cứng:** mọi câu nói về tiền phải chứa **con số** và, khi là sự kiện đã xảy ra, chứa **mốc thời gian**. Không có câu tiền nào chỉ mang cảm xúc.

Lỗi kỹ thuật không bao giờ lộ ra giao diện. Người dùng thấy điều gì đã xảy ra và làm gì tiếp theo; mã lỗi vào log.

### Microcopy — trạng thái "đang trong phiên hỏi riêng"

Vùng giọng **ấm** (chưa có coin nào bị trừ), nhưng không đùa. Chuỗi khoá dùng cho i18n; `{name}` là tên người được hỏi, `{price}` là đơn giá.

| Khoá | VI | EN |
|---|---|---|
| `busy.chip` | 🔒 Đang hỏi riêng | 🔒 In a private session |
| `busy.chip.waiting` | Đang chờ | Waiting |
| `busy.cta` | Báo tôi khi rảnh | Notify me when free |
| `busy.dialog.title` | {name} đang trong một phiên hỏi riêng | {name} is in a private session |
| `busy.dialog.body` | Phiên riêng là kênh tách biệt nên bạn chưa vào được. Bạn có thể đợi, hoặc hỏi cả phòng — thường có người khác cùng học chủ đề này. | Private sessions are a separate channel, so you can't join right now. You can wait, or ask the whole room — someone else here is usually studying the same thing. |
| `busy.dialog.primary` | Báo tôi khi rảnh | Notify me when free |
| `busy.dialog.secondary` | Hỏi cả phòng | Ask the room |
| `busy.dialog.dismiss` | Để sau | Not now |
| `busy.queued.snackbar` | Sẽ báo bạn khi {name} xong. | We'll let you know when {name} is done. |
| `busy.queued.cancel` | Huỷ chờ | Cancel |
| `busy.free.toast.title` | {name} đã rảnh | {name} is free now |
| `busy.free.toast.body` | Hỏi riêng · {price} coin/phút | Private session · {price} coins/min |
| `busy.free.toast.cta` | Hỏi ngay | Ask now |
| `busy.chat.hint` | {name} đang trong phiên hỏi riêng, có thể chưa đọc ngay. | {name} is in a private session and may not read this right away. |
| `busy.left.room` | {name} đã rời phòng. Bạn không còn trong danh sách chờ. | {name} left the room. You're no longer waiting. |
| `busy.self.after` | Có {n} người muốn hỏi bạn khi nãy. | {n} people wanted to ask you while you were busy. |
| `busy.self.after.cta` | Xem | View |

**Ba điều những câu trên cố ý không nói**, và lý do:

| Không nói | Vì sao |
|---|---|
| Đang hỏi riêng **với ai** | Lộ chuyện người kia đang trả coin — vi phạm chính giá trị ẩn danh của sản phẩm |
| **Còn bao lâu** nữa xong | Thời gian còn lại = số dư ÷ đơn giá ⇒ lộ gián tiếp số dư coin của người đang hỏi |
| "{name} **bận**", "đang có người khác" | Đọc như bị từ chối. "Đang trong một phiên hỏi riêng" là mô tả trạng thái, trung tính hơn và đúng hơn |

**Luật bổ sung cho `busy.chat.hint`:** gợi ý này **không chặn** việc gửi tin. Người dùng vẫn nhắn được vào chat cả phòng; câu này chỉ đặt kỳ vọng về thời gian trả lời.

### Microcopy — xin tham gia phiên đang có

| Khoá | VI | EN |
|---|---|---|
| `join.cta` | Xin tham gia | Ask to join |
| `join.sent` | Đã gửi lời xin. Cả hai người trong phiên cần đồng ý. | Request sent. Both people in the session need to agree. |
| `join.waiting` | Đang chờ người còn lại đồng ý. | Waiting for the other person to agree. |
| `join.expired` | Không ai phản hồi. Bạn thử lại sau nhé. | No response. You can try again later. |
| `join.declined` | Lời xin không được chấp nhận. | Your request wasn't accepted. |
| `join.prompt.host` | {asker} xin tham gia phiên này. | {asker} is asking to join this session. |
| `join.prompt.payer` | {asker} xin tham gia. Nếu bạn đồng ý, {asker} sẽ thấy bạn đang ở đây. | {asker} is asking to join. If you agree, {asker} will see that you're here. |
| `join.prompt.accept` | Đồng ý | Agree |
| `join.prompt.ignore` | Bỏ qua | Ignore |
| `join.joined` | {asker} đã vào phiên. | {asker} joined the session. |

**Ba luật của lời xin tham gia:**

1. **Không bao giờ là popup.** Người trong phiên đang trả tiền theo phút; một dialog chặn màn hình là cướp thời gian đã mua. Đây là một dải inline trong panel phiên, cao tối đa một dòng, tự hết hạn sau 30 giây. **Từ chối bằng cách không làm gì** — không bắt ai phải bấm để tiếp tục học.
2. **Cần hai phiếu, và người trả tiền là phiếu quan trọng hơn.** Người được hỏi đồng ý chưa đủ: người đang trả coin mới là người bị thay đổi thứ mình đang mua. Người xin không được biết ai đã đồng ý, ai chưa — nếu không, im lặng của một người sẽ bị đọc thành sự từ chối cá nhân.
3. **Người trả tiền phải được cảnh báo về cái sẽ bị lộ.** `join.prompt.payer` nói thẳng: đồng ý nghĩa là để {asker} thấy bạn đang ở trong phiên này. Với một sản phẩm mà ẩn danh là giá trị cốt lõi, và người dùng có thể đang ẩn mặt, việc lộ diện phải là một lựa chọn có ý thức chứ không phải hệ quả phụ.

**Một lời từ chối không bao giờ nêu lý do và không bao giờ nêu người.** `join.declined` cố ý mơ hồ — không nói ai từ chối, không nói vì sao. Nói rõ sẽ biến một quyết định riêng tư thành một sự đối đầu trong phòng học.

**Luật tiền của phiên nhiều người** *(đã chốt 20/08/2026 — `docs/prd.md` US-2.3 AC5–AC7)*:

- **Trần một phiên là 3 người:** 1 người được hỏi + tối đa 2 người trả coin. Trần này tồn tại để khung giá 10–500 coin/phút không bị vô hiệu hoá bằng cách nhân số người.
- **Mỗi người hỏi trả đủ đơn giá.** Hai người cùng hỏi ở giá 120 thì mỗi người bị trừ 120/phút, người được hỏi nhận 240/phút. Mỗi người có **một đồng hồ riêng** — giao diện không bao giờ hiển thị một đồng hồ chung, và người này không thấy số dư hay thời gian còn lại của người kia.
- **Người vào sau bị trừ từ block đầu tiên sau khi vào**, không truy thu phần phiên đã diễn ra trước đó. `card-ask-confirm` của họ nói rõ điều này.
- **Hết coin thì chỉ người đó rời**, phiên tiếp tục với những người còn lại. Không có khái niệm "người khởi tạo" — phiên sống chừng nào còn ít nhất một người trả coin.
- **Khi phiên đã đủ 3 người**, lời xin tham gia bị từ chối tự động bằng `join.full`, không làm phiền người trong phiên.

Thêm một khoá microcopy cho trường hợp đầy phiên:

| Khoá | VI | EN |
|---|---|---|
| `join.full` | Phiên này đã đủ người. Bạn có thể đợi hoặc hỏi cả phòng. | This session is full. You can wait or ask the room. |

**Khi đồng hồ dừng vì người được hỏi tắt mic** *(quyết định 21/08/2026 — `docs/prd.md` US-2.3 AC7)*. Một đồng hồ đứng im mà không giải thích đọc như hỏng, nên trạng thái này **bắt buộc** phải nói ra lý do:

| Khoá | VI | EN |
|---|---|---|
| `meter.paused.mic` | Đồng hồ đang tạm dừng — {name} đang tắt mic. Bạn không bị trừ coin lúc này. | Meter paused — {name}'s mic is off. You're not being charged right now. |
| `meter.resumed` | {name} đã bật mic. Đồng hồ chạy tiếp. | {name} turned their mic back on. The meter is running again. |
| `meter.paused.self` | Bạn đang tắt mic. Người hỏi tạm thời không bị trừ coin. | Your mic is off. The person asking isn't being charged right now. |

Ba luật đi kèm:

1. **Chỉ mic của người *được hỏi* mới dừng đồng hồ.** Người hỏi tắt mic là chuyện bình thường — họ đang nghe.
2. **Đánh giá tại ranh giới block, không liên tục.** Ho một tiếng rồi bật lại không làm đồng hồ nhấp nháy; trạng thái chỉ đổi ở đầu block kế.
3. **Người được hỏi phải thấy `meter.paused.self`.** Nếu không, họ sẽ tưởng vẫn đang được trả tiền trong lúc tắt mic — và đó là tranh chấp tiền chờ sẵn.

## Component Patterns

Hành vi. Đặc tả thị giác nằm ở `DESIGN.md.Components` **dưới đúng khoá kebab-case này** — ghép hai spine bằng khoá, không bằng nhãn tiếng Việt.

| Khoá component | Nhãn | Dùng ở | Luật hành vi |
|---|---|---|---|
| `tile-participant` | Ô người tham gia | Lưới phòng live | Bấm → mở hồ sơ rút gọn. Nếu người đó đã bật nhận hỏi riêng, hồ sơ rút gọn có nút "Hỏi riêng · N coin/phút"; nếu chưa bật, **nút không tồn tại** (không hiện dạng mờ). |
| `control-bar` | Thanh điều khiển phòng | Đáy sân khấu | Mic, Camera, Khuôn mặt, Giơ tay, Rời phòng luôn hiện. Không bao giờ tự ẩn theo thời gian — người học không di chuột liên tục. Đứng **trước** lưới trong thứ tự tab. |
| `face-mode-panel` | Bảng chế độ khuôn mặt | Popover từ `control-bar` | Đổi chế độ có hiệu lực **tức thì**, không cần xác nhận. Có ô xem trước chính mình. Xử lý client-side; khi đang Ẩn mặt hoặc Filter, khung hình gốc không rời máy người dùng. Ba lựa chọn là một nhóm chọn-một (`role="radiogroup"`), không phải ba nút rời. |
| `chip-status` | Chip trạng thái mạng | Top bar | Ba mức: Tốt / Yếu / Mất kết nối. Đổi mức hoãn `{motion.network-chip-debounce}` để tránh nhấp nháy khi mạng dao động. |
| `card-ask-confirm` | Thẻ xác nhận hỏi riêng | Trước khi phiên bắt đầu | Bắt buộc hiện: đơn giá, độ dài block, số phút ước tính theo số dư hiện tại, và **luật khi mất mạng**. Đồng hồ không chạy trước khi bấm xác nhận. |
| `dialog-busy` | Popup "đang bận" | Khi bấm Hỏi riêng vào người đang trong phiên | Chặn hành động, không chặn phòng. **Không nêu tên người đối diện, không nêu thời gian còn lại** (xem `§ Luật coin & tiền`). Luôn có ít nhất một lối đi tiếp, không bao giờ chỉ có nút Đóng. |
| `card-coin` | Khối tiền | Bên trong `card-ask-confirm`, thẻ phiên đang chạy, biên nhận nạp | Bề mặt tiền dùng chung. Mọi con số bên trong dùng `{typography.numeric}` (tabular). Không bao giờ chứa emoji hay câu chữ nhí nhảnh — đây là ranh giới giữa vùng giọng ấm và vùng giọng chính xác. |
| `countdown-display` | Đồng hồ phiên | Trong phiên hỏi riêng | Đếm ngược theo số dư thực. Luôn kèm dòng giải thích cách tính. Ở ngưỡng còn 2 phút và 1 phút, đổi sang `{colors.warn}` **và** hiện dòng cảnh báo bằng chữ. Xem luật `aria-live` ở `§ Accessibility Floor` — đây là bẫy dễ mắc nhất của cả spine. |
| `progress-coin` | Thanh coin còn lại | Cạnh `countdown-display` | Không bao giờ đứng một mình. |
| `transaction-row` | Thẻ giao dịch | Ví coin, sau mỗi phiên | Đọc lại được vĩnh viễn. Mọi thay đổi số dư đều sinh một hàng, kể cả hoàn coin. Trừ và cộng phân biệt bằng dấu và nhãn, không chỉ bằng màu. |
| `badge-credential` | Huy hiệu | `tile-participant`, hồ sơ | Tối đa 2 trên ô, đầy đủ ở hồ sơ. Huy hiệu học vấn chỉ render khi đã xác minh. Ký hiệu 🎓/▲/● là trang trí — nghĩa nằm ở nhãn văn bản. |
| `chat-panel` | Chat cả phòng | Rail phải / sheet đáy | Miễn phí, realtime. Rate limit hiện dưới dạng đếm ngược ngắn, không dưới dạng lỗi. Mỗi tin có menu báo cáo. Thông báo tin mới: xem `§ Accessibility Floor`. |
| `strip-join-request` | Dải xin tham gia | Trong panel phiên hỏi riêng | Cao tối đa một dòng, **không chặn màn hình**, tự hết hạn 30 giây. Hai nút cùng trọng lượng — không nút nào được tô `primary`. Không phản hồi = từ chối. Đầy đủ luật ở `§ Microcopy — xin tham gia phiên đang có`. |
| `button-secondary` | Nút phụ | Khắp nơi | Hành động không tiêu coin và không phá huỷ. Không bao giờ là nút duy nhất trên một bề mặt quyết định — luôn có một `button-primary` đối trọng, trừ `strip-join-request` (hai nút cùng trọng lượng là cố ý). |
| `snackbar` | Thông báo nhẹ | Khắp nơi trừ vùng tiền | Chỉ xác nhận hành động không đảo ngược được trạng thái quan trọng (đã sao chép link phòng, đã gửi báo cáo). Tồn tại 4 giây. **Cấm** dùng cho mọi thông báo liên quan coin hoặc thanh toán — những thứ đó phải nằm ở bề mặt đọc lại được. |

## State Patterns

| Trạng thái | Bề mặt | Xử lý |
|---|---|---|
| Đăng nhập thất bại | Đăng nhập | "Không đăng nhập được. Thử lại hoặc chọn cách khác." Không lộ mã lỗi, không nói provider nào hỏng *(US-0.1 AC4)* |
| Provider từ chối quyền | Đăng nhập | "Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới." Không coi là lỗi |
| Bị rate-limit đăng nhập | Đăng nhập | "Thử lại sau N giây." Đếm ngược thật, không nói lý do kỹ thuật *(US-0.1 AC3)* |
| Phiên hết hạn giữa buổi học | Bất kỳ đâu | Không đá ra ngoài đột ngột. Dialog "Phiên đăng nhập đã hết hạn — đăng nhập lại để tiếp tục", giữ nguyên phòng đang ở để quay lại |
| **Trình duyệt chặn camera/mic** | **Pre-join** | Bề mặt duy nhất xin quyền thiết bị. Hiện hướng dẫn mở lại quyền theo đúng trình duyệt, **và** một lối thoát: "Vào phòng chỉ để nghe". Không bao giờ để người dùng kẹt ở đây |
| Không tìm thấy thiết bị | Pre-join | "Không thấy micro. Bạn vẫn vào phòng và dùng chat được." + nút vào phòng |
| Chưa có lớp nào | Khám phá | "Chưa có lớp nào khớp. Thử mô tả nguyện vọng bằng câu đầy đủ, hoặc vào ngẫu nhiên theo AI." + nút vào ngẫu nhiên |
| Phòng chỉ có mình | Phòng live | "Chỉ có bạn ở đây. Cứ học, ai vào sẽ thấy bạn." Không giục, không đếm ngược |
| Phòng đầy | Trước pre-join | "Phòng đã đủ N người theo gói %s. Bạn có thể xem lớp tương tự." + gợi ý lớp khác |
| Mạng yếu | Toàn phòng | Video tụt bậc rồi tắt hẳn → avatar. Banner `{colors.warn}` một dòng. Audio giữ nguyên. Xem `Thang suy giảm mạng` |
| Mất hẳn kết nối | Toàn phòng | Đóng băng lưới, banner "Mất kết nối — đang thử lại". Tự kết nối lại 30 giây rồi mới đưa về Khám phá |
| Người kia đang bận | `tile-participant` của người đang trong phiên | **Phòng ngừa trước, popup sau.** Chip đơn giá trên ô đổi thành chip 🔒 "Đang hỏi riêng"; trong hồ sơ rút gọn, nút "Hỏi riêng" đổi thành "Báo tôi khi rảnh" |
| Vẫn bấm Hỏi riêng vào người bận | `dialog-busy` | Popup không nêu tên người đối diện và không nêu thời gian còn lại. Ba lối đi: đợi có báo, hỏi cả phòng, hoặc đóng |
| Đã đăng ký chờ | Snackbar + `tile-participant` | Xác nhận nhẹ; chip trên ô đổi thành "Đang chờ". Chỉ giữ đăng ký khi người dùng còn ở trong phòng |
| Người kia vừa rảnh | Toast trong phòng | Chỉ hiện với người đã bấm "Báo tôi khi rảnh". Có giá kèm để không phải bấm mù. Tự tắt sau 20 giây, không xếp chồng |
| Xin tham gia phiên | `dialog-busy` → dải inline trong phiên | Người thứ ba xin vào phiên đang có. **Cần cả hai người trong phiên đồng ý**, không chỉ người được hỏi — người trả coin mới là người bị thay đổi thứ mình đang mua |
| Có lời xin tham gia | Người đang **trong** phiên | **Không popup, không âm thanh** (xem hàng dưới). Một dải inline trong panel phiên, cao tối đa một dòng, tự hết hạn sau 30 giây. Từ chối bằng cách không làm gì |
| Một người đã đồng ý, chờ người kia | Cả ba phía | Người xin thấy "Đang chờ người còn lại đồng ý" — **không** biết ai đã đồng ý. Đủ hai phiếu mới vào |
| Có người muốn hỏi mình | Người đang **trong** phiên | **Tuyệt đối không popup, không âm thanh, không rung.** Người đó đang trả tiền theo phút — cắt ngang là cướp thời gian đã mua. Chỉ tăng một chấm đếm trên nút Hỏi riêng, xem sau khi phiên kết thúc |
| Còn ≤ 2 phút coin | Phiên hỏi riêng | Đồng hồ đổi `{colors.warn}` + dòng chữ + lối tắt Nạp coin ngay trong phiên |
| Hết coin | Phiên hỏi riêng | Phiên dừng ở ranh giới block. Thẻ tổng kết: đã trừ bao nhiêu, dừng lúc mấy giờ, số dư còn lại. **Số dư không bao giờ âm** |
| Nạp coin lỗi/timeout | Nạp coin | "Chưa trừ tiền của bạn. Giao dịch không hoàn tất lúc HH:MM." Idempotency key bảo đảm không cấp coin trùng |
| Chưa xác minh | Hồ sơ | Huy hiệu học vấn không hiện. Ô trống ghi "Chưa xác minh" — không hiện huy hiệu mờ |
| Bị báo cáo / đang xử lý | Hồ sơ, phòng | Người bị báo cáo không thấy danh tính người báo cáo. Trạng thái xử lý hiện với người gửi báo cáo |
| Focus bàn phím | Mọi nơi | Vòng focus 2px `{colors.primary}`, cách viền 2px. Không bao giờ tắt outline |
| Đang tải | Khám phá, ví | Skeleton theo hình dạng nội dung thật. Không spinner toàn trang |

## Thang suy giảm mạng

Đây là trạng thái vận hành trung tâm của StuWith, không phải nhánh lỗi. Bốn bậc, mỗi bậc có tín hiệu riêng, **âm thanh không bao giờ bị hy sinh**:

| Bậc | Điều kiện | Video | Audio | Người dùng thấy |
|---|---|---|---|---|
| 1 · Tốt | Băng thông đủ | Simulcast, độ phân giải cao | Opus đầy đủ | Chip `ok` "Mạng tốt" |
| 2 · Giảm | Băng thông tụt | Tự tụt xuống lớp thấp | Opus + DTX | Chip vẫn `ok`, không báo gì — người dùng không cần biết |
| 3 · Nhẹ | Không đủ cho video | **Tắt, thay bằng avatar** | Opus + DTX/RED | Chip `warn` "Mạng yếu" + banner một dòng giải thích |
| 4 · Mất | Không có audio | Tắt | Mất | Banner "Mất kết nối — đang thử lại", lưới đóng băng, thử lại 30s |

Chuyển bậc **lên** (mạng tốt lại) thì im lặng, không thông báo — trừ khi người dùng đã bị đẩy xuống bậc 3, khi đó hiện nút "Bật lại camera" chứ **không** tự bật lại. Tự bật lại camera cho một người đang ẩn mặt là vi phạm nghiêm trọng.

Quy tắc bao trùm: mọi màn hình có người-trong-phòng phải được thiết kế ở **cả** bậc 1 và bậc 3. Bậc 3 là trạng thái chính thức, không phải bản dự phòng xấu xí.

## Luật coin & tiền

- **Không có gì trừ coin mà không qua thẻ xác nhận.** Thẻ hiện đơn giá, độ dài block, ước tính số phút theo số dư, và luật khi mất mạng — trước khi đồng hồ chạy.
- **Mất mạng vẫn tính coin nếu audio còn thông.** Video tắt không dừng đồng hồ, vì phiên vẫn đang diễn ra bằng tiếng — đúng với nguyên tắc "audio là chính". Chỉ khi mất hẳn audio (bậc 4) thì phiên tạm dừng và chỉ tính đến block cuối đã dùng. **Luật này phải in nguyên văn trên thẻ xác nhận** — người dùng không được biết điều này lần đầu vào lúc bị trừ.
- **Trạng thái bận không được rò rỉ hai thứ.** Khi báo cho người thứ ba biết ai đó đang trong phiên hỏi riêng, giao diện **không** được nêu *đang hỏi riêng với ai* (lộ chuyện người kia đang trả coin — vi phạm chính giá trị ẩn danh), và **không** được nêu *còn bao lâu nữa* (thời gian còn lại = số dư ÷ đơn giá, tức là lộ gián tiếp số dư coin của người đang hỏi). Chỉ được nói: người này đang bận, và bạn làm gì tiếp.
- **Chỉ người đã bật "nhận hỏi riêng" mới bị hỏi.** Ai chưa bật thì không có nút, không có lời mời, không có thông báo. Không có cơ chế nào để người lạ gõ cửa.
- **Giá nằm trong khung 10–500 coin/phút.** Khung này hiện ngay trên ô nhập giá cùng lý do ("để tránh đặt giá lừa đảo"), không phải chỉ là lỗi validation khi nhập sai.
- **Số dư không bao giờ âm.** Phiên dừng ở ranh giới block, không vượt.
- **Mọi thay đổi số dư đều sinh một thẻ giao dịch đọc lại được**, kèm mốc thời gian. Snackbar không bao giờ là nơi duy nhất người dùng biết mình bị trừ tiền.
- Trong bản thử, mỗi tài khoản được cấp sẵn 1.000.000 coin. Giao diện **không** hứa hẹn gì về việc quy đổi ra tiền thật — không có chữ "giá trị", "VNĐ", hay "rút" ở bất cứ đâu, vì tính năng đó đang chờ pháp lý.

## Ẩn danh, riêng tư & báo cáo

Ẩn danh là tính năng cốt lõi, nên nó cũng là bề mặt tấn công. Ba luật đối trọng:

- **Ẩn mặt là quyết định của người dùng, hệ thống không bao giờ đảo ngược.** Không tự bật lại camera sau khi mạng hồi phục, không tự tắt filter khi chuyển phòng, không có "chế độ bắt buộc hiện mặt" cho người tham gia thường.
- **MVP không ghi lại gì cả, và được phép nói thẳng điều đó.** Không có bản ghi buổi học, không có retention, không có luồng đồng thuận ghi hình — quyết định ngày 20/08/2026 (`docs/prd.md` §5). Đây là cam kết riêng tư **mạnh hơn** phương án "ghi có consent", nên giao diện nên nói ra ở chỗ người dùng đang phải quyết định lộ mặt hay không, ví dụ ở pre-join: *"Buổi học không được ghi lại."* Khi tính năng ghi hình quay lại ở phase sau, nó phải dựng lại luồng đồng thuận từ đầu — **không được bật lén như một cải tiến**.
- **Chặn hành vi có tiền với tài khoản dưới 18** (`docs/prd.md` US-0.5). Người dưới 18 không bật được "nhận hỏi riêng", không đặt giá, không nhận coin — nhưng vẫn học, vẫn hỏi cả phòng, vẫn trả coin để hỏi người khác. Giao diện **không** hiển thị nút ở trạng thái mờ rồi báo lỗi khi bấm; nút đơn giản là không tồn tại, đúng như luật với người chưa bật nhận hỏi riêng. Tuổi là PII: không bao giờ hiện trên hồ sơ công khai.
- **Báo cáo luôn ở trong tầm với, một bước.** Menu ngữ cảnh trên mọi người, mọi phòng, mọi tin nhắn. Người báo cáo không bao giờ bị lộ danh tính với người bị báo cáo. Với hành vi nhạy cảm — đặt giá hỏi riêng, nhận coin — hệ thống yêu cầu xác minh danh tính nhẹ trước.

## Interaction Primitives

- Bấm để hành động. Không dùng hover làm kênh thông tin duy nhất — spine này phải chuyển được xuống cảm ứng.
- Đổi chế độ khuôn mặt có hiệu lực tức thì, không dialog xác nhận.
- Mọi hành động **tiêu coin** đều cần một bước xác nhận rõ ràng. Mọi hành động **không tiêu coin** đều không được có bước xác nhận thừa.
- Thanh điều khiển không tự ẩn. Không có "chuột không di chuyển thì mờ đi".
- Phím tắt: `M` mic, `V` camera, `F` chế độ khuôn mặt, `Esc` rời phiên hỏi riêng (không rời phòng).
- **Cấm:** carousel, hiệu ứng mở màn, đếm ngược tạo áp lực ngoài đồng hồ coin, thông báo đẩy kiểu kéo-quay-lại, tự động bật camera hoặc mic trong mọi hoàn cảnh.

## Accessibility Floor

Hành vi. Tương phản thị giác nằm ở `DESIGN.md.Colors`.

- **WCAG 2.1 AA là sàn**, không phải mục tiêu. Mọi cặp màu đã kiểm và ghi tỉ lệ trong `DESIGN.md`.
- **Màu không bao giờ là kênh duy nhất** (WCAG 1.4.1). Mạng tốt/yếu, đang nói, đã xác minh, đang tính coin — tất cả đều có chữ hoặc ký hiệu đi kèm. Cặp xanh-lá/đất-nung của StuWith chính là cặp người mù màu đỏ-lục khó phân biệt nhất, và nó đang mang thông tin quan trọng nhất.
- Vùng chạm ≥ 44px, nút ≥ 48px, kể cả trên desktop.
- Đi được toàn bộ bằng bàn phím, kể cả lưới người tham gia và thanh điều khiển. Vòng focus luôn nhìn thấy.
- **`countdown-display` mang `aria-live="off"` — luật cứng.** Đồng hồ đổi mỗi giây; nếu ai đó đặt live region lên nó, trình đọc màn hình sẽ đọc số suốt cả phiên và át luôn giọng người mà người dùng đang trả tiền để nghe. Thông báo chỉ phát ở **các mốc** — phiên bắt đầu, còn 2 phút, còn 1 phút, phiên kết thúc — qua một live region `polite` riêng.
- Các thay đổi khác phát `aria-live` `polite`: đổi bậc mạng, có người vào/ra phòng.
- **Lưới người tham gia là một composite widget** (mẫu `grid` của WAI-ARIA): **một** điểm dừng tab duy nhất, di chuyển giữa các ô bằng phím mũi tên. Không được để mỗi ô là một tab stop — lớp Campus 45–100 người sẽ buộc người dùng bàn phím tab qua tối đa 100 ô mới tới thanh điều khiển. `control-bar` đứng **trước** lưới trong thứ tự tab.
- `face-mode-panel` là `role="radiogroup"` có nhãn nhóm, mỗi lựa chọn `role="radio"` + `aria-checked` — không phải ba nút rời.
- `tile-participant` có nhãn văn bản đầy đủ, **đọc theo đúng thứ tự này**: tên → vai trò → đang nói → trạng thái mic → chế độ khuôn mặt → huy hiệu. Thông tin quan trọng nhất đọc trước.
- Ký hiệu trong `badge-credential` (🎓 ▲ ●) mang `aria-hidden="true"`; nghĩa nằm ở nhãn văn bản ("Huy hiệu học vấn đã xác minh: Thạc sĩ Toán").
- `chat-panel` dùng live region `polite` có gom nhóm, kèm công tắc tắt thông báo chat — **mặc định bật khi audio của người dùng đang tắt**, vì khi đó chat là kênh duy nhất họ theo được lớp.
- Đoạn tiếng Anh nhúng trong câu tiếng Việt ("Study Circle", "Opus", "filter") mang `lang="en"` để trình đọc màn hình tiếng Việt không phát âm sai.
- Tôn trọng `prefers-reduced-motion`: tắt mọi chuyển động trang trí; đồng hồ đếm ngược vẫn cập nhật vì đó là thông tin.
- Chat và audio là hai kênh song song, không thay thế nhau — người khiếm thính dùng chat phải theo được lớp học. *(Phụ đề trực tiếp nằm ngoài MVP — xem Open Questions.)*

## Inspiration & Anti-patterns

Bốn hướng thị giác được dựng đầy đủ và so sánh trực tiếp trên cùng một màn hình (phòng học live, ở cả hai bậc mạng). Ghi lại đây để người sau không vô tình quay về một hướng đã bị loại có lý do.

| Hướng | Tính cách | Kết quả |
|---|---|---|
| **Cắm trại** | Tím sâu, coral, viền ink dày, bóng lệch cứng. Ẩn mặt và huy hiệu như trò chơi | ✅ **Đã chọn.** Lời mời dễ nhận nhất cho người đang ngại; và viền ink dày tự đạt ngưỡng WCAG 1.4.11 cho thành phần giao diện |
| **Sân trường** | Giấy ấm, xanh lá học đường, nút to, chip nền màu | ❌ Loại ở vòng hai. Rất rõ ràng và an toàn cho người non-tech, nhưng thiếu nhận diện — dễ trôi thành "một app học nữa" |
| **Thư viện đêm** | Nền tối trầm, bão hoà thấp, tiêu đề serif | ❌ Loại. Đẹp cho học khuya một mình, nhưng làm phòng đông người trông lạnh và khó tạo kết nối |
| **Bảng điều khiển** | Mật độ cao, góc nhỏ, số liệu monospace | ❌ Loại làm hướng chủ đạo, **nhưng một ý được giữ lại**: chữ số tabular cho mọi con số biến thiên — nay là luật cứng ở `DESIGN.md § Typography` |

**Điều phải tránh, nói rõ:**

- **Không được trông như phần mềm họp hành.** Xám công sở, xanh dương doanh nghiệp, thanh điều khiển tự ẩn khi không di chuột — đây là những thứ StuWith cố ý không làm. Người dùng ở đây ngồi lâu và không di chuột liên tục.
- **Không gamify phần tiền.** Chất vui của Cắm trại dừng lại ở cửa vùng tiền. Huy hiệu, hạng mùa, filter mèo thì vui được; số dư coin, đồng hồ đếm ngược, biên nhận thì không.
- **Không dùng ẩn danh làm điểm bán kiểu ẩn danh mạng xã hội.** Ẩn mặt ở đây phục vụ việc học của người ngại, không phải sự vô danh để làm điều khuất tất — nên nó luôn đi kèm huy hiệu đã xác minh, báo cáo một bước, và chặn hành vi có tiền với tài khoản dưới 18.

## Responsive & Platform

Desktop-first. Ngưỡng breakpoint và hành vi lưới nằm ở `DESIGN.md.Layout & Spacing`. Phần lệch về hành vi:

- **< 900px:** rail phải rời khỏi luồng. Chat thành sheet kéo từ đáy; **thẻ phiên hỏi riêng không được vào sheet** — nó ghim lại thành thanh mỏng luôn hiện ở đáy, vì đó là đồng hồ đang tiêu tiền và không bao giờ được khuất.
- **< 600px:** thanh điều khiển rút còn Mic · Camera · Khuôn mặt · Rời phòng; phần còn lại vào menu "…".
- Lớp Campus (45–100) trên mobile chỉ hiện người đang nói + host; danh sách đầy đủ nằm sau một bề mặt riêng.
- Mọi thứ trong spine này phải diễn đạt lại được trên cảm ứng — đây là điều kiện để "đầu chờ" cho app phone có ý nghĩa.

## Key Flows

### Flow 1 — Trâm vào học lần đầu (23h, phòng trọ, hôm trước ngày thi Giải tích)

**Trâm**, sinh viên năm hai, wifi phòng trọ chập chờn, đang kẹt ở một câu tích phân từng phần.

1. Mở stuwith.app → màn Đăng nhập, 4 nút provider, không có form mật khẩu nào để nghĩ. Chọn Google.
2. Vào thẳng Khám phá. Ô lớn nhất trên màn không phải thanh tìm kiếm mà là ô nguyện vọng: *"Bạn đang muốn học gì?"*
3. Gõ "tích phân từng phần, mai thi". Hệ thống embedding và trả các lớp khớp nhất, cao nhất lên đầu, mỗi lớp hiện host + huy hiệu học vấn đã xác minh.
4. Chọn "Ôn Giải tích 1 — Tích phân từng phần" của Minh Anh, 🎓 Thạc sĩ Toán.
5. **Pre-join.** Camera bật ở chế độ xem trước — chỉ Trâm thấy. Ba lựa chọn ngang hàng: Để nguyên · Ẩn mặt · Filter. Thử mic, thấy vạch nhảy.
6. **Cao trào nhỏ:** Trâm nhìn khuôn mặt mình lúc 11 giờ đêm, chưa gội đầu, và bấm **Ẩn mặt**. Ô xem trước lập tức thành avatar chữ "TR". Không ai từng thấy khuôn mặt đó.
7. Bấm "Vào phòng". Vào trong dưới 5 giây. Lưới 6 người, một nửa cũng là avatar.

*Điều luồng này phải chứng minh:* quyết định lộ mặt xảy ra **trước** khi có bất kỳ ai nhìn thấy, và nó dễ như bấm một nút.

### Flow 2 — Trâm bấm "hỏi riêng" lần đầu

Trâm nghe Minh Anh giảng 20 phút, vẫn vướng đúng chỗ của mình, mà cả phòng đang bàn câu khác.

1. Trâm nhìn ô của Minh Anh: dưới tên có 🎓 Thạc sĩ Toán, góc trên có chip `{colors.coin}` ghi **120 coin/phút**. Chip đó chỉ tồn tại vì Minh Anh đã bật nhận hỏi riêng.
2. Bấm vào ô → hồ sơ rút gọn: hạng uy tín mùa, huy hiệu học vấn, badge kỹ năng, và nút "Hỏi riêng · 120 coin/phút".
3. Bấm → **thẻ xác nhận**, vùng giọng chính xác. Trên thẻ: đơn giá 120 coin/phút · block 1 phút · số dư 1.000.000 · *"Với số dư hiện tại bạn có khoảng 8.333 phút."* · và một dòng in rõ: *"Nếu mạng yếu, video sẽ tắt nhưng phiên vẫn tính coin vì tiếng vẫn thông. Phiên chỉ dừng khi mất hẳn kết nối."*
4. **Cao trào.** Trâm bấm "Bắt đầu". Đồng hồ hiện lên và bắt đầu chạy — chữ số vàng, tabular, không giật. Đây là khoảnh khắc quyết định cả sản phẩm: nếu Trâm cảm thấy bị đồng hồ đuổi, cô sẽ hỏi vội và không quay lại. Vì thế đồng hồ đếm **thời gian còn lại**, không đếm **tiền đã tiêu**, và câu dưới nó giải thích con số đến từ đâu.
5. Kênh 1-1 mở, tách biệt — người trong phòng không nghe được. Trâm hỏi xong trong 4 phút, bấm dừng.
6. Thẻ tổng kết ngay tại chỗ: *"Phiên đã dừng lúc 23:14. Đã trừ 480 coin. Số dư còn 999.520."* Thẻ này cũng xuất hiện trong Ví coin, đọc lại được mãi.

*Điều luồng này phải chứng minh:* không có một đồng coin nào rời ví trong sự bất ngờ, và luật khó chịu nhất (mất mạng vẫn tính tiền) được nói ra **trước**, không phải sau.

### Flow 3 — Mạng sập giữa phiên hỏi riêng

Cùng buổi đó, phút thứ hai, wifi phòng trọ tụt.

1. Video của Minh Anh giảm độ nét — Trâm không được báo gì (bậc 2). Đồng hồ chạy tiếp.
2. Băng thông tụt tiếp. Video **tắt hẳn**, ô thành avatar "MA". Banner một dòng màu đất nung: *"Mạng yếu — đã tắt video để giữ tiếng. Âm thanh vẫn thông suốt."* Chip đổi thành `warn` "Mạng yếu". Giọng Minh Anh không hề gián đoạn.
3. **Đồng hồ vẫn chạy** — và điều này không gây sốc, vì Trâm đã đọc đúng câu đó trên thẻ xác nhận ở bước 3 của Flow 2. Thẻ phiên vẫn ghim ở đáy màn hình, không bị banner đẩy đi.
4. Wifi hồi phục. Chip về `ok` trong im lặng. Camera **không** tự bật lại — thay vào đó nút "Bật lại camera" xuất hiện. Trâm đang ẩn mặt; hệ thống không có quyền quyết định thay cô.
5. Giả sử tệ hơn: mất hẳn cả tiếng (bậc 4). Banner "Mất kết nối — đang thử lại", đồng hồ **dừng**, phiên chỉ tính đến block cuối đã dùng. Thử kết nối lại 30 giây; nếu thất bại, thẻ tổng kết hiện với đúng số coin đã trừ.

*Điều luồng này phải chứng minh:* suy giảm mạng trông như một chuyện bình thường của việc học ở phòng trọ, không như một sự cố phần mềm — và tiền vẫn minh bạch xuyên suốt.

### Flow 4 — Khánh mở phòng và đặt giá lần đầu

**Khánh**, kỹ sư đi làm, tối rảnh muốn dạy thêm và xây uy tín.

1. Khám phá → Tạo phòng. Điền tên, mô tả, chủ đề. Mô tả được nhắc là *sẽ dùng cho AI match*, nên viết kỹ có lợi.
2. Chọn công khai/riêng và thấy trần người theo gói hiện tại: Study Buddy 6 người. Có lối nâng lên Study Circle 25 ngay tại đây, không phải đi tìm.
3. Bật **"Nhận hỏi riêng"**. Ô nhập giá hiện kèm khung ngay bên cạnh: *"10–500 coin/phút — khung giới hạn để tránh đặt giá lừa đảo."* Khánh đặt 120.
4. Vì đặt giá và nhận coin là hành vi nhạy cảm, hệ thống yêu cầu **xác minh danh tính nhẹ** trước khi bật. Khánh làm xong; huy hiệu học vấn Kỹ sư của anh cũng chuyển sang trạng thái đã xác minh và bắt đầu hiện trên ô của anh.
5. Vào phòng. Người vào dần. Trâm bấm Hỏi riêng, phiên bắt đầu. Vài phút sau, **Khang xin tham gia** — một dải mỏng hiện trong panel phiên của Khánh: *"Khang xin tham gia phiên này."* Không âm thanh, không che màn hình, Khánh vẫn đang giảng.
6. Trâm cũng nhận được lời xin, nhưng câu của cô khác: *"Khang xin tham gia. Nếu bạn đồng ý, Khang sẽ thấy bạn đang ở đây."* Trâm đang ẩn mặt — đây là lúc cô quyết định có lộ diện hay không, chứ không phải hệ quả phụ của việc Khánh bấm đồng ý.
7. **Cao trào thứ hai của Khánh:** cả hai đồng ý. Khang vào, và đồng hồ của Khánh nhảy từ 120 lên **240 coin/phút** — vì mỗi người hỏi trả đủ giá. Đây là lần đầu Khánh thấy thu nhập của mình nhân lên mà không phải dạy thêm giờ; nó cũng là lúc anh hiểu vì sao trần phiên là 3 người.
8. Nếu Trâm hết coin trước, cô rời phiên và Khánh học tiếp với Khang — không ai bị cắt ngang vì lý do của người khác.

*Điều luồng này phải chứng minh:* mọi cơ chế có rủi ro lạm dụng (đặt giá, cho người lạ vào phiên) đều đi kèm một cửa chặn ngay tại điểm bật, không phải một điều khoản chôn trong cài đặt — và người đang trả tiền luôn có phiếu ngang với người đang được trả.

### Flow 5 — Trâm nạp coin giữa phiên *(US-4.2)*

Ba tuần sau. Trâm đã tiêu gần hết số coin cấp ban đầu, và đang giữa một phiên hỏi riêng thì đồng hồ chuyển màu.

1. Đồng hồ còn **01:40**, đổi sang `{colors.warn}`, kèm dòng chữ "Còn dưới 2 phút. Phiên sẽ tự dừng khi hết coin." Một live region phát đúng **một** lần ở mốc này — không đọc lặp.
2. Ngay trong thẻ phiên có nút "Nạp thêm coin". Bấm → mở ở lớp trên, **phiên không bị ngắt**, đồng hồ vẫn chạy và vẫn nhìn thấy.
3. Chọn gói. Bề mặt tiền, giọng chính xác: giá tiền, số coin nhận được, không có chữ "chỉ", không có emoji.
4. Chuyển sang cổng thanh toán ngoài. **Cao trào:** Trâm quay lại app và không biết chuyện gì đã xảy ra — đã trừ tiền chưa, đã có coin chưa. Đây là khoảnh khắc mất niềm tin nhanh nhất trong cả sản phẩm.
5. Màn quay lại **không bao giờ để trống hay quay vòng vô định**. Ba trạng thái, mỗi trạng thái nói rõ tiền đang ở đâu:
   - *Thành công:* "Đã nhận 500.000 coin lúc 21:37. Số dư: 512.400." + biên nhận đọc lại được trong Ví coin.
   - *Đang xử lý:* "Giao dịch đang được xác nhận. Chưa trừ coin nào của bạn. Bạn sẽ thấy kết quả trong Ví coin." — kèm mã tham chiếu.
   - *Thất bại/timeout:* "Chưa trừ tiền của bạn. Giao dịch không hoàn tất lúc 21:37." Idempotency key bảo đảm không cấp coin trùng nếu Trâm bấm lại.
6. Phiên hỏi riêng vẫn đang chạy suốt quá trình đó. Nếu coin về kịp, đồng hồ tự cộng thêm thời gian và đổi lại màu thường — **không** cần Trâm bấm gì.
7. Nếu không kịp, phiên dừng ở ranh giới block với thẻ tổng kết bình thường. Số dư không âm.

*Điều luồng này phải chứng minh:* ở mọi thời điểm, kể cả lúc quay về từ một hệ thống bên ngoài, người dùng luôn đọc được một câu nói rõ tiền của họ đang ở đâu.

## Open Questions

- ✅ ~~Phiên hỏi riêng ba người~~ — **đã giải quyết 20/08/2026.** PRD đã cập nhật (US-2.3 AC5–AC7 + US-2.4 mới), ba luật tiền đã chốt, spine đã đồng bộ. Không còn mâu thuẫn.
- ✅ ~~Chặn theo tuổi~~ — **đã giải quyết 20/08/2026** → `docs/prd.md` US-0.5. Xem `§ Ẩn danh, riêng tư & báo cáo`.
- 🟡 **Ghi hình đã bị gỡ khỏi MVP** (20/08/2026). Hệ quả cho UX: không còn bề mặt Ghi hình, không còn `dialog-consent`. Khi tính năng quay lại ở phase sau, luồng đồng thuận phải được thiết kế lại từ đầu — spine cũ không còn giữ nó nữa.
- 🔴 **Giao diện moderator bị hoãn có chủ đích — rủi ro đã được chấp nhận.** `docs/prd.md` §2 liệt kê `moderator` và `system_admin` là vai trò hệ thống, và US-3.4 AC2 yêu cầu "moderator xử lý; block/ban". Spine này **cố ý không** đặc tả bề mặt nào cho họ: quyết định của chủ dự án ngày 19/08/2026 là xử lý thủ công qua công cụ admin/DB trong MVP, làm giao diện ở sprint sau. Hệ quả cần theo dõi: sản phẩm bán chính tính năng ẩn danh mà cơ chế đối trọng chưa có giao diện — thời gian phản hồi một báo cáo phụ thuộc hoàn toàn vào thao tác tay. Luồng **gửi** báo cáo của người dùng thì vẫn được đặc tả đầy đủ ở `§ Ẩn danh, riêng tư & báo cáo`.
- **Phụ đề trực tiếp / speech-to-text** cho người khiếm thính: hiện chat là kênh song song duy nhất. Nằm ngoài MVP nhưng ảnh hưởng ngưỡng tiếp cận thật — cần quyết ở sprint nào.
- **Chặn theo tuổi:** brief nêu rủi ro trẻ vị thành niên + ẩn mặt + hỏi riêng, nhưng chưa có luồng. Cần một bề mặt hoặc một cửa chặn.
- **Tên gọi coin trong giao diện** khi tính năng quy đổi còn treo pháp lý — dùng thẳng "coin" hay một tên trung tính hơn?
- **Be Vietnam Pro** là đề xuất dựa trên chất lượng dấu tiếng Việt, chưa được bạn duyệt. Nếu đổi font, mọi thang chữ trong `DESIGN.md` phải kiểm lại ở cỡ `meta` 12.5px.
- **Ngưỡng chuyển sang lưới dày** cho Campus 45–100 chưa có con số cụ thể — cần đo trên thiết bị thật.
