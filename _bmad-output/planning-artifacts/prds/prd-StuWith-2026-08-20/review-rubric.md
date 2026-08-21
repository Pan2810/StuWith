# PRD Quality Review — StuWith (MVP S0–S4)

Rà `docs/prd.md` (234 dòng, 19 US, 5 EPIC) theo rubric 7 chiều của bmad-prd, sau đợt cập nhật 20/08/2026.

## Overall verdict

PRD này mạnh ở chỗ hầu hết PRD yếu: **AC kiểm chứng được** và **phạm vi trung thực**. Việc gỡ US-4.3 hôm nay được làm ồn ào — có bảng ngoài phạm vi, có lý do, có ghi hệ quả mất bằng chứng cho moderation — chứ không lặng lẽ biến mất. US-2.4 mới có 8 AC gần như đều test được.

Điểm yếu thật nằm ở **tầng chiến lược**: PRD chưa bao giờ phát biểu luận điểm mà nó đặt cược, và ba "thước đo thành công" ở §1 đều là **tiêu chí nghiệm thu kỹ thuật**, không phải thước đo sản phẩm. Không có gì trong PRD đo được liệu có ai học được gì hay có quay lại không.

Đợt sửa hôm nay cũng để lại **hai mâu thuẫn mới** cần vá trước khi vào Architecture: quyền nhận coin của tài khoản dưới 18 va với việc cấp sẵn 1.000.000 coin, và MinIO vẫn nằm trong stack bắt buộc dù lý do tồn tại của nó đã bị gỡ.

## 1. Decision-readiness — adequate

Quyết định được nói ra là quyết định, không giấu dưới dạng "cân nhắc". §6 nêu thẳng cái phải đánh đổi (gỡ ghi hình = mất nguồn bằng chứng, và nó chồng lên việc moderator UI cũng hoãn). §7 là câu hỏi mở thật, có cột chặn sprint.

### Findings
- **medium** §1 "Thước đo (mục tiêu tham khảo cho bản thử)" — cụm "tham khảo" làm mọi con số mất hiệu lực. Một thước đo không ràng buộc thì không phải thước đo. *Fix:* hoặc cam kết con số, hoặc đổi tên mục thành "Tiêu chí nghiệm thu kỹ thuật" và thừa nhận PRD chưa có success metric.
- **low** Không có `[NOTE FOR PM]` ở chỗ căng thật — ví dụ chỗ US-0.5 AC4 (dưới 18 vẫn được tiêu coin) là một quyết định có rủi ro pháp lý về sau, hiện chỉ nằm trong ngoặc đơn nghiêng.

## 2. Substance over theater — adequate

Không có NFR theater: bảng §3 toàn ngưỡng cụ thể của chính sản phẩm ("không rớt tiếng", "khung 10–500 coin/phút", "khuôn mặt không rời máy người dùng"), không có câu "hệ thống phải scalable". Không có vision theater.

### Findings
- **medium** §2 Personas là **một dòng liệt kê tên**, không dẫn tới quyết định nào trong PRD. Đây không phải persona theater — đây là ngược lại, persona quá mỏng đến mức không làm việc gì. Với sản phẩm consumer, người đọc không biết Learner khác Class Creator ở nhu cầu nào. *Fix:* hoặc viết đủ để mỗi persona ràng buộc ít nhất một US, hoặc bỏ hẳn và trỏ sang Key Flows trong `EXPERIENCE.md`.

## 3. Strategic coherence — thin

Đây là chiều yếu nhất.

