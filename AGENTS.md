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

Three layers enforce it, and the first two are the gates:

1. **Primary — TypeScript project references.** `packages/domain/tsconfig.json`
   references *only* `packages/contracts`. A forbidden import does not resolve and
   `tsc` fails on the exact line. No comment switches this off.
2. **Secondary — `dependency-cruiser`** (`.dependency-cruiser.cjs`), which catches
   what a type graph cannot see: dynamic `import()` and `import type` used as a
   smuggling route.
3. **Free — pnpm's isolated `node_modules`.** `packages/domain` cannot resolve `pg`
   just because `packages/db` installed it. Never set `node-linker=hoisted` or
   `shamefully-hoist=true` in `.npmrc`.

**Two edits silently repeal all of the above. Do not make them:**

- adding a `paths` mapping to `tsconfig.base.json`, or
- adding an entry to `packages/domain/tsconfig.json`'s `references`.

`tests/gates/ad-1-dependency-direction.test.ts` proves the gate is red for a
violating import. If you change the enforcement mechanism, that test must still
pass — it is the only thing standing between "we have a gate" and "we believe we
have a gate".

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
  exactly one role.
- **AD-14 — no default value for any secret.** `packages/config` validates the
  environment once and exits non-zero, naming the exact missing variable, *before a
  port is opened*. Every variable is listed in `.env.example`. `.env` is git-ignored.
- **AD-12 — the audit trail is append-only.** No role holds `DELETE`. Do not add one.
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
| `pnpm test:unit` | domain + contracts + config. No Docker, no network. |
| `pnpm test:contract` | CI gate 3 — the adapter suite against in-memory and PG18. |
| `pnpm test:migrations` | CI gate 4 — migrations on a seeded PG18. |
| `pnpm test:gates` | Proves the AD-1 gate rejects a violating import. |
| `pnpm test:e2e` | Playwright smoke test: `/healthz` on both processes. |
| `pnpm dep-check` | CI gate 2, secondary layer. |
| `pnpm --filter @stuwith/db migrate` | Forward migrations. Needs `MIGRATION_DATABASE_URL`. |
| `docker compose --env-file .env -f infra/docker-compose.yml up -d --wait` | The four-service local stack. `--env-file` is required: Compose otherwise looks for `.env` next to the compose file, not at the repo root. |

`STUWITH_SKIP_TESTCONTAINERS=1` skips the Docker-backed suites on a machine with no
daemon. **Never set it in CI** — gates 3 and 4 are required checks, and a skipped
required check is a silent pass.

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
  finished control.
- **`ClockPort` and `HeartbeatPort` are scaffolding.** They exist so the hexagon and
  the shared contract test-kit are exercised by something real. The money ports
  (`debit()` and `InsufficientFunds`) arrive in Epic 3 and follow the same shape: a
  refusal is a **return branch the caller must handle**, never a thrown exception.
