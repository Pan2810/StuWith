---
title: 'Story 1.1 — Dựng khung monorepo, hai process và bốn cổng CI'
type: 'feature'
created: '2026-08-21'
status: 'done'
baseline_commit: '5cf16eb72376460087662b93acd490d07c0d04a2'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/test-artifacts/test-stack-decision.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Repo hoàn toàn trống — chưa có dòng code nào. Mọi story sau đứng trên một bộ khung chưa tồn tại, và các luật kiến trúc (chiều phụ thuộc, chủ ghi DB, không lộ bí mật) hiện chỉ là văn bản, tức là góp ý review chứ không phải ràng buộc.

**Approach:** Dựng monorepo pnpm với cây nguồn cố định, hai process NestJS chạy tách nhau, stack local bằng `docker compose`, và bốn cổng CI biến từng luật trên thành lỗi build. Mấu chốt: luật phải được *cưỡng chế bằng cơ chế* (project references, `GRANT`, schema env fail-fast, workflow CI), không phải bằng lời văn.

## Boundaries & Constraints

**Always:**
- Cây nguồn đúng như spine: `apps/web` · `apps/api` · `apps/realtime-gateway` · `packages/domain` · `packages/contracts` · `packages/db` · `packages/config` · `infra/`. Thư mục kebab-case.
- `packages/domain` là code thuần: không import `apps/*`, `packages/db`, hay bất kỳ SDK hạ tầng nào (`pg`, LiveKit, Valkey client). Cưỡng chế **chính** bằng TypeScript project references — tsconfig của `domain` không reference hạ tầng nên import sai **không resolve được**; **phụ** bằng `dependency-cruiser` ở CI. Không dùng ESLint làm lớp chính (tắt được bằng comment).
- TypeScript kép: `typescript@7.0.2` cho `typecheck` toàn repo + build `apps/web`; `@typescript/typescript6@6.0.2` (binary `tsc6`) cho `nest build`. Cả hai lệnh cùng chạy được trong một repo.
- Cấm tới TS 7.1: `ts-jest`, `ts-node`, `ts-morph`, `@typescript-eslint/*` với `parserOptions.project`.
- Mọi config đọc từ env var, kiểm schema lúc khởi động, **fail fast** nêu đúng tên biến thiếu. **Không giá trị mặc định nào cho bí mật.**
- Hai DB role tách biệt, quyền cưỡng chế bằng `GRANT`/`REVOKE` chứ không bằng lời văn.
- Mọi giá trị từ context không tin được trong GitHub Actions (`github.event.*`, `inputs.*`) phải đi qua biến `env:` trung gian — **không bao giờ nội suy thẳng vào khối `run:`**.
- Version ghim chính xác, không dùng dải `^`/`~` cho stack đã chốt.

**Ask First:**
- Bật GitHub Environments + required reviewers (đây là **cấu hình repo**, không phải file; `gh` CLI chưa cài trên máy này).
- Tạo bất kỳ bảng nghiệp vụ nào (`users`, `coin_ledger`, `audit_events`…) — chúng thuộc Story 1.2/1.7 trở đi.
- Thêm bất kỳ dependency nào ngoài danh sách đã ghim trong spec này.

