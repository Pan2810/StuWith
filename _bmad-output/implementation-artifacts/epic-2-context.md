# Epic 2 Context: Học cùng người khác trong phòng live, ẩn mặt được

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 2 dựng phòng học live: người dùng tạo hoặc tìm một phòng, vào học cùng người lạ, và **quyết định mình hiện lên thế nào trước khi bất kỳ ai nhìn thấy**. Đây là epic tự chứng minh luận điểm sản phẩm — tách *sự hiện diện* khỏi *danh tính* — nên sau nó đo được ngay tỉ lệ phiên ẩn mặt, chỉ số quan trọng nhất của MVP. Epic cũng gánh phần "buổi học không gãy khi mạng yếu", vì nhóm người dùng mục tiêu học đêm khuya trên wifi phòng trọ. Story i18n đứng **đầu** epic chứ không cuối: chi phí thật nằm ở việc rút chuỗi ra khỏi component, và tám story phòng live sau nó sẽ nhân đôi lượng chuỗi phải rút nếu làm ngược lại.

## Stories

- Story 2.0: Rút chuỗi ra i18n — VI mặc định, EN song song
- Story 2.1: Tạo phòng học với chủ đề và quyền
- Story 2.2: Cấp token vào phòng kèm giữ chỗ nguyên tử
- Story 2.3: Màn pre-join — xem trước, chọn khuôn mặt, thử mic
- Story 2.4: Vào phòng và nghe thấy nhau
- Story 2.5: Thang suy giảm mạng bốn bậc
- Story 2.6: Lưới người tham gia đi được bằng bàn phím
- Story 2.7: Ba chế độ khuôn mặt xử lý client-side
- Story 2.8: Chat cả phòng với lọc nội dung và report

## Requirements & Constraints

- **Audio là ưu tiên tuyệt đối.** Video được phép tụt bậc rồi tắt hẳn; tiếng không bao giờ được rớt. Opus có DTX và RED. Vào phòng đo bằng **p90 dưới 5 giây trên 4G phổ thông**, tính tới lúc nghe được tiếng đầu tiên.
- **Pre-join bắt buộc, không bỏ qua được bằng bất kỳ đường nào.** Không ai được rơi thẳng vào phòng với camera đang bật mà chưa kịp quyết định lộ mặt hay không.
- **Khuôn mặt ở chế độ ẩn hoặc filter không rời máy người dùng.** Không endpoint nào nhận ảnh khuôn mặt; server và LiveKit không bao giờ nhận khung hình gốc.
- **Hệ thống không bao giờ tự đảo ngược quyết định ẩn mặt.** Mạng hồi phục, đổi phòng, tự hạ bậc hiệu năng — không sự kiện nào được đưa người dùng về Để nguyên. Camera chỉ bật lại khi họ tự bấm.
- **Trần người theo gói** (Study Buddy 6 / Study Circle 25 / Campus 45–100) cưỡng chế thật ở server, không phải bằng cách ẩn nút.
- **MVP không ghi hình và không lưu tệp nhị phân nào.** Epic này dựng media thật và LiveKit bật recording được bằng cấu hình, nên hai mệnh đề đó cần một thứ *chặn* chứ không chỉ "chưa ai bật" — hiện chưa story nào chính thức nhận.
- **i18n VI mặc định + EN song song, không chuỗi cứng kể cả trong thông báo lỗi.** Thiếu bản dịch một chiều là lỗi build, không phải rơi về khoá thô; `<html lang>` phải động; chuỗi VI dài hơn EN 15–25% nên nhãn không được cắt chữ.
- **WCAG 2.1 AA là sàn** cho mọi màn hình, gồm reflow ở tương đương 320px.
- Chat cả phòng miễn phí, realtime, có rate limit; tin bị lọc phải **hiện lý do cho người gửi**; mọi tin report được trong một bước.

## Technical Decisions

