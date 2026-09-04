# Epic 1 Context: Vào được StuWith với danh tính của mình

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 1 đưa người dùng vào sản phẩm với một danh tính mà hệ thống hiểu được: đăng nhập bằng tài khoản mạng xã hội sẵn có, có hồ sơ kèm ngày sinh, và hệ thống biết họ được phép làm gì. Đồng thời epic này dựng nền vật lý mà mọi epic sau đứng lên — khung monorepo hai process, stack local chạy bằng `docker compose`, bốn cổng CI biến vi phạm kiến trúc thành lỗi build, bộ token thiết kế light/dark, đường audit bất biến và bộ lọc PII. Đây là repo greenfield: mọi ràng buộc dưới đây phải được *cài đặt* ở epic này chứ không suy ra từ code sẵn có. Bối cảnh sản phẩm quyết định độ nghiêm của epic: sản phẩm đặt cược vào việc tách *sự hiện diện* khỏi *danh tính* — học ẩn mặt mà vẫn tích được uy tín thật — và những đối trọng giữ cho ẩn danh không biến thành nơi trú ẩn (chặn hành vi có tiền với người dưới 18, audit bất biến, PII không rò) chính là phần Epic 1 gánh. Chúng không phải tính năng phụ; chúng là điều kiện để phần còn lại của sản phẩm được phép tồn tại.

## Stories

- Story 1.1: Dựng khung monorepo, hai process và bốn cổng CI
- Story 1.2: Đăng nhập bằng bốn provider mạng xã hội
- Story 1.3: Trạng thái lỗi đăng nhập và chống brute-force
- Story 1.4: Khai ngày sinh khi tạo hồ sơ lần đầu
- Story 1.5: Cổng chặn hành vi có tiền theo tuổi
- Story 1.6: Hệ thiết kế "Cắm trại" — token light và dark
- Story 1.7: Audit log append-only và lọc PII khỏi log

## Requirements & Constraints

- **Đăng nhập 4 provider**: Google, Facebook, Apple, Microsoft; Microsoft phải đi được luồng Azure AD/Entra cho tài khoản tổ chức. Lần đầu tự tạo hồ sơ; lần sau map đúng user theo provider-id, không sinh tài khoản trùng.
- **Lỗi đăng nhập không lộ kỹ thuật**: thất bại, bị rate-limit, provider từ chối, phiên hết hạn đều nói *chuyện gì đã xảy ra và làm gì tiếp*. Không mã lỗi, không tên provider hỏng, không stack trace. Rate-limit trả đếm ngược thật bằng giây. Người dùng huỷ ở bước cấp quyền **không** phải lỗi. Phiên hết hạn giữa buổi học thì hiện dialog và giữ nguyên phòng để quay lại.
- **Ngày sinh bắt buộc, không tự sửa**: khai ở bước tạo hồ sơ lần đầu, không bỏ qua được; đổi phải qua luồng hỗ trợ. Ngày sinh là PII — không vào log, không lên hồ sơ công khai; hồ sơ chỉ thể hiện đủ/chưa đủ 18 khi luật nghiệp vụ cần.
- **Cổng tuổi chặn đúng một chiều**: tài khoản dưới 18 bị chặn **ở tầng API** với mọi hành vi có *tiền đi vào* — bật "nhận hỏi riêng", đặt đơn giá, nhận coin **từ người dùng khác**. Chặn cả khi client gọi thẳng API, không chỉ ẩn nút. Ngược lại: coin do **hệ thống** cấp (số dư ban đầu, thưởng uy tín) **không** bị luật tuổi chạm tới, và người dưới 18 **vẫn tiêu được coin** để hỏi riêng người khác. Đây là giả định cần rà lại nếu sau này mở quy đổi coin ↔ tiền thật.
- **Mô hình vai trò phải chứa được sáu vai ngay từ đầu**: `guest` (chỉ trang công khai) · `user` (có cờ đủ/chưa đủ 18 chi phối mọi hành vi có tiền) · `host` (**quyền theo từng phòng, không phải quyền toàn cục**) · `org_admin` (gói Campus) · `moderator` · `system_admin`. Hai vai cuối chưa có giao diện trong MVP, nhưng mô hình phân quyền phải có chỗ cho chúng.
- **Rò rỉ PII là cổng phát hành, không phải mục tiêu**: "0 sự cố rò rỉ credential/PII trong log" là một trong ba tiêu chí bắt buộc đạt trước khi mở cho người dùng thật. Ngày sinh tính là PII.
- **Chống tấn công**: rate limit theo IP **và** theo user; khoá brute-force đăng nhập; WAF và chống DDoS ở gateway.
- **Bảo mật & governance vận hành**: credential chỉ trong env var/secret store, không có giá trị mặc định cho bí mật; pipeline có bước quét credential; audit log bất biến cho hành động nhạy cảm; deploy cần một bước duyệt thủ công; có risk registry.
- **Web là client thuần**: không luật nghiệp vụ nào sống ở `apps/web`. Hợp đồng API versioned `/v1` tồn tại để app phone sau này dùng lại — đó là lý do thật của việc tách hai process, không phải thẩm mỹ kiến trúc.
- **Không lưu tệp nhị phân nào của người dùng**: MVP không ghi hình, **không có object store** trong stack (kể cả trong compose), và **không endpoint nào nhận tệp**. Avatar sinh ở client từ chữ cái; ảnh hồ sơ dùng URL từ OAuth provider.
- **Thiết kế**: Material 3 làm xương với nhận diện riêng "Cắm trại"; i18n VI (mặc định) + EN; light và dark ngang hàng; WCAG 2.1 AA là sàn.
- **Danh từ miền dùng nguyên văn ở mọi nơi** — tài liệu, story, khoá i18n, tên module, chữ trên giao diện: Phòng học · Phiên hỏi riêng · Hỏi cả phòng · Đơn giá · Block · Số dư · Ví coin · Chế độ khuôn mặt · Ẩn mặt · Điểm nỗ lực · Hạng uy tín · Huy hiệu học vấn · Badge kỹ năng · Study Buddy / Study Circle / Campus (luôn viết đủ tên). Biến thể là lỗi, không phải phong cách.