**Never:**
- Object store trong `docker compose` (AD-29) — kể cả MinIO cho "tiện dev".
- Caddy trong compose local (TLS kết thúc ở edge VPS, không phải máy dev).
- Lời gọi HTTP đồng bộ giữa hai process cho việc có hệ quả tiền hoặc quyền (outbox thuộc Epic 4).
- Logic nghiệp vụ thật (OAuth, coin, phiên) — story này chỉ dựng khung.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Health-check hai process | `GET /healthz` trên `api` và `realtime-gateway` | `200` + `{status:"ok",service,version}`; hai process nghe **hai cổng khác nhau** | N/A |
| Thiếu env bắt buộc | Xoá một biến bắt buộc rồi khởi động bất kỳ process nào | Process thoát **khác 0** trước khi mở cổng, log nêu **đúng tên biến thiếu** | Không fallback, không giá trị mặc định |
| Vi phạm chiều phụ thuộc | Thêm `import { Pool } from 'pg'` vào `packages/domain` | `pnpm typecheck` **đỏ**, trỏ đúng dòng vi phạm; `dependency-cruiser` cũng đỏ | Không tắt được bằng cấu hình cục bộ hay comment |
| Ghi sai chủ sở hữu | Role `stuwith_realtime` thử `UPDATE users` (khi bảng tồn tại) | Postgres từ chối vì thiếu quyền | Lỗi đến từ DB, không phải từ code app |
| `docker compose up` | Máy sạch | Lên đúng 4 service: Postgres 18 + pgvector, Valkey, LiveKit, coturn; **không** service object store | Healthcheck compose fail thì `up` báo unhealthy |

</frozen-after-approval>

## Code Map

Repo là **greenfield** — không có code để đọc. Bản đồ dưới đây trỏ tới nguồn quyết định (đọc) và các file phải tạo (viết).

**Nguồn quyết định — đọc, không sửa:**
- `_bmad-output/implementation-artifacts/epic-1-context.md` -- ngữ cảnh Epic 1 đã chắt lọc; đọc trước tiên
- `_bmad-output/test-artifacts/test-stack-decision.md` -- TD-1…TD-8: Vitest, Playwright, chính sách TS kép, hai lớp cưỡng chế AD-1, test-kit adapter, GitHub Actions
- `_bmad-output/planning-artifacts/architecture/architecture-StuWith-2026-08-20/ARCHITECTURE-SPINE.md` -- cây nguồn, bảng Stack, AD-1/6/8/12/13/14/20. ⚠️ Sơ đồ ghi "Redis" là **nhãn cũ** — bảng Stack ghi Valkey, theo bảng Stack
- `_bmad-output/planning-artifacts/epics.md` -- AC của Story 1.1 ở khoảng dòng 322–360
- `docs/prd.md` -- PRD thật (§3 NFR, §4 EPIC S0). Lưu ý: `epic-1-context.md` ghi nhầm là "không có PRD" — có, ở đây

**Version đã verify trên registry ngày 2026-08-21 (dùng nguyên, đừng tra lại):**
`pnpm@11.22.0` · Node `>=24.14.1` · `typescript@7.0.2` · `@typescript/typescript6@6.0.2` · `next@16.3.0` · `@nestjs/core@11.2.1` · `@nestjs/platform-fastify@11.2.1` · `@nestjs/cli@11.0.24` · `pg@8.23.0` · `node-pg-migrate@9.0.0` · `zod@4.4.3` · `pino@10.3.1` · `nestjs-pino@4.6.1` · `vitest@4.1.11` · `@playwright/test@1.62.1` · `dependency-cruiser@18.2.0` · `testcontainers@12.1.0`

