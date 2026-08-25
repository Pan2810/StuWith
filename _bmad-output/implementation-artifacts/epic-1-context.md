# Epic 1 Context: Vào được StuWith với danh tính của mình

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 1 đưa người dùng vào được sản phẩm với một danh tính mà hệ thống hiểu: đăng nhập bằng tài khoản mạng xã hội sẵn có, có hồ sơ với ngày sinh, và hệ thống biết họ được phép làm gì. Đồng thời epic này dựng nền vật lý mà mọi epic sau đứng lên — bộ khung monorepo hai process, stack local chạy bằng `docker compose`, bốn cổng CI biến vi phạm kiến trúc thành lỗi build, bộ token thiết kế light/dark, và đường audit + lọc PII. Đây là repo greenfield: chưa có dòng code nào, nên mọi ràng buộc dưới đây phải được *cài đặt* trong epic này chứ không phải suy ra từ code sẵn có. Lưu ý về nguồn: dự án không có tài liệu PRD độc lập; yêu cầu đến từ bản phân rã epic và spine kiến trúc.

## Stories

- Story 1.1: Dựng khung monorepo, hai process và bốn cổng CI
- Story 1.2: Đăng nhập bằng bốn provider mạng xã hội
- Story 1.3: Trạng thái lỗi đăng nhập và chống brute-force
- Story 1.4: Khai ngày sinh khi tạo hồ sơ lần đầu
- Story 1.5: Cổng chặn hành vi có tiền theo tuổi
- Story 1.6: Hệ thiết kế "Cắm trại" — token light và dark
- Story 1.7: Audit log append-only và lọc PII khỏi log

## Requirements & Constraints

- **Đăng nhập 4 provider**: Google, Facebook, Apple, Microsoft; Microsoft phải đi được luồng Azure AD/Entra cho tài khoản tổ chức. Lần đầu tự tạo hồ sơ; các lần sau map đúng user theo provider-id, không sinh tài khoản trùng.
- **Lỗi đăng nhập không lộ kỹ thuật**: thất bại, bị rate-limit, provider từ chối, phiên hết hạn đều có thông báo thân thiện nói *chuyện gì đã xảy ra và làm gì tiếp*. Không mã lỗi, không tên provider hỏng, không stack trace. Rate-limit trả về đếm ngược thật bằng giây. Người dùng huỷ ở bước cấp quyền **không** phải lỗi. Phiên hết hạn giữa buổi học thì hiện dialog và giữ nguyên phòng để quay lại, không đá ra ngoài.
- **Ngày sinh bắt buộc, không tự sửa**: khai ở bước tạo hồ sơ lần đầu, không bỏ qua được; đổi phải qua luồng hỗ trợ. Ngày sinh là PII — không vào log, không lên hồ sơ công khai; hồ sơ chỉ thể hiện đủ/chưa đủ 18 khi luật nghiệp vụ cần.
- **Cổng tuổi cho tiền đi vào**: tài khoản dưới 18 bị chặn **ở tầng API** với mọi hành vi có tiền đi vào (nhận hỏi riêng, đặt giá, nhận coin) — chặn cả khi client gọi thẳng API, không chỉ ẩn nút. Phần còn lại của sản phẩm dùng bình thường, kể cả **tiêu coin** để hỏi riêng người khác; chỉ chiều tiền đi vào bị chặn.
- **Chống tấn công**: rate limit theo IP và theo user, khoá brute-force đăng nhập.
- **Bảo mật vận hành**: credential chỉ nằm trong env var/secret store, không có giá trị mặc định cho bí mật; 0 sự cố rò rỉ credential/PII trong log; audit log bất biến; deploy cần một bước duyệt thủ công.
- **Không lưu tệp nhị phân**: MVP không ghi hình, không có object store trong stack — kể cả trong `docker compose`.
- **Thiết kế**: Material 3 làm xương với nhận diện riêng "Cắm trại"; i18n VI (mặc định) + EN; light và dark ngang hàng; WCAG 2.1 AA là sàn.

## Technical Decisions

