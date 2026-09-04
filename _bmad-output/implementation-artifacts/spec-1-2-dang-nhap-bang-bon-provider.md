---
title: 'Story 1.2 — Đăng nhập bằng bốn provider mạng xã hội'
type: 'feature'
created: '2026-09-04'
baseline_commit: 'cb22e3a1b14e37c497365334353520e90270b209'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Repo có khung nhưng chưa có người dùng. Không có bảng `users`, không có danh tính, không có phiên — nên mọi story sau (ngày sinh, cổng tuổi, phòng học, ví coin) không có chủ thể để gắn vào. Đồng thời hai action audit `auth.signed_in`/`auth.sign_in_failed` đã khai trong `packages/contracts/src/audit.ts` nhưng không có bảng để ghi, tức đang là lời hứa suông.

**Approach:** Dựng luồng OAuth 2.0 authorization-code + PKCE cho Google/Facebook/Apple/Microsoft ở `apps/api`, sinh `users` + `user_identities` + `sessions` + `audit_events`, phát phiên bằng cookie `httpOnly`+`secure` với refresh xoay vòng. Danh tính map bằng **ràng buộc UNIQUE `(provider, provider_user_id)`** chứ không bằng logic ứng dụng. Credential đọc từ env, fail-fast; provider chưa cấu hình thì **không bật**, không đoán giá trị.

## Boundaries & Constraints

**Always:**
- `packages/domain` giữ luật thuần (enum provider, vai trò, quyết định "danh tính này ra user nào") và **port**; SDK OAuth, `pg`, HTTP chỉ được ở `apps/api` và `packages/db`. AD-1 vẫn là lỗi build.
- Mọi payload qua ranh giới `/v1` khai ở `packages/contracts` — không type hợp đồng nào khai trong `apps/*` (AD-13). Lỗi trả đúng envelope `makeError()` sẵn có.
- Không secret nào có default. Provider nào bật thì credential của nó là **bắt buộc**, thiếu là process exit khác 0 nêu đúng tên biến (AD-14).
- Cookie phiên: `httpOnly`, `secure`, `SameSite=Lax`, không đọc được từ JS. Refresh token **chỉ lưu hash** trong DB, xoay vòng mỗi lần refresh, tái sử dụng token cũ = thu hồi cả chuỗi.
- `audit_events` append-only bằng `GRANT`: cả hai role chỉ có `INSERT`, **không** `UPDATE`/`DELETE` — và trong code cũng không tồn tại đường gọi hai lệnh đó (AD-12).
- `stuwith_api` là chủ ghi `users`/`user_identities`/`sessions`; `stuwith_realtime` **không** được `INSERT`/`UPDATE` trên ba bảng này (AD-8).
- Email, provider-id, `code`, `state`, `id_token`, `access_token`, `code_verifier` không bao giờ vào log ở bất kỳ mức nào.
- Quy ước spine: khoá chính `uuidv7()`, bảng snake_case số nhiều, `timestamptz` UTC, migration chỉ tiến (không `down`).

**Ask First:**
- **Ghim dependency mới ngoài danh sách Story 1.1.** Spec này đề xuất `openid-client` (OIDC cho Google/Microsoft/Apple) + `jose` (ký client secret của Apple). Chốt ở CHECKPOINT 1 — **đã duyệt spec thì không hỏi lại lúc thực thi**. Bất kỳ package nào ngoài hai cái này thì HALT.
- Đổi hình dạng cookie/tên cookie sau khi đã chốt, hoặc thêm cột vào `users` ngoài danh sách ở Code Map.