### Findings
- **high** **PRD không phát biểu luận điểm.** Đọc hết 234 dòng vẫn không thấy câu "chúng ta đặt cược rằng…". Luận điểm thật sự có tồn tại và khá sắc — *người ta ngại học cùng người lạ vì sợ lộ mặt, nên nếu cho phép ẩn danh mà vẫn tích được uy tín thật thì sẽ mở khoá một nhóm người học chưa ai phục vụ* — nhưng nó chỉ nằm rải rác trong Brief và trong `DESIGN.md § Brand & Style`, không nằm trong PRD. Không có luận điểm thì thứ tự ưu tiên S0→S4 không kiểm chứng được. *Fix:* thêm một đoạn "Luận điểm" ở §1, trước thước đo.
- **high** **Ba thước đo ở §1 đều là tiêu chí nghiệm thu kỹ thuật, không phải success metric.** "Vào phòng < 5s", "giao dịch coin chính xác 100%", "0 rò rỉ PII" — cả ba đều đúng và đều nên có, nhưng cả ba đều xanh hoàn toàn ở một sản phẩm không ai dùng. Không có gì đo việc học, việc quay lại, hay việc uy tín có ý nghĩa với ai không. *Fix:* thêm ít nhất một metric hành vi (vd tỉ lệ người vào phòng lần hai trong 7 ngày) và một metric của vòng giá trị coin (vd tỉ lệ phiên hỏi riêng kết thúc bởi người hỏi chứ không phải bởi hết coin).
- **medium** **Không có counter-metric.** Sản phẩm có coin và có ẩn danh — hai thứ rất dễ tối ưu sai hướng. *Fix:* đặt counter-metric, vd tỉ lệ báo cáo trên mỗi 100 phiên hỏi riêng, hoặc tỉ lệ người dùng tiêu hết coin trong tuần đầu (dấu hiệu thiết kế đang ép tiêu).

## 4. Done-ness clarity — adequate

Phần lớn AC có hệ quả kiểm chứng được, và các AC thêm hôm nay (US-0.5, US-2.3 AC6–AC7, US-2.4) đều test được. Nhưng vẫn còn tính từ không có bờ.

### Findings
- **high** **US-0.5 AC2 mâu thuẫn với US-2.2 AC1.** AC2 nói tài khoản dưới 18 "không nhận được coin từ người khác"; AC1 của US-2.2 nói mọi user được cấp sẵn 1.000.000 coin khi tạo tài khoản. Coin cấp sẵn có phải "nhận coin" không? Nếu có, tài khoản dưới 18 không dùng được gì; nếu không, phải nói rõ. Đây là mâu thuẫn **mới sinh ra hôm nay**. *Fix:* AC2 ghi rõ "không nhận coin **từ người dùng khác**; coin cấp sẵn của hệ thống không bị ảnh hưởng".
- **medium** **US-2.1 AC3 "giữ hiệu năng ở máy phổ thông"** — không có bờ. Máy phổ thông là gì, hiệu năng bao nhiêu FPS, tụt xuống mức nào thì tự tắt filter? *Fix:* đặt ngưỡng, vd "≥ 20 FPS trên máy 4 nhân/8GB; dưới ngưỡng thì tự hạ chất lượng filter rồi tắt hẳn, có báo cho người dùng".
- **medium** **US-1.4 AC2 "Lọc nội dung cơ bản"** — không định nghĩa. Lọc gì, theo danh sách nào, chặn hay cảnh báo? *Fix:* nêu phạm vi tối thiểu.
- **medium** **US-3.2 AC1 "Điểm nỗ lực tăng theo hoạt động"** — không có công thức, không có bậc. Story sinh ra từ AC này sẽ phải tự bịa. *Fix:* nêu các hành vi tính điểm và trọng số, hoặc chuyển US-3.2 sang trạng thái chưa sẵn sàng làm.
- **low** **US-1.2 AC2 "Vào phòng < 5s"** — thiếu điều kiện đo (mạng nào, phân vị nào). *Fix:* "p90 < 5s trên kết nối 4G phổ thông".

## 5. Scope honesty — strong

§5 đã thành bảng có lý do cho từng mục, và việc gỡ ghi hình được ghi kèm hệ quả thay vì chỉ ghi kết quả. §7 có cột "chặn sprint" — hiếm PRD nào làm.

