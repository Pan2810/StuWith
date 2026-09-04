/**
 * CI gate #2, SECONDARY layer (TD-4).
 *
 * The primary layer is the TypeScript project-reference graph: packages/domain
 * references only packages/contracts, so `import { Pool } from 'pg'` there simply
 * does not resolve and `tsc` fails on the offending line — no comment can switch
 * that off. dependency-cruiser exists to catch what a reference graph cannot see:
 * dynamic `import()`, `import type` used as a smuggling route, and imports that
 * resolve only because someone hoisted node_modules.
 *
 * If you are here to add an exception for packages/domain: don't. Move the code.
 */

/** Infrastructure SDKs the domain must never touch, as a resolvable-path regex. */
const INFRA_SDK =
  'node_modules/(pg|pg-pool|pg-native|postgres|node-pg-migrate|ioredis|iovalkey|redis|@redis|valkey|livekit-client|livekit-server-sdk|@livekit|fastify|@fastify|@nestjs|next|react|react-dom|pino|pino-http|nestjs-pino|testcontainers|axios|undici|node-fetch)(/|$)';

module.exports = {
  forbidden: [
    {
      name: 'ad1-domain-no-app-or-adapter',
      severity: 'error',
      comment:
        'AD-1: packages/domain must not import apps/* or packages/db. Business rules live in the ' +
        'core; shells only translate in and out. A violation here is a build failure, not review feedback.',
      from: { path: '^packages/domain' },
      to: { path: '^(apps/|packages/db/)' },
    },
    {
      name: 'ad1-domain-no-infra-sdk',
      severity: 'error',
      comment:
        'AD-1: packages/domain must not import any infrastructure SDK (Postgres driver, Valkey ' +
        'client, LiveKit, an HTTP framework or client). Express the need as a port instead.',
      from: { path: '^packages/domain' },
      to: { path: INFRA_SDK },
    },
    {
      name: 'ad1-domain-no-node-builtins',
      severity: 'error',
      comment:
        'AD-1 / TD-1: domain code must run with no DB and no network. A node builtin (fs, net, ' +
        'http, child_process, crypto...) is infrastructure wearing a smaller name.',
      from: { path: '^packages/domain/src', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'ad13-contracts-stay-standalone',
      severity: 'error',
      comment:
        'AD-13: packages/contracts is the shared wire vocabulary. It must not depend on the ' +
        'domain, on an adapter, on config, or on a shell — otherwise it cannot be consumed by a ' +
        'future mobile client.',
      from: { path: '^packages/contracts' },
      to: { path: '^(apps/|packages/(db|domain|config)/)' },
    },
    {
      name: 'ad24-no-direct-call-between-processes',
      severity: 'error',
      comment:
        'AD-24: apps/api and apps/realtime-gateway must not import each other. Cross-process ' +
        'commands go through the durable outbox channel (Epic 4), never a direct call.',
      // `$1` is the capture group from `from.path`, so this flags only the *other*
      // process, never an app importing its own files.
      from: { path: '^apps/(api|realtime-gateway)/' },
      to: { path: '^apps/(api|realtime-gateway)/', pathNot: '^apps/$1/' },
    },
    {
      name: 'ad1-adapter-and-config-stay-below-the-shells',
      severity: 'error',
      comment:
        'AD-1 is a direction, not a single forbidden pair. packages/db and packages/config sit ' +
        'BELOW apps/*: an adapter or a config module that reaches up into a process shell ' +
        'inverts the arrow, and drags NestJS wiring into a package the other process also loads. ' +
        'Nothing forbade this before — an adapter importing apps/api satisfied every other rule.',
      from: { path: '^packages/(db|config)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'ad1-web-touches-contracts-only',
      severity: 'error',
      comment:
        'apps/web is a client. It may read packages/contracts and nothing else from the workspace: ' +
        'it must never link the domain, an adapter, or server config into a browser bundle.',
      from: { path: '^apps/web' },
      to: { path: '^packages/(db|domain|config)/' },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'An unresolvable import is usually AD-1 working as designed (domain reaching for something ' +
        'it is not allowed to see). Fix the import, do not add a path mapping.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle means the layering is already gone.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Dead module — delete it or wire it up.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(next\\.config|vitest\\.config|playwright\\.config)\\.[^/]+$',
          '^apps/web/src/app/',
        ],
      },
      to: {},
    },
  ],

  options: {
    // `doNotFollow` records a dependency on an installed package but does not
    // cruise INTO it. That distinction is load-bearing: `node_modules` must NOT
    // appear in `exclude` below, because `exclude` drops those modules from the
    // graph entirely — and a rule whose `to.path` names `node_modules/pg` can
    // never match a target that is not in the graph at all.
    //
    // That was the state of this file until it was measured. With `pg` made
    // resolvable from packages/domain, `ad1-domain-no-infra-sdk` produced NO
    // error: the rule read as enforcement, but the only thing failing an infra
    // import was `no-unresolvable` — i.e. pnpm's isolated node_modules, not this
    // config. Add `pg` to packages/domain/package.json and both AD-1 layers would
    // have gone green together, in exactly the scenario the rule exists for.
    doNotFollow: { path: 'node_modules' },
    exclude: {
      // `\\.next(-e2e)?` and not `\\.next.*`: the E2E suite builds `apps/web` into
      // `.next-e2e` so it cannot overwrite a developer's `.next`, and the anchored
      // spelling let 46 build artefacts into the graph as orphan warnings. Naming
      // the one extra directory keeps the exclusion a decision rather than a
      // prefix that would also swallow a real source folder starting with `.next`.
      path: '(^|/)(dist|\\.next(-e2e)?|\\.tsbuild|coverage|migrations|seeds)(/|$)',
    },
    // Required to see `import type` and type-only re-exports — the exact routes a
    // reference graph alone would let through.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['require', 'node', 'import', 'default', 'types'],
      mainFields: ['main', 'types'],
      extensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.d.ts', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
