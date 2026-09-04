# StuWith — repository rules for humans and agents

This file is the operating manual for the repo. It records the rules that are
**mechanically enforced** and the two or three that are not, so nobody has to guess
which is which.

Architecture decisions live in
`_bmad-output/planning-artifacts/architecture/architecture-StuWith-2026-08-20/ARCHITECTURE-SPINE.md`
(referenced below as AD-*). Test and CI decisions live in
`_bmad-output/test-artifacts/test-stack-decision.md` (TD-*).

---

## 1. The dual TypeScript policy (TD-3) — read before installing anything

TypeScript 7.0 ships a Go-native compiler and **removed the programmatic compiler
API** (`Program` / `LanguageService`). It returns in 7.1. Until then this repo runs
two compilers side by side, on purpose:

| Job | Compiler | Invoked by |
| --- | --- | --- |
| Repo-wide `typecheck`, build of `apps/web` | `typescript@7.0.2` (binary `tsc`) | `pnpm typecheck`, `next build` |
| `nest build` for `apps/api` and `apps/realtime-gateway` | `@typescript/typescript6@6.0.2` (binary `tsc6`) | `pnpm --filter api build` |
| Vitest transform | esbuild, via Vite | `pnpm test` |
| Playwright transform | Playwright's own babel | `pnpm test:e2e` |
| dependency-cruiser parse | `@typescript/typescript6@6.0.2` | `pnpm dep-check` |
| Lint | none — `pnpm check` is dep-check + typecheck | blocked by TS 7.0, see section 6 |

Neither Vitest nor Playwright touches the `typescript` package, which is why the
policy costs nothing at test time.

### How the split is wired, so you can find it when it breaks

- `apps/api` and `apps/realtime-gateway` declare
  `"typescript": "npm:@typescript/typescript6@6.0.2"`. The Nest CLI resolves
  `typescript` starting from the app directory, so this alias is what actually makes
  `nest build` compile on 6.0.2.
- `pnpm-workspace.yaml` adds `overrides['@nestjs/cli>typescript']` pointing at the
  same package — the CLI pins `typescript@5.9.3` as a direct dependency, and without
  the override that copy wins in some resolution orders.
- `pnpm-workspace.yaml` adds a `packageExtensions` entry giving `dependency-cruiser`
  its own 6.0.2 compiler. Under TS 7 the tool degrades to **"0 modules cruised" and
  exits 0** — a green gate that checked nothing. If `dep-check` ever reports a
  suspiciously low module count, that is what happened.

### Banned until TypeScript 7.1

Do **not** install any of these. They call the removed compiler API and break the
repo, usually in a way that first shows up as an unrelated test failure:

- `ts-jest` — use Vitest (TD-1)
- `ts-node` — run `node` on built output, or use `vitest`
- `ts-morph`
- `@typescript-eslint/*` **with `parserOptions.project`** (type-aware linting)

---

## 2. AD-1 — the dependency direction is a build error, not review feedback

`packages/domain` must not import `apps/*`, `packages/db`, or any infrastructure SDK
(`pg`, a Valkey client, LiveKit, an HTTP client) — nor a Node builtin.

Three layers enforce it. They do **not** all catch the same things, and the table
below is the accurate division of labour — an earlier version of this section
claimed the reference graph caught everything, which was measurably false for Node
builtins.

| Kind of violation | Caught by the type layer? | Caught by dependency-cruiser? |
| --- | --- | --- |
| `import { Pool } from 'pg'` (not a dependency of domain) | yes — does not resolve | yes, as `no-unresolvable` |
| `import ... from '@stuwith/db'` | yes — does not resolve | yes |
| Deep relative reach, `../../db/src/...` | yes — outside `rootDir` | yes, `ad1-domain-no-app-or-adapter` |
| `import { readFileSync } from 'node:fs'` | yes — **only because** domain sets `types: []` | yes, `ad1-domain-no-node-builtins` |
| `import type { Pool } from 'pg'` | **no** — erased before emit | yes |
| `await import('pg')` | **no** — never in the type graph | yes |
| `pg` after someone adds it to domain's `package.json` | **no** — it resolves fine | yes, `ad1-domain-no-infra-sdk` |