**Never:**
- Rate-limit, khoá brute-force, và **câu chữ trạng thái lỗi cho người dùng** — Story 1.3.
- `date_of_birth` và bước khai ngày sinh — Story 1.4. Cột này **không** xuất hiện trong migration của story này.
- Cổng chặn theo tuổi, decorator "hành vi có tiền" — Story 1.5.
- Token thiết kế, styling, i18n đầy đủ — Story 1.6. Trang đăng nhập ở đây là khung trần có chủ ý.
- Serializer whitelist thay cho deny-list — Story 1.7. Ở đây chỉ mở rộng deny-list và khoá nó bằng test.
- Xác thực WebSocket ở `realtime-gateway`, đường thu hồi quyền — Epic 2/4.
- Bất kỳ lời gọi HTTP đồng bộ nào giữa hai process.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Đăng nhập lần đầu | Callback hợp lệ, `(provider, provider_user_id)` chưa tồn tại | Tạo 1 `users` + 1 `user_identities`, mở phiên, set 2 cookie, 302 về web; 1 dòng `auth.signed_in` | N/A |
| Đăng nhập lại | Cùng `(provider, provider_user_id)` | Map về đúng `user_id` cũ, **không** sinh user mới; tổng số `users` không đổi | N/A |
| Hai provider, cùng email | Google rồi Facebook, cùng địa chỉ email | **Hai user riêng biệt** — email không phải khoá danh tính | N/A |
| Callback đồng thời | Hai request callback song song cho danh tính mới giống nhau | Đúng một user được tạo (UNIQUE `(provider, provider_user_id)` quyết định) | Bên thua đọc lại hàng đã có, không trả 500 |
| Tài khoản tổ chức Microsoft | `@fpt.com`, tenant cấu hình `organizations`/tenant-id | Đổi được code lấy token, `oid`+`tid` map thành `provider_user_id`, vào được | N/A |
| `state` sai hoặc thiếu | Callback không kèm cookie state, hoặc state lệch | Không mở phiên; `unauthenticated` theo envelope chuẩn; 1 dòng `auth.sign_in_failed` | Không nêu tên provider, không mã lỗi provider |
| Provider chưa bật | `GET /v1/auth/apple/start` khi `apple` không nằm trong `AUTH_ENABLED_PROVIDERS` | `404` + `not_found` | Không lộ provider nào đang bật |
| Refresh xoay vòng | `POST /v1/auth/refresh` với refresh cookie hợp lệ | Cookie mới, hàng session cũ đánh dấu đã xoay, session id giữ nguyên | N/A |
| Refresh token dùng lại | Gửi lại refresh token **đã bị xoay** | Thu hồi toàn bộ chuỗi session đó; `unauthenticated` | Coi là dấu hiệu bị đánh cắp, không phải lỗi tạm |
| Phiên hết hạn | `GET /v1/auth/me` sau khi hết TTL | `401` + `unauthenticated` | N/A |
| Thiếu env của provider đã bật | `AUTH_ENABLED_PROVIDERS=google` nhưng thiếu `GOOGLE_CLIENT_SECRET` | Process exit khác 0 **trước khi mở cổng**, log nêu đúng tên biến | Không default, không tự tắt provider |
| Log của trọn luồng | Chạy hết start→callback→refresh với logger thật | Không dòng log nào chứa email, provider-id, `code`, `state`, `id_token`, token | N/A |

</frozen-after-approval>

## Code Map

