import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * TD-4 says this test must exist, and says why: without it, CI gate #2 is a belief
 * rather than a control. Everything else in the repo asserts that correct code
 * passes. This file asserts that INCORRECT code fails — and fails for the right
 * reason, by the right rule, on the right line.
 *
 * "By the right rule" is not pedantry. Every violation in a pnpm workspace also
 * trips `no-unresolvable`, so an assertion that only checks "the output mentions
 * the bad file" is satisfied by `no-unresolvable` alone and proves nothing about
 * the architecture rule it claims to be testing. Each example below names the rule
 * it expects.
 *
 * This file lives outside packages/domain on purpose: the gate is about the domain
 * being unable to reach infrastructure, and a test that spawns child processes and
 * writes to the filesystem has no business sitting inside the package it guards.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** One filename everywhere, so `.gitignore` can name it once and a crashed run
 *  cannot leave a committable file behind. */
const VIOLATION_BASENAME = '__ad1_violation__.ts';

const VIOLATION_SITES = [
  'packages/domain/src',
  'packages/contracts/src',
  'packages/db/src',
  'apps/api/src',
  'apps/web/src',
] as const;

type ViolationSite = (typeof VIOLATION_SITES)[number];

const createdFiles = new Set<string>();
const createdLinks = new Set<string>();

function violationPath(site: ViolationSite): string {
  return path.join(REPO_ROOT, ...site.split('/'), VIOLATION_BASENAME);
}

function writeViolation(site: ViolationSite, source: string): void {
  const target = violationPath(site);
  writeFileSync(target, source, 'utf8');
  createdFiles.add(target);
}

/** Removes a symlink/junction without ever touching what it points at. */
function removeLink(link: string): void {
  if (!existsSync(link)) return;
  try {
    unlinkSync(link);
  } catch {
    rmSync(link, { recursive: false, force: true });
  }
}

/**
 * Makes an installed package resolvable from a workspace package that does NOT
 * depend on it, by adding the same symlink pnpm would have created.
 *
 * This is the only way to exercise `ad1-domain-no-infra-sdk` honestly. In a clean
 * tree `pg` is unresolvable from packages/domain, so a violating import fails as
 * `no-unresolvable` and the infra-SDK rule never gets a chance to match. The
 * scenario the rule actually exists for is "someone added `pg` to
 * packages/domain/package.json and ran install" — at which point pnpm's isolation
 * stops helping and this rule is the only thing left. So that is what gets set up.
 */