1. **Primary — TypeScript project references.** `packages/domain/tsconfig.json`
   references *only* `packages/contracts`, so a package import has nowhere to
   resolve to and `tsc` fails on the exact line. No comment switches this off.
   Node builtins are a separate mechanism: `tsconfig.base.json` puts
   `types: ["node"]` in scope for every project, so `packages/domain/tsconfig.json`
   overrides it with `"types": []`. Remove that line and `node:fs` typechecks
   cleanly inside the domain again.
2. **Secondary — `dependency-cruiser`** (`.dependency-cruiser.cjs`). It is the only
   layer that covers the bottom three rows of the table. Note the `exclude` option
   there must never list `node_modules`: excluded modules leave the graph entirely,
   and a rule whose target is `node_modules/pg` cannot match a node that does not
   exist. `doNotFollow` is the setting that keeps installed packages cheap.
3. **Free — pnpm's isolated `node_modules`.** `packages/domain` cannot resolve `pg`
   just because `packages/db` installed it. Never set `node-linker=hoisted` or
   `shamefully-hoist=true` in `.npmrc`. This layer disappears the moment someone
   adds the dependency deliberately, which is why layer 2 exists.

**Three edits silently repeal most of the above. Do not make them:**

- adding a `paths` mapping to `tsconfig.base.json`,
- adding an entry to `packages/domain/tsconfig.json`'s `references`, or
- removing `"types": []` from `packages/domain/tsconfig.json`.

`tests/gates/ad-1-dependency-direction.test.ts` proves each rule is red for a
violation *by name* — not merely that the output mentions the offending file,
which `no-unresolvable` alone would satisfy. If you change the enforcement
mechanism, that test must still pass: it is the only thing standing between "we
have a gate" and "we believe we have a gate".

ESLint is deliberately **not** the primary layer: `// eslint-disable-next-line`
defeats it, and the acceptance criterion says there must be no way to bypass the
rule with local configuration.

---

## 3. Layout

```text
apps/web                 Next.js 16.3 client. May import packages/contracts only.
apps/api                 NestJS on Fastify. REST /v1, OAuth, classroom tokens.
apps/realtime-gateway    NestJS on Fastify. WebSocket, coin scheduler, sessions.
packages/domain          Pure rules and ports. No infrastructure, ever.
packages/contracts       Wire vocabulary for /v1 and the audit row shape. Emits OpenAPI.
packages/db              Postgres adapters, migrations, and the shared contract test-kit.
packages/config          Env schema, fail-fast startup validation, logging policy.
infra/                   docker compose stack: postgres, valkey, livekit, coturn.
```

Directories are kebab-case. NestJS modules are named after domain nouns from the PRD
glossary (`private-session`, not `chat-1v1`).

`tests/` and `.github/` sit outside that list on purpose: they hold gates, not
product code.

---

## 4. Rules with teeth

- **AD-8 — one writer per entity, enforced by `GRANT`.** Two login roles,
  `stuwith_api` and `stuwith_realtime`. New tables inherit `SELECT` only via
  `ALTER DEFAULT PRIVILEGES`, so a migration that adds a table and forgets to think
  about ownership fails closed. A story that needs a write grants it explicitly, to
  exactly one role. Three details in that migration are load-bearing:
  - `ALTER DEFAULT PRIVILEGES **FOR ROLE**`, named rather than implied. The bare
    form silently means `FOR ROLE current_user`, so a migration later run by a
    different role would create tables inheriting nothing.
  - default privileges on **SEQUENCES** as well as TABLES. An identity or `serial`
    column owns a sequence, and a granted INSERT still fails with "permission
    denied for sequence" without it.
  - `REVOKE CREATE ON SCHEMA public` from both app roles, which is what makes
    "only migrations create tables here" true rather than assumed.
