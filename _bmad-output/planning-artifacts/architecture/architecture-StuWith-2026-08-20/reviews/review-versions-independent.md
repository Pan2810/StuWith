# Review độc lập — Kiểm chứng công nghệ & phiên bản

- **Đối tượng:** `ARCHITECTURE-SPINE.md` (StuWith, 2026-08-20)
- **Lăng kính:** mọi quyết định công nghệ đã cam kết có thật sự được tra cứu web / đối chiếu thực tế, hay chỉ là khẳng định từ trí nhớ mô hình
- **Ngày review:** 2026-08-20
- **Phương pháp:** WebSearch + WebFetch trực tiếp tới nguồn gốc (GitHub releases/tags, npm dist-tags, Docker Hub API, tài liệu chính chủ, postgresql.org). Không dùng trí nhớ mô hình cho bất kỳ con số phiên bản nào.

---

## 0. Kết luận một câu

Spine ghi ở đầu mục Stack rằng **"Đã kiểm trên web ngày 20/08/2026"**, nhưng **hai dòng sai lệch nghiêm trọng (LiveKit, Redis)** cho thấy câu đó không đúng với toàn bảng — phần lớn bảng thì chính xác đáng khen (PostgreSQL, Next.js, NestJS, pgvector đều đúng và đúng cả sắc thái), song hai dòng còn lại mang dấu vân tay rõ rệt của trí nhớ huấn luyện chứ không phải của một lần tra cứu.

---

## 1. Bảng kiểm chứng toàn bộ Stack

