# Project Brief — Nền tảng phòng học live (**StuWith**)

> BMAD · Project Brief → PRD → UX → Architecture
> Tạo 2026-08-19 · **Cập nhật 2026-08-20** · Chủ dự án: IPan
> Bảo mật tuân theo `casan_harness_assessment.md` (khung CASAN 7-Harness)
>
> ⚠️ **Bản đã sửa 2026-08-20 để khớp với `docs/prd.md`.** Ba thay đổi: **gỡ ghi hình khỏi MVP** (kéo theo gỡ object store khỏi stack) · **phiên hỏi riêng cho tối đa 3 người**, mỗi người trả đủ đơn giá · **chốt luật chặn theo tuổi**. Khi PRD và brief mâu thuẫn, **PRD thắng**.

---

## 1. Tầm nhìn (Vision)

Một "thư viện học tập mini" trực tuyến: bất kỳ ai cũng có thể vào một **phòng học live** để cùng học, giấu/biến đổi khuôn mặt tùy ý, hỏi cả phòng miễn phí hoặc trả **coin** để hỏi riêng theo block thời gian (tối đa 3 người trong một phiên). Người dùng tích lũy **uy tín** qua nỗ lực và **huy hiệu học vấn** đã xác minh, xây dựng một hồ sơ dạng CV để (giai đoạn sau) nhà tuyển dụng tham khảo.

**Nguyên tắc xuyên suốt:** nhẹ cho mạng yếu (ưu tiên audio, video tụt xuống icon/avatar khi nghẽn), thiết kế đẹp — hệ **"Cắm trại"** dựng trên xương Material 3, xem `DESIGN.md` — dễ dùng cho người non-tech, an toàn trước tấn công.

---

## 2. Người dùng mục tiêu (Personas)

| Persona | Nhu cầu chính |
|---|---|
| Người học tự do | Tìm/join lớp theo nguyện vọng, học ẩn danh, hỏi khi cần |
| Người tạo lớp / gia sư | Mở phòng, thu coin khi được hỏi riêng, xây uy tín |
| Tổ chức / giáo viên (gói Campus) | Tổ chức lớp/event đông người |
| Nhà tuyển dụng (Sprint sau) | Xem hồ sơ CV đã xác minh — nguồn doanh thu |

---

## 3. Phạm vi MVP (theo quyết định đã chốt)

### Trong MVP
- Đăng nhập qua mạng xã hội (OAuth: **Google, Facebook, Apple, Microsoft** — Microsoft để tích hợp account @fpt.com).
- Vào/tạo/tìm lớp theo keyword; **AI match** theo nguyện vọng (embedding + similarity).
- Phòng học **live WebRTC** (audio ưu tiên, video simulcast, degrade → avatar/icon khi mạng yếu).
- Chế độ khuôn mặt: **để nguyên / blur-ẩn / filter biến đổi** (xử lý client-side).
- Chat/nói với **cả phòng** (miễn phí) và **hỏi riêng trả coin theo block** (đồng hồ đếm ngược theo số coin đang có). Phiên hỏi riêng tối đa **3 người** — 1 người được hỏi + tối đa 2 người trả coin, mỗi người trả đủ đơn giá; người thứ ba phải được **cả hai** người trong phiên đồng ý mới vào được.
- **Ví coin nội bộ**: bản thử nghiệm cấp sẵn **1.000.000 coin/user**, tiêu trong app, **chưa** convert ra tiền/chưa rút.
- Hệ thống **hạng uy tín** (theo mùa) + **huy hiệu học vấn** đã xác minh.
- **Report + xác minh danh tính kiểu Mercari** (KYC nhẹ, report mạnh, block/ban).
- **Khai tuổi lúc đăng ký + chặn hành vi có tiền với tài khoản dưới 18** (không nhận hỏi riêng, không đặt giá, không nhận coin từ người khác — vẫn học, vẫn hỏi, vẫn tiêu coin bình thường).
- ~~Ghi hình phòng, lưu 30 ngày~~ — **đã gỡ khỏi MVP 20/08/2026.** MVP không ghi lại nội dung buổi học dưới bất kỳ hình thức nào, và không lưu tệp nhị phân nào của người dùng.
- Web trước; **để sẵn "đầu chờ"** cho app phone (tách API + realtime gateway riêng, web chỉ là 1 client).
- Chạy **local (Docker Compose)** nhưng viết cloud-native để đẩy cloud sau.

