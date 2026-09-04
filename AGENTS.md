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
packages/db              Postgres AND Valkey adapters, migrations, the shared contract test-kit.
packages/config          Env schema, fail-fast startup validation, logging policy,
                         and the trusted-proxy list (compiled by @fastify/proxy-addr,
                         the same library and version Fastify itself resolves).
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
| `pnpm test` | Every Vitest project. Needs Docker for the Postgres **and Valkey** passes. |
| `pnpm test:unit` | domain + contracts + config + api + realtime-gateway + web. No Docker, no network. |
| `pnpm test:contract` | CI gate 3 — the adapter suites against in-memory, PG18 and Valkey 9. |
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

- **The rate limit in front of `/v1/auth/*` FAILS OPEN, and that is a decision
  with consequences worth knowing.** A human chose this on 2026-09-04: when Valkey
  cannot answer — down, or slower than `VALKEY_COMMAND_TIMEOUT_MS` — the request
  goes through unchecked. **For the length of that outage there is no rate limit
  and no brute-force lock on the login at all.** A login flood during a Valkey
  incident is therefore a real, accepted exposure, not a bug.

  What makes it defensible is the other half, and the other half is a test:
  `apps/api/src/rate-limit/rate-limit.guard.ts` logs one `error` line saying the
  blocking layer is off, and `rate-limit.flow.test.ts` asserts that line is
  written. Deleting the log leaves the decision looking the same and makes it
  indefensible — an unavailable control nobody is told about is a control that has
  been off for a week. If you are watching production, `rate limiting is not
  working` is the string to alert on.

  The decision lives in the guard, never in the adapter. `packages/db`'s Valkey
  adapter contains no `try/catch`: an adapter that answered "allowed" when its
  store was unreachable would turn a fault into a normal outcome (the collapse
  `heartbeat-port.ts` forbids) and there is nowhere in `packages/db` with the
  context to write that log line.

