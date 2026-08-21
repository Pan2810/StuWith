# Accessibility Review — StuWith

Lệ kiểm tiếp cận, chạy vì sản phẩm ở mức **Consumer**, có giao dịch tiền và có ghi hình người dùng. Soi `DESIGN.md § Colors`, `EXPERIENCE.md § Accessibility Floor`, `§ State Patterns`, `§ Interaction Primitives`, và bốn mockup trong `mockups/`.

## Preamble

Phần màu sắc là điểm mạnh thật sự: bảy cặp chịu lực đều có tỉ lệ tính sẵn, thấp nhất 4.73:1, và luật "màu không bao giờ là kênh duy nhất" được viết ra kèm đúng lý do (cặp xanh-lá/đất-nung là cặp khó nhất với người mù màu đỏ-lục, mà lại đang mang thông tin quan trọng nhất). Hiếm khi thấy một spine cam kết đến mức đó.

Phần yếu nằm ở **ngữ nghĩa động**: một phòng video có 6–100 ô, một đồng hồ đếm ngược từng giây, và một danh sách chat realtime là ba thứ dễ biến trình đọc màn hình thành cực hình. Spine hiện chỉ nói "phát `aria-live` khi đổi trạng thái quan trọng" — chưa đủ để ngăn thảm hoạ.

## Findings

- **high** Đồng hồ đếm ngược có nguy cơ đọc lặp mỗi giây. `§ Accessibility Floor` liệt kê "ngưỡng còn 2 phút coin" vào nhóm phát `aria-live`, nhưng không có câu nào **cấm** đặt live region lên bản thân đồng hồ. Nếu lập trình viên đặt `aria-live="polite"` lên `countdown-display`, trình đọc màn hình sẽ đọc số mỗi giây suốt cả phiên và người dùng không nghe được gì khác — kể cả giọng gia sư họ đang trả tiền để nghe. *Fix:* ghi luật cứng: `countdown-display` mang `aria-live="off"`; thông báo chỉ phát ở các mốc (bắt đầu, còn 2 phút, còn 1 phút, kết thúc) qua một live region riêng.

- **high** Thứ tự tab trong lưới người tham gia không được đặc tả. Với lớp Campus 45–100 người, người dùng bàn phím phải tab qua tối đa 100 ô để tới thanh điều khiển. `DESIGN.md § Layout & Spacing` có giới hạn "không quá 12 ô cùng lúc trên desktop" — nhưng đó là luật thị giác, không phải luật focus. *Fix:* lưới là một composite widget: một điểm dừng tab duy nhất, di chuyển trong lưới bằng phím mũi tên (mẫu grid của WAI-ARIA). Thanh điều khiển đứng trước lưới trong thứ tự tab.

- **medium** Nhóm ba chế độ khuôn mặt không có ngữ nghĩa nhóm. Trong `mockups/pre-join.html` chúng là ba nút, trạng thái chọn thể hiện bằng viền và màu. Trình đọc màn hình sẽ đọc ba nút rời rạc, không biết đây là chọn-một và không biết cái nào đang chọn. *Fix:* `role="radiogroup"` với nhãn nhóm ("Chế độ khuôn mặt"), mỗi lựa chọn `role="radio"` + `aria-checked`.

- **medium** Emoji đang gánh nghĩa trong huy hiệu. `DESIGN.md.Components.badge-credential` phân biệt ba loại bằng 🎓 / ▲ / ●. Có chữ đi kèm nên không vi phạm 1.4.1, nhưng trình đọc màn hình sẽ đọc "biểu tượng mũ tốt nghiệp Thạc sĩ Toán" và "hình tam giác hướng lên Hạng Vàng". *Fix:* bọc ký hiệu trong `aria-hidden="true"`, đặt nghĩa vào nhãn văn bản: "Huy hiệu học vấn đã xác minh: Thạc sĩ Toán".

- **medium** Ô người tham gia mang bốn lớp thông tin (mic, chế độ mặt, tên, huy hiệu, đang nói) nhưng `§ Accessibility Floor` chỉ nói "có nhãn văn bản đầy đủ" mà không nói **thứ tự**. Đọc sai thứ tự thì thông tin quan trọng nhất (ai đang nói) rơi xuống cuối. *Fix:* chốt thứ tự đọc: tên → vai trò → đang nói → trạng thái mic → chế độ khuôn mặt → huy hiệu.

- **medium** Chat realtime chưa có luật thông báo. Trong một phòng đông, mỗi tin nhắn mới phát ra một thông báo sẽ nhấn chìm người dùng; không thông báo gì thì người khiếm thính dùng chat sẽ bỏ lỡ. *Fix:* live region `polite` cho chat, gom nhóm, và một công tắc tắt thông báo chat — mặc định bật khi audio của người dùng đang tắt.

- **low** Thuộc tính `lang` cho nội dung song ngữ. Giao diện VI/EN trộn tên riêng và thuật ngữ tiếng Anh ("Study Circle", "Opus", "filter"). Trình đọc màn hình tiếng Việt sẽ phát âm sai nếu không đánh dấu. *Fix:* `lang="en"` trên các đoạn tiếng Anh nhúng trong câu tiếng Việt.

- **low** Ngưỡng tương phản của viền chưa được kiểm. Bảng tương phản trong `DESIGN.md` phủ chữ và nền, nhưng `border-hairline` (#E4DED2 trên #FFFFFF) chỉ khoảng 1.3:1 — dưới ngưỡng 3:1 của WCAG 1.4.11 cho thành phần giao diện. Vì ô người tham gia và nút phụ **phân biệt bằng viền**, đây là ranh giới thật. *Fix:* hoặc nâng viền cho các thành phần tương tác lên đạt 3:1, hoặc bổ sung nền phân biệt và ghi rõ viền chỉ mang tính trang trí.

- **low** Không có luật cho zoom 200% / reflow (WCAG 1.4.10). Breakpoint đã có, nhưng zoom trên desktop không đổi viewport width theo cùng cách. *Fix:* một câu trong Responsive & Platform: bố cục phải reflow được ở 320px CSS width tương đương, không cuộn ngang.

## Điểm mạnh cần giữ

- Bảy cặp màu chịu lực có số đo thật, không phải "đã kiểm AA" nói suông.
- Luật không-chỉ-bằng-màu được viết kèm lý do cụ thể chứ không phải trích dẫn tiêu chuẩn.
- Sàn 48px cho nút, kể cả trên desktop, và nói rõ lý do (bấm vội khi mất tập trung).
- "Không tự bật lại camera cho người đang ẩn mặt" — đây là quyết định về quyền tự chủ, và nó bảo vệ đúng nhóm dễ tổn thương nhất.
- Phụ đề trực tiếp đã được nêu thẳng trong Open Questions thay vì lờ đi.