## Technical Decisions

- **Kiến trúc**: modular monolith, lõi hexagonal (ports & adapters), triển khai thành **hai process** — `apps/api` (REST `/v1`, OAuth, cấp token phòng học) và `apps/realtime-gateway` (WebSocket, coin scheduler, phiên, chat, presence). Mỗi process có health-check riêng.
- **Cây nguồn cố định**: `apps/web` · `apps/api` · `apps/realtime-gateway` · `packages/domain` · `packages/contracts` · `packages/db` · `packages/config` · `infra/docker-compose.yml` + `infra/livekit.yaml`. Thư mục kebab-case; module NestJS đặt theo danh từ miền ở trên (`private-session`, không phải `chat-1v1`).
- **Chiều phụ thuộc chỉ đi vào trong**: `packages/domain` không import từ `apps/*`, `packages/db`, hay bất kỳ SDK hạ tầng nào. Cưỡng chế **chính** bằng TypeScript project references (tsconfig của `domain` đơn giản không reference hạ tầng — import sai không resolve được, `tsc` báo đúng dòng vi phạm); **phụ** bằng `dependency-cruiser` trong CI. Không dùng ESLint làm lớp chính vì `eslint-disable` bỏ qua được.
- **Stack đã ghim**: Next.js 16.3.0 · NestJS 11.2.1 trên Fastify v5 · PostgreSQL 18 · pgvector 0.8.6 · **Valkey 9.0.4** (BSD-3, thay Redis) · LiveKit 1.13.5 · coturn (**bắt buộc**, không tuỳ chọn; ghim bản cụ thể khi dựng compose) · Caddy 2.11.4 (TLS ở edge). ⚠️ Các sơ đồ trong tài liệu kiến trúc còn ghi nhãn cũ "Redis" — **bảng Stack thắng, dùng Valkey**.
- **TypeScript kép, viết thành luật trong repo**: `typescript@7.0.2` cho typecheck toàn repo + build `apps/web`; `@typescript/typescript6@6.0.2` (binary `tsc6`) cho `nest build`. **Cấm tới TS 7.1**: `ts-jest`, `ts-node`, `ts-morph`, và `@typescript-eslint/*` với `parserOptions.project` (lint chạy không bật type-aware rules).
- **Test stack**: **Vitest** cho unit + integration (transform bằng esbuild, không chạm compiler API); **Playwright** cho E2E và cả API test không cần trình duyệt. `packages/domain` chạy environment `node` **không có setup file nào chạm DB hoặc mạng** — đó là cách luật chiều phụ thuộc được kiểm chứng chứ không chỉ được tuyên bố. Contract testing kiểu Pact hoãn có chủ ý. Phiên bản của vitest / playwright / dependency-cruiser / testcontainers / gitleaks **chưa được kiểm** — phải kiểm và ghim từng cái khi cài, và xác nhận yêu cầu Node/Vite của Vitest khớp với Node mà Next.js và NestJS đang dùng.
- **Bốn cổng CI (GitHub Actions)**: (1) quét credential bằng `gitleaks` trên toàn lịch sử PR · (2) kiểm chiều phụ thuộc · (3) test hợp đồng adapter chạy **hai lần**: adapter in-memory và PostgreSQL 18 thật qua Testcontainers · (4) migration chạy được trên bản sao DB **có dữ liệu**. Deploy VPS dùng GitHub Environments + required reviewers. Ràng buộc bảo mật bắt buộc: mọi giá trị từ context không tin được (`github.event.*`, `inputs.*`) phải đi qua biến `env:` trung gian, **không bao giờ nội suy thẳng vào khối `run:`**.
- **Test-kit hợp đồng adapter**: `packages/db` export một hàm nhận implementation của một port và chạy trọn bộ assertion hợp đồng, chạy lại được trên mọi adapter. Epic 1 chỉ cần khung chạy được với một port giả; port thật đến ở Epic 3.
- **Cấu hình**: đọc từ env var, kiểm schema lúc khởi động, **fail fast** nêu đúng tên biến thiếu. Local và VPS dùng cùng một `docker-compose`, chỉ khác file env.
- **Hai DB role riêng, cưỡng chế bằng `GRANT`**: role của `api` **không có** `INSERT`/`UPDATE` trên `coin_ledger`, `user_balances`; role của `realtime-gateway` **không có** `UPDATE` trên `users`, `rooms`, `plans`. Người dùng / hồ sơ / tuổi / xác minh thuộc chủ ghi `api`. Sở hữu viết bằng lời văn là góp ý; cưỡng chế bằng quyền DB mới là bất biến.
- **Audit append-only**: `audit_events` được cả hai process ghi nhưng không role nào có `UPDATE`/`DELETE`, và trong code cũng không tồn tại đường gọi hai lệnh đó. Hành động nhạy cảm (đăng nhập, cấp token phòng, thay đổi số dư, báo cáo, moderation) sinh đúng một dòng mang `request_id` truy được xuyên hai process. **Hình dạng dòng audit khai trong `packages/contracts`** để hai process không ghi hai kiểu.
- **Logging**: JSON có cấu trúc, một dòng một sự kiện, `request_id` xuyên suốt. Lọc PII theo **danh sách trắng** — chỉ id và trường đã khai được ghi; trường mới thêm vào payload mặc định **không** vào log. Email, provider-id, ngày sinh, access token, nội dung chat không bao giờ vào log ở bất kỳ mức nào.
- **Hợp đồng `/v1`**: mọi payload qua ranh giới process khai trong `packages/contracts` (schema kiểm lúc chạy, sinh được OpenAPI); không type hợp đồng nào khai ở `apps/*`. Thêm trường **tuỳ chọn** là tương thích; đổi tên, đổi kiểu, bỏ trường, siết ràng buộc là phá vỡ và phải lên `/v2`.
- **Envelope lỗi duy nhất**: `{ error: { code, message, details? } }` — `code` là hằng máy đọc, `message` đã i18n cho người đọc. Không bao giờ đẩy stack trace hay mã lỗi provider ra client.
- **Auth**: session cookie `httpOnly` + `secure`, refresh flow chuẩn. Ranh giới WebSocket xác thực **ngay khi bắt tay** bằng chính session của `api` và **xác thực lại** khi phiên bị thu hồi, không giữ mãi tới khi client tự ngắt.
- **Luật tuổi là hàm thuần trong domain**: `canReceiveMoney(user)` sống ở `packages/domain`, test được không cần DB. Ở `apps/api`, guard áp dụng **tự động** qua decorator/metadata — endpoint mới chỉ cần đánh dấu là hành vi có tiền đi vào, không chép lại điều kiện tuổi.
- **Quy ước chung**: khoá chính UUIDv7 · bảng snake_case số nhiều · sự kiện `<danh-từ>.<động-từ quá khứ>` · thời gian `timestamptz` luôn UTC · coin là **số nguyên**, không dùng số thực ở bất kỳ đâu trong đường tiền · migration chỉ tiến, chạy được trên DB đang có dữ liệu mà không khoá bảng lâu · mọi lệnh ghi có hệ quả tiền hoặc quyền mang khoá idempotent do bên gọi cung cấp.
- **Thứ tự dựng bảng**: `users` ra đời ở Story 1.2, không sớm hơn.

