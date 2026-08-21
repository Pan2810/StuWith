# Validation Report — StuWith

- **DESIGN.md:** `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/DESIGN.md`
- **EXPERIENCE.md:** `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/EXPERIENCE.md`
- **Run at:** 2026-08-19
- **Lenses:** rubric walker · accessibility

## Overall verdict

Cặp spine phủ được phần lõi và cam kết đúng những chỗ khó — luật tiền, thang suy giảm mạng, đồng thuận ghi hình đều đã được quyết chứ không để mở. Nhưng nó **chưa dùng được như một hợp đồng máy đọc**: tên component trong `DESIGN.md` và `EXPERIENCE.md` không khớp nhau, và cặp token light/dark tồn tại mà không có luật ánh xạ, nên consumer phía dưới sẽ phải đoán.

Lỗ hổng thật về nội dung nằm ở phần an toàn: `moderator` là một vai trò trong PRD nhưng **không có bề mặt nào** trong IA, và không có Key Flow nào cho báo cáo/xử lý — với một sản phẩm bán chính tính năng ẩn danh, đó là mảng rủi ro cao nhất lại được đặc tả mỏng nhất.

Lệ kiểm tiếp cận cho một bức tranh lệch: phần *tĩnh* (màu, tương phản, kích thước chạm) mạnh hơn mức thường thấy — bảy cặp chịu lực đều có số đo thật. Phần *động* (ngữ nghĩa của lưới video, đồng hồ đếm ngược, chat realtime) thì chưa đủ luật để ngăn một bản cài đặt biến trình đọc màn hình thành cực hình.

## Category verdicts

- Flow coverage — **thin**
- Token completeness — **adequate**
- Component coverage — **broken**
- State coverage — **thin**
- Visual reference coverage — **strong**
- Bloat & overspecification — **adequate**
- Inheritance discipline — **adequate**
- Shape fit — **adequate**

## Findings by severity

### Critical (2)

**[Token completeness]** — Không có luật ánh xạ token light → dark (§ DESIGN.md frontmatter.components)
Khối `components` chỉ trỏ tới token light (`background: '{colors.primary}'`). Không chỗ nào ghi rằng ở dark mode `X` đọc thành `X-dark`. Consumer sinh code sẽ hoặc hardcode light, hoặc tự bịa quy ước.
Fix: thêm câu luật ánh xạ ngay đầu mục Colors.

**[Component coverage]** — Tên component không khớp giữa hai spine (§ DESIGN.md.Components ↔ EXPERIENCE.md § Component Patterns)
DESIGN.md dùng kebab-case tiếng Anh; EXPERIENCE.md dùng tên tiếng Việt. Không có bảng nối. Consumer không ghép được đặc tả thị giác với đặc tả hành vi.
Fix: kebab-case tiếng Anh làm khoá máy đọc ở cả hai file, tên tiếng Việt trong ngoặc làm nhãn người đọc.

### High (7)

**[Flow coverage]** — Không có flow cho báo cáo & xử lý; vai trò moderator không có bề mặt nào (§ IA · US-3.4)
Fix: thêm bề mặt "Hàng đợi kiểm duyệt" và Key Flow thứ 5 với nhân vật moderator.

**[Flow coverage]** — Không có Key Flow cho nạp coin (§ Key Flows · US-4.2)
Fix: thêm flow "Trâm nạp coin giữa phiên", cao trào là lúc quay lại từ cổng thanh toán mà chưa rõ đã trừ tiền hay chưa.

**[Component coverage]** — Bốn component có hành vi nhưng không có đặc tả thị giác (§ DESIGN.md.Components)
Thanh điều khiển phòng, bảng chế độ khuôn mặt, thẻ giao dịch, chat cả phòng.
Fix: thêm bốn dòng.

**[State coverage]** — Màn Đăng nhập không có state nào, dù US-0.1 AC4 yêu cầu tường minh (§ State Patterns)
Fix: thêm hàng cho đăng nhập thất bại, provider từ chối, phiên hết hạn giữa buổi học.

**[State coverage]** — Pre-join thiếu trạng thái trình duyệt chặn camera/mic (§ State Patterns)
Màn duy nhất xin quyền thiết bị; bấm "Chặn" là cả luồng đứng.
Fix: thêm hàng permission-denied + cho phép vào phòng ở chế độ chỉ nghe.