- **Kiến trúc**: modular monolith, lõi hexagonal (ports & adapters), triển khai thành **hai process** — `apps/api` (REST `/v1`, OAuth, cấp token phòng học) và `apps/realtime-gateway` (WebSocket, coin scheduler, phiên, chat, presence). Mỗi process có health-check riêng.
- **Cây nguồn cố định**: `apps/web` · `apps/api` · `apps/realtime-gateway` · `packages/domain` · `packages/contracts` · `packages/db` · `packages/config` · `infra/docker-compose.yml` + `infra/livekit.yaml`. Thư mục kebab-case; module NestJS đặt theo danh từ miền.
- **Chiều phụ thuộc chỉ đi vào trong**: `packages/domain` không import từ `apps/*`, `packages/db`, hay bất kỳ SDK hạ tầng nào. Cưỡng chế **chính** bằng TypeScript project references (tsconfig của `domain` đơn giản không reference hạ tầng — import sai không resolve được, `tsc` báo đúng dòng vi phạm), **phụ** bằng `dependency-cruiser` trong CI. Không dùng ESLint làm lớp chính vì `eslint-disable` bỏ qua được.
- **Stack đã ghim**: Next.js 16.3.0 · NestJS 11.2.1 trên Fastify v5 · PostgreSQL 18 · pgvector 0.8.6 · **Valkey 9.0.4** (BSD-3, thay Redis) · LiveKit 1.13.5 · coturn (ghim bản cụ thể khi dựng compose; **bắt buộc**, không tuỳ chọn) · Caddy 2.11.4 (TLS ở edge).
- **TypeScript kép, viết thành luật trong repo**: `typescript@7.0.2` cho typecheck toàn repo + build `apps/web`; `@typescript/typescript6@6.0.2` (binary `tsc6`) cho `nest build` — NestJS chưa build được dưới TS 7. **Cấm tới TS 7.1**: `ts-jest`, `ts-node`, `ts-morph`, và `@typescript-eslint/*` với `parserOptions.project` (lint chạy không bật type-aware rules).
- **Test stack**: **Vitest** cho unit + integration ở `packages/*` và cả hai app (transform bằng esbuild, không chạm compiler API); **Playwright** cho E2E của `apps/web` và cả API test không cần trình duyệt. `packages/domain` chạy environment `node` **không có setup file nào chạm DB hoặc mạng** — đó là cách luật chiều phụ thuộc được kiểm chứng chứ không chỉ được tuyên bố. Story 1.1 cần lệnh chạy được + smoke test chạm health-check hai process; chưa cần spec E2E. Contract testing kiểu Pact bị hoãn có chủ ý. Phiên bản cụ thể của vitest/playwright/dependency-cruiser/testcontainers/gitleaks **chưa được kiểm** — phải kiểm và ghim từng cái khi cài, và xác nhận yêu cầu Node/Vite của Vitest khớp với Node mà Next.js 16.3 và NestJS 11.2.1 đang dùng.
- **Bốn cổng CI (GitHub Actions)**: (1) quét credential bằng `gitleaks` trên toàn lịch sử của PR · (2) kiểm chiều phụ thuộc · (3) test hợp đồng adapter chạy **hai lần**: adapter in-memory và PostgreSQL 18 thật qua Testcontainers · (4) migration chạy được trên bản sao DB **có dữ liệu** (Testcontainers + dump có seed). Deploy VPS dùng GitHub Environments + required reviewers. Ràng buộc bảo mật bắt buộc: mọi giá trị từ context không tin được (`github.event.*`, `inputs.*`) phải đi qua biến `env:` trung gian, **không bao giờ nội suy thẳng vào khối `run:`**. Story 1.1 phải có test chứng minh cổng chiều phụ thuộc thật sự đỏ khi thêm một import vi phạm.
- **Test-kit hợp đồng adapter**: `packages/db` export một hàm nhận vào implementation của một port và chạy trọn bộ assertion hợp đồng. Story 1.1 chỉ cần dựng khung chạy được với một port giả; port thật đến ở Epic 3.
- **Cấu hình**: mọi config đọc từ env var, kiểm schema lúc khởi động, **fail fast** nêu đúng tên biến thiếu. Local và VPS dùng cùng một `docker-compose`, chỉ khác file env.
- **Hai DB role riêng**: mỗi process một role; quyền sở hữu ghi cưỡng chế bằng Postgres `GRANT`, không bằng lời văn. Role của `api` **không có** `INSERT`/`UPDATE` trên `coin_ledger`, `user_balances`; role của `realtime-gateway` **không có** `UPDATE` trên `users`, `rooms`, `plans`. Người dùng / hồ sơ / tuổi / xác minh thuộc chủ ghi `api`.
- **Audit append-only**: `audit_events` được cả hai process ghi nhưng không role nào có `UPDATE`/`DELETE`, và trong code cũng không tồn tại đường gọi hai lệnh đó. Hành động nhạy cảm (đăng nhập, cấp token phòng, thay đổi số dư, báo cáo, moderation) sinh đúng một dòng, mang `request_id` truy được xuyên hai process. **Hình dạng dòng audit khai trong `packages/contracts`** để hai process không ghi hai kiểu.
- **Logging**: JSON có cấu trúc, một dòng một sự kiện, `request_id` xuyên suốt. Bộ lọc PII theo **danh sách trắng** — chỉ id và trường đã khai được ghi; trường mới thêm vào payload mặc định **không** vào log. Email, provider-id, ngày sinh, access token, nội dung chat không bao giờ vào log ở bất kỳ mức nào.
- **Hợp đồng `/v1`**: mọi payload qua ranh giới process khai trong `packages/contracts` (schema kiểm lúc chạy, sinh được OpenAPI); không type hợp đồng nào khai ở `apps/*`. Thêm trường **tuỳ chọn** là tương thích; đổi tên, đổi kiểu, bỏ trường, siết ràng buộc là phá vỡ và phải lên `/v2`.
- **Envelope lỗi duy nhất**: `{ error: { code, message, details? } }` — `code` là hằng máy đọc, `message` đã i18n cho người đọc. Không bao giờ đẩy stack trace hay mã lỗi provider ra client.
- **Auth**: web dùng session cookie `httpOnly` + `secure` có refresh flow chuẩn. Ranh giới WebSocket xác thực **ngay khi bắt tay** bằng chính session của `api` và **xác thực lại** khi phiên bị thu hồi, không giữ mãi tới khi client tự ngắt.
- **Luật domain thuần**: chính sách tuổi sống ở `packages/domain` dưới dạng hàm thuần (`canReceiveMoney(user)`), test được không cần DB. Ở `apps/api`, guard áp dụng **tự động** qua decorator/metadata — endpoint mới chỉ cần đánh dấu là hành vi có tiền đi vào, không chép lại điều kiện tuổi.
- **Quy ước chung**: khoá chính UUIDv7 · bảng snake_case số nhiều · sự kiện `<danh-từ>.<động-từ quá khứ>` · thời gian `timestamptz` luôn UTC · coin là **số nguyên**, không dùng số thực ở bất kỳ đâu trong đường tiền · migration chỉ tiến, chạy được trên DB đang có dữ liệu mà không khoá bảng lâu · mọi lệnh ghi có hệ quả tiền hoặc quyền mang khoá idempotent do bên gọi cung cấp.
- **Thứ tự dựng bảng**: `users` ra đời ở Story 1.2, không sớm hơn.