function linkPackageInto(packageName: string, intoPackageDir: string): void {
  const target = realpathSync(path.join(REPO_ROOT, 'packages', 'db', 'node_modules', packageName));
  const nodeModules = path.join(REPO_ROOT, intoPackageDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  const link = path.join(nodeModules, packageName);
  removeLink(link);
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  createdLinks.add(link);
}

/** `tsc -p ... --noEmit` uses the identical tsconfig reference graph as the real
 *  `pnpm typecheck` (`tsc -b`), minus the emit — so it can run while other test
 *  projects are importing packages/domain/dist without racing them. */
function runTypecheck() {
  return run('typescript/bin/tsc', [
    '-p',
    'packages/domain/tsconfig.json',
    '--noEmit',
    '--composite',
    'false',
  ]);
}

function runDependencyCruiser() {
  return run('dependency-cruiser/bin/dependency-cruise.mjs', [
    '--config',
    '.dependency-cruiser.cjs',
    'packages',
    'apps',
  ]);
}

/**
 * Spawns the tool's JS entry point through node directly — no shell, so the
 * arguments cannot be reinterpreted, and no `.CMD`/`.sh` platform split.
 *
 * `status` is deliberately never left as `null`. `spawnSync` returns null when the
 * child is killed by a signal or never started, and `expect(null).not.toBe(0)`
 * passes — so a gate test whose compiler failed to launch would report success
 * while proving nothing at all.
 */
function run(moduleEntry: string, args: readonly string[]): { status: number; output: string } {
  const entry = path.join(REPO_ROOT, 'node_modules', ...moduleEntry.split('/'));
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${moduleEntry}: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new Error(
      `${moduleEntry} did not exit normally (signal: ${String(result.signal)}). ` +
        'Treating this as a pass would make the gate meaningless.',
    );
  }

  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function expectRule(output: string, rule: string): void {
  expect(output, `expected dependency-cruiser rule "${rule}" to fire`).toContain(`error ${rule}:`);
}

beforeAll(() => {
  // A previous run that crashed (or was killed mid-example) leaves a violation
  // file behind, and the first thing it breaks is the "clean tree" example — which
  // then reads as a real regression. Sweep before starting.
  for (const site of VIOLATION_SITES) {
    rmSync(violationPath(site), { force: true });
  }
  removeLink(path.join(REPO_ROOT, 'packages', 'domain', 'node_modules', 'pg'));
});

afterEach(() => {
  for (const file of createdFiles) {
    rmSync(file, { force: true });
  }
  createdFiles.clear();
  for (const link of createdLinks) {
    removeLink(link);
  }
  createdLinks.clear();
});

describe('AD-1 gate — a clean tree', () => {
  it('passes both layers', () => {
    expect(runTypecheck().status).toBe(0);
    expect(runDependencyCruiser().status).toBe(0);
  }, 300_000);
});

describe('AD-1 gate — primary layer (TypeScript project references)', () => {
  it('fails the build when packages/domain imports the Postgres driver', () => {
    writeViolation('packages/domain/src', "import { Pool } from 'pg';\n\nexport const leaked = Pool;\n");

    const { status, output } = runTypecheck();

    expect(status, 'tsc must exit non-zero').not.toBe(0);
    // Points at the offending line, as the acceptance criterion requires.
    expect(output).toContain(`${VIOLATION_BASENAME}(1,22)`);
    expect(output).toContain("Cannot find module 'pg'");
  }, 300_000);

  it('fails the build when packages/domain imports the adapter package', () => {
    writeViolation(
      'packages/domain/src',
      "import { InMemoryHeartbeatAdapter } from '@stuwith/db';\n\nexport const leaked = InMemoryHeartbeatAdapter;\n",
    );

    const { status, output } = runTypecheck();

    expect(status).not.toBe(0);
    expect(output).toContain("Cannot find module '@stuwith/db'");
  }, 300_000);

  it('fails the build when packages/domain imports a NODE BUILTIN', () => {
    // The domain must run with no DB and no network (TD-1); `node:fs` is
    // infrastructure wearing a shorter name. This used to typecheck cleanly,
    // because tsconfig.base.json put `types: ["node"]` in scope for every project
    // including this one. packages/domain now sets `types: []`.
    writeViolation(
      'packages/domain/src',
      "import { readFileSync } from 'node:fs';\n\nexport const leaked = readFileSync;\n",
    );

    const { status, output } = runTypecheck();

    expect(status, 'a node builtin must not typecheck inside packages/domain').not.toBe(0);
    expect(output).toContain(VIOLATION_BASENAME);
  }, 300_000);

  it('cannot be silenced by a local comment', () => {
    // `// eslint-disable-next-line` is the reason AD-1 is NOT enforced with ESLint.
    // A module-resolution failure has no equivalent escape hatch, and
    // @ts-expect-error only swallows the error at this line — the import still does
    // not resolve, so the symbol is `any` and the build still reports the file.
    writeViolation(
      'packages/domain/src',
      [
        '// eslint-disable-next-line',
        '/* eslint-disable */',
        "import { Pool } from 'pg';",
        '',
        'export const leaked = Pool;',
        '',
      ].join('\n'),
    );

    expect(runTypecheck().status).not.toBe(0);
  }, 300_000);
});

describe('AD-1 gate — secondary layer (dependency-cruiser)', () => {
  it('fails on a type-only import, which the reference graph alone can miss', () => {
    writeViolation('packages/domain/src', "import type { Pool } from 'pg';\n\nexport type Leaked = Pool;\n");

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'no-unresolvable');
    expect(output).toContain(VIOLATION_BASENAME);
  }, 300_000);

  it('fails on a dynamic import, which never appears in the type graph', () => {
    writeViolation(
      'packages/domain/src',
      [
        'export async function leak(): Promise<unknown> {',
        "  const mod = await import('pg');",
        '  return mod;',
        '}',
        '',
      ].join('\n'),
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'no-unresolvable');
  }, 300_000);

  it('fires ad1-domain-no-infra-sdk once the SDK is actually resolvable', () => {
    // The case pnpm's isolation does NOT cover: someone adds `pg` to
    // packages/domain/package.json and installs. `no-unresolvable` goes quiet and
    // this rule is the last line standing.
    linkPackageInto('pg', 'packages/domain');
    writeViolation('packages/domain/src', "import type { Pool } from 'pg';\n\nexport type Leaked = Pool;\n");

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad1-domain-no-infra-sdk');
  }, 300_000);

  it('fires ad1-domain-no-node-builtins', () => {
    writeViolation(
      'packages/domain/src',
      "import { readFileSync } from 'node:fs';\n\nexport const leaked = readFileSync;\n",
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad1-domain-no-node-builtins');
  }, 300_000);

  it('fires ad1-domain-no-app-or-adapter on a relative reach into packages/db', () => {
    // A deep relative path is how a determined author gets around a package
    // boundary without touching any package.json.
    writeViolation(
      'packages/domain/src',
      "import type { InMemoryHeartbeatAdapter } from '../../db/src/in-memory/heartbeat-adapter';\n\nexport type Leaked = InMemoryHeartbeatAdapter;\n",
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad1-domain-no-app-or-adapter');
  }, 300_000);

  it('fires ad13-contracts-stay-standalone', () => {
    // AD-13: contracts is the shared wire vocabulary. If it depends on the domain,
    // a future mobile client cannot consume it without dragging business rules in.
    writeViolation(
      'packages/contracts/src',
      "import type { ClockPort } from '../../domain/src/ports/clock-port';\n\nexport type Leaked = ClockPort;\n",
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad13-contracts-stay-standalone');
  }, 300_000);

  it('fires ad24-no-direct-call-between-processes', () => {
    // AD-24: the two processes exchange commands through the durable outbox, never
    // a direct call. A direct import is the first step to a synchronous one.
    writeViolation(
      'apps/api/src',
      "import type { AppModule } from '../../realtime-gateway/src/app.module';\n\nexport type Leaked = AppModule;\n",
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad24-no-direct-call-between-processes');
  }, 300_000);

  it('does NOT fire ad24 when an app imports its own files', () => {
    // Guards the rule's `$1` capture-group exclusion: without it the rule would
    // flag every ordinary intra-app import, someone would weaken it, and the real
    // cross-process case would go with it.
    writeViolation(
      'apps/api/src',
      "import type { AppModule } from './app.module';\n\nexport type Local = AppModule;\n",
    );

    const { output } = runDependencyCruiser();

    expect(output).not.toContain('error ad24-no-direct-call-between-processes:');
  }, 300_000);

  it('fires ad1-web-touches-contracts-only', () => {
    // apps/web is a browser bundle. Linking the domain into it ships business
    // rules to the client and invites a second, divergent copy of them.
    writeViolation(
      'apps/web/src',
      "import type { ClockPort } from '../../../packages/domain/src/ports/clock-port';\n\nexport type Leaked = ClockPort;\n",
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad1-web-touches-contracts-only');
  }, 300_000);

  it('fires ad1-adapter-and-config-stay-below-the-shells', () => {
    // The inverted arrow: an adapter reaching UP into a process shell. Nothing
    // forbade this before — it satisfied every other rule in the file.
    writeViolation(
      'packages/db/src',
      "import type { AppModule } from '../../../apps/api/src/app.module';\n\nexport type Leaked = AppModule;\n",
    );

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expectRule(output, 'ad1-adapter-and-config-stay-below-the-shells');
  }, 300_000);

  it('cruises a non-empty module graph — a green run on 0 modules is not a pass', () => {
    const { output } = runDependencyCruiser();
    const match = /(\d+) modules/.exec(output);
    expect(match, 'dependency-cruiser did not report a module count').not.toBeNull();
    expect(Number(match?.[1] ?? 0)).toBeGreaterThan(10);
  }, 300_000);
});