**Docker image đã verify tồn tại trên Docker Hub:**
`pgvector/pgvector:0.8.6-pg18-trixie` (Postgres 18 + pgvector 0.8.6 trong một image) · `valkey/valkey:9.0.4-alpine` · `livekit/livekit-server:v1.13.5` · `coturn/coturn:4.17.2-alpine` (⚠️ spine đoán "upstream 4.13.1" — sai; 4.17.2 là bản hiện hành)

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`, `.nvmrc` -- Dựng root workspace: `packageManager: "pnpm@11.22.0"`, `engines.node >=24.14.1`, script `typecheck`/`build`/`test`/`lint`/`dep-check`. -- Nền của mọi task sau; corepack bật pnpm nên CI không cần cài riêng.
- [x] `tsconfig.base.json` + `tsconfig.json` -- Base `composite: true`, `strict: true`, và **đồ thị project references**: `contracts` → (không ai); `domain` → **chỉ** `contracts`; `db` → `contracts`+`domain`; `config` → `contracts`; `apps/*` → tất cả packages. -- Đây là cơ chế cưỡng chế **chính** của AD-1: `domain` không reference `db`/`apps` nên import sai không resolve.
- [x] `packages/config/` -- Schema env bằng `zod@4.4.3`, parse **một lần lúc khởi động**, thiếu biến thì in đúng tên biến rồi `process.exit(1)`. Export type-safe config cho hai process. -- AD-14 fail-fast; không secret nào có default.
- [x] `packages/contracts/` -- Khai envelope lỗi `{error:{code,message,details?}}`, shape response health-check, và shape dòng audit. Schema kiểm lúc chạy, sinh được OpenAPI. -- AD-13: không type hợp đồng nào được khai ở `apps/*`.
- [x] `packages/domain/` -- Code thuần + một **port giả** (ví dụ `ClockPort`) đủ để test-kit hợp đồng chạy. `package.json` **không có** dependency hạ tầng nào. -- Port tiền thật đến ở Epic 3; ở đây chỉ chứng minh khung đứng được.
- [x] `packages/db/` -- Adapter `pg@8.23.0`, migration bằng `node-pg-migrate@9.0.0` (chỉ tiến), và **export test-kit**: hàm nhận một implementation của port rồi chạy trọn bộ assertion. -- AD-6, TD-5: một suite chạy được trên nhiều adapter.
- [x] `packages/db/migrations/` -- Migration tạo hai role `stuwith_api` và `stuwith_realtime` + `REVOKE`/`GRANT` mặc định, và một bảng hạ tầng tối thiểu để cổng CI #4 có cái mà chạy lên. **Không tạo `users`/`coin_ledger`/`audit_events`.** -- AC đòi hai role; bảng nghiệp vụ thuộc story sau.
- [x] `apps/api/` -- NestJS 11.2.1 trên Fastify v5, `GET /healthz`, bootstrap qua `packages/config`, log JSON bằng `nestjs-pino@4.6.1`. -- Process 1; `nest build` phải chạy bằng `tsc6`.
- [x] `apps/realtime-gateway/` -- Cấu trúc y hệt `apps/api` nhưng **cổng khác**, `GET /healthz` riêng. -- AC đòi hai process tách nhau, mỗi cái health-check riêng.
- [x] `apps/web/` -- Next.js 16.3.0 tối thiểu, build bằng `typescript@7.0.2`. -- Chứng minh nhánh TS 7 chạy song song nhánh `tsc6`.
- [x] `infra/docker-compose.yml`, `infra/livekit.yaml`, `infra/coturn/turnserver.conf`, `.env.example` -- Bốn service với image đã ghim ở Code Map, mỗi service có healthcheck, LiveKit + coturn mở cổng UDP. **Không object store, không Caddy.** `.env.example` liệt kê mọi biến bắt buộc với giá trị rỗng. -- AC `docker compose up`.
- [x] `.dependency-cruiser.cjs` -- Rule cấm `packages/domain` chạm `apps/*`, `packages/db`, và SDK hạ tầng; bắt cả import động và `import type` bị lạm dụng. -- Lớp cưỡng chế **phụ** của AD-1.
- [x] `vitest.config.ts` + config theo package -- `packages/domain` chạy environment `node`, **không setup file nào chạm DB/mạng**. Test-kit hợp đồng chạy hai lần: in-memory và Postgres 18 thật qua `testcontainers@12.1.0`. -- TD-1, TD-5. Cách AD-1 được *kiểm chứng* chứ không chỉ tuyên bố.
- [x] `playwright.config.ts` + smoke test -- Smoke test chạm `/healthz` của **cả hai** process. Chưa cần spec E2E. -- TD-2.
- [x] `packages/domain/**/*.test.ts` (hoặc test tương đương) -- Test **chứng minh cổng #2 thật sự đỏ**: thêm một import vi phạm rồi kiểm typecheck/dep-check trả mã lỗi khác 0. -- TD-4 nói thẳng story phải có test này; không có nó thì cổng chỉ là niềm tin.
- [x] `.github/workflows/ci.yml` -- Bốn job: (1) `gitleaks` toàn lịch sử PR · (2) `tsc -b` + `dependency-cruiser` · (3) test-kit × {in-memory, PG18 Testcontainers} · (4) migration chạy lên DB đã seed. Mọi giá trị untrusted đi qua `env:`. -- AD-20.
- [x] `.github/workflows/deploy.yml` -- Deploy VPS gắn `environment:` để GitHub chặn chờ required reviewers. -- H5 duyệt thủ công.
- [x] `AGENTS.md` (hoặc `CONTRIBUTING.md`) -- Chép bảng chính sách TypeScript kép + danh sách package bị cấm tới TS 7.1. -- TD-3: để người sau không vô tình cài `ts-jest`.
- [x] `tests/gates/compose-stack.test.ts` -- Phủ hàng 5 của I/O Matrix: parse tĩnh `infra/docker-compose.yml`, assert đúng 4 service, 4 image ghim tag chính xác, không object store, không Caddy, mỗi service có healthcheck. -- Thêm ở Matrix Test Audit của step-03: hàng này trước đó chỉ được kiểm thủ công một lần, tức không phải cổng. Parse tĩnh nên chạy được trong CI không cần Docker daemon.

**Acceptance Criteria:**
- Given repo trống, when chạy `pnpm install && pnpm typecheck && pnpm build`, then cả ba lệnh xanh và cây nguồn khớp đúng tám thư mục spine quy định.
- Given TypeScript kép, when chạy `pnpm typecheck` (TS 7.0.2) rồi `pnpm --filter api build` (`tsc6` 6.0.2), then **cả hai đều xanh trong cùng một repo**.
- Given `docker compose up`, when stack lên, then đủ 4 service healthy, hai DB role tồn tại, và `docker compose config` **không** liệt kê service object store nào.
- Given một pull request, when CI chạy, then bốn job đều bắt buộc xanh mới merge được; job deploy dừng chờ duyệt thủ công.

## Spec Change Log

### 2026-08-25 — vòng review 1: hạ cấp một finding `bad_spec` xuống `patch`

**Finding kích hoạt:** task `packages/contracts/` của spec yêu cầu shape dòng audit phải "kiểm lúc chạy, **sinh được OpenAPI**". Cài đặt không đạt cả hai: `occurred_at` dùng `z.date()` — không phải kiểu wire JSON nên vừa từ chối mọi payload parse từ JSON vừa không emit được JSON Schema; và `openapi.ts` chỉ đăng ký `ErrorEnvelope` + `HealthResponse`, trong khi `contracts.test.ts` assert đúng hai schema đó nên khoá luôn thiếu sót lại.

**Phân loại theo luật:** đây là lệch trực tiếp khỏi spec, tức `bad_spec`, tức loopback — revert code rồi dựng lại từ step-03.

**Đã amend thành gì:** không amend spec. Con người quyết định hạ xuống `patch` và sửa tại chỗ.

**Lý do hạ cấp:** code đã merge vào `main` qua PR #1, CI xanh 5/5 trên runner thật, và cấu hình GitHub (environment `StuWithEnv` + required reviewers + branch protection) đã dựng quanh nó. "Revert code changes" ở trạng thái này nghĩa là revert 86 file khỏi nhánh chính rồi sinh lại toàn bộ — cho một khiếm khuyết ~10 dòng trong schema mà hiện chưa có gì tiêu thụ. Luật loopback được viết cho code chưa commit; áp máy móc vào code đã merge sẽ phá nhiều hơn sửa.

**Trạng thái xấu đã tránh:** không revert `main`; không mất commit sửa `production` → `StuWithEnv` vốn là thứ duy nhất làm H5 có hiệu lực.

**KEEP — phải sống sót qua mọi lần dựng lại sau này:**
- Cơ chế TS kép ba tầng: alias `typescript` trong từng app Nest, `overrides['@nestjs/cli>typescript']`, và `packageExtensions` tiêm compiler 6.0.2 cho `dependency-cruiser`. Tầng thứ ba là thứ chặn lỗi "cruise 0 module nhưng exit 0" — cổng xanh mà không kiểm gì.
- `--no-verbose` trên lệnh migrate: verbose in cả `CREATE ROLE ... PASSWORD` vào log CI.
- Volume Postgres 18 phải mount **trên một cấp** so với `/var/lib/postgresql/data`.
- `packages/domain` chạy Vitest environment `node` **không setup file nào** — đó là cách AD-1 được kiểm chứng chứ không chỉ tuyên bố.
- Test chứng minh cổng AD-1 thật sự đỏ, và test canh số module của `dependency-cruiser`.

**Ghi chú cho người đọc sau:** mục "environment production tồn tại" trong phần Verification bên dưới đã lỗi thời — environment thật tên `StuWithEnv`. Xem `AGENTS.md` §6.

## Design Notes

**Vì sao project references là lớp chính, không phải ESLint:** AC viết *"không có cách nào bỏ qua bằng cấu hình cục bộ"*. `// eslint-disable-next-line` bỏ qua được; lỗi resolve của `tsc` thì không. Đồ thị reference phải để `domain` **thực sự không thấy** hạ tầng — nếu đặt `paths` mapping toàn cục ở base tsconfig thì lớp bảo vệ này bay mất. Đó là cái bẫy dễ vấp nhất của task tsconfig.