## UX & Interaction Patterns

- **Hai giọng theo vùng, nhầm vùng là lỗi**: vùng *ấm* (khám phá, pre-join, phòng live, hồ sơ) nói ngang hàng, ngắn, không khách sáo; vùng *chính xác* (ví coin, xác nhận hỏi riêng, báo cáo, xác minh) trung tính, có số liệu và mốc thời gian, không đùa, không trấn an. Lỗi kỹ thuật không bao giờ lộ ra giao diện — người dùng thấy điều gì đã xảy ra và làm gì tiếp theo, mã lỗi vào log.
- **Token màu đủ cả light và dark**, ánh xạ theo quy ước `X` → `X-dark`; component chỉ viết tên token gốc và trình phân giải tự đổi ở chế độ tối. Token không có cặp `-dark` (spacing, rounded, typography, motion) dùng chung cho cả hai chế độ. **Không màu nào được định nghĩa chỉ bên trong một media query** — ba trạng thái (theo hệ điều hành / chọn tay light / chọn tay dark) đều phải render đúng một bộ màu nhất quán.
- **Ngưỡng tương phản là hợp đồng**: mọi cặp tiền cảnh/hậu cảnh chịu lực ≥ WCAG AA 4.5:1 ở cả hai chế độ; `border-ink` ≥ 3:1 (WCAG 1.4.11) vì viền 2px là thành phần chịu lực, không phải trang trí. Coral là màu nhấn trang trí duy nhất và **không bao giờ mang chữ**; cần chữ cảnh báo thì dùng `warn` trên `warn-container`. `coin-fill` chỉ làm mảng đặc, không bao giờ làm màu chữ. **Màu không bao giờ là kênh duy nhất** mang thông tin.
- **Typography**: Be Vietnam Pro (fallback Roboto → Segoe UI → system-ui), thang nghiêng về đậm (`body` 500, tiêu đề 800). Mọi con số biến thiên theo thời gian dùng `font-variant-numeric: tabular-nums` để bề rộng chữ số không đổi. Không in hoa toàn phần cho câu tiếng Việt.
- **Độ sâu bằng bóng lệch cứng**: khối màu `border-ink` dịch 3–6px theo trục chéo, **không blur, không alpha**, bốn mức, giảm một mức ở dark mode. Không bao giờ trộn bóng lệch với bóng mờ.
- **Motion**: có token duration/easing riêng; dưới `prefers-reduced-motion` tắt mọi chuyển động trang trí nhưng **đồng hồ đếm ngược vẫn cập nhật** vì đó là thông tin, không phải hiệu ứng.
- **Component base** (`button-primary`, `button-secondary`, `chip-status`): cao tối thiểu 48px, vùng chạm ≥ 44px, kể cả trên desktop. Bo `full` cho mọi nút, chip, huy hiệu. Vòng focus 2px `primary` cách viền 2px, **không bao giờ tắt outline**.
- **A11y sàn**: bố cục reflow được ở tương đương 320px CSS width, không sinh cuộn ngang kể cả khi zoom 200% (WCAG 1.4.10). Đoạn tiếng Anh nhúng trong câu tiếng Việt mang `lang="en"`.
- **Không được trông như phần mềm họp hành**: tránh xám công sở, xanh dương doanh nghiệp, và thanh điều khiển tự ẩn khi không di chuột.