### Ngoài MVP (backlog / sprint sau)
- **[TODO — pending pháp lý]** Rút coin ra tiền thật, convert coin↔VND (cần giấy phép trung gian thanh toán).
- Trang CV cho **nhà tuyển dụng** xem (Sprint tiếp theo).
- App phone native.
- **Ghi hình buổi học** (gỡ khỏi MVP 20/08 — làm lại từ đầu ở phase sau, gồm cả luồng đồng thuận).
- Giao diện moderator (MVP xử lý thủ công qua admin/DB).
- Phụ đề trực tiếp cho người khiếm thính.

---

## 4. Đặc tả các cơ chế chính

### 4.1 Gói dịch vụ (tiers)
| Gói | Tên đề xuất | Số người / phòng | Ghi chú |
|---|---|---|---|
| Free | **Study Buddy** | 6 | miễn phí |
| Pro | **Study Circle** | 25 | phí/năm |
| Business | **Campus** | mặc định 45, trần 100 | lớp/event; phần dư "view-only" |

*(Trần 100 tương tác nằm trong khả năng SFU; tham chiếu Teams/Zoom/Meet đều cấu hình 100→1000.)*

### 4.2 Coin & hỏi riêng
- Người được hỏi tự đặt giá **trong khung giới hạn** (vd 10–500 coin/phút) để tránh set giá lừa đảo.
- Tính theo **block** (mặc định 1 phút); trừ coin liên tục, **đồng hồ đếm ngược** hiển thị rõ thời gian còn lại theo số coin. Thoát giữa một block đang tính thì block đó đã trả, không hoàn.
- **Phiên nhiều người:** trần 3 người, **mỗi người hỏi trả đủ đơn giá** (2 người hỏi ở giá 120 → người được hỏi nhận 240/phút). Mỗi người một đồng hồ độc lập; hết coin thì chỉ người đó rời, phiên tiếp tục. Trần 3 người tồn tại để khung giá 10–500 không bị vô hiệu bằng cách nhân số người.
- Hết coin → tự động dừng phiên hỏi riêng + thông báo nạp thêm.
- **Idempotency + audit log** cho mọi giao dịch coin (H2 CASAN — tránh trừ 2 lần).

### 4.3 Hệ thống uy tín & huy hiệu (đề xuất 3 trục thay vì 2 khung cứng)
1. **Uy tín/Nỗ lực** — hạng động kiểu LoL, reset theo mùa, thưởng gem/coin hàng tháng.
2. **Học vấn** — huy hiệu tĩnh, **đã xác minh** (cử nhân/kỹ sư/thạc sĩ...).
3. **Kỹ năng/lĩnh vực** — badge theo chủ đề học.
Cả ba cùng hiển thị trên hồ sơ, mỗi trục một ý nghĩa riêng.

### 4.4 AI match
- Embedding hoá "nguyện vọng" của user và "mô tả lớp", so khớp **cosine similarity**, chọn điểm cao nhất.
- Input người dùng đi qua **prompt-injection scan** trước khi vào bất kỳ agent nào (H4).

---

## 5. Kiến trúc high-level (cloud-native, chạy local trước)

```
[Web client]  ──►  API Gateway ──► Auth · User · Class · Coin · Ranking (services)
  (Cắm trại)           │                     │
[Phone (sau)] ─(đầu chờ)                   PostgreSQL · Redis
        │
        └─► Realtime Gateway ──► SFU (LiveKit/Mediasoup)
                                     Opus audio ưu tiên
                                     video simulcast/degrade → avatar

(Không có Recorder, không có Object store — xem PRD US-0.2 AC4)
```