**Vì sao pnpm:** `node_modules` không phẳng nghĩa là `packages/domain` không import được `pg` chỉ vì `packages/db` đã cài nó. Đây là lớp thứ ba, miễn phí, cùng chiều với AD-1.

**Về `docs/prd.md`:** file này tồn tại và là PRD thật, nhưng nằm ngoài `_bmad-output/planning-artifacts/` nên bước biên soạn epic context đã bỏ sót. Không sửa `epic-1-context.md` trong story này; chỉ cần biết mà đối chiếu.

## Verification

**Commands:**
- `pnpm install` -- expected: cài xong, lockfile sinh ra, không cảnh báo peer nghiêm trọng
- `pnpm typecheck` -- expected: exit 0, dùng `typescript@7.0.2`
- `pnpm --filter api build && pnpm --filter realtime-gateway build` -- expected: exit 0, dùng binary `tsc6`
- `pnpm --filter web build` -- expected: exit 0, Next.js 16.3.0
- `docker compose -f infra/docker-compose.yml up -d` rồi `docker compose ps` -- expected: 4 service `healthy`; `docker compose config --services` trả đúng 4 tên, không có object store
- `curl -f localhost:{API_PORT}/healthz` và `curl -f localhost:{GATEWAY_PORT}/healthz` -- expected: cả hai `200`, hai cổng khác nhau
- `pnpm dep-check` -- expected: exit 0 khi sạch
- `pnpm test` -- expected: test-kit chạy đủ hai lượt (in-memory + Testcontainers PG18), smoke test hai health-check xanh
- Xoá một biến bắt buộc trong `.env` rồi khởi động `api` -- expected: exit khác 0, log nêu **đúng tên biến thiếu**, không mở cổng
- Thêm `import { Pool } from 'pg'` vào một file trong `packages/domain`, chạy `pnpm typecheck` -- expected: **đỏ**, trỏ đúng dòng; hoàn tác sau khi kiểm

**Manual checks (if no CLI):**
- GitHub repo settings → Environments: environment production tồn tại và có required reviewers (cần quyền admin repo; `gh` CLI chưa cài trên máy này)
- Mở PR thử và xác nhận bốn job hiện ra là required status checks trên branch protection của `main`
