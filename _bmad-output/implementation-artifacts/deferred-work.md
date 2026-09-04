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

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-bang-bon-provider.md`
  summary: Trang đăng nhập luôn hiện đủ bốn provider, không đọc AUTH_ENABLED_PROVIDERS, nên provider chưa bật cho ra nút dẫn tới 404.
  evidence: Không có endpoint GET /v1/auth/providers và không có schema cho nó trong packages/contracts. Chưa chặn phát hành vì trang này là khung trần sẽ được dựng lại ở Story 1.6, và câu chữ trạng thái lỗi thuộc Story 1.3 — nhưng khi chưa cắm credential thật thì cả bốn nút đều 404.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-bang-bon-provider.md`
  summary: ProductionRuntime.close() không được gắn vào vòng đời NestJS nên pool pg không bao giờ được rút cạn lúc tắt process.
  evidence: main.ts gọi app.enableShutdownHooks() nhưng AuthModule không khai OnModuleDestroy hay hook nào gọi close(). Chính docblock ghi "Epic 2 sẽ dùng" — tức là đang ghi nhận khoảng trống chứ không đóng nó.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-bang-bon-provider.md`
  summary: Hồ sơ đổi ở provider (tên hiển thị, avatar, email) không bao giờ đồng bộ về hàng users sau lần đăng nhập đầu.
  evidence: findOrCreateByIdentity trả về User cũ nguyên vẹn ở mọi lần đăng nhập sau; không lệnh UPDATE users nào tồn tại trong diff, và users.updated_at đứng yên từ lúc INSERT. Có thể là chủ ý, nhưng không được nêu trong Boundaries của spec lẫn ghim bằng test.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-bang-bon-provider.md`
  summary: test:unit không còn thuần unit — project api và realtime-gateway nay dựng server thật kèm OIDC server trong process, với hook timeout 60 giây.
  evidence: test:unit là cổng CI nhanh; auth.flow.test.ts và logging.test.ts boot NestJS + Fastify trên cổng thật. Tên script, chú thích project trong vitest.config.mts và fileParallelism đều chưa được xem lại, và nhiều suite đang tranh cổng trống trong cùng một project.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-bang-bon-provider.md`
  summary: OpenAPI sinh ra không khai securitySchemes, nên client đọc tài liệu không biết cái gì xác thực /v1/auth/me và /v1/auth/refresh.
  evidence: authPaths() thêm response 401 nhưng toOpenApiDocument() không có components.securitySchemes (ví dụ apiKey in: cookie cho stuwith_session) và không operation nào mang security. Lý do AD-13 đặt các path này ở packages/contracts chính là để app phone dùng lại được.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-bang-bon-provider.md`
  summary: Không có kiểm tra Origin/Sec-Fetch-Site tường minh cho POST /v1/auth/refresh và /v1/auth/logout; SameSite=Lax là phòng tuyến CSRF duy nhất và không test nào khẳng định điều đó.
  evidence: refresh xoay credential và logout thu hồi cả chuỗi — hai thao tác đổi trạng thái. SameSite=Lax thực tế chặn POST cross-site, nên đây là quyết định hợp lệ, nhưng nó đang ngầm định thay vì được ghi lại và ghim bằng test.

- source_spec: none
  summary: AC3 của Story 1.3 — rate limit theo IP và theo user, khoá brute-force đăng nhập, kèm đếm ngược thật bằng giây.
  evidence: Tách khỏi Story 1.3 ngày 2026-09-04 theo quyết định của con người. Ship độc lập được: thuần backend, không đụng khối hiển thị kết quả trên trang đăng nhập. Cần thêm một client Valkey (VALKEY_URL đã validate ở packages/config/src/schema.ts:121 nhưng chưa gì kết nối tới). Đây là lớp bảo vệ duy nhất chống dò đăng nhập ở tầng ứng dụng, nên đừng để trôi quá lâu.