- **Local dev:** Docker Compose — Postgres, Redis, LiveKit. Lên cloud chỉ đổi endpoint. *(MinIO đã bỏ cùng với ghi hình.)*
- **Mạng yếu:** ưu tiên audio (Opus DTX/RED), video tụt bậc → avatar/icon; không rớt tiếng.
- **Face filter:** chạy trên máy user (MediaPipe / TensorFlow.js hoặc SDK DeepAR), giảm tải server + bảo vệ riêng tư.
- **Chống tấn công:** rate limit, WAF, sandbox/timeout cho tác vụ, tách credential ra env var.

---

## 6. Bảo mật theo CASAN (tự đánh giá mục tiêu MVP)

| Harness | Cam kết trong MVP |
|---|---|
| H4 Security | Prompt-injection scan trên input; credential chỉ trong env var; PII không vào log; sandbox/timeout tác vụ |
| H5 Governance | Approval checkpoint trước deploy; **audit log bất biến** cho coin & report; risk registry (hành vi cấm) |
| H2 Tool | Idempotency key cho giao dịch coin & ghi dữ liệu; audit mỗi call |
| H1/H3/H6/H7 | Context tập trung, test gate, cost tracking, retry/rollback — cứng hoá dần |

> Nguyên tắc CASAN: *Harness thấp nhất quyết định trần*. Ưu tiên nâng H4/H5 ngay từ MVP vì hệ thống có tiền (coin) và có luồng video thời gian thực của người dùng — kể cả khi không lưu lại gì.

---

## 7. Rủi ro & TODO đang treo

- 🔴 **[TODO pháp lý]** Rút/convert coin ↔ tiền thật → cần giấy phép trung gian thanh toán (NHNN), KYC, thuế. **Giữ pending, không làm trong MVP.**
- 🟠 An toàn nội dung: che mặt + hỏi riêng dễ bị lạm dụng → dựa vào **report mạnh + xác minh kiểu Mercari** (đã chốt). Chặn tuổi **đã chốt 20/08** → PRD US-0.5. Rủi ro còn lại: phiên 3 người làm tăng bề mặt lạm dụng, không giảm.
- ✅ ~~Video: consent ghi hình, retention 30 ngày~~ → **moot**, ghi hình đã gỡ khỏi MVP. Đổi lại: mất một nguồn bằng chứng cho moderation, trong khi giao diện moderator cũng đang hoãn — hai lớp phòng vệ cùng mỏng đi một lúc.
- 🟡 CV/recruiter: đồng ý opt-in mới hiển thị (Sprint sau).

---

## 8. Roadmap phân sprint (đề xuất)

| Sprint | Mục tiêu |
|---|---|
| S0 – Nền móng | Docker Compose local; skeleton API + Realtime Gateway (đầu chờ phone); OAuth; khai tuổi + chặn hành vi; design system "Cắm trại" trên xương M3 |
| S1 – Phòng học live | WebRTC/SFU, audio ưu tiên, degrade video, tạo/join phòng, chat cả phòng |
| S2 – Face + Coin | Filter mặt client-side; ví coin 1tr; hỏi riêng theo block + đếm ngược; xin tham gia phiên (tối đa 3 người) |
| S3 – Match + Uy tín | AI match embedding; hạng uy tín + huy hiệu học vấn; xác minh + report kiểu Mercari |
| S4 – Gói & Nạp coin | 3 tier (Study Buddy/Study Circle/Campus); nạp coin qua credit |
| S5+ | CV recruiter · app phone · convert coin (khi có giấy phép) |

---

## 9. Bước tiếp theo trong BMAD

Đã chốt: tên **StuWith**, OAuth **Google/Facebook/Apple/Microsoft** (Microsoft cho @fpt.com), PRD phủ **toàn bộ MVP (S0–S4)**.

- ✅ **Project Brief** — tài liệu này
- ✅ **PRD** → `docs/prd.md` (19 US, 5 EPIC, có Glossary + Chỉ mục giả định)
- ✅ **UX Design** → `_bmad-output/planning-artifacts/ux-designs/ux-StuWith-2026-08-19/` — hệ thiết kế **"Cắm trại"**, `DESIGN.md` + `EXPERIENCE.md`, 4 mockup light/dark
- ⬜ **Architecture Document** → chọn SFU, schema coin chịu được nhiều người trả song song trong một phiên, đóng gap CASAN H4/H5/H6
