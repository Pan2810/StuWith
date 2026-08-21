# Lệ kiểm phiên bản & thực tế — StuWith Architecture Spine

Câu hỏi của lệ này: **mỗi công nghệ được bind trong spine đã được kiểm trên web hay chỉ được khẳng định từ trí nhớ mô hình?**

## Verdict

Bốn công nghệ chịu lực **đã kiểm thật** trong hội thoại và có nguồn trong memlog. Nhưng ba dòng còn lại trong bảng Stack được viết ra **không qua kiểm** — và một trong ba đã sai.

## Findings

### 1. [high] PostgreSQL 17 — sai, bản ổn định hiện tại là 18

**Đã kiểm 20/08/2026:** PostgreSQL **18** là major ổn định hiện tại (bản vá mới nhất 18.6, thông báo 13/08/2026). PostgreSQL 19 đang beta, dự kiến phát hành khoảng tháng 9–10/2026.

Spine ghi `PostgreSQL | 17` — con số này đến từ trí nhớ mô hình, không từ kiểm tra. Đây đúng là loại lỗi lệ này tồn tại để bắt.

*Fix:* đổi thành 18. Cân nhắc ghi chú rằng 19 sắp ra để đừng nâng vội ngay sau khi khởi động dự án.
*Nguồn:* postgresql.org/about/news — "PostgreSQL 18.6, 17.11, 16.15, 15.19, 14.24 and 19 Beta 3 Released"; endoflife.date/postgresql

### 2. [medium] `TypeScript 5.x`, `Redis 7.x` — không kiểm, nhưng dải rộng nên rủi ro thấp

Cả hai ghi ở dạng dải chính chứ không phải bản cụ thể, nên khó "sai" — nhưng cũng chưa được xác nhận. Đáng lưu ý: Next.js 16.3 được quảng cáo là "type checking nhanh hơn nhờ **TypeScript 7**", nghĩa là hệ sinh thái TS có thể đã bước qua mốc lớn mà dòng `5.x` không phản ánh.

*Fix:* kiểm dòng TypeScript hiện hành trước khi khởi tạo repo; nếu TS 7 đã ổn định thì bind theo nó vì Next.js 16.3 đang tối ưu quanh nó.

### 3. [low] `coturn`, `Caddy/Traefik` ghi "bản hiện hành của distro"

Chấp nhận được ở mức spine — đây là hạ tầng vận hành, không phải thư viện app, và việc bám bản distro là chủ ý hợp lý. Nhưng nên chốt **một** trong hai (Caddy *hoặc* Traefik) trước khi viết compose, vì cấu hình TLS của hai cái khác hẳn nhau và đây là thứ hai đơn vị có thể chọn lệch.

## Đã kiểm thật, có nguồn

| Công nghệ | Phiên bản | Kiểm ngày | Nguồn |
| --- | --- | --- | --- |
| LiveKit server | 1.9.x | 20/08/2026 | github.com/livekit/livekit/releases; OpenTalk 26.1.0 |
| Next.js | 16.3.0 (ra 03/08/2026) | 20/08/2026 | nextjs.org/blog/next-16-3 |
| NestJS | 11, hỗ trợ adapter Fastify v5 | 20/08/2026 | encore.dev nestjs-vs-fastify |
| pgvector | 0.8.x | 20/08/2026 | tổng hợp guide 2026 + trang release pgvector |

## Quyết định phi phiên bản đã được đối chiếu thực tế

- **LiveKit vs mediasoup** — đối chiếu với so sánh SFU 2026 (bloggeek.me, forasoft), không chọn từ cảm tính. Cái giá của mediasoup ("ba tháng xây signaling trước khi cho khách xem được gì") lấy từ nguồn, không phải mình nghĩ ra.
- **pgvector thay vì vector DB riêng** — đối chiếu với xu hướng 2026 "hầu hết workload thì pgvector là đủ".
- **coturn bắt buộc** — không phải phiên bản mà là thực tế vận hành WebRTC; giữ nguyên.