- **LiveKit là mặt phẳng media, hai process của ta là mặt phẳng nghiệp vụ.** Client nối thẳng LiveKit bằng SDK, nhưng mọi thứ có tiền, quyền hoặc phải ghi audit đi qua `apps/api` / `apps/realtime-gateway`. Cấm dùng LiveKit data channel làm đường truyền cho sự kiện có hệ quả.
- **Token vào phòng là điểm chốt quyền duy nhất.** JWT ngắn hạn, riêng cho một lần vào một phòng cụ thể, cấp sau khi kiểm bốn điều kiện ở một chỗ: đã đăng nhập · không bị ban · đủ tuổi · còn chỗ theo trần. Không có credential tĩnh phía client. `apps/api` cấp token phòng học vì nó sở hữu `rooms`.
- **Một phép kiểm chỉ đọc là gợi ý, không phải cổng.** Bên cấp token phải **giữ chỗ trong cùng thao tác nguyên tử** với phép kiểm — một `INSERT` có điều kiện đếm vào `room_reservations`, thất bại thì không có token. Kiểm trần bằng cách đọc `room_participants` là sai: bảng đó do gateway ghi theo tín hiệu LiveKit nên trễ vài giây.
- **Chủ ghi chia dứt khoát, cưỡng chế bằng quyền DB chứ không bằng lời văn.** `rooms` và `room_reservations` (kể cả dọn hết hạn) thuộc `apps/api`; `room_participants` và tin nhắn chat thuộc `apps/realtime-gateway`; bên còn lại chỉ đọc.
- **Không tồn tại đường xoá cứng một phòng.** Phòng có trạng thái tường minh gồm `closing`; giao thức đóng phòng đầy đủ thuộc epic sau, epic này chỉ có nghĩa vụ không mở cửa hậu.
- **Ranh giới WebSocket xác thực ngay khi bắt tay** bằng chính session của `apps/api`, xác thực lại khi phiên bị thu hồi, và rate limit theo **cả IP lẫn user**. Vượt ngưỡng trả đếm ngược, không trả lỗi kỹ thuật.
- ⚠️ **Chiều "theo user" của rate limit hiện có là cơ chế đã hỏng.** Mã đã ship băm cookie đang trình chứ không khoá theo tài khoản, và reset được bằng một lần gia hạn phiên. Story bắt tay WebSocket sẽ thừa hưởng đúng cơ chế đó nếu không sửa trước — đây là việc phải làm, không phải nền có sẵn.
- **Ẩn mặt không dùng ML, và đó là ràng buộc chứ không phải tối ưu.** Ẩn mặt = ngừng publish video track + hiện avatar chữ cái. Bậc lùi cuối của thang hạ chất lượng chính là Ẩn mặt, nên nó không được phụ thuộc vào thứ đang hỏng. `@mediapipe/tasks-vision@1.0.1` chỉ dùng cho Filter, model **tự host** từ origin của ta — một request tới CDN nhà cung cấp trong lúc bật filter là bằng chứng ngược cho chính lời hứa riêng tư.
- **Track publish lên LiveKit luôn là track đã qua pipeline xử lý, kể cả ở chế độ Để nguyên.** Gắn processor *sau* khi publish để lại một cửa sổ mà khung hình gốc đã rời máy; đóng bằng cấu trúc, không bằng canh giờ.
- Story nào chạm đường trình duyệt → LiveKit → server phải khai **probe ở tầng trình duyệt**; unit test trên hàm xử lý khung hình không chứng minh được các AC riêng tư này.
- Ngưỡng filter đo trên máy tham chiếu 4 nhân / 8 GB / không GPU rời, tối thiểu 20 FPS; dưới ngưỡng thì hạ một bậc rồi rơi về Ẩn mặt, kèm lý do cho người dùng.

## UX & Interaction Patterns

- **Thang suy giảm mạng bốn bậc là trạng thái vận hành trung tâm, không phải nhánh lỗi.** Bậc 2 tụt lặng lẽ; bậc 3 tắt video thay bằng avatar kèm banner một dòng; bậc 4 đóng băng lưới và thử lại 30 giây. Lên bậc thì im lặng, chip có hoãn để không nhấp nháy. **Mọi màn hình có người-trong-phòng phải được thiết kế ở cả bậc 1 và bậc 3.**
- **Màu không bao giờ là kênh duy nhất.** Cặp xanh-lá / đất-nung của hệ "Cắm trại" đúng là cặp khó nhất với người mù màu đỏ-lục, mà nó đang mang thông tin quan trọng nhất — trạng thái mạng, đang nói, mic tắt đều phải kèm chữ.
- **Lưới người tham gia là một composite widget:** một điểm dừng tab duy nhất, di chuyển bằng phím mũi tên; thanh điều khiển đứng **trước** lưới trong thứ tự tab, và **không bao giờ tự ẩn** — người học không di chuột liên tục.
- Ba chế độ khuôn mặt là một nhóm chọn-một có nhãn nhóm, không phải ba nút rời; đổi tức thì, không dialog xác nhận, có ô xem trước chính mình.
- Người dùng **không bao giờ bị kẹt ở pre-join**: thiết bị bị chặn thì hiện hướng dẫn theo đúng trình duyệt kèm lối thoát "vào phòng chỉ để nghe". Pre-join cũng là chỗ nói thẳng buổi học không được ghi lại — đó là nơi người dùng đang phải quyết định lộ mặt.
- Chat dùng live region lịch sự **có gom nhóm**, kèm công tắc tắt thông báo mặc định **bật khi audio của người dùng đang tắt**, vì khi đó chat là kênh duy nhất họ theo được lớp.
- Khoá component dùng chung giữa hai spine UX — ghép hai tài liệu bằng khoá kebab-case, không bằng nhãn tiếng Việt. Tầng token đã đủ từ Epic 1; epic này chỉ thêm class, không thêm giá trị token. Dưới 900px rail thành sheet đáy; dưới 600px thanh điều khiển rút còn bốn nút chính.

## Cross-Story Dependencies

- **Story i18n phải xong trước mọi story có giao diện**, nếu không tám story sau đẻ thêm literal phải rút lần hai.
- Cấp token và giữ chỗ nguyên tử là tiền đề của pre-join và của vào phòng; trần gói lưu cùng phòng lúc tạo, không tính lại mỗi lần có người vào.
- Ba chế độ khuôn mặt trải qua hai story: Ẩn mặt bằng avatar phải hoạt động đầy đủ ngay ở pre-join, Filter và thang tự hạ bậc đến sau. Thang suy giảm mạng và thang hạ bậc filter cùng kết thúc ở Ẩn mặt, nên hai story đó chia chung một bậc lùi.
- Kế thừa từ Epic 1: seam phiên hết hạn gọi refresh thừa và mở dialog sai khi người dùng chủ động đăng xuất trong phòng; khôi phục focus sau dialog chưa có chiến lược và cần một màn hình dài thật để đo. Cả hai lộ ra lần đầu ở epic này.
- `apps/realtime-gateway` hôm nay chưa có WebSocket, chưa có auth, chưa có kết nối DB — epic này dựng chúng lần đầu, gồm cả hàng audit cấp token đã khai tên từ Epic 1 mà chưa có mã nào ghi.
- WAF và chống DDoS ở edge **không thuộc epic này** và không thuộc story nào — chúng ở track vận hành cùng chỗ với coturn TLS. Đừng cố dựng chúng bằng code trong một story phòng học.