## Cross-Story Dependencies

- **Story 1.1 chặn tất cả**: không có monorepo, hai process, hai DB role và bốn cổng CI thì không story nào khác có chỗ đứng. Đây cũng là nơi bảng chính sách TypeScript kép được ghi vào `AGENTS.md`/`CONTRIBUTING` để người sau không vô tình cài `ts-jest`.
- **Story 1.2 → 1.3, 1.4**: bảng `users` và luồng OAuth ra đời ở 1.2; trạng thái lỗi (1.3) và bước khai ngày sinh (1.4) gắn vào chính luồng đó.
- **Story 1.4 → 1.5**: cổng tuổi chỉ có nghĩa khi ngày sinh đã tồn tại và không sửa tuỳ ý được.
- **Story 1.7 xuyên suốt**: bộ lọc PII và đường audit cần có mặt trước khi 1.2/1.4 bắt đầu xử lý email, provider-id, ngày sinh — nên dựng sớm hoặc song song, đừng để sau cùng.
- **Story 1.6 nuôi Epic 2 trở đi**: mọi component có đặc tả kép ở các epic sau đọc từ bộ token này; token thiếu ở đây thành nợ ở mọi màn hình sau.
- **Chuỗi epic**: Epic 1 → Epic 2 → Epic 3/Epic 4 → Epic 5. Toàn bộ chuỗi đứng trên nền của Epic 1.
- **Không đưa outbox vào Epic 1**: kênh lệnh bền xuyên process ra đời ở Epic 4. Trong Epic 1 chỉ cần giữ đúng luật — không mở lời gọi HTTP đồng bộ giữa hai process cho việc có hệ quả tiền hoặc quyền.
- **Sau Story 1.1**: chạy lại quy trình khởi tạo framework test để scaffold fixtures/helpers (hiện preflight fail vì repo chưa có `package.json`). Nếu Story 1.1 cài `@seontechnologies/playwright-utils` thì mandate thư viện của TEA bắt đầu ràng buộc từ thời điểm đó.