- **AD-14 — no default value for any secret.** `packages/config` validates the
  environment once and exits non-zero, naming the exact missing variable, *before a
  port is opened*. Every variable is listed in `.env.example`. `.env` is git-ignored.
  "Before a port is opened" is a property of the process, not of the function, so
  `tests/gates/config-fail-fast.test.ts` spawns the real built `apps/api` with a
  variable removed and asserts the port never accepts a connection. Moving
  `loadApiConfig()` below `app.listen()` fails there and nowhere else.
- **AD-12 — the audit trail is append-only.** No role holds `DELETE`. Do not add one.
- **AD-15 — an inbound `x-request-id` is never trusted verbatim.** It is stamped on
  every log line for the request and echoed in a response header, so a raw value
  gives the caller log injection (newlines) and unbounded log growth (length).
  `resolveRequestId` in `packages/config` accepts it only if it already looks like
  an id, and mints a fresh one otherwise. Both processes go through that one
  function; do not re-implement it per app.
- **AD-13 — contract types live in `packages/contracts`, never in `apps/*`.** Adding
  an optional field is compatible. Renaming, retyping, removing, or tightening a
  constraint is breaking and goes to `/v2`.
- **AD-24 — the two processes never call each other directly** for anything with a
  money or permission consequence. `dependency-cruiser` blocks the import; the
  durable outbox channel arrives in Epic 4.
- **AD-29 — no object store**, not in production and not in `docker compose`. The MVP
  stores no binaries. A MinIO container "just for dev" is how a PII store nobody
  approved comes into existence.
- **Migrations are forward-only** and must run against a database that already has
  rows. CI gate 4 checks exactly that.
- **`--no-verbose` on migrations is not cosmetic**: verbose mode prints every
  statement, and the roles migration contains `CREATE ROLE ... PASSWORD`.

---

## 5. Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Requires Node >= 24.14.1 (`engine-strict`). pnpm comes from corepack. |
| `pnpm typecheck` | `tsc -b` over the reference graph, then `apps/web`. TS 7.0.2. |
| `pnpm build` | Packages (TS 7), then both Nest apps (tsc6), then Next. |
| `pnpm test` | Every Vitest project. Needs Docker for the Postgres passes. |
| `pnpm test:unit` | domain + contracts + config + api + realtime-gateway + web. No Docker, no network. |
| `pnpm test:contract` | CI gate 3 — the adapter suite against in-memory and PG18. |
| `pnpm test:migrations` | CI gate 4 — migrations on a seeded PG18. |
| `pnpm test:gates` | Proves each gate rejects what it claims to. Builds `apps/api` first — one gate spawns the real process. |
| `pnpm test:e2e` | Playwright smoke test: `/healthz` on both processes. |
| `pnpm dep-check` | CI gate 2, secondary layer. |
| `pnpm --filter @stuwith/db migrate` | Forward migrations. Needs `MIGRATION_DATABASE_URL`. |
| `docker compose --env-file .env -f infra/docker-compose.yml up -d --wait` | The four-service local stack. `--env-file` is required: Compose otherwise looks for `.env` next to the compose file, not at the repo root. |

`STUWITH_SKIP_TESTCONTAINERS=1` skips the Docker-backed suites on a machine with no
daemon. It cannot be used in CI: gates 3 and 4 are required checks and a skipped
required check is a silent pass, so both the workflow and
`packages/db/src/__testing__/postgres.ts` refuse to honour it when `CI` is set.

---

## 6. Known gaps — deliberate, and owned by a later story