- **`TRUSTED_PROXY_ADDRESSES` is required, rejects every near-empty spelling, and
  is compiled by `@fastify/proxy-addr` — not by us.** It is the only non-secret in
  `.env.example` treated like a secret, and the file ships it **commented out** on
  purpose. It holds the addresses/CIDRs of the proxies in front of `apps/api`, or
  the single word `none`.

  - Declare too FEW (or `none` behind Caddy) and `X-Forwarded-For` is ignored, so
    every visitor is counted as the proxy — the first person to trip the limit
    locks out the whole product.
  - Declare a proxy that is not really in front and anybody connecting directly
    can forge the header and pick their own rate-limit key, so the blocking layer
    exists and blocks nothing.

  Both produce a green CI run and a healthy-looking deployment.

  **There is no IP or CIDR parser in this repository, and there must not be one
  again.** There was: `packages/domain/src/policies/client-address.ts`. Three
  review rounds found three different holes in it, each time in the fix for the
  last one:

  1. it counted HOPS rather than checking the peer, so a direct client with a
     forged `X-Forwarded-For` chose its own rate-limit key;
  2. it accepted `0.0.0.0/0`, which matches everything;
  3. it accepted `0.0.0.0/1` and `128.0.0.0/1` — two tokens that between them
     cover all of IPv4 — because the fix for (2) was a one-bit floor. It also
     accepted `1.2.3.4::` and `2001:db8:1.2.3.4::1`, which `net.isIP` rejects,
     while handing the same raw string to Fastify: the config validated while the
     two views of the list disagreed.

  Every round patched the named example instead of the class. The file is deleted.
  `packages/config/src/trusted-proxies.ts` compiles the list with
  **`@fastify/proxy-addr@5.1.0`** — the FORK Fastify 5 resolves, not upstream
  `proxy-addr` — and `apps/api/src/rate-limit/request-identity.ts` resolves the
  address with the same library and the same compiled predicate. "Fastify and we
  cannot disagree about who is trusted" is now a property of the wiring, not of a
  test comparing two implementations. `packages/domain` keeps key building and
  policy only, so AD-1 is untouched.

  **One rule is still ours, because the library has no opinion on it:** a list that
  reaches out onto the public internet is refused. A fourth round found the third
  version of that rule — nine public PROBE addresses handed to the compiled
  predicate — was a SAMPLE: `32.0.0.0/3`, `40.0.0.0/5`, `96.0.0.0/4` and
  `132.0.0.0/6` all fitted between the nine points and were accepted, so a peer
  connecting directly from `40.1.2.3` could forge `X-Forwarded-For` again. Every
  round until then had patched the example it was shown.

  The rule now DECIDES, over sets rather than over examples, and it is written into
  the spec under "Bất biến của danh sách proxy":

  > a range is accepted if and only if it lies entirely inside internal/special
  > address space, OR it covers no more addresses than the ceiling for its family.

  Both halves are computed from the range's own prefix length, so they hold for
  every spelling including ones nobody has thought of. The ceilings are `2^20` for
  IPv4 (a `/12`, which is the largest range a real edge operator publishes —
  Cloudflare's `104.16.0.0/12`) and `2^16` for IPv6. The IPv6 one is deliberately
  much tighter, and not for symmetry: `::ffff:0:0/96` is where the library maps
  every IPv4 address, so a token that reads like an ordinary IPv6 subnet would
  otherwise trust the whole IPv4 internet. Any ceiling below `2^32` makes that
  impossible by arithmetic rather than by spotting the mapped spelling.

  **There is still no address parsing of ours.** The prefix length is read from the
  token's own text as a decimal integer; the address half is validated by
  `node:net`; "is this range inside internal space" is answered by asking a
  predicate `@fastify/proxy-addr` compiled, using the fact that two CIDR blocks are
  either nested or disjoint. `packages/config/src/trusted-proxies.test.ts` is a
  PROPERTY test that sweeps every prefix length across every `/8` of IPv4 and a
  spread of IPv6 against an independent model of the invariant — not a list of
  examples, which is what failed four times.

  Two spellings are refused that a permissive reading would allow, both on purpose:
  a netmask (`10.0.0.0/255.0.0.0`), because measuring its width means parsing an
  address, and anything `@fastify/proxy-addr` compiles that `node:net` does not
  recognise, because that is the round-three failure where the config validated
  while the two views of the list disagreed. The trade on the main rule: a
  deployment whose edge really is a wide public range is refused, and the error
  names the token, its size and what to write instead.

  **The library is pinned to one copy by `overrides` in `pnpm-workspace.yaml`, and
  `tests/gates/proxy-addr-single-copy.test.ts` proves it.** "Fastify and we cannot
  disagree" was true only by coincidence: two workspace packages declared `5.1.0`
  and Fastify resolved its own, which happened to match. A Fastify bump carrying a
  different version would have split the process into two readings of the proxy
  list, silently, in a green CI run.

  **Near-empty values are refused too, and each was a real bypass.** `''` (read
  with `z.coerce.number()` when this was a hop count: `Number('')` is `0`, `0`
  passed `.min(0)`, and `toProblems` never saw it), `,` and `" , "` (length 1, so
  `.trim().min(1)` was satisfied and the parser returned zero proxies with nothing
  invalid). All produced `trustProxy: false` in silence. Any future variable added
  here needs a schema that refuses `''` on its own.

  **Never a NUMBER for `trustProxy`.** Two copies of Fastify are installed and they
  disagree about what one means: `fastify@5.11.3` — the copy
  `@nestjs/platform-fastify` resolves, so the one that runs — honours "trust this
  many hops", while `5.12.1` returns `() => false` for a number as a security fix.
  `fastifyAdapterOptions` passes the comma-separated string, or `false`.

- **The numeric env knobs are digit strings, and that is a BREAKING change for an
  existing `.env`.** `z.coerce.number()` is `Number()` underneath, so it accepted
  `0x10` (16), `1e3` (1000), `' 30 '` and `'30.0'` — none of which is the number
  the operator typed. The rate-limit knobs and the pre-existing `SESSION_*` /
  `OAUTH_STATE_TTL_SECONDS` TTLs now take digits only.

  Concretely: a deployment whose `.env` says `SESSION_TTL_SECONDS=3600.0` or
  ` 3600` started yesterday and exits non-zero today, naming the variable. That is
  the intended trade — the alternative is a config file that says one thing while
  the process does another — but it is a change somebody could meet during a
  deploy, so it is written down here.

  A LEADING ZERO is refused too, and that is the same rule rather than an extra
  one: `SESSION_TTL_SECONDS=03600` started yesterday and exits non-zero today.
  `Number('030')` is 30, an octal reader says 24, and the operator meant "thirty,
  padded" — three answers to one string, which is exactly what this change is
  about. A bare `0` is still a digit string; whether zero is a legal value is the
  range check's question.

  `API_PORT` and `GATEWAY_PORT` deliberately still use `z.coerce`: they are
  pre-existing, have their own tests, and were out of this story's scope. That
  inconsistency is known, not accidental.

- **A rate-limit outage logs ONCE, not once per request, and never logs the
  error's message.** `RateLimitHealth` holds the degraded state that the guard and
  `AuthService` share; the first failure writes the `error` line with the code
  path, every failure after it is counted silently, and recovery is announced once
  after three consecutive successes. The recovery streak is hysteresis: without it
  an intermittently failing store — the shape a real incident takes — flips the
  state twice per pair and writes two lines each time.

  The error's **message** is deliberately dropped, and only `error.name` plus the
  stack frames are logged. `iovalkey` puts the failing command and its arguments in
  the message, and the argument is the rate-limit key — built from an address or a
  hashed credential. Story 1.7's whitelist serializer is not here yet to catch it.

  If you add a third place that touches the counter store, report through
  `RateLimitHealth` rather than a logger.

- **The fail-open branch catches STORE FAULTS only, in BOTH places.** It used to be
  "anything that is not a `RateLimitInputError`", which swallowed every `TypeError`
  and `RangeError` in `apps/api` as well: a plain bug was reported for ever as "the
  counter store did not answer", pointed the alert at Valkey, and left the layer
  off. `isStoreFault` decides positively — a connection, timeout or protocol
  failure from the client library — and everything else surfaces as the 500 it is.

  Both places, and that needed saying because for one round it was one: the guard
  used `isStoreFault` while `AuthService.withRateLimitStore` — the half that runs
  `countFailure` and `forgetFailures` on `/callback` and `/refresh` — still kept
  the old rule.

  `isStoreFault` does NOT match the words "valkey" or "redis" any more. They
  matched a product name rather than a failure, so the adapter's own
  `ValkeyReplyShapeError` (a bug in the script or in `packages/db`, thrown while
  Valkey is healthy) was classified as an outage: the layer failed open in silence
  and the alert pointed at a service with nothing wrong with it. That class is now
  recognised BY NAME as a defect of ours.

- **The Valkey client's offline queue is ON, and that is not the obvious choice.**
  It was `false`, reasoning that a command must reject rather than park. What that
  produced: `lazyConnect` means the socket is still opening when the first request
  arrives, so the first login after every start and every reconnect went through
  UNCOUNTED and wrote the `error` line operators are told to page on — a false
  alarm, on a healthy Valkey, once per deploy. Adding `void connect()` did not fix
  it either; the connect is still in flight. The bound is now enforced by
  `commandTimeout` plus `maxRetriesPerRequest: 0`, and `client.timeout.test.ts`
  holds it from both sides against a server that completes the handshake and then
  stalls.

- **The Valkey counter is atomic, and the contract suite now actually checks it.**
  The Lua in `packages/db/src/valkey/client.ts` does `INCR` + `PEXPIRE` inside one
  `EVAL`, because as two commands a process that dies between them leaves a counter
  with **no expiry** — a key that never resets, so the person it belongs to is
  locked out permanently and nothing in the product can say why.

  For two rounds nothing could see the difference: every example called `hit`
  sequentially and none looked at the expiry the FIRST hit left behind, so
  rewriting it as `INCR` then an awaited `PEXPIRE` passed everything. The suite now
  asserts a live expiry immediately after the first hit, and runs `limit + 5`
  concurrent hits expecting exactly `limit` allowances. Both scripts also REPAIR a
  key found alive with no expiry, and the harnesses can plant one — the branch had
  no coverage on either pass until they could.

- **The brute-force lock runs one dimension per channel: a browser leg by ADDRESS,
  a `fetch` leg by CREDENTIAL.** `bruteForceSubjectFor` in `packages/domain` is the
  only place that decision lives, and both halves — the guard that ENFORCES a lock
  and `AuthService` that EARNS one — read it. That is not tidiness; the two halves
  disagreed twice, and each way was a live defect:

  - counting both dimensions everywhere while enforcing the address lock only on
    browser legs meant `/refresh` failures earned an ADDRESS lock that then blocked
    `/start` and `/callback` for everyone behind that address;
  - counting the credential on a browser leg punished the wrong person entirely. A
    signed-in visitor navigated cross-site to `/callback` sends their session
    cookie under `SameSite=Lax`, so a few induced clicks with a bogus `state`
    locked a credential that was never part of the attempt.

  If you add a fifth `/v1/auth` route, its channel decides its dimension. Do not
  add a second rule.

- **A successful sign-in clears the ADDRESS counter, and on a shared address that
  is everybody's.** This is a trade, taken deliberately, and the docblock in
  `AuthService.forgetFailures` says the same thing:

  - the weakness — somebody with a valid account on a campus NAT can log in
    successfully every few failures and keep that address counter from ever
    reaching the threshold;
  - why the alternatives are worse — clearing nothing leaves an honest person who
    finally got in one slip from a fifteen-minute lock they already worked
    through, and clearing only a credential dimension is a no-op on the sign-in
    legs, because a sign-in attempt carries no credential of its own;
  - what limits it — the address counter is a fifteen-minute window, and the
    CREDENTIAL dimension, which no bystander can reset, is what actually catches an
    attack on a specific account.

  A successful `/refresh` clears its own credential counter, for the same reason
  and with none of the sharing.

- **A provider's 401, 403 or 429 is OUR problem, not evidence of an attack.**
  `fetchJson` treated every 4xx from a provider as "the provider refused what we
  sent" and mapped it to `code_rejected`, which counts towards the brute-force
  lock. But `401 invalid_client` means our client secret is wrong or expired —
  Apple's is rotated every six months — and 403/429 are our app being disabled or
  our own quota. On the day the secret expires, nobody could sign in AND everybody
  would then be locked out for fifteen minutes, with the log calling it a
  brute-force attempt. Only `400` and `404` count now; the rest travel as
  `provider_exchange_failed`, which is on the innocent list.

  The innocent/counted split is a `Record` over the reason union in `audit.ts`, not
  a `Set` of one side. A set has a default, so a thirteenth reason added later
  silently fell into "counted" — the dangerous direction. A missing key is now a
  typecheck error.

- **`POST /v1/auth/logout` is not rate limited, and cannot become so by accident.**
  Every other `/v1/auth` route carries `@RateLimited(...)`. Logout carries nothing,
  because `RateLimitAction` in `packages/domain` has no name for logging out — so
  there is no value that could be written in the parentheses. Do not add one:
  limiting sign-out keeps somebody inside a session they are trying to leave, which
  on a shared machine is a security failure rather than an inconvenience.
