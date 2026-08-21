# Rubric walker — StuWith Architecture Spine

Đối chiếu với good-spine checklist: có bịt đúng điểm phân kỳ của tầng dưới không · Rule có cưỡng chế được không · Deferred có chỗ nào để hai đơn vị lệch không · công nghệ có kiểm chưa · có phủ hết capability của nguồn không · **có chiều nào bị bỏ trắng không**.

## Verdict

Spine đúng altitude và đúng độ dài: nó cố định invariant, để seed tối thiểu, và Deferred làm việc thật chứ không phải chỗ đổ rác. Phủ đủ 19 US của `docs/prd.md` qua bảng Capability Map. Điểm yếu là **ba chiều bị bỏ trắng hoàn toàn** — không quyết, không hoãn, không nêu thành câu hỏi mở. Theo checklist thì im lặng cả một chiều là finding, không phải spine sạch.

## Findings

### 1. [high] Chiều CI/CD bị bỏ trắng

`docs/prd.md` US-0.4 AC1 yêu cầu tường minh "pipeline có bước quét credential", và NFR Governance H5 yêu cầu "approval checkpoint trước deploy". Spine **không nói gì** về pipeline — không quyết, không hoãn.

Hệ quả cụ thể: AD-14 nói "pipeline có bước quét credential" như một Rule, nhưng không AD nào nói pipeline tồn tại ở đâu. Rule trỏ vào hư không.

*Fix:* thêm một dòng Deferred có điều kiện quay lại, hoặc một AD tối thiểu chốt nơi pipeline chạy và cổng chặn nào là bắt buộc.

### 2. [medium] Chiến lược test bị bỏ trắng

Spine nói `domain` không import hạ tầng (AD-1) — một quyết định mà **lý do chính** là để test được lõi mà không cần DB. Nhưng không chỗ nào nói ra điều đó, nên tầng dưới không biết đó là ràng buộc test hay chỉ là thẩm mỹ kiến trúc. Lệ đối kháng cũng đề xuất "bộ test hợp đồng chung cho mọi adapter" — thứ không tồn tại nếu spine không đặt.

*Fix:* thêm dòng Deferred nêu rõ spine chưa chốt framework test, nhưng ràng buộc "domain test được không cần hạ tầng" và "adapter phải qua bộ test hợp đồng chung" là bắt buộc.

### 3. [medium] Quan trắc (observability) bị bỏ trắng

Có convention logging (JSON, `request_id`, lọc PII) nhưng không có gì về metric, trace, hay cảnh báo. Với một hệ thống có đồng hồ tiền chạy nền, câu hỏi "làm sao biết scheduler chết?" là câu hỏi vận hành bậc nhất — và `docs/prd.md` §1.5 còn định nghĩa hẳn counter-metric cần đo.

*Fix:* Deferred có điều kiện, kèm ghi rõ một thứ **không** hoãn được: scheduler phải có health signal.

### 4. [low] `AD-13` cấm sửa `/v1` phá tương thích nhưng không định nghĩa "phá tương thích"

Hai đơn vị có thể bất đồng về việc thêm một trường tuỳ chọn có phải breaking không. Rủi ro thấp ở giai đoạn một người làm, nhưng chính `/v1` tồn tại để phục vụ app phone tương lai — nơi client cũ vẫn chạy.

*Fix:* một câu trong Conventions: thêm trường tuỳ chọn là tương thích; đổi tên, đổi kiểu, bỏ trường, siết ràng buộc là phá vỡ.

## Đã kiểm và đạt

- **Bịt đúng điểm phân kỳ:** đường tiền (AD-3→AD-7) là chỗ hai đơn vị dễ lệch nhất và được cố định chặt nhất. Đúng ưu tiên.
- **Rule cưỡng chế được:** AD-1 (lỗi build), AD-4 (`UNIQUE` ở DB), AD-6 (hình dạng câu lệnh), AD-12 (quyền DB không có UPDATE/DELETE) — đều là cưỡng chế máy, không phải lời khuyên.
- **Deferred không để lệch:** mỗi mục hoãn đều cô lập được bằng một AD đã có (thanh toán bị AD-8 cô lập; embedding provider bị pgvector cô lập).
- **Vỏ vận hành đã phủ:** triển khai, môi trường, TLS, TURN, cấu hình — có sơ đồ và có luật. Đây thường là chiều bị bỏ quên nhất và ở đây thì không.
- **Phủ nguồn:** 19/19 US có dòng trong Capability Map.