- **There is no ESLint, and there cannot be one until TS 7.1 — this was tested, not
  assumed.** The script is named `pnpm check` (`dep-check` + `typecheck`), not
  `lint`, so the name does not promise linting that is not happening.

  Adding ESLint 10.9.0 was approved and attempted on 2026-08-23. It fails: parsing
  TypeScript needs `@typescript-eslint/parser`, and that package **throws at import
  time** — `"typescript-eslint does not support TS 7.0"` — before any rule runs.
  This is broader than the ban in section 3: the restriction is not merely that
  type-aware rules are unavailable, it is that the parser refuses to load at all,
  so an untyped ESLint setup is not a way around it.

  Redirecting the parser to `@typescript/typescript6@6.0.2` (the trick that works
  for `nest build` and `dependency-cruiser`) does **not** work here, and the reason
  is worth knowing before anyone retries it: `typescript` is a *peer* dependency of
  the parser, and `eslint.config.mjs` lives at the repo root, so the peer resolves
  from the root — where `typescript` is 7.0.2. Neither `overrides` nor
  `packageExtensions` reaches a peer resolved that way. Both were tried.

  If ESLint becomes worth the effort before TS 7.1, the remaining route is to move
  the lint runner into its own workspace package that depends on 6.0.2 directly, so
  the peer resolves inside that package instead of at the root.
  Tracking: typescript-eslint#10940. The dependency-direction rules that actually
  matter are already enforced by stronger mechanisms (section 2).
- **The deploy environment is named `StuWithEnv`** — configured 2026-08-25 with
  *Required reviewers*, which is what satisfies H5.

  **The name in `deploy.yml` must match it exactly, and nothing will tell you when
  it does not.** A referenced environment that does not exist is not an error:
  GitHub creates it on the fly, with **no protection rules**, and the job deploys
  unattended. This already happened once — the workflow said `production` while the
  configured environment was `StuWithEnv`, so the reviewers were attached to an
  environment no workflow pointed at. If you rename either side, rename both.
- **The VPS rollout step is a deliberate `exit 1`**, so a green "deploy" job can
  never be mistaken for a deploy that actually happened.
- **`packages/config` redacts PII with a deny-list.** The spine mandates a
  *whitelist* serializer; that is Story 1.7's job. What is here is the floor, not the
  finished control — but the floor is now pinned: `packages/config/src/logging.test.ts`
  asserts the required paths exist, and `apps/api/src/logging.test.ts` runs a real
  pino logger and asserts no cookie, authorization header, email, date of birth,
  access token or provider id reaches an output line. Deleting a path, flipping
  `remove: true`, or dropping the serializers block now fails a test.
- **No real OAuth credential exists yet, and `AUTH_ENABLED_PROVIDERS` is how that
  is handled honestly.** Story 1.2 ships the full Google / Facebook / Apple /
  Microsoft flow, but nobody has registered an app with any of them (human
  decision, 2026-09-04). Requiring all four credentials would mean `apps/api`
  cannot start on a developer machine; defaulting any of them would break AD-14.
  So the enabled set is an explicit list, empty by default:

  - a provider that is **not** listed answers `404` on `/v1/auth/:provider/start`
    and `/callback`, with a body identical to the one an unknown provider gets, so
    the endpoint does not enumerate the deployment's configuration;
  - a provider that **is** listed must be configured completely — a missing
    `GOOGLE_CLIENT_SECRET` exits non-zero naming that variable before a port opens.
    `tests/gates/config-fail-fast.test.ts` spawns the real built process to prove
    it, for each of the four providers.

  **Open manual check.** The acceptance criterion "an organisational `@fpt.com`
  account can sign in through Microsoft/Entra" cannot be closed until a real tenant
  credential exists. What IS verified today, with a real signed `id_token` from an
  in-process authorization server: `MICROSOFT_TENANT_ID` goes into the authority URL
  (`login.microsoftonline.com/<tenant>/v2.0/...`), and the provider subject is the
  pair `(tid, oid)` rather than `sub` or `oid` alone — so the same `oid` in two
  tenants is two people, and a rotated `sub` is still the same person. Sign in once
  with a real Entra tenant before calling that criterion done.