## UX & Interaction Patterns

- **Hai giọng theo vùng, nhầm vùng là lỗi**: vùng *ấm* (khám phá, pre-join, phòng live, chat, hồ sơ) ngang hàng, ngắn, không khách sáo; vùng *chính xác* (ví coin, xác nhận hỏi riêng, báo cáo, xác minh) trung tính, có số liệu và mốc thời gian, không đùa, không trấn an. Mọi câu về tiền phải chứa con số, và khi là việc đã xảy ra thì chứa cả mốc thời gian. Lỗi kỹ thuật không bao giờ lộ ra giao diện.
- **Token màu đủ cả light và dark**, ánh xạ theo quy ước `X` → `X-dark`; component chỉ viết tên token gốc, trình phân giải tự đổi ở chế độ tối. Token không có cặp `-dark` (spacing, rounded, typography, motion) dùng chung cho cả hai chế độ. **Không màu nào được định nghĩa chỉ bên trong một media query** — ba trạng thái (theo hệ điều hành / chọn tay light / chọn tay dark) đều phải render đúng một bộ màu nhất quán.
- **Ngưỡng tương phản là hợp đồng**: mọi cặp tiền cảnh/hậu cảnh chịu lực ≥ AA 4.5:1 ở cả hai chế độ; `border-ink` ≥ 3:1 (WCAG 1.4.11) vì viền 2px là thành phần chịu lực, không phải trang trí. Coral là màu nhấn trang trí duy nhất và **không bao giờ mang chữ**; `coin-fill` chỉ làm mảng đặc, không làm màu chữ; màu vàng coin chỉ thuộc về tiền. **Màu không bao giờ là kênh duy nhất** mang thông tin.
- **Typography**: Be Vietnam Pro (fallback Roboto → Segoe UI → system-ui), thang nghiêng về đậm (`body` 500, tiêu đề 800). Mọi con số biến thiên theo thời gian dùng `font-variant-numeric: tabular-nums`. Không in hoa toàn phần cho câu tiếng Việt.
- **Độ sâu bằng bóng lệch cứng**: khối màu `border-ink` dịch 3–6px theo trục chéo, **không blur, không alpha**, bốn mức, giảm một mức ở dark mode. Không bao giờ trộn với bóng mờ.
- **Motion**: có token duration/easing riêng; dưới `prefers-reduced-motion` tắt mọi chuyển động trang trí nhưng **đồng hồ đếm ngược vẫn cập nhật** vì đó là thông tin, không phải hiệu ứng.
- **Component base** (`button-primary`, `button-secondary`, `chip-status`): cao tối thiểu 48px, vùng chạm ≥ 44px, kể cả trên desktop; bo `full`. Vòng focus 2px `primary` cách viền 2px, **không bao giờ tắt outline**.
- **A11y sàn**: bố cục reflow được ở tương đương 320px CSS width, không sinh cuộn ngang kể cả khi zoom 200%. Đoạn tiếng Anh nhúng trong câu tiếng Việt mang `lang="en"`.
- **Không được trông như phần mềm họp hành**: tránh xám công sở, xanh dương doanh nghiệp, nền dark ngả xám, và thanh điều khiển tự ẩn khi không di chuột.