| # | Công nghệ | Spine tuyên bố | Thực tế tìm được (20/08/2026) | Nguồn | Trạng thái |
|---|---|---|---|---|---|
| 1 | TypeScript | "kiểm dòng hiện hành trước khi khởi tạo repo — Next.js 16.3 tối ưu quanh TypeScript 7" | npm `latest` = **7.0.2**; TS 7.0 GA 08/07/2026 (trình biên dịch native Go). Dòng cũ còn sống qua gói tương thích `@typescript/typescript6` = **6.0.2**. `next` = 7.1.0-dev | [npm dist-tags](https://registry.npmjs.org/-/package/typescript/dist-tags) · [InfoQ](https://www.infoq.com/news/2026/08/typescript-7-released/) | **Corrected** (xem §3) |
| 2 | Next.js | 16.3.0 | **16.3 GA 03/08/2026**. Blog chính chủ xác nhận hỗ trợ TypeScript 7 cho type-check trong `next build` | [nextjs.org/blog/next-16-3](https://nextjs.org/blog/next-16-3) | **Verified** |
| 3 | NestJS | 11 (adapter Fastify v5) | `@nestjs/core` npm `latest` = **11.2.1**. NestJS 11 yêu cầu Node 20+ và ship hỗ trợ **Fastify v5** + Express v5. `next` = 12.0.0-alpha.5 (chưa ổn định) | [npm dist-tags](https://registry.npmjs.org/-/package/@nestjs/core/dist-tags) · [nestjs/nest#14450](https://github.com/nestjs/nest/issues/14450) | **Verified** |
| 4 | PostgreSQL | 18 (18.6 hiện hành; 19 đang beta — không nâng vội) | **18.6 phát hành 13/08/2026**; **19 Beta 3** cùng ngày, GA dự kiến ~09–10/2026. Lưu ý 18.5 bị bỏ do regression | [postgresql.org news](https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/) | **Verified** (chính xác cả sắc thái) |
| 5 | pgvector | 0.8.x | **v0.8.6 (29/07/2026)**. Nhịp phát hành dày trong 2026: 0.8.3 → 0.8.6 chỉ trong 6 tuần | [GitHub tags](https://github.com/pgvector/pgvector/tags) | **Verified** |
| 6 | Redis | 7.x | **Redis 8.8.1 (23/07/2026)** là bản ổn định hiện hành. Redis 8.0 đổi giấy phép thêm **AGPLv3**. **Redis 7.4 hết vòng đời 30/11/2026** | [versionlog.com/redis](https://versionlog.com/redis/) · [Redis product lifecycle](https://redis.io/docs/latest/operate/rs/installing-upgrading/product-lifecycle/) | **CORRECTED — SAI** |
| 7 | LiveKit server | 1.9.x | **v1.13.5 (31/07/2026)**. Docker Hub tag `latest` trỏ đúng v1.13.5. Đã đi qua các dòng 1.10, 1.11, 1.12, 1.13 | [CHANGELOG](https://github.com/livekit/livekit/blob/master/CHANGELOG.md) · [Docker Hub](https://hub.docker.com/r/livekit/livekit-server/tags) | **CORRECTED — SAI** |
| 8 | coturn | "bản hiện hành của distro" | Upstream hiện hành **4.13.1**. Nhưng "bản của distro" thường tụt hậu nhiều so với upstream | [coturn releases](https://github.com/coturn/coturn/releases) | **Unverifiable** (xem §5) |
| 9 | Caddy | "bản hiện hành" | **v2.11.4 (03/06/2026)**, dự án còn sống khoẻ | [caddyserver/caddy releases](https://github.com/caddyserver/caddy/releases) · [endoflife.date/caddy](https://endoflife.date/caddy) | **Verified** (nhưng không phải một tuyên bố phiên bản) |

**Tổng kết:** 4 verified chắc chắn · 2 sai phải sửa · 1 cần định nghĩa lại (TypeScript) · 2 là "không tuyên bố gì" nên không kiểm được.

---

## 2. LiveKit — kiểm chuyên sâu (yêu cầu #2)

### 2.1 Phiên bản — SAI

Spine ghi **1.9.x**. Thực tế **1.13.5**. Kiểm chéo hai nguồn độc lập:

- `CHANGELOG.md` trên nhánh master: mục trên cùng là `[1.13.5] - 2026-07-31`
- Docker Hub API: tag `latest` và `v1.13` cùng trỏ tới build ngày `2026-07-31`, tag `v1.13.5` tồn tại

Dòng 1.9.x là dòng cũ **bốn thế hệ minor**. Đây là dấu hiệu điển hình của khẳng định theo trí nhớ: 1.9.x là con số đúng ở thời điểm dữ liệu huấn luyện, không phải ở 08/2026.

### 2.2 Go / Pion — ĐÚNG

README chính chủ: *"LiveKit's server is written in Go, using the awesome Pion WebRTC implementation."* → **Verified**.

### 2.3 Client SDK cho web + iOS/Android native — ĐÚNG

Đây là chỗ spine dựa vào cho app điện thoại tương lai. Xác nhận LiveKit công bố:

| Nền tảng | SDK |
|---|---|
| Web | JavaScript/TypeScript (+ React declarative) |
| iOS / macOS | **Swift** (có SwiftUI) |
| Android | **Kotlin** (có Compose) |
| Đa nền | Flutter, React Native (beta), Rust |

→ **Verified.** Giả định "app phone sau này dùng lại hợp đồng `/v1` + LiveKit native SDK" là giả định đứng vững.

### 2.4 Webhook server-side về participant/track — TỒN TẠI, nhưng AD-3 có LỖ HỔNG

**Không phải CRITICAL** — webhook có thật. Nhưng **không đủ như AD-3 mô tả**.

Bộ webhook đầy đủ mà LiveKit công bố:

`room_started` · `room_finished` · `participant_joined` · `participant_left` · `participant_connection_aborted` · `track_published` · `track_unpublished` · `egress_started` · `egress_updated` · `egress_ended` · `ingress_started` · `ingress_ended`

Hai vấn đề nghiêm trọng với AD-3:

#### Vấn đề A — Không có webhook cho MUTE

AD-3 viết: *"Điều kiện 'phiên còn tính tiền' suy ra từ tín hiệu server-side của LiveKit (webhook + server SDK) về trạng thái participant **và audio track**."*

**Không tồn tại `track_muted` / `track_unmuted` ở tầng webhook.** Tài liệu chính chủ nói rõ: `TrackMuted`/`TrackUnmuted` là **sự kiện phía client**, không có webhook tương ứng.

Hệ quả cụ thể cho StuWith: người **được hỏi** tắt mic vẫn **giữ nguyên track đã publish**. Không có `track_unpublished`, không có webhook nào bắn ra. Nếu scheduler chỉ nghe webhook, nó sẽ **tiếp tục trừ coin của người học trong khi người được hỏi đã tắt tiếng** — đúng chính xác kịch bản mà AD-3 tuyên bố mình ngăn chặn.

**Khắc phục:** trạng thái mute chỉ lấy được qua **server SDK**, không qua webhook — `ListParticipants` / `GetParticipant` trả `ParticipantInfo` có cờ `muted` trên từng track. Vì AD-7 đã bắt "trừ ở đầu block", cách tự nhiên là: **tại mỗi mốc block, scheduler chủ động gọi server SDK để đọc trạng thái thật**, coi webhook chỉ là tín hiệu đánh thức.

#### Vấn đề B — Webhook là best-effort, mâu thuẫn nội bộ với AD-2

Tài liệu LiveKit: *"Due to the protocol's push-based nature, there are no guarantees around delivery."* Có retry và có sắp thứ tự, nhưng **không bảo đảm giao hàng**.

Đây là mâu thuẫn logic bên trong spine:

- **AD-2** loại bỏ đường media khỏi luồng tiền với lý do *"giao hàng chỉ là best-effort"*
- **AD-3** lại đặt toàn bộ điều kiện tính tiền lên **webhook — cũng best-effort**

Cùng một lý do bác bỏ data channel thì cũng bác bỏ việc coi webhook là nguồn sự thật. Spine cần nói rõ: **server SDK (pull) là nguồn quyết định; webhook (push) chỉ là tối ưu độ trễ.** Hiện AD-3 viết "webhook + server SDK" như thể hai thứ ngang quyền — chưa đủ chặt cho một đường có tiền.

> **Điểm sáng:** AD-4 (idempotent theo `block_index`) và AD-16 (đóng phòng hai bước) đã hấp thụ được phần lớn hậu quả của webhook mất gói. Kiến trúc không sụp; nhưng câu chữ của AD-3 thì cần sửa.

---

## 3. TypeScript — câu trả lời là **cả 6.x lẫn 7.x**, không phải 5.x (yêu cầu #4)

Spine để ngỏ: *"kiểm dòng hiện hành trước khi khởi tạo repo — Next.js 16.3 tối ưu quanh TypeScript 7"*. Để ngỏ là **khôn ngoan**, nhưng gợi ý nghiêng về TS 7 lại **giấu một cái bẫy chí mạng cho monorepo này**.

### Sự thật đã kiểm

| Câu hỏi | Trả lời |
|---|---|
| TS 5.x có phải dòng hiện hành? | **Không.** Đã lỗi thời hai major |
| npm `latest` | **7.0.2** |
| TS 7.0 GA | 08/07/2026, port native Go, nhanh ~10× |
| Next.js 16.3 có hỗ trợ TS 7? | **Có**, chính chủ hướng dẫn `pnpm add -D typescript@^7` để type-check khi `next build` |
| NestJS 11 có build được bằng TS 7? | **KHÔNG** |

### Cái bẫy

TypeScript 7.0 **không ship compiler API lập trình được**. Mà `nest build` chính là một chương trình `import typescript` rồi gọi `createProgram()` / `program.emit()` với transformer riêng. Hệ quả:

- `nest build` **không chạy được** trên TS 7
- Các CLI plugin của **Swagger và GraphQL** cũng hỏng theo — đáng lo trực tiếp cho **AD-13** (`packages/contracts` phải "sinh được OpenAPI")
- Phần decorator thì ổn: trình biên dịch Go **có** xử lý `experimentalDecorators` và `emitDecoratorMetadata`, nên `design:paramtypes` mà DI của Nest đọc lúc boot vẫn được phát ra

### Khuyến nghị cho spine

Đây là monorepo **một dòng TypeScript dùng chung** cho `apps/web` (Next.js) và `apps/api` + `apps/realtime-gateway` (NestJS), với `packages/domain` và `packages/contracts` nằm giữa. Không thể chọn một con số duy nhất. Cấu hình đang chạy được trong thực tế là **cài song song**:

- **TS 7.0.2** — type-check toàn repo, và build phía `apps/web`
- **`@typescript/typescript6@^6.0.2`** — riêng cho `nest build` và các CLI plugin sinh OpenAPI

→ Spine nên **ghi thẳng ràng buộc này vào Stack**, vì nó không phải chi tiết cấu hình mà là **một ràng buộc kiến trúc thật**: AD-13 (sinh OpenAPI) phụ thuộc vào toolchain của Nest, mà toolchain đó chưa qua được TS 7.

---

## 4. pgvector so với vector DB chuyên dụng (yêu cầu #3)

**Kết luận: lựa chọn của spine đúng, và đúng vì lý do đúng.**

- Phiên bản **0.8.6** — verified, dự án phát triển tích cực trong 2026
- Ở quy mô **dưới ~5 triệu vector**, pgvector cho độ trễ ngang ngửa vector DB chuyên dụng (một tới hai chữ số mili-giây). Đa số ứng dụng không bao giờ vượt mốc này
- Vector DB chuyên dụng (Pinecone…) chỉ thắng ở quy mô **hàng trăm triệu tới hàng tỉ vector**

Với US-3.1 (vector mô tả lớp học), số vector xấp xỉ số phòng — cách ngưỡng chuyển đổi nhiều bậc độ lớn. Thêm nữa, luận điểm mạnh nhất lại khớp thẳng với triết lý của spine: **một hệ thống, một backup, một transaction**. Bảng `room_embeddings` nằm cùng DB với `rooms` nghĩa là vector và dữ liệu quan hệ cập nhật **nguyên tử** trong cùng transaction — điều mà tách vector DB riêng sẽ phá vỡ, và sẽ phải dựng job đồng bộ, đúng loại "cạnh thừa" mà AD-8 sinh ra để tránh.

Mục Deferred *"Chọn nhà cung cấp embedding… pgvector cố định phía lưu trữ"* cũng là cách chia đúng: khoá phía lưu trữ, thả lỏng phía sinh vector.

Nguồn: [Postgres as a Vector Database: pgvector in Production 2026](https://devstarsj.github.io/2026/06/22/pgvector-postgres-vector-database-production-2026/) · [pgvector vs Qdrant (2026)](https://open-techstack.com/blog/pgvector-vs-qdrant-2026/)

---

## 5. coturn + Caddy (yêu cầu #5)

### Caddy — vẫn là lựa chọn hợp lý

v2.11.4 (03/06/2026), dự án khoẻ mạnh. Việc spine **chốt hẳn Caddy thay vì để ngỏ Caddy/Traefik** là quyết định đúng tinh thần "spine không để ngỏ hai lựa chọn".

**Nhưng có mâu thuẫn nhỏ:** mục Stack chốt Caddy, trong khi sơ đồ Mermaid "Triển khai & môi trường" vẫn ghi node `E[Caddy/Traefik · TLS]`. Sơ đồ chưa được cập nhật theo quyết định. Cần sửa thành `E[Caddy · TLS]`.

### coturn — vẫn là lựa chọn mặc định, nhưng dòng Stack là một "không-tuyên-bố"

coturn vẫn là TURN server mã nguồn mở tiêu chuẩn cho WebRTC tự vận hành; upstream hiện hành **4.13.1**. Luận điểm *"coturn là bắt buộc, không phải tuỳ chọn"* là **đúng về mặt kỹ thuật** — WebRTC qua Internet thật luôn cần TURN cho tỉ lệ đáng kể người dùng sau NAT đối xứng / firewall doanh nghiệp.

**Vấn đề:** *"bản hiện hành của distro"* không phải một phiên bản đã kiểm — đó là uỷ thác quyết định cho một biến chưa xác định (distro nào chưa được nêu). coturn trong repo distro ổn định thường tụt hậu đáng kể so với upstream 4.13.1. Vì `infra/docker-compose.yml` đã có sẵn, nên **ghim thẻ image cụ thể** thay vì trỏ tới "distro" — vốn còn chẳng phải khái niệm rõ nghĩa khi chạy trong container. Đánh dấu **Unverifiable** vì không có tuyên bố nào để kiểm.

---

## 6. Những tuyên bố mang dấu vân tay của trí nhớ huấn luyện (yêu cầu #6)

| Tuyên bố | Vì sao đáng ngờ | Mức độ |
|---|---|---|
| **"LiveKit server 1.9.x"** | 1.9.x là dòng đúng ở thời điểm cắt dữ liệu huấn luyện, không phải 08/2026. Lệch bốn dòng minor. Không ai vừa mở [releases](https://github.com/livekit/livekit/releases) hôm nay lại viết ra 1.9.x | **Cao** |
| **"Redis 7.x"** | Cùng dạng: 7.x là con số của trí nhớ. Bỏ sót hoàn toàn hai sự kiện lớn — Redis 8.x đã ra, và giấy phép đổi sang AGPLv3 từ 8.0. Một lần tra cứu thật chắc chắn sẽ đụng phải chuyện giấy phép | **Cao** |
| **"Đã kiểm trên web ngày 20/08/2026"** (dòng đầu mục Stack) | Bị chính hai dòng trên phản chứng. Câu này nguy hiểm hơn cả hai lỗi phiên bản: nó **dập tắt sự hoài nghi của người đọc sau** đối với mọi dòng trong bảng, kể cả những dòng chưa từng được kiểm | **Cao** |
| "coturn — bản hiện hành của distro" | Không phải kết quả tra cứu; là chỗ trống được lấp bằng câu chữ trông giống quyết định | Trung bình |
| "Next.js 16.3 **tối ưu quanh** TypeScript 7" | Gần đúng nhưng nói quá. Next.js 16.3 **hỗ trợ** TS 7 cho type-check (tuỳ chọn, phải tự bump dependency); nó không "tối ưu quanh" TS 7 và không yêu cầu TS 7 | Thấp |
| `E[Caddy/Traefik]` trong sơ đồ | Tàn dư của trạng thái "còn để ngỏ" trước khi Stack chốt Caddy — quyết định chưa lan hết vào artifact | Thấp |

**Điểm ghi nhận ngược lại:** dòng PostgreSQL (*"18.6 hiện hành; 19 đang beta — không nâng vội"*) **chỉ có thể đến từ một lần tra cứu thật**. PG 18.6 mới ra ngày 13/08/2026 — bảy ngày trước. Kèm nhận định đúng rằng 19 đang beta. Tương tự, Next.js 16.3 ra 03/08/2026 và NestJS 11 + Fastify v5 cũng chính xác. Nghĩa là **có tra cứu thật, nhưng không phủ hết bảng** — nguy hiểm hơn là không tra gì, vì kết quả trông đồng đều đáng tin.

---

## 7. Việc cần làm

### Bắt buộc sửa

1. **Stack → LiveKit server: `1.9.x` → `1.13.x`** (hiện hành 1.13.5). Kiểm lại ghi chú vận hành nếu có gì bám theo hành vi của 1.9.
2. **Stack → Redis: `7.x` → quyết định lại.** Redis 7.4 EOL **30/11/2026** — tức là hết vòng đời **ngay trong lúc MVP đang xây**. Hai đường:
   - **Redis 8.8.x** — chính danh, nhưng cần chấp nhận **AGPLv3**
   - **Valkey 9.x** — fork BSD-3, tương thích API, đã là mặc định ở AWS ElastiCache và Google Memorystore

   Đây **không phải** chuyện hoãn được: giấy phép là quyết định pháp lý, và spine đã tự đặt chuẩn "không để ngỏ hai lựa chọn" ở dòng Caddy.
3. **Sửa AD-3** cho khớp thực tế LiveKit:
   - Nói rõ **server SDK (pull) là nguồn quyết định**, webhook chỉ là tín hiệu đánh thức — vì webhook là best-effort, đúng lý do mà AD-2 dùng để loại data channel
   - Xử lý **mute**: không có webhook mute; trạng thái mute phải đọc qua `ListParticipants`/`GetParticipant` tại mỗi mốc block
4. **Bỏ tuyên bố "Đã kiểm trên web ngày 20/08/2026"** hoặc thu hẹp lại còn đúng những dòng thật sự đã kiểm, kèm ngày kiểm riêng từng dòng.

### Nên sửa

5. **Ghi ràng buộc TypeScript kép vào Stack:** TS 7.0.x để type-check + build web; `@typescript/typescript6` để `nest build` và sinh OpenAPI (AD-13). Kèm điều kiện thoát: bỏ TS 6 khi Nest hỗ trợ được API của TS 7.
6. **Ghim phiên bản coturn cụ thể** trong `infra/docker-compose.yml` thay vì "bản hiện hành của distro".
7. **Sửa sơ đồ triển khai:** `E[Caddy/Traefik · TLS]` → `E[Caddy · TLS]` cho khớp quyết định ở Stack.

### Ghi nhận không cần sửa

- **PostgreSQL 18 / 18.6, hoãn 19** — chính xác, kèm sắc thái đúng
- **Next.js 16.3.0** — chính xác
- **NestJS 11 trên Fastify v5** — chính xác và tương thích
- **pgvector 0.8.x** — chính xác, và là lựa chọn đúng ở quy mô này
- **LiveKit là Go/Pion, có SDK web + iOS Swift + Android Kotlin** — chính xác; giả định app phone tương lai đứng vững
- **Caddy** — còn sống khoẻ, chốt hẳn là đúng
- **coturn bắt buộc chứ không tuỳ chọn** — đúng về kỹ thuật

---

## 8. Nguồn đã tra

- https://nextjs.org/blog/next-16-3
- https://registry.npmjs.org/-/package/typescript/dist-tags
- https://registry.npmjs.org/-/package/@typescript/typescript6/dist-tags
- https://registry.npmjs.org/-/package/@nestjs/core/dist-tags
- https://www.infoq.com/news/2026/08/typescript-7-released/
- https://fernforge.github.io/devnotes/nestjs-typescript-7/
- https://github.com/nestjs/nest/issues/14450
- https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/
- https://github.com/pgvector/pgvector/tags
- https://github.com/livekit/livekit/blob/master/CHANGELOG.md
- https://hub.docker.com/r/livekit/livekit-server/tags
- https://github.com/livekit/livekit
- https://docs.livekit.io/home/server/webhooks/
- https://docs.livekit.io/home/server/managing-participants/
- https://versionlog.com/redis/
- https://redis.io/docs/latest/operate/rs/installing-upgrading/product-lifecycle/
- https://github.com/coturn/coturn/releases
- https://github.com/caddyserver/caddy/releases
- https://endoflife.date/caddy
- https://devstarsj.github.io/2026/06/22/pgvector-postgres-vector-database-production-2026/
- https://open-techstack.com/blog/pgvector-vs-qdrant-2026/
