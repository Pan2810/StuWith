# Spine Pair Review — StuWith

## Overall verdict

Cặp spine phủ được phần lõi và cam kết đúng những chỗ khó — luật tiền, thang suy giảm mạng, đồng thuận ghi hình đều đã được quyết chứ không để mở. Nhưng nó **chưa dùng được như một hợp đồng máy đọc**: tên component trong `DESIGN.md` và `EXPERIENCE.md` không khớp nhau, và cặp token light/dark tồn tại mà không có luật ánh xạ, nên consumer phía dưới sẽ phải đoán.

Lỗ hổng thật về nội dung nằm ở phần an toàn: `moderator` là một vai trò trong PRD nhưng **không có bề mặt nào** trong IA, và không có Key Flow nào cho báo cáo/xử lý — với một sản phẩm bán chính tính năng ẩn danh, đó là mảng rủi ro cao nhất lại được đặc tả mỏng nhất.

## 1. Flow coverage — thin

Đối chiếu 15 US trong `docs/prd.md` với 4 Key Flow. Có flow: US-0.1, 1.1, 1.2, 1.3, 2.1, 2.3, 3.1, 3.3 (một phần), 4.1 (một phần), 4.3.

### Findings
- **high** Không có Key Flow cho báo cáo & xử lý vi phạm (US-3.4); vai trò `moderator` và `system_admin` trong PRD §2 **không có bề mặt nào** trong `EXPERIENCE.md § Information Architecture`. *Fix:* thêm bề mặt "Hàng đợi kiểm duyệt" vào IA và một Key Flow thứ 5 với nhân vật là moderator, đi từ báo cáo tới block/ban và audit log.
- **high** Không có Key Flow cho nạp coin (US-4.2), chỉ có một dòng trạng thái lỗi. Đây là luồng có tiền thật đi qua cổng thanh toán. *Fix:* thêm flow "Trâm nạp coin giữa phiên", cao trào là lúc quay lại từ cổng thanh toán mà chưa rõ đã trừ tiền hay chưa.
- **medium** Hạng uy tín theo mùa (US-3.2) chỉ xuất hiện dạng huy hiệu tĩnh. Không có gì mô tả điểm nỗ lực tăng thế nào, người dùng thấy nó tăng ở đâu, hay chuyện gì xảy ra lúc reset mùa. *Fix:* một mục trong State Patterns, hoặc thu hẹp phạm vi và ghi rõ là ngoài vòng này.
- **low** Chat cả phòng (US-1.4) chỉ có dòng trong Component Patterns, không xuất hiện trong flow nào. Chấp nhận được vì nó là nền, không phải đích đến.

## 2. Token completeness — adequate

Mọi tham chiếu `{path.to.token}` trong cả hai file đều resolve. Màu có đủ hex, có cặp light/dark, và tương phản đã ghi số cho 7 cặp chịu lực.

### Findings
- **critical** Khối `components` trong frontmatter chỉ trỏ tới token light (`background: '{colors.primary}'`). Không có chỗ nào ghi luật "ở dark mode, `X` đọc thành `X-dark`". Consumer sinh code sẽ hoặc hardcode light, hoặc tự bịa quy ước. *Fix:* thêm một câu luật ánh xạ ngay đầu mục Colors: mọi token có hậu tố `-dark` là biến thể dark của token cùng tên; component tự động phân giải theo chế độ.
- **medium** Không có token chuyển động (duration, easing) dù `EXPERIENCE.md § Accessibility Floor` có luật `prefers-reduced-motion` và Component Patterns có "hoãn 3 giây" cho chip mạng. *Fix:* thêm nhóm `motion` với ít nhất `duration.fast/base/slow` và `network-chip-debounce: 3000ms`.
- **low** `danger` / `danger-container` được định nghĩa nhưng chỉ xuất hiện trong một dòng "Không làm". `surface-elevated-dark` không có cặp light. *Fix:* hoặc dùng chúng trong một component, hoặc ghi rõ chúng dành cho trạng thái nào.
- **low** `tile-video` / `tile-avatar-bg` dùng nhiều trong mockup nhưng không nằm trong component spec nào. *Fix:* đưa vào `components.tile-participant`.

## 3. Component coverage — broken

### Findings
- **critical** Tên component **không khớp giữa hai file**. `DESIGN.md.Components` dùng kebab-case tiếng Anh (`tile-participant`, `card-coin`, `countdown-display`); `EXPERIENCE.md § Component Patterns` dùng tên tiếng Việt ("Ô người tham gia", "Thẻ xác nhận hỏi riêng", "Đồng hồ phiên"). Không có bảng nối. Consumer không ghép được đặc tả thị giác với đặc tả hành vi. *Fix:* chọn kebab-case tiếng Anh làm khoá máy đọc ở cả hai file, tên tiếng Việt đi kèm trong ngoặc làm nhãn người đọc.
- **high** Bốn component có luật hành vi nhưng **không có đặc tả thị giác**: thanh điều khiển phòng, bảng chế độ khuôn mặt, thẻ giao dịch, chat cả phòng. *Fix:* thêm bốn dòng vào `DESIGN.md.Components`.
- **medium** `button-secondary` và `snackbar` có đặc tả thị giác nhưng không có dòng hành vi nào trong `EXPERIENCE.md`. `snackbar` đặc biệt cần, vì spine đã cấm nó ở vùng tiền. *Fix:* thêm hai dòng vào Component Patterns.

## 4. State coverage — thin

Đi qua 16 bề mặt trong IA. Phủ tốt: Khám phá, phòng live, phiên hỏi riêng, nạp coin (lỗi), hồ sơ, báo cáo, focus.