**Đọc trước khi viết — quy ước đã có, bám theo, đừng phát minh lại:**
- `AGENTS.md` §1 (TS kép), §2 (AD-1), §4, §6 -- §6 ghi rõ deny-list PII hiện là "sàn, không phải control hoàn chỉnh"
- `packages/db/migrations/1755734500000_process-roles.js:114-158` -- posture DENY mặc định: bảng mới **chỉ** thừa kế `SELECT`; migration của story này phải `GRANT` tường minh. `:156-158` là mẫu grant có chủ đích, `:160-167` là `COMMENT ON ROLE` đã hứa sẵn `users` thuộc chủ ghi `stuwith_api`
- `packages/db/migrations/1755734400000_infrastructure-baseline.js:21-29` -- mẫu bảng: `uuidv7()`, `timestamptz`, không `down`, `COMMENT ON TABLE`
- `packages/contracts/src/audit.ts:14-19,24-47` -- `AUDIT_ACTIONS` **đã có** `auth.signed_in`/`auth.sign_in_failed`; `auditEventSchema` là hình dạng hàng phải khớp. `occurred_at` là ISO string, không `z.date()` — đừng lặp lại lỗi cũ
- `packages/contracts/src/error.ts:96-109` -- `errorEnvelopeSchema` + `makeError()`; `details` cấm khoá `provider_error`, giá trị 1 dòng ≤200 ký tự
- `packages/config/src/schema.ts:20-22,38-44` -- helper `secret()`; `SESSION_COOKIE_SECRET` (min 32) **đã tồn tại** trong `apiEnvSchema`, dùng lại
- `packages/config/src/logging.ts:12-31` -- `LOG_REDACT_PATHS`; đã có `*.email`, `*.provider_id`, `*.access_token`
- `apps/api/src/app.module.ts:15-22` -- `AppModule.forConfig()`: config được **truyền vào**, không đọc trong module. Module mới gắn ở đây
- `apps/api/src/health/health.controller.ts:15-22` -- mẫu controller: parse response qua schema của contracts
- `packages/db/src/pg/heartbeat-adapter.ts:24-45` -- mẫu adapter: một câu lệnh có điều kiện, **fault không bao giờ biến thành refusal**
- `packages/domain/src/ports/heartbeat-port.ts:30-102` -- hình dạng port chuẩn của repo: refusal là nhánh `{ok:false}`, input sai thì `throw`
- `packages/db/src/test-kit.ts:14-45` + `packages/db/src/__testing__/postgres.ts` -- harness Testcontainers PG18 dùng lại cho test adapter mới
- `vitest.config.mts:20-92` -- project `db` (Docker, tuần tự) / `api` / `gates`. Test mới rơi vào `db` hoặc `api`, **không** vào `domain`
- `apps/api/src/logging.test.ts` -- mẫu test chạy pino thật rồi assert không rò rỉ; test PII của story này nối dài file này

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/auth.ts` (+ export ở `index.ts`) -- Khai `AUTH_PROVIDERS = ['google','facebook','apple','microsoft']`, `USER_ROLES` sáu vai, và shape của `GET /v1/auth/me` (`{id, display_name, avatar_url, role}` — **không email, không provider-id**). -- AD-13; đồng thời chốt "mô hình vai trò chứa được sáu vai ngay từ đầu" ở đúng một chỗ.
- [x] `packages/domain/src/ports/identity-port.ts`, `session-port.ts` -- Port cho "tìm-hoặc-tạo user theo danh tính provider" và vòng đời phiên (mở, đọc, xoay, thu hồi chuỗi). Không import SDK nào. -- AD-1; theo hình dạng `heartbeat-port.ts`.
- [x] `packages/domain/src/policies/identity.ts` -- Hàm thuần: chuẩn hoá `provider_user_id`, quyết định "email trùng ≠ cùng người", vai trò mặc định `user`. Test chạy không cần DB. -- Luật danh tính phải kiểm được ở tầng không có hạ tầng.
- [x] `packages/db/migrations/<ts>_users-and-identities.js` -- Tạo `users`, `user_identities` (UNIQUE `(provider, provider_user_id)`), `sessions` (lưu **hash** refresh token, `rotated_at`, `revoked_at`, `expires_at`), `audit_events`. `GRANT INSERT, UPDATE` ba bảng đầu **chỉ** cho `stuwith_api`; `GRANT INSERT` (không `UPDATE`/`DELETE`) `audit_events` cho cả hai role. -- AC "bảng `users` được tạo trong story này"; AD-8 + AD-12 cưỡng chế bằng quyền, không bằng lời văn.
- [x] `packages/db/src/pg/identity-adapter.ts`, `session-adapter.ts`, `audit-adapter.ts` (+ `index.ts`) -- Cài đặt ba port. Tìm-hoặc-tạo là **một** `INSERT ... ON CONFLICT (provider, provider_user_id) DO NOTHING` rồi đọc lại — không read-then-write. -- Chống đua ở hàng "Callback đồng thời" của Matrix.
- [x] `packages/db/src/in-memory/identity-adapter.ts`, `session-adapter.ts` -- Bản in-memory của cùng port, để suite hợp đồng chạy hai lượt. -- TD-5.
- [x] `packages/db/src/identity-contract.test.ts` + `.pg.test.ts`, `session-contract.*` -- Mở rộng test-kit: một suite hợp đồng dùng chung, chạy in-memory và PG18 thật. -- Cổng CI #3 phải thật sự phủ port mới.
- [x] `packages/config/src/schema.ts` -- Thêm `AUTH_ENABLED_PROVIDERS`, `WEB_BASE_URL`, `OAUTH_REDIRECT_BASE_URL`, TTL phiên/refresh, và credential từng provider (Microsoft kèm `MICROSOFT_TENANT_ID`; Apple kèm team id / key id / private key). `superRefine`: provider có trong danh sách bật thì credential của nó bắt buộc. -- AD-14 + hàng "Thiếu env của provider đã bật".
- [x] `packages/config/src/logging.ts` -- Bổ sung deny-list: `code`, `state`, `code_verifier`, `id_token`, `refresh_token`, `client_secret`, và cookie phiên. -- AC "email và provider-id không xuất hiện trong bất kỳ dòng log nào".
- [x] `apps/api/src/auth/` (module, controller, service, provider adapters) -- `GET /v1/auth/:provider/start` (302 + PKCE/state trong cookie ngắn hạn), `GET /v1/auth/:provider/callback`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me`. Ba provider OIDC dùng discovery; Facebook có adapter riêng. -- Trái tim story; gắn vào `AppModule.forConfig()`.
- [x] `apps/api/src/auth/audit.ts` -- Ghi **đúng một** dòng `auth.signed_in` / `auth.sign_in_failed` mỗi lần, mang `request_id` lấy từ `REQUEST_ID_HEADER`. `metadata` chỉ chứa scalar không-PII. -- AD-12; khoá cam kết mà `contracts/audit.ts` đã khai.
- [x] `apps/api/src/auth/__testing__/fake-authorization-server.ts` -- OIDC server giả trong process: discovery, `/authorize`, `/token`, JWKS, ký `id_token` thật. -- Cách duy nhất chứng minh luồng end-to-end khi chưa có credential thật.
- [x] `apps/api/src/auth/auth.flow.test.ts` -- Phủ **mọi hàng** của I/O Matrix qua fake server: lần đầu, lần hai, hai provider cùng email, callback đua, state sai, provider tắt, refresh xoay, refresh dùng lại, phiên hết hạn, tenant Microsoft. -- Matrix không có test là Matrix không có hiệu lực.
- [x] `apps/api/src/logging.test.ts` -- Nối thêm: chạy trọn luồng đăng nhập với pino thật, assert không dòng nào chứa email/provider-id/`code`/`state`/`id_token`/token. -- Hàng cuối Matrix; theo đúng mẫu test PII sẵn có.
- [x] `apps/web/src/app/dang-nhap/page.tsx` + link từ `page.tsx` -- Bốn liên kết tới `/v1/auth/{provider}/start` và hiển thị trạng thái từ `/v1/auth/me`. **Khung trần, không style.** -- Web là client thuần; giao diện thật đến ở 1.6.
- [x] `.env.example`, `AGENTS.md` §6 -- Liệt kê mọi biến mới với giá trị rỗng; ghi vào §6 rằng credential thật chưa cắm và AC Microsoft/Entra còn treo một manual check. -- Giữ "known gaps" trung thực thay vì để nó mục âm thầm.