- **The PII deny-list gained the OAuth handshake, with one deliberate omission.**
  `code`, `state`, `code_verifier`, `id_token`, `client_secret` and the session
  cookies are covered by `LOG_REDACT_PATHS`. A bare `*.code` is **not** in the list,
  on purpose: pino's one-level wildcard would also delete `err.code` — the SQLSTATE
  or errno every incident starts from. The place an OAuth `code` would really have
  reached a log line is `req.url` on the callback, and no redaction path can reach
  inside a string; that leak is closed structurally by `sanitizeLoggedUrl`, which
  both processes put in front of `req.url` (the query string is dropped, leaving
  `/v1/auth/google/callback?<redacted>`). `packages/config/src/logging.test.ts`
  pins the omission so it stays a decision, and `apps/api/src/logging.test.ts` runs
  a whole login through a real pino and reads back every line it wrote.

- **Session cookies are always `Secure`, including in development.** There is no
  `NODE_ENV` branch, because that branch is how a production deployment ends up
  shipping session cookies in the clear.

  An earlier version of this note said local development therefore needs TLS,
  "Caddy is in the compose stack for exactly this". Both halves were wrong:
  `infra/docker-compose.yml` deliberately contains **no Caddy** (four backing
  services only; TLS terminates at the VPS edge), and no TLS is needed for the
  ordinary local case anyway. Chrome (≥ 89) and Firefox (≥ 75) treat
  `http://localhost` as a secure context and accept `Secure` cookies from it, so
  `pnpm dev` on `http://localhost:3000` + `http://localhost:3001` signs in
  normally.

  Where it does bite: Safari is stricter, and **any non-localhost plain-HTTP
  origin** — a LAN IP so a phone can reach your laptop, a bare staging box — drops
  the cookie silently. The login redirect succeeds and `/v1/auth/me` then answers
  401 with nothing in the log to explain it. Put a TLS terminator in front for
  those cases; do not make the flag conditional.

- **`sessions` grows without bound and nothing can prune it — later story.** One
  row per login AND one per refresh rotation, and no role holds `DELETE` or
  `TRUNCATE`. For `audit_events` permanence is the design; for `sessions` it is a
  side effect of reusing that posture. A user refreshing hourly for a year is
  ~8,800 rows, so this is a housekeeping problem rather than an urgent one, but it
  has no owner today and the two knobs it needs — a retention window, and a
  privilege that can act on it — are both deliberate omissions right now. Whoever
  picks it up: revoking is an UPDATE for a reason, so the answer is probably a
  scheduled job under a THIRD role rather than a `DELETE` grant to either process.

- **The `web` Vitest project has no DOM, on purpose, and that shapes what is
  testable there.** `jsdom`, `happy-dom` and `@testing-library/*` are all absent,
  so a component with an effect, state or a `window` read cannot be executed. What
  runs is `renderToStaticMarkup` from `react-dom` — enough to assert real output
  HTML for a component with none of those. The pattern to follow when a page needs
  coverage is `apps/web/src/app/dang-nhap/sign-in-outcome.tsx`: every decision in
  a pure function or an effect-free component, and only `setState` / `history`
  calls left in the page.

  Two traps in that project's config. Vite 8 transforms with **oxc**, so a
  project-level `esbuild: {...}` block is ignored with a warning that scrolls past
  in CI — JSX settings go in `oxc: { jsx: … }`. And `apps/web/tsconfig.json`
  excludes `src/**/*.test.ts(x)` the way `apps/api` does, so test files are not
  typechecked and their imports must not be needed by `next build`.

- **`ClockPort` and `HeartbeatPort` are scaffolding.** They exist so the hexagon and
  the shared contract test-kit are exercised by something real. The money ports
  (`debit()` and `InsufficientFunds`) arrive in Epic 3 and follow the same shape: a
  refusal is a **return branch the caller must handle**, never a thrown exception.