- source_spec: none
  summary: AC4 của Story 1.3 — phiên hết hạn giữa buổi thì hiện dialog đăng nhập lại và quay về đúng chỗ đang đứng, không đá người dùng ra ngoài.
  evidence: Tách khỏi Story 1.3 ngày 2026-09-04 theo quyết định của con người. Chủ yếu ở client, ship độc lập được. Con người đã chốt hướng: dựng cơ chế tổng quát (lưu vị trí + khôi phục sau khi đăng nhập lại) để màn phòng live của Epic 2 cắm vào, chứ không dựng riêng cho phòng học. Ràng buộc bảo mật bắt buộc: chỉ khôi phục đường dẫn same-origin, không bao giờ nhận URL tuyệt đối — nếu không đây là một lỗ open-redirect nằm ngay trong luồng đăng nhập.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-trang-thai-loi-dang-nhap.md`
  summary: Chặng start (GET /v1/auth/:provider/start) vẫn trả JSON 502 thẳng vào trình duyệt khi discovery của provider hỏng — đúng khiếm khuyết mà Story 1.3 sửa cho chặng callback, chỉ lệch một chặng.
  evidence: Người dùng tới URL này bằng cách bấm nút đăng nhập, nên thân JSON CHÍNH LÀ màn hình họ thấy. Nằm ngoài khối đóng băng của spec 1.3 (Matrix chỉ phủ chặng callback) nên không sửa trong story này. Cơ chế đã có sẵn: failedSignIn giờ redirect kèm mã kết quả, chặng start chỉ việc dùng lại — nhưng cần một mã kết quả mới vì "provider đang hỏng" không phải "đăng nhập thất bại".

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3-trang-thai-loi-dang-nhap.md`
  summary: Người lạ không cần xác thực vẫn ghi được dòng auth.sign_in_failed vào audit_events, mà không role nào có DELETE để dọn.
  evidence: Có từ Story 1.2 (state_missing đã như vậy), Story 1.3 thêm một đường nữa qua ?error=. audit_events append-only theo AD-12 nên bảng chỉ lớn lên, không co lại. Đây chính là lý do mục AC3 (rate limit) ở trên không nên trôi lâu — hai việc này phải đọc cùng nhau: rate limit là thứ duy nhất chặn một vòng lặp curl bơm phình bảng audit. Khi làm AC3, nhớ phủ luôn cả hai chặng callback chứ không chỉ đường đăng nhập thành công.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Ngưỡng mặc định RATE_LIMIT_IP_MAX=30 trong 60 giây có thể quá chặt với NAT của trường đại học, nơi hàng trăm người chia nhau một địa chỉ.
  evidence: Comment trong schema gọi 30 là "generous" nhưng không nêu cơ sở nào cho con số. Trang đăng nhập gọi /v1/auth/me mỗi lần tải, nên lưu lượng hợp lệ cũng tiêu ngân sách. Đây là quyết định tinh chỉnh của con người chứ không phải lỗi, và biến đã là env nên đổi được lúc vận hành — nhưng cần một con số có cơ sở trước khi mở cho người dùng thật, và cần cân nhắc miễn trừ hoặc khoá riêng cho /v1/auth/me.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Trạng thái "lớp chặn rate limit đang hỏng" chỉ tồn tại dưới dạng một dòng log tự do, không có tín hiệu máy đọc được.
  evidence: Quyết định fail-open (con người chốt 2026-09-04) nghĩa là trong lúc Valkey sập thì không có giới hạn nào cả, và biện pháp bù duy nhất là dòng log "rate limiting is not working". AGENTS.md đang bảo người vận hành đặt cảnh báo bằng cách grep văn bản tự do — một chuỗi đổi chữ là cảnh báo im lặng chết. Cần một cờ boolean trong /healthz hoặc một metric để trạng thái đã chấp nhận này quan sát được thay vì phải đi tìm. Nằm ngoài phạm vi spec 1.3b vì nó thêm một bề mặt mới cho health-check, vốn tới nay cố ý chỉ là liveness.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Ba dòng cuối của đồng hồ đếm ngược — việc React thực sự gọi callback trong setTimeout — chưa có test, vì project `web` cố ý không có môi trường DOM.
  evidence: Đã thu hẹp qua ba vòng: vòng 1 chỉ grep source tìm chữ setTimeout; vòng 2 test hàm thuần nextTickDelayMs; vòng 3 tiêm `clock` thành prop nên renderToStaticMarkup render được component thật ở hai thời điểm và so số. Phần dư còn lại là hợp đồng của chính React chứ không phải logic của ta — làm rỗng callback trong setTimeout thì test vẫn xanh. Con người chọn chấp nhận ngày 2026-09-04 thay vì thêm jsdom. Story 1.6 dựng lại trọn trang này; nếu 1.6 cần DOM cho việc khác thì gánh luôn chỗ này.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Offline queue của iovalkey không có trần, nên một sự cố Valkey kéo dài trong lúc /v1/auth bị bắn dồn dập sẽ phình bộ nhớ tiến trình API.
  evidence: Vòng 3 đổi `enableOfflineQueue` về `true` để sửa lỗi request đầu tiên bị từ chối oan, và đó là sửa đúng. Nhưng iovalkey xếp hàng lệnh không giới hạn khi client chưa `ready`; mỗi lệnh giữ tham chiếu cho tới khi `commandTimeout` cắt. Ở tải bình thường thì vô hại vì timeout ngắn, nên đây là rủi ro vận hành chứ không phải lỗi — cần một trần hàng đợi hoặc bỏ lệnh khi `client.status !== 'ready'` quá N lệnh chờ. Nằm ngoài 1.3b vì nó đụng chính sách kết nối, không phải chính sách đếm.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Trong lúc Valkey treo, mỗi request /v1/auth phải chờ cộng dồn khoảng ba lần `VALKEY_COMMAND_TIMEOUT_MS` trước khi được cho đi tiếp.
  evidence: Guard đọc khoá lock rồi gọi `hit` hai lần (theo IP và theo user), mỗi lệnh tự chịu một timeout riêng. Fail-open nghĩa là mọi request đó chắc chắn sẽ được cho qua — nên độ trễ này là thuần lãng phí, đúng thứ mà một timeout nhỏ được đặt ra để tránh. Cần một ngân sách thời gian cho cả lượt enforce thay vì cho từng lệnh, hoặc một circuit breaker ngắn mạch sau lần hỏng đầu. Không phải lỗi đúng-sai nên không vá trong vòng review.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: `apps/api/src/main.ts` không đóng Nest app ở nhánh catch, nên `RuntimeShutdown` có thể gọi `close()` lần thứ hai.
  evidence: Nếu `NestFactory.create` thành công mà `configureHttpApp` hoặc `app.listen` ném, code gọi tay `runtime.close()` còn app vẫn sống với `enableShutdownHooks()` đã bật; `onApplicationShutdown` sau đó có thể `pool.end()` lần hai. `RuntimeShutdown` nuốt lỗi nên hiện không vỡ, và đường thoát này chưa có test nào (`app.shutdown.test.ts` chỉ đi đường thành công). Là lỗi khởi động của Story 1.2, không phải 1.3b.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Bốn file test dựng `ApiEnv` bằng `as unknown as ApiEnv`, vô hiệu hoá đúng lớp an toàn mà `packages/config` tồn tại để cung cấp.
  evidence: `app.shutdown.test.ts`, `http-setup.test.ts`, `rate-limit.guard.test.ts`, `rate-limited.filter.test.ts`. Thêm một biến env bắt buộc sau này sẽ không làm file nào trong số đó đỏ, dù chúng đang mô phỏng cấu hình production — tức AD-14 (fail-fast lúc khởi động) không được các test này bảo vệ. Cần một builder `testApiEnv()` trả về `ApiEnv` thật, có kiểu đầy đủ. Đụng nhiều story nên tách riêng.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: `RATE_LIMITED_OUTCOME` (mã UI `bi-khoa`) đang nằm trong `apps/api/src/rate-limit/request-identity.ts`, một file tự mô tả là chỉ suy ra hai giá trị chính sách cần.
  evidence: `rate-limited.filter.ts` import ngược lên đó để lấy hằng số trình bày. Chỗ đúng của nó là cạnh `SIGN_IN_OUTCOMES` trong `packages/contracts`, hoặc trong chính filter. Thuần phân lớp, không đổi hành vi, nên không vá giữa vòng review đang tập trung vào bảo mật.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Nhánh `refusedByProvider = true` cho lỗi nonce không khớp trong `oidc-provider.ts` chưa có ví dụ nào chạm tới.
  evidence: `FakeAuthorizationServer` luôn phát lại đúng `nonce` của request nên không đường test nào tạo được nonce lệch; ví dụ duy nhất chứng minh `code_rejected` có đếm lại đi qua nhánh 400 `invalid_grant` của `fetchJson`. Đổi đối số `true` về `false` thì replay id_token quay lại tập vô tội và không test nào đỏ. Cần một cờ trong fake server để phát nonce sai. Ghi nhận riêng vì vòng 4 đã sửa chính cách phân loại 4xx, nên nhánh này cần được xem lại cùng lúc với việc đó chứ không vá vội.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Hằng số 900 giây được nhân bản trong hai adapter dưới tên `DEFAULT_REPAIR_SECONDS`, không nơi nào là nguồn.
  evidence: `packages/db/src/in-memory/rate-limit-adapter.ts` và `packages/db/src/valkey/rate-limit-adapter.ts` cùng khai 900, trùng giá trị mặc định của `RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS` nhưng không đọc từ đó. Người vận hành đổi biến env thì TTL vá của một khoá mất hạn vẫn là 900. Gắn với M16 (chữ ký `remainingSeconds` lệch giữa port và adapter) nên nên xử lý cùng lúc.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Trần "quá rộng" của danh sách proxy áp cho TỪNG token, không cho tổng cả danh sách, nên nhiều token hợp lệ cộng lại vẫn phủ rất rộng.
  evidence: Probe thật sau vòng 4: `1.0.0.0/12,2.0.0.0/12,3.0.0.0/12,4.0.0.0/12` được chấp nhận — mỗi token đúng 2^20 nên qua trần, tổng là 4 triệu địa chỉ công cộng; danh sách 100 token thì 100 triệu. Bất biến ghi trong spec phát biểu theo một dải, nên hiện thực làm đúng thứ được yêu cầu; thiếu sót nằm ở phát biểu. Chưa vá trong vòng 4 vì nó cần một quyết định mới của con người: trần tổng là bao nhiêu, và có nên tính riêng phần công cộng với phần nội bộ không (danh sách nội bộ dài là chuyện bình thường). Rủi ro thực tế thấp — cần người vận hành cố ý dán một danh sách dài — nhưng nó là cạnh duy nhất còn lại của luật này.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3b-rate-limit-dang-nhap.md`
  summary: Luật proxy mới vẫn cho phép tin tới 2^20 địa chỉ công cộng mỗi token, nên một lỗi gõ một chữ số có thể âm thầm mở rộng vùng tin cậy.
  evidence: `192.168.0.0/15` được chấp nhận vì 2^17 dưới trần, nhưng nó phủ cả `192.169.0.0/16` vốn là không gian công cộng — trong khi ý định của người gõ gần như chắc chắn là `/16`. Trần 2^20 là quyết định có chủ đích để một token chứa được `104.16.0.0/12` của Cloudflare, nên đây không phải lỗi mà là bề mặt còn lại của đánh đổi đó. Cần cân nhắc: cảnh báo (không chặn) khi một dải công cộng được khai mà không phải dải đã biết của một CDN, hoặc bắt khai riêng biến `TRUSTED_PROXY_PUBLIC_RANGES` để việc tin địa chỉ công cộng luôn là hành động cố ý.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: Một lượt `/v1/auth/*` bị rate limit chặn thì đường dẫn quay về bị mất — `rate-limited.filter.ts` luôn trả người dùng về `/dang-nhap` trần.
  evidence: Guard chạy **trước** handler, nên `/start` bị chặn không bao giờ tới `AuthService.start()`, tức không có state nào được ký và filter không có gì đáng tin để đọc. Nó chỉ nhìn thấy `request.query` — đúng cái nguồn mà spec 1.3c cấm chặng redirect đọc đường dẫn, vì kiểm rồi ký ở một chỗ là toàn bộ luận điểm chống open-redirect. Một đường vòng (kiểm lại trong filter, hoặc nhét đường dẫn vào cookie riêng) sẽ tạo ra **chỗ kiểm thứ hai**, đúng kiểu lệch đã tốn của story rate-limit bốn vòng review. Hệ quả thực tế nhỏ: người bị khoá đằng nào cũng phải chờ hết `giay` rồi bấm lại từ dialog — mà dialog vẫn còn đó và vẫn mang đường dẫn cũ, nên chỗ đứng chỉ mất khi họ tải lại trang trong lúc chờ. Muốn đóng thật thì cần một quyết định thiết kế mới: hoặc cho guard chạy sau khi state được ký, hoặc cho filter ký một payload rút gọn bằng chính `SESSION_COOKIE_SECRET`.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: Số lượt đăng nhập đang bay không có trần, và mỗi lượt giờ nặng gấp 2,85 lần.
  evidence: Đo thật ngày 2026-09-04 trên harness: dòng `Set-Cookie` của một state cookie là **374 byte** khi không có đường dẫn quay về và **1066 byte** khi có đường dẫn dài đúng trần 512 — 512 ký tự path thành ~683 byte base64 trong payload đã ký. Phần trình duyệt gửi lại (`name=value`) là ~314 và ~1006 byte. Giới hạn header mặc định của Node là 16 KB, nên số lượt sống cùng lúc trước khi máy chủ trả 431 rơi từ ~52 xuống ~16. `deadAttemptCookies` chỉ dọn cookie ĐÃ chết; không có trần nào cho số lượt còn sống. Rate limit `auth_start` mặc định cho 30 lượt/60 giây còn `OAUTH_STATE_TTL_SECONDS` là 600, nên một người có thể tích tới ~300 cookie state còn hạn — vượt cả hai ngưỡng. Đây là khoảng trống có từ Story 1.2; 1.3c làm nó hẹp đi 3,2 lần chứ không tạo ra nó. Cần một trần cho số cookie state đang sống (ví dụ giữ N cái mới nhất, xoá phần còn lại ở `/start`), và quyết định N là quyết định của con người vì nó chính là số tab đăng nhập song song được hỗ trợ.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: `returnPath` được chốt lúc gặp 401 chứ không phải lúc người dùng bấm nút trong dialog.
  evidence: Dialog mở ở `/phong-hoc/a`, người dùng điều hướng client-side sang `/phong-hoc/b` rồi mới bấm "Tiếp tục với Google" thì vẫn bị đưa về `/phong-hoc/a`. Test `follows the person to a new location between two 401s` chỉ phủ trường hợp có 401 THỨ HAI cập nhật lại prompt. Không vá trong vòng này vì mọi cách sửa đều đẩy một lần đọc `window.location` vào chỗ không test được: href được dựng lúc render, nên muốn đúng lúc bấm thì phải có `onClick` đọc `window.location` rồi ghi đè `href` — đúng loại code mà `vitest.config.mts:119` (project `web`, `environment: node`, không DOM) không chạy được, và spec 1.3c bắt mọi quyết định nằm trong hàm thuần. Hệ quả thực tế nhỏ: người dùng về nhầm một trang trong cùng ứng dụng, không phải mất phiên. Sửa đúng cách cần Story 1.6 (khi có DOM cho việc khác) hoặc một `usePathname()` trong provider kèm Suspense boundary.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: Dialog phiên hết hạn xuất hiện mà không có gì thông báo cho bàn phím và trình đọc màn hình.
  evidence: Không chuyển focus, không `aria-live`, không `role="alertdialog"`. Người dùng bàn phím đang ở cuối trang sẽ không biết vừa có bốn liên kết đăng nhập xuất hiện; trình đọc màn hình cũng không đọc gì vì phần tử được THÊM vào cây chứ không phải nội dung thay đổi trong một live region đã tồn tại. Story 1.6 lo styling và focus-trap, nhưng "xuất hiện mà không có gì thông báo" là khoảng trống HÀNH VI chứ không phải trang trí. Không vá ở đây vì cách sửa đúng là một live region luôn được mount ở layout — đúng thứ Story 1.6 dựng, và cùng một hạn chế đã ghi cho `SignInPanel`.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: Đăng xuất chủ động đi qua seam, nên ở Epic 2 nó sẽ tự bật dialog "đăng nhập lại".
  evidence: `page.tsx` gọi `/v1/auth/logout` rồi `load()` gọi `/v1/auth/me`, cả hai qua `authorizedFetch`. Hôm nay im lặng vì cả hai chỉ xảy ra trên `/dang-nhap`, nơi `authorizedCall` không gia hạn và `nextSessionExpiry` không mở dialog. Ở Epic 2, bấm "Đăng xuất" trong phòng học sẽ cho `/me` trả 401 tại `/phong-hoc/...` — seam sẽ thử `/v1/auth/refresh` (một request thừa, chắc chắn 401 vì refresh cookie vừa bị xoá) rồi mở dialog nói phiên vừa kết thúc, với người vừa tự bấm đăng xuất. Cần một cách để một lời gọi nói "401 ở đây là kết quả mong đợi" — ví dụ một `authorizedFetch(url, init, { expect401: true })` hoặc một `signOut()` riêng trên seam. Không vá trong 1.3c vì nó thêm một bề mặt API mà chưa có màn hình nào dùng.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: Luật cấm dấu `%` làm mất mọi đường dẫn quay về có escape, gồm ký tự tiếng Việt và khoảng trắng.
  evidence: Sản phẩm có locale mặc định là tiếng Việt, nên `/tim-kiem?q=tiếng%20Việt` — một URL hoàn toàn bình thường — không đề nghị được và người dùng rơi về `/dang-nhap`. Phương án hẹp hơn đã cân nhắc: chỉ cấm `%2F`, `%5C`, `%00`, `%0D`, `%0A` (và các biến thể hoa/thường) thay vì cấm cả ký tự `%`. Chưa chọn vì nó đưa lại đúng cái mà luật hiện tại loại bỏ: một danh sách cấm theo VÍ DỤ, trong khi Fastify đã decode một lần trước khi hàm chạy, nên "cấm những chuỗi này" phải đúng ở CẢ hai mức mã hoá — đúng lớp lỗi mà danh sách proxy đã tốn bốn vòng review. Muốn mở thì cần quyết định về hình dạng chuẩn hoá (decode một lần rồi kiểm, và cấm mọi `%` còn lại sau đó), kèm test theo lớp chứ không theo ví dụ.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-3c-phien-het-han-quay-lai.md`
  summary: Một lời gọi có xác thực mang body kiểu stream sẽ không được seam gia hạn và phát lại.
  evidence: `authorizedCall` chỉ phát lại khi `init.body` gửi được hai lần; một `ReadableStream` đã bị tiêu thụ ở request đầu, nên phát lại sẽ gửi body RỖNG và rất có thể nhận 200 — một câu trả lời sai trong im lặng, tệ hơn mọi lỗi. Hiện tại không có call site nào có body, nên đây là giới hạn chứ chưa phải khiếm khuyết. Ở Epic 2, nếu phòng học cần upload theo stream thì cách sửa là truyền vào seam một FACTORY dựng `init` mới cho mỗi lần thử, chứ không phải một `init` dùng lại. Ghi lại ở đây để nó không trở thành cái bẫy im lặng.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: Không có luồng đổi ngày sinh — không endpoint, không màn hình, và người khai nhầm không có đường nào tự sửa.
  evidence: Spec đặt điều này ở mục **Never** ("Đường tự sửa ngày sinh — không endpoint, không màn hình. Đổi phải qua luồng hỗ trợ, và luồng đó không thuộc epic này"), nên đây là quyết định chứ không phải thiếu sót. Điều chưa có là *luồng hỗ trợ* mà câu đó trỏ tới: không có kênh, không có công cụ vận hành, và không role nào ngoài owner ghi được `users.date_of_birth` sau lần đầu. Câu `UPDATE ... WHERE date_of_birth IS NULL` từ chối mọi lần ghi thứ hai kể cả từ `apps/api`, nên hôm nay việc sửa một ngày sinh gõ nhầm phải làm bằng tay trên DB bằng quyền owner. `DATE_OF_BIRTH_ALREADY_SET_MESSAGE` bảo người dùng "liên hệ hỗ trợ" cho một quy trình chưa tồn tại. Cần quyết định của con người: ai được sửa, ghi lại ở đâu (audit hiện không có action nào cho việc này — xem mục AUDIT_ACTIONS bên dưới), và có nên có một script vận hành riêng thay vì một endpoint hay không.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: Trạng thái kẹt chưa được đặt tên — một hàng đã lưu ngày sinh nhưng không còn qua được `parseDateOfBirth` sẽ vĩnh viễn `is_over_18: false`.
  evidence: `isAtLeastYearsOld` cố ý parse lại giá trị đã lưu và trả `false` khi parse hỏng (fail-closed, đúng chiều). Sau vòng review này `isProfileComplete` cũng hỏi bằng `isCalendarDate`, nên một giá trị *không phải* ngày lịch đọc thành "chưa khai" và người dùng thấy lại form — nhưng endpoint vẫn từ chối bằng 409 vì cột không `NULL`. Còn một khe hẹp hơn vẫn kẹt thật: một chuỗi VẪN là ngày lịch hợp lệ nhưng năm dưới `MIN_DATE_OF_BIRTH_YEAR` (ví dụ `1899-12-31` sửa tay, hoặc dữ liệu di trú sau này) thì `profile_completed: true` còn `is_over_18: false` mãi mãi, không màn hình nào hiện form, không endpoint nào ghi đè. Cột là `date` nên driver không tạo ra được hình dạng này; chỉ can thiệp tay hoặc migration mới. Chưa vá vì lối ra đúng là luồng hỗ trợ ở mục trên, và bịt bằng một endpoint sửa sẽ phá thẳng bất biến ghi-một-lần. Muốn phát hiện sớm thì cần một truy vấn kiểm kê định kỳ: `SELECT count(*) FROM users WHERE date_of_birth IS NOT NULL AND date_of_birth < DATE '1900-01-01'`.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: Màn khai ngày sinh không có e2e nào, đúng phần dư mà chính test của nó tự nhận là không phủ được.
  evidence: `date-of-birth-form.test.tsx` ghi rõ phần còn lại nó không chứng minh được là "React có thực sự gọi effect của page hay không" — vì project `web` chạy `environment: node`, không `jsdom`/`happy-dom`/`@testing-library` (thêm là mục Ask First), nên `renderToStaticMarkup` không bao giờ chạy `useEffect`. Đó chính xác là phần e2e phải gánh: mở `/khai-ngay-sinh`, xác nhận nó gọi `/v1/auth/me`, điền form, thấy màn xác nhận. `playwright.config.ts` hiện chỉ chạy smoke `/healthz` trên hai process và không khởi động `apps/web`, nên thêm ca này là dựng thêm một webServer, một phiên đăng nhập thật (hoặc một fake provider chạy trong e2e) và ảnh chụp trạng thái — một hạ tầng chứ không phải một file test. Cùng khoảng trống với `/dang-nhap` từ Story 1.2 và với dialog hết phiên của 1.3c, nên nên làm một lần cho cả ba.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: `AUDIT_ACTIONS` chưa được hỏi — câu trả lời hiện tại là "không ghi audit gì cả", và đó là một khoảng trống có chủ đích chứ không phải sự im lặng.
  evidence: Spec đặt "Thêm giá trị vào `AUDIT_ACTIONS`" ở mục **Ask First** và story đã chọn không hỏi: `recordDateOfBirth` không ghi dòng audit nào, và sau vòng review này bất biến đó có test giữ (`auth.flow.test.ts`, describe "Never: the declaration writes no audit row" — đếm trước/sau kèm đối chứng dương rằng audit không rỗng). Lý do vẫn đúng cho phần quan trọng nhất: dòng đáng ghi nhất là dòng mang ngày sinh, và `audit_events` không role nào có `DELETE` còn `metadata` chưa whitelist khoá, nên một dòng như vậy là không xoá được vĩnh viễn. **Nhưng** một dòng chỉ gồm `user_id` + `action` (không ngày sinh, không metadata) vẫn ghi lại được một sự kiện không thể hoàn tác — hồ sơ chuyển từ chưa hoàn tất sang hoàn tất — và đó là loại sự kiện Story 1.5 sẽ cần khi cổng chặn tiền dựa vào cờ tuổi. Chưa làm vì nó là ba nơi cùng lúc (`AUDIT_ACTIONS`, CHECK constraint nhân bản tay trong migration, và bảng phân loại reason), và vì nó cần một câu trả lời của con người chứ không phải một suy luận của agent. Ghi lại để đây là một quyết định đã cân nhắc và hoãn.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: Deny-list PII vẫn chỉ phủ được các đường được gọi tên; `RecordDateOfBirthResult` là hình dạng hai tầng đầu tiên trong repo.
  evidence: Wildcard `*` của pino khớp đúng MỘT tầng. `RecordDateOfBirthResult` là `{ ok: true, user: User }`, nên `logger.info({ outcome })` đặt ngày sinh ở `outcome.user.dateOfBirth` — ngoài tầm mọi đường `*.`. Vòng review này thêm `*.user.date_of_birth` và `*.user.dateOfBirth` kèm test chạy pino thật, nên hình dạng cụ thể đó đã đóng; cái chưa đóng là *lớp*: bất kỳ kiểu trả về lồng nào sau này (một `{ result: { user } }`, một mảng user) lại nằm ngoài. Đây đúng là giới hạn mà `logging.ts` đã ghi từ Story 1.1 và **Story 1.7 sở hữu** bằng whitelist serializer. Không vá rộng hơn ở đây vì đường đúng không phải là thêm đường thứ ba mà là đổi cơ chế, và đổi cơ chế giữa vòng review của một story khác là đúng kiểu thay đổi làm hỏng thứ chưa ai nhìn.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: `isOver18` được export từ `packages/contracts` nhưng chưa consumer sản phẩm nào gọi.
  evidence: Chỉ `packages/contracts/src/auth.test.ts` gọi nó. `apps/web` cố ý không đọc cờ tuổi ở đâu cả — màn khai chỉ hỏi "đã khai chưa" (`isProfileCompleted`), và `/dang-nhap` sau vòng này cũng vậy. Giữ lại chứ không xoá vì nó là nửa đối xứng của `isProfileCompleted`: cùng một luật "vắng mặt đọc thành false" cho một boolean optional, và consumer thật là cổng chặn hành vi có tiền của Story 1.5 (`canReceiveMoney`), vốn phải đọc cờ chứ không được tự tính lại tuổi trong `apps/web`. Rủi ro của việc giữ: một export không ai gọi là một export không ai thấy khi nó sai. Rủi ro của việc xoá: Story 1.5 viết lại luật đó ở nơi khác. Ghi lại để 1.5 hoặc dùng nó, hoặc xoá nó có chủ đích.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: Dòng `pnpm run test:e2e` trong mục Verification của spec KHÔNG chứng minh được gì về `/khai-ngay-sinh`, vì Playwright không khởi động `apps/web`.
  evidence: `playwright.config.ts` khai đúng hai `webServer`: `node apps/api/dist/main.js` và `node apps/realtime-gateway/dist/main.js`. Không có webServer nào cho `apps/web`, `testDir` là `./tests/e2e` và project duy nhất tên `api` chạy không trình duyệt (`use: {}`) — nó chỉ gọi `/healthz` bằng request fixture. Nên khi lệnh đó xanh, điều được chứng minh là "hai process API còn sống", không phải "màn khai ngày sinh chạy được". Ghi rõ ở đây vì một mục Verification đọc như một lời hứa: người đọc spec vòng sau sẽ tưởng route web đã có cổng e2e. Muốn có thật thì cần một webServer cho `apps/web`, một project có browser, và một phiên đăng nhập thật (hoặc fake provider chạy trong e2e) — cùng hạ tầng với mục "Màn khai ngày sinh không có e2e nào" ở trên, nên làm một lần cho cả `/dang-nhap`, dialog hết phiên của 1.3c và màn khai.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-khai-ngay-sinh.md`
  summary: Không có guard/middleware nào bắt "chưa khai ngày sinh thì không đi đâu khác" — chỉ có đúng một liên kết ở `/dang-nhap`.
  evidence: Sau vòng review này, đường tới `/khai-ngay-sinh` là `SignedInPanel` trong `apps/web/src/app/dang-nhap/sign-in-outcome.tsx`, và `routes.test.ts` giữ cho nó không chết. Nhưng đó là một LỜI MỜI, không phải một cổng: người đăng nhập với `quay-ve` trỏ vào chỗ khác (ví dụ `/`) đáp thẳng xuống trang chủ, và `apps/web/src/app/page.tsx` không đọc `/v1/auth/me`, không biết hồ sơ chưa hoàn tất, không nhắc gì. AC "không có đường bỏ qua bước khai" vì thế đúng theo nghĩa "có đường tới màn khai", chưa đúng theo nghĩa "không thể đi tiếp khi chưa khai". Chưa vá ở đây vì cách làm đúng là một cổng đọc cờ `profile_completed` ở tầng layout hoặc middleware — nó chạm mọi trang, cần quyết định về trang nào được miễn (`/dang-nhap`, `/khai-ngay-sinh`, `/healthz`) và có thể cần đọc phiên ở phía server, thứ mà `apps/web` hôm nay cố ý không làm. Story 1.5 dựng cổng chặn hành vi có tiền trên cùng cờ này, nên đó là chỗ làm chặt một lần.