### Findings
- **high** Màn Đăng nhập không có state nào trong `§ State Patterns`, dù `docs/prd.md` US-0.1 **AC4 yêu cầu tường minh** thông báo lỗi thân thiện không lộ chi tiết kỹ thuật. Voice & Tone có một dòng ví dụ nhưng đó không phải đặc tả trạng thái. *Fix:* thêm hàng cho đăng nhập thất bại, provider từ chối, và phiên hết hạn giữa buổi học.
- **high** Pre-join thiếu trạng thái **trình duyệt chặn camera/mic**. Đây là màn duy nhất xin quyền thiết bị, và nếu người dùng lỡ bấm "Chặn" thì toàn bộ luồng đứng. *Fix:* thêm hàng permission-denied với hướng dẫn mở lại quyền, và cho phép vào phòng chỉ nghe.
- **medium** Tạo phòng không có state validation (tên trùng, mô tả rỗng, chọn trần vượt gói). *Fix:* thêm hàng.
- **medium** Ghi hình không có trạng thái "sắp hết hạn 30 ngày" dù retention là cam kết hiển thị. *Fix:* thêm hàng.
- **low** Gói dịch vụ: chuyện gì xảy ra khi hạ gói mà phòng đang có nhiều người hơn trần mới. *Fix:* thêm hàng hoặc đẩy về PRD.

## 5. Visual reference coverage — strong

Bốn mockup trong `mockups/`, đều được link inline ở đúng mục trong cả hai spine và có mô tả cái gì được minh hoạ. Bốn hướng thiết kế đã loại nằm ở `.working/`, được nêu tên. Câu "spine thắng khi xung đột" xuất hiện ở cả hai file. `imports/` rỗng, không có orphan.

### Findings
- **low** `mockups/phong-hoc-live.html` là bản sao y hệt `.working/theme-san-truong-light-dark.html`. Hai bản sẽ trôi khỏi nhau. *Fix:* xoá bản trong `.working/` hoặc ghi rõ bản trong `mockups/` là bản chuẩn.

## 6. Bloat & overspecification — adequate

`DESIGN.md` mang giọng biên tập, đúng như spec cho phép. `EXPERIENCE.md` chủ yếu là luật và bảng.

### Findings
- **low** Các dòng "*Điều luồng này phải chứng minh:*" cuối mỗi Key Flow là lý lẽ chứ không phải luật. Chúng có ích cho người đọc nhưng không có consumer máy nào dùng. *Fix:* giữ lại, nhưng đừng thêm kiểu này ở chỗ khác.
- **low** Bảng IA lặp lại một phần phạm vi từ PRD. Trong ngưỡng chấp nhận vì cột "Vào từ" là thông tin mới.

## 7. Inheritance discipline — adequate

`sources:` trỏ `docs/prd.md` và `docs/brief.md`, cả hai đều tồn tại. Từ vựng ("hỏi riêng", "coin", "uy tín", "huy hiệu", "ẩn mặt") nhất quán giữa hai spine và nguồn.

### Findings
- **medium** Không có mã US nào (`US-1.3`, `US-2.3`…) xuất hiện trong hai spine. `bmad-create-epics-and-stories` chạy sau sẽ không nối được story với luật UX tương ứng. *Fix:* gắn mã US vào cột nguồn của bảng IA và vào tiêu đề mỗi Key Flow.
- **low** Tên gói không nhất quán: brief dùng "Study Buddy / Study Circle / Campus", `EXPERIENCE.md` dùng "Buddy / Circle / Campus", mockup dùng "Study Circle". *Fix:* chốt một dạng và dùng nguyên văn ở mọi nơi.

## 8. Shape fit — adequate

`DESIGN.md` đủ 8 mục theo đúng thứ tự chuẩn. `EXPERIENCE.md` có đủ 8 mục mặc định bắt buộc, cộng Responsive & Platform (đúng trigger vì có breakpoint). Ba mục tự đặt — Thang suy giảm mạng, Luật coin & tiền, Ẩn danh/đồng thuận/báo cáo — đều xứng đáng: mỗi mục gom một nhóm luật mà các mục chuẩn sẽ làm vỡ vụn.

### Findings
- **medium** Thiếu **Inspiration & Anti-patterns** dù đã bị kích hoạt: `.memlog.md` ghi bốn hướng thiết kế được cân nhắc và ba bị loại, và trong hội thoại có nêu rõ điều cần tránh ("không giống app họp hành"). *Fix:* thêm mục, ghi ba hướng bị loại và lý do — nó ngăn người sau vô tình quay lại hướng đã bỏ.

## Mechanical notes

- Cả hai file vẫn ở `status: draft` — cần chuyển `final` sau khi xử lý findings.
- `EXPERIENCE.md` dùng chuỗi giữ chỗ `{gói}` trong bảng State Patterns; trông giống cú pháp tham chiếu token `{path.to.token}` nhưng không phải. Đổi sang dạng khác để tránh nhầm khi parse.
- `DESIGN.md` frontmatter: `font-family-base` nằm trong `typography` nhưng là chuỗi phẳng, không phải object có `fontFamily` như các entry khác. Không sai spec nhưng lệch hình dạng với các key anh em.
- Không có Mermaid trong hai file, không có lỗi cú pháp cross-ref.
- Đường dẫn `sources` là repo-relative (`docs/prd.md`), trong khi `planning_artifacts` cấu hình là `_bmad-output/planning-artifacts`. Đúng thực tế nhưng nên ghi chú, vì mọi skill sau sẽ tìm ở `planning_artifacts` trước.
