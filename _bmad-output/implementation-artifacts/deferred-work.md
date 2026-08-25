# Deferred work

Việc đã được xác nhận là thật nhưng cố ý hoãn. Mỗi mục ghi rõ nguồn và bằng chứng
để story sau không phải điều tra lại từ đầu.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: coturn không có listener TLS/DTLS nào — không `tls-listening-port`, không đường dẫn cert.
  evidence: `infra/coturn/turnserver.conf` tắt TLS 1.0/1.1 nhưng không hề mở cổng TLS. TURN-over-TLS trên 443 chính là thứ khiến TURN có ích trên mạng bị chặn, mà đó lại là lý do spine gọi coturn là "bắt buộc, không phải tuỳ chọn". Hoãn được vì MVP chưa có người dùng thật sau firewall doanh nghiệp.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: comment chống SSRF trong turnserver.conf hứa nhiều hơn cấu hình thực có.
  evidence: `no-loopback-peers` và `no-multicast-peers` không chặn relay vào 10/8, 172.16/12, 192.168/16. Muốn chặn thật phải khai `denied-peer-ip` — nhưng làm vậy sẽ chặn luôn relay tới các service khác trong compose, nên cần thiết kế mạng cẩn thận chứ không sửa một dòng được.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: `use_external_ip: false` nhiều khả năng làm media production hỏng.
  evidence: `infra/livekit.yaml` giải thích rằng trên VPS "địa chỉ public được phát hiện qua cấu hình TURN/external-ip". `--external-ip` của coturn không hề nuôi ICE candidate của LiveKit; LiveKit cần `use_external_ip: true` hoặc `node_ip` của chính nó. Chỉ lộ ra khi deploy thật, nên hoãn tới lúc dựng VPS.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: dải cổng UDP trong env chỉ là trang trí — phía container hardcode.
  evidence: `LIVEKIT_UDP_PORT_START/END` và `TURN_RELAY_PORT_START/END` chỉ đổi phía host của publish mapping. Phía container cố định trong `infra/livekit.yaml` (50000–50019) và `infra/coturn/turnserver.conf` (50100–50119), `listening-port=3478` cũng vậy. Đổi env sẽ tạo mapping hỏng âm thầm. Cần một test cổng khẳng định hai dải khớp nhau.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: bí mật đi vào container qua argv và env, đọc được bằng `docker inspect`.
  evidence: `infra/docker-compose.yml` render `--static-auth-secret=${TURN_SECRET}` vào command line của coturn và `LIVEKIT_KEYS` vào environment. Cả hai lộ qua `docker inspect` và qua danh sách tiến trình trong container. Câu "nothing secret is ever committed" đúng nhưng không bảo vệ điều này. Cách đóng: mount file secret.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: bộ lọc PII hiện là deny-list một tầng, spine yêu cầu whitelist serializer.
  evidence: wildcard của pino (`*.email`, `*.provider_id`) chỉ khớp đúng một tầng — `req.body.user.email` không bị che. Comment trong `logging.ts` gọi đây là "whitelist", nhưng whitelist chỉ áp cho serializer `req`/`res`; mọi thứ khác đi qua deny-list. **Story 1.7 sở hữu việc này** và AGENTS.md §6 đã thừa nhận đây là "sàn, không phải control hoàn chỉnh".

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: `auditEventSchema.metadata` nhận record tự do, PII lọt được vào bảng append-only.
  evidence: `z.record(...)` không giới hạn khoá. Bảng audit không role nào có `DELETE` — nên một dòng chứa email hay ngày sinh là **không xoá được**. Cần whitelist khoá metadata. Story 1.7 dựng audit thật nên thuộc về nó.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: chỉ có liveness probe, không có readiness probe.
  evidence: `/healthz` ở cả hai process chỉ báo tiến trình còn sống, không báo phụ thuộc (DB, Valkey) đã sẵn sàng. `docker compose --wait` và mọi orchestration sau này không có gì để hỏi. Chưa cấp bách khi chưa deploy thật.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: `healthResponseSchema.parse()` chạy trên mọi request liveness, drift schema thành vòng lặp restart.
  evidence: chính comment ngay trên nó nói endpoint tồn tại để tránh restart loop, nhưng một parse ném lỗi trên đường probe sẽ tạo ra đúng vòng lặp đó. Validate một lần lúc khởi tạo, hoặc trong contract test, cho cùng tín hiệu drift mà không đặt rủi ro lên probe.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: hai process shell gần như trùng khít nhau, file đối file.
  evidence: `logging.ts`, `config.token.ts`, `app.module.ts`, `main.ts`, `health.controller.ts` chỉ khác một tên type và một chuỗi service; `nest-cli.json` và `tsconfig.build.json` giống hệt từng byte. Danh sách redact đã được dời vào `packages/config` đúng vì "hai bản sao sẽ trôi khỏi nhau ngay khi một bên thêm field" — lập luận đó áp cho mọi thứ còn lại.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: không package nào typecheck test của chính nó.
  evidence: mọi `tsconfig.json` của package và app đều `exclude` `src/**/*.test.ts`; `tests/gates/` và `tests/e2e/` nằm ngoài đồ thị reference của root. Vitest transpile bằng esbuild, Playwright bằng babel — không cái nào typecheck. Lỗi kiểu trong bất kỳ file test nào, kể cả `test-kit.ts` và `__testing__/postgres.ts`, hiện không có gì bắt.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: không có cấu hình hay ngưỡng coverage ở đâu cả.
  evidence: `vitest.config.mts` không khai coverage, không job CI nào thu thập. Không biết được phần nào của khung đang thực sự được test.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: `pnpm test` kéo theo suite cần Docker, người mới không có daemon phải chờ 180s mới thấy lỗi.
  evidence: `db` project đặt `hookTimeout: 300_000`. Không có thông báo nào chỉ tới `STUWITH_SKIP_TESTCONTAINERS=1` mà AGENTS.md có ghi. Một bước kiểm daemon với thông báo rõ ràng là rẻ.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: `packages/db/package.json` khai `vitest` vừa là devDependency, vừa là peer, vừa là peer optional.
  evidence: `@stuwith/db/test-kit` thật sự cần vitest ở phía *consumer*, nên đánh dấu peer là optional xoá mất tín hiệu duy nhất consumer nhận được; devDependency local lại thoả mãn peer nên ràng buộc không bao giờ báo cho ai.

- source_spec: `spec-1-1-dung-khung-monorepo-va-bon-cong-ci.md`
  summary: `epic-1-context.md` khẳng định dự án không có PRD — sai.
  evidence: `docs/prd.md` tồn tại (31KB, đủ NFR và epic S0–S4). Bước biên soạn epic context chỉ quét `planning-artifacts/` nên bỏ sót, vì config đặt `project_knowledge` = `docs/`. Tài liệu này là thứ các story sau của Epic 1 biên dịch từ đó, nên câu sai sẽ lan. Sửa bằng cách chạy lại compile-epic-context với đường dẫn đúng.