## Cross-Story Dependencies

- **Story 1.1 chặn tất cả**: không có monorepo, hai process, hai DB role và bốn cổng CI thì không story nào khác có chỗ đứng. Đây cũng là nơi ghi bảng chính sách TypeScript kép vào `AGENTS.md`/`CONTRIBUTING` để người sau không vô tình cài `ts-jest`.
- **Story 1.2 → 1.3, 1.4**: bảng `users` và luồng OAuth ra đời ở 1.2; trạng thái lỗi (1.3) và bước khai ngày sinh (1.4) gắn vào chính luồng đó.
- **Story 1.4 → 1.5**: cổng tuổi chỉ có nghĩa khi ngày sinh đã tồn tại và không sửa tuỳ ý được.
- **Story 1.7 xuyên suốt**: bộ lọc PII và đường audit cần có mặt **trước** khi 1.2/1.4 bắt đầu xử lý email, provider-id và ngày sinh — dựng sớm hoặc song song, đừng để sau cùng.
- **Story 1.6 nuôi Epic 2 trở đi**: mọi component có đặc tả kép ở các epic sau đọc từ bộ token này; token thiếu ở đây thành nợ ở mọi màn hình sau.
- **Ra ngoài Epic 1**: khai gian tuổi rơi vào luồng report/moderation của Epic 4; endpoint thu hồi quyền (ban / hạ gói / chặn theo tuổi phải cắt được phiên đang chạy và đuổi khỏi phòng) cũng thuộc Epic 4 — Epic 1 chỉ dựng cổng chặn lúc cấp quyền, không dựng đường thu hồi.
- **Không đưa outbox vào Epic 1**: kênh lệnh bền xuyên process ra đời ở Epic 4. Epic 1 chỉ cần giữ đúng luật — không mở lời gọi HTTP đồng bộ giữa hai process cho việc có hệ quả tiền hoặc quyền.
- **Chuỗi epic**: Epic 1 → Epic 2 → Epic 3 / Epic 4 → Epic 5. Toàn bộ chuỗi đứng trên nền của Epic 1.
- **Sau Story 1.1**: chạy lại quy trình khởi tạo framework test để scaffold fixtures/helpers (preflight hiện fail vì repo chưa có `package.json`). Nếu Story 1.1 cài `@seontechnologies/playwright-utils` thì mandate thư viện của TEA bắt đầu ràng buộc từ thời điểm đó.