**[Accessibility]** — Đồng hồ đếm ngược có nguy cơ bị đọc lặp mỗi giây (§ Accessibility Floor)
Fix: `countdown-display` mang `aria-live="off"`; thông báo chỉ phát ở các mốc qua live region riêng.

**[Accessibility]** — Thứ tự tab trong lưới người tham gia không được đặc tả (§ Accessibility Floor)
Campus 45–100 người ⇒ tab qua tối đa 100 ô mới tới thanh điều khiển.
Fix: lưới là composite widget, một điểm dừng tab, di chuyển bằng phím mũi tên.

### Medium (11)

**[Flow coverage]** — Hạng uy tín theo mùa chỉ tồn tại dạng huy hiệu tĩnh (US-3.2). Fix: mục trong State Patterns, hoặc ghi rõ ngoài phạm vi.
**[Token completeness]** — Không có token chuyển động (duration/easing). Fix: thêm nhóm `motion` + `network-chip-debounce: 3000ms`.
**[Component coverage]** — `button-secondary` và `snackbar` không có dòng hành vi. Fix: thêm hai dòng.
**[State coverage]** — Tạo phòng không có state validation. Fix: thêm hàng.
**[State coverage]** — Ghi hình không có trạng thái sắp hết hạn 30 ngày (US-4.3). Fix: thêm hàng.
**[Inheritance]** — Không có mã US nào xuất hiện trong hai spine. Fix: gắn mã US vào bảng IA và tiêu đề Key Flow.
**[Shape fit]** — Thiếu mục Inspiration & Anti-patterns dù đã bị kích hoạt. Fix: ghi ba hướng thiết kế bị loại và lý do.
**[Accessibility]** — Nhóm ba chế độ khuôn mặt không có ngữ nghĩa nhóm. Fix: `role="radiogroup"` + `aria-checked`.
**[Accessibility]** — Emoji đang gánh nghĩa trong huy hiệu. Fix: `aria-hidden` cho ký hiệu, nghĩa vào nhãn văn bản.
**[Accessibility]** — Thứ tự đọc của ô người tham gia không được chốt. Fix: tên → vai trò → đang nói → mic → chế độ mặt → huy hiệu.
**[Accessibility]** — Chat realtime chưa có luật thông báo. Fix: live region `polite` có gom nhóm + công tắc tắt.

### Low (11)

**[Flow coverage]** — Chat cả phòng không xuất hiện trong flow nào (US-1.4). Chấp nhận được.
**[Token completeness]** — Token mồ côi: `danger`, `surface-elevated-dark`.
**[Token completeness]** — `tile-video` / `tile-avatar-bg` không nằm trong component spec nào.
**[Visual reference]** — `mockups/phong-hoc-live.html` trùng lặp với bản trong `.working/`.
**[Bloat]** — Dòng "Điều luồng này phải chứng minh" là lý lẽ, không phải luật.
**[Bloat]** — Bảng IA lặp một phần phạm vi từ PRD.
**[Inheritance]** — Tên gói không nhất quán (Study Buddy/Buddy/Study Circle).
**[State coverage]** — Hạ gói khi phòng đang vượt trần mới: không có luật.
**[Accessibility]** — Thiếu thuộc tính `lang` cho nội dung song ngữ.
**[Accessibility]** — Tương phản viền chưa kiểm: `border-hairline` ~1.3:1, dưới ngưỡng 3:1 của WCAG 1.4.11.
**[Accessibility]** — Không có luật cho zoom 200% / reflow (WCAG 1.4.10).

## Điểm mạnh cần giữ

- Bảy cặp màu chịu lực có số đo tương phản thật, không phải "đã kiểm AA" nói suông.
- Luật không-chỉ-bằng-màu được viết kèm lý do cụ thể chứ không phải trích dẫn tiêu chuẩn.
- Sàn 48px cho nút kể cả trên desktop, có nêu lý do.
- "Không tự bật lại camera cho người đang ẩn mặt" — quyết định về quyền tự chủ, bảo vệ đúng nhóm dễ tổn thương nhất.
- Ba mục tự đặt (Thang suy giảm mạng, Luật coin & tiền, Ẩn danh/đồng thuận/báo cáo) đều xứng đáng chỗ đứng.

## Reviewer files

- `review-rubric.md`
- `review-a11y.md`