**Acceptance Criteria:**
- Given `pnpm check && pnpm test`, when chạy trên repo sạch, then xanh; suite hợp đồng của port mới chạy đủ **hai lượt** (in-memory + PG18 Testcontainers).
- Given migration đã chạy, when `stuwith_realtime` thử `INSERT`/`UPDATE` trên `users`, `user_identities`, `sessions`, then Postgres từ chối vì thiếu quyền; và khi **bất kỳ** role nào thử `UPDATE` hoặc `DELETE` trên `audit_events`, Postgres cũng từ chối.
- Given một lần đăng nhập thành công qua fake server, when đọc response, then cookie phiên có `HttpOnly` + `Secure`, và `GET /v1/auth/me` trả hồ sơ **không chứa** email hay provider-id.
- Given `AUTH_ENABLED_PROVIDERS` liệt kê cả bốn provider, when khởi động `api` mà thiếu bất kỳ credential nào, then process exit khác 0 nêu đúng tên biến thiếu, trước khi mở cổng.

## Spec Change Log

**2026-09-04 — dependency decision.** Of the two packages approved at CHECKPOINT 1,
only `jose@5.10.0` was installed (in `apps/api`). `openid-client` was not needed:
discovery, the token exchange and the Graph API call are three `fetch` calls, and
`fetch` had to be injectable anyway for the fake authorization server to work at
all. `jose` earns its place — JWKS handling, `id_token` verification and Apple's
ES256 client secret are not code to hand-roll. Version 5 rather than 6 because v6
is ESM-only and `apps/api` is a CommonJS bundle built by `tsc6`; v5 ships a `require`
build. Nothing outside the approved list was added.