### Findings
- **medium** **Không có tag `[ASSUMPTION]` nào trong toàn PRD**, dù có ít nhất một suy luận chưa được xác nhận trực tiếp: US-0.5 AC4 (dưới 18 vẫn được tiêu coin) do PM đề xuất chứ không phải chủ dự án nêu. *Fix:* gắn tag và lập chỉ mục ở cuối.

## 6. Downstream usability — thin

PRD này là chain-top (nuôi UX → Architecture → stories), nên chiều này quan trọng hơn bình thường.

### Findings
- **high** **US-0.2 AC3 vẫn bắt buộc MinIO trong stack, nhưng lý do tồn tại của MinIO đã bị gỡ hôm nay.** AC3 ghi "`docker compose up` là lên đủ stack (Postgres, Redis, MinIO, SFU)". Sau khi bỏ ghi hình, object store chỉ còn phục vụ "tài sản tĩnh (avatar, tệp đính kèm nếu có)" — mà "nếu có" nghĩa là chưa chắc cần. Architecture sẽ dựng một dịch vụ không ai dùng. *Fix:* quyết dứt khoát ở AC3 — giữ MinIO cho avatar, hay bỏ khỏi stack MVP.
- **medium** **Không có Glossary.** Sản phẩm có nhiều danh từ miền dễ trôi: "hỏi riêng" / "phiên hỏi riêng" / "phiên riêng" dùng lẫn nhau; "uy tín" / "hạng" / "điểm nỗ lực" chưa phân biệt. *Fix:* thêm mục Glossary, đồng bộ với `EXPERIENCE.md`.
- **medium** **Tên gói không nhất quán** giữa PRD ("Buddy / Circle / Campus"), Brief ("Study Buddy / Study Circle / Campus") và mockup ("Study Circle"). *Fix:* chốt một dạng, dùng nguyên văn.
- **low** **PRD không có User Journey nào.** Với sản phẩm consumer thì UJ là phần chịu lực — nhưng ở đây chúng sống trong `EXPERIENCE.md § Key Flows` (5 flow, có nhân vật đặt tên). Chấp nhận được vì UX đã chạy và PRD đã khai `EXPERIENCE.md` trong `sources`. *Fix:* thêm một dòng ở §2 nói rõ UJ nằm ở đâu, để người đọc không tưởng là thiếu.

## 7. Shape fit — adequate

Hình dạng đúng loại sản phẩm: consumer, chain-top, có tiền và có dữ liệu người dùng nhạy cảm. EPIC theo sprint là lựa chọn hợp lý cho một dự án một người. NFR tách riêng, không nhét vào từng US. Không bị over-formalize.

### Findings
- **low** §2 gộp cả persona lẫn vai trò hệ thống (`guest`, `moderator`, `system_admin`) vào một dòng. Hai thứ này phục vụ hai người đọc khác nhau — persona cho UX, vai trò cho Architecture. *Fix:* tách hai dòng.

## Mechanical notes

- **ID:** US-0.1→0.5, 1.1→1.4, 2.1→2.4, 3.1→3.4, 4.1→4.2. Khoảng trống ở 4.3 **đã được đánh dấu tường minh** bằng dòng gạch ngang — đúng cách, không phải lỗi.
- **Cross-reference:** các tham chiếu US-0.5, US-2.4, US-3.4 trong §3 và §5 đều resolve đúng.
- **Frontmatter:** đầy đủ (`title`, `status: final`, `created`, `updated`, `owner`, `sources`). `sources` có khai cả UX spine — tốt cho truy vết.
- **Glossary:** không có (xem chiều 6).
- **Assumptions Index:** không có (xem chiều 5).
- **Personas:** một dòng, không có protagonist đặt tên (UJ nằm ở `EXPERIENCE.md`).
- **Đường dẫn:** PRD ở `docs/`, không ở `planning_artifacts` như config `bmm` khai. Đúng thực tế nhưng nên ghi chú, vì skill sau sẽ tìm ở `planning_artifacts` trước.