**2026-09-04 — one port more than the spec listed.** The Execution list named
`identity-port.ts` and `session-port.ts` but also asked `packages/db` to implement
"three ports" including `audit-adapter.ts`. `packages/domain/src/ports/audit-port.ts`
was added to close that gap: an adapter with no port to implement would put the
audit row shape in `packages/db`, which AD-1 forbids. It has exactly one method,
`append` — there is no `update` and no `delete` for anyone to call, which is the
code-side half of the GRANT posture.

**2026-09-04 — `code` is redacted structurally, not by a deny-list path.** The spec
asked for `code` in `LOG_REDACT_PATHS`. A bare `*.code` would also delete `err.code`
(SQLSTATE, errno) from every log line, and it would not have covered the real leak,
which is `req.url` on the callback — a redaction path cannot reach inside a string.
Both processes now put `sanitizeLoggedUrl` in front of `req.url`, dropping the whole
query string, and the specific paths (`req.query.code`, `req.body.code`,
`*.code_verifier`, `*.id_token`, `*.state`, `*.client_secret`, ...) cover the rest.
The omission is asserted by a test and recorded in `AGENTS.md` §6 so it stays a
decision. Net effect is stronger than the literal instruction; the intent — "`code`
never reaches a log line" — is verified end to end by a real login through a real
pino.

**2026-09-04 — two test seams added to `AppModule.forConfig`.** `authRuntime` and
`logDestination`, following the precedent `loadApiConfig`'s injected `ExitBehaviour`
set. Neither is reachable from the environment: production calls
`forConfig(config)` and gets Postgres and stdout.

**2026-09-04 — `WEB_BASE_URL` and `OAUTH_REDIRECT_BASE_URL` are unconditionally
required.** Making them conditional on a provider being enabled would have kept
existing fixtures untouched but left `ApiEnv` carrying `string | undefined` for
values every redirect depends on. Four env fixtures were updated instead.

**2026-09-04 — `pnpm test:contract` filter widened** from `heartbeat-contract` to
`contract`, or CI gate #3 would have kept running only the Story 1.1 suite while
the new ports went unchecked.

### 2026-09-04 — review patch round (19 findings, no loopback)

**Five defects that would have reached production.**

*CORS was absent entirely.* `apps/web` calls the API cross-origin with
`credentials: 'include'`, so both browser calls were blocked and the login page
could never read a session back — invisible to every test, because Node's `fetch`
ignores CORS. `apps/api/src/http-setup.ts` now enables it with the origin taken
from `WEB_BASE_URL` and `credentials: true`; never a wildcard, which the fetch
spec rejects outright alongside credentials. It is called by BOTH `main.ts` and
the flow harness, so the harness can no longer be testing a differently-configured
server than the one that ships.

*Apple could never have worked.* Apple requires `response_mode=form_post` once the
scope includes `name` or `email`, and then POSTs a form-encoded callback. The
registry asked for that scope, set no response mode, and there was no POST route.
Both are now in place, the fake authorization server refuses the wrong combination
the way Apple does, and the flow test drives a real cross-site form POST. One half
of the finding was wrong on inspection and is recorded in the code: Fastify ships
no urlencoded parser, but `@nestjs/platform-fastify` registers one during
`init()`, so adding our own threw `Content type parser ... already present`.

*Logout did nothing an hour into a session.* It revoked the chain only while the
access token was still readable; after `SESSION_TTL_SECONDS` the read refused,
nothing was revoked, and the thirty-day refresh chain stayed valid server-side —
clearing cookies protects nobody who already holds the token. `SessionPort` gained
`revokeChainByRefreshTokenHash`, which takes the refresh token as the handle and
ignores its own rotated/expired state, with contract examples on both adapters.

*The schema-drift guard was never executed by CI.* `identity-schema.test.ts` — the
only thing holding `AUTH_PROVIDERS`/`GLOBAL_USER_ROLES`/`AUDIT_ACTIONS` in step
with the migration's CHECK constraints — matched neither the `contract` nor the
`migration` filename filter. Gate 3 now selects by PROJECT (`vitest run --project
db`) rather than by a substring somebody has to remember, so the next file added to
`packages/db` is covered without a naming convention.

*`PgAuditAdapter.append` had no test at all.* Every audit assertion ran against the
in-memory adapter, so a swapped parameter or a dropped `JSON.stringify` would have
shipped green into the one table that cannot be corrected afterwards. Added
`runAuditPortContract` and the two-pass pair; the Postgres pass connects as
`stuwith_api`, so it also pins that the INSERT-only GRANT suffices.

**Audit coverage completed.** `SignInFailureReason` gained members for the start
leg and for every refresh refusal, and three paths that previously ended in a 401
or a 500 with no row now write one: a provider outage during `/start` (502 +
`provider_start_failed`, not 401 — an outage is not the user's fault), an
`IdentityInputError` or a `jose` key error during the callback
(`identity_rejected`), and every refresh refusal rather than only the reused-token
case. A store FAULT during `findOrCreateByIdentity` still propagates as a 500: a
database outage must not read to a user as "your account was rejected".

**Two tabs now work.** `OAUTH_STATE_COOKIE_NAME` became
`OAUTH_STATE_COOKIE_PREFIX`: one cookie per attempt, and the callback finds its own
by verifying each candidate's signature and matching the `state` inside it rather
than by trusting a cookie name. A single fixed name meant a second `/start`
clobbered the first tab, and finishing the first tab failed as "state missing".

**Test fidelity.** The harness cookie jar keys on `(name, path)` and path-matches
per RFC 6265 §5.1.4 — a name-keyed jar models a browser that ignores paths, under
which clearing the session cookie at the wrong path reads as a successful logout.
`Path` is now asserted on every cookie the flow sets and clears. `normalizePem`'s
escaped-newline branch — the form `.env.example` documents and production will use
— has its own test proving a verifiable ES256 secret comes out; every existing test
fed a real multi-line PEM, so deleting the transformation was green. A
`realtime-gateway` Vitest project now exists at all: a test placed there previously
would not have run, while `AGENTS.md` claimed both processes share the AD-15 URL
sanitising.

**Hardening.** Provider requests carry `AbortSignal.timeout(5s)`; without it a
provider that accepts the connection and never answers holds a Fastify connection
and a `pg` pool slot indefinitely.

**Documentation corrected where it was false.** Both the `Secure`-cookie
justifications claimed "Caddy is in the compose stack for exactly this";
`infra/docker-compose.yml` says the opposite. The decision stands, the reason
did not: Chrome ≥ 89 and Firefox ≥ 75 accept `Secure` cookies over
`http://localhost`, so ordinary local development needs no TLS — Safari and any
non-localhost plain-HTTP origin do. `AuditPort`'s docblock claimed `occurred_at`
was the store's business directly above a caller-supplied `occurredAt`; the field
stays (one clock read per request, so a request's rows agree, and `FixedClock`
makes the trail testable) and the comment now argues for it. `normalizeAvatarUrl`
said "http(s)" while accepting https only. Unbounded `sessions` growth with no role
able to prune it is now recorded in `AGENTS.md` §6 as an owned gap. Mangled
indentation in `apps/api/src/logging.ts` fixed by hand; the gateway's copy of the
five-line OAuth-callback rationale replaced by a pointer, since it serves no
`/v1/auth/*` route.

## Design Notes

**Vì sao `AUTH_ENABLED_PROVIDERS` thay vì bắt buộc cả bốn:** AC đòi bốn provider chạy được, nhưng credential thật chưa có (quyết định của con người, 2026-09-04). Bắt buộc cả bốn thì `api` không khởi động nổi trên máy dev; cho credential một giá trị default thì phá AD-14. Danh sách bật tường minh giữ được cả hai: không đoán gì, và "nửa cấu hình" là trạng thái **không tồn tại** — provider đã bật mà thiếu secret thì process chết ngay, provider chưa bật thì endpoint trả `404`.

**Vì sao danh tính tách khỏi `users`:** AC nói "map đúng theo provider-id, không tạo tài khoản trùng". Đặt `provider`/`provider_user_id` thẳng trên `users` khiến "một người, hai provider" thành hai user vĩnh viễn và không gộp được. Bảng `user_identities` với UNIQUE `(provider, provider_user_id)` biến chống-trùng thành **ràng buộc DB**, không phải nhánh `if` — cùng tinh thần với AD-8.

**Vì sao email không phải khoá danh tính:** provider khác nhau xác minh email ở mức khác nhau, Apple còn phát email trung chuyển. Gộp theo email là đường để chiếm tài khoản. Hai user riêng là kết quả **đúng**; gộp tài khoản là tính năng có chủ ý của epic sau.

**Vì sao phiên opaque, không JWT:** spine đòi WebSocket "xác thực lại khi phiên bị thu hồi". JWT không thu hồi được trước hạn mà không dựng thêm sổ đen — tức là vẫn phải có bảng. Một `sessions` server-side làm được cả refresh xoay vòng lẫn thu hồi tức thì, và Epic 2 chỉ cần đọc bảng đó.

**Cột của `users` (chốt ở đây, mở rộng là Ask First):** `id`, `display_name`, `email` (nullable — Apple giấu được), `avatar_url` (URL từ provider, AD-29 cấm object store), `role`, `created_at`, `updated_at`. **Không** `date_of_birth` (1.4). `role` chứa năm vai toàn cục; `host` **cố ý vắng mặt** vì nó là quyền theo từng phòng, thuộc Epic 2.

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0; `dependency-cruiser` không báo `packages/domain` chạm SDK OAuth hay `pg`
- `pnpm test` -- expected: exit 0; suite hợp đồng identity/session chạy hai lượt; test luồng auth phủ đủ hàng Matrix
- `pnpm --filter api build` -- expected: exit 0, dùng `tsc6`
- `pnpm migrate` trên DB có dữ liệu sẵn -- expected: exit 0, không khoá bảng lâu (cổng CI #4)
- `psql` bằng role `stuwith_realtime`: `UPDATE users SET display_name='x'` -- expected: `permission denied`
- `psql` bằng role `stuwith_api`: `UPDATE audit_events SET action='x'` và `DELETE FROM audit_events` -- expected: cả hai `permission denied`
- Đặt `AUTH_ENABLED_PROVIDERS=google` rồi xoá `GOOGLE_CLIENT_SECRET`, khởi động `api` -- expected: exit khác 0, log nêu đúng `GOOGLE_CLIENT_SECRET`, không mở cổng
- `pnpm test:e2e` -- expected: smoke test cũ vẫn xanh

**Manual checks (if no CLI):**
- AC "tài khoản tổ chức `@fpt.com` qua Microsoft/Entra": treo lại tới khi có credential thật. Kiểm được ngay ở mức cấu hình — `MICROSOFT_TENANT_ID` đi vào đúng authority URL và `oid`+`tid` là thứ tạo `provider_user_id`. Ghi trạng thái treo này vào `AGENTS.md` §6.
- Đọc `.env.example`: mọi biến mới có mặt, giá trị rỗng, không secret thật nào bị dán vào.

## Suggested Review Order

**Luật danh tính — đọc trước tiên**

- Điểm vào: cả năm endpoint và mọi quyết định phiên hội tụ ở lớp này.
  [`auth.service.ts:113`](../../apps/api/src/auth/auth.service.ts#L113)

- Hàm thuần quyết định "danh tính nào ra user nào", test được không cần DB.
  [`identity.ts:32`](../../packages/domain/src/policies/identity.ts#L32)

- Microsoft khoá theo `(tid, oid)`, không theo `sub` — `sub` xoay được, cặp kia thì không.
  [`identity.ts:59`](../../packages/domain/src/policies/identity.ts#L59)

- Port giữ hạ tầng ngoài miền; adapter chỉ là chi tiết thay được.
  [`identity-port.ts:71`](../../packages/domain/src/ports/identity-port.ts#L71)

**Lược đồ và quyền — nơi luật được cưỡng chế, không phải nơi nó được phát biểu**

- `UNIQUE (provider, provider_user_id)` CHÍNH LÀ luật chống trùng tài khoản.
  [`users-and-identities.js:105`](../../packages/db/migrations/1788480000000_users-and-identities.js#L105)

- AD-8: chỉ `stuwith_api` ghi được ba bảng danh tính.
  [`users-and-identities.js:188`](../../packages/db/migrations/1788480000000_users-and-identities.js#L188)

- AD-12: không role nào `UPDATE`/`DELETE` được audit — append-only bằng quyền.
  [`users-and-identities.js:203`](../../packages/db/migrations/1788480000000_users-and-identities.js#L203)

- Một lệnh có điều kiện rồi đọc lại; không read-then-write, nên callback đua không sinh hai user.
  [`identity-adapter.ts:150`](../../packages/db/src/pg/identity-adapter.ts#L150)

**Luồng OAuth**

- Đổi code, xác minh `id_token` bằng JWKS, kiểm `iss`/`aud`/`nonce`.
  [`oidc-provider.ts:93`](../../apps/api/src/auth/providers/oidc-provider.ts#L93)

- Apple bắt buộc `response_mode=form_post` khi scope xin `name`/`email`.
  [`registry.ts:83`](../../apps/api/src/auth/providers/registry.ts#L83)

- CORS phải cho phép credential và bám `WEB_BASE_URL`; wildcard sẽ fail closed.
  [`http-setup.ts:28`](../../apps/api/src/http-setup.ts#L28)

**Phiên, cookie, thu hồi**

- Refresh token là tay cầm của đăng xuất — session token chỉ sống một giờ.
  [`auth.service.ts:345`](../../apps/api/src/auth/auth.service.ts#L345)

- Xoay vòng: dùng lại thế hệ đã xoay là tín hiệu bị đánh cắp, không phải lỗi tạm.
  [`session-port.ts:102`](../../packages/domain/src/ports/session-port.ts#L102)

- Một cookie state cho mỗi lần thử, nên hai tab không đá nhau.
  [`cookies.ts:117`](../../apps/api/src/auth/cookies.ts#L117)

- Xoá cookie phải đúng `Path` đã đặt, nếu không trình duyệt giữ lại bản cũ.
  [`cookies.ts:150`](../../apps/api/src/auth/cookies.ts#L150)

**Audit và PII**

- Đúng một dòng mỗi lần thử, mang `request_id` truy được xuyên hai process.
  [`audit.ts:58`](../../apps/api/src/auth/audit.ts#L58)

- Query string bị bỏ cả cụm, không lọc: `redact` không với được vào trong một chuỗi.
  [`logging.ts:91`](../../packages/config/src/logging.ts#L91)

**Cấu hình fail-fast**

- Provider đã bật thì credential của nó bắt buộc; nửa cấu hình là trạng thái không tồn tại.
  [`schema.ts:183`](../../packages/config/src/schema.ts#L183)

**Kiểm chứng**

- Cổng 3 chọn theo project, nên file mới trong `packages/db` tự động được phủ.
  [`package.json:22`](../../package.json#L22)

- Chạy `PgAuditAdapter` bằng chính role `stuwith_api`, nên GRANT chỉ-INSERT cũng được kiểm.
  [`audit-contract.pg.test.ts:45`](../../packages/db/src/audit-contract.pg.test.ts#L45)

- Phủ trọn 12 hàng I/O Matrix qua authorization server giả trong process.
  [`auth.flow.test.ts:51`](../../apps/api/src/auth/auth.flow.test.ts#L51)

- Quyền kiểm bằng câu lệnh thật trên PG18, không phải bằng bit đặc quyền.
  [`migrations.test.ts:332`](../../packages/db/src/migrations.test.ts#L332)

- Chặn nửa cấu hình: dựng process thật, khẳng định nó chưa từng mở cổng.
  [`config-fail-fast.test.ts:238`](../../tests/gates/config-fail-fast.test.ts#L238)
