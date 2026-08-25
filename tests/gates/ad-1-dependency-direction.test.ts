import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * TD-4 says this test must exist, and says why: without it, CI gate #2 is a belief
 * rather than a control. Everything else in the repo asserts that correct code
 * passes. This file asserts that INCORRECT code fails — and fails for the right
 * reason, on the right line.
 *
 * It lives outside packages/domain on purpose: the gate is about the domain being
 * unable to reach infrastructure, and a test that spawns child processes and reads
 * the filesystem has no business sitting inside the package it is guarding.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const VIOLATION_FILE = path.join(REPO_ROOT, 'packages', 'domain', 'src', '__ad1_violation__.ts');

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

/** Spawns the tool's JS entry point through node directly — no shell, so the
 *  arguments cannot be reinterpreted, and no `.CMD`/`.sh` platform split. */
function run(moduleEntry: string, args: readonly string[]) {
  const entry = path.join(REPO_ROOT, 'node_modules', ...moduleEntry.split('/'));
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function writeViolation(source: string): void {
  writeFileSync(VIOLATION_FILE, source, 'utf8');
}

afterEach(() => {
  if (existsSync(VIOLATION_FILE)) {
    rmSync(VIOLATION_FILE);
  }
});

describe('AD-1 gate — a clean tree', () => {
  it('passes both layers', () => {
    expect(runTypecheck().status).toBe(0);
    expect(runDependencyCruiser().status).toBe(0);
  }, 300_000);
});

describe('AD-1 gate — primary layer (TypeScript project references)', () => {
  it('fails the build when packages/domain imports the Postgres driver', () => {
    writeViolation("import { Pool } from 'pg';\n\nexport const leaked = Pool;\n");

    const { status, output } = runTypecheck();

    expect(status, 'tsc must exit non-zero').not.toBe(0);
    // Points at the offending line, as the acceptance criterion requires.
    expect(output).toContain('__ad1_violation__.ts(1,22)');
    expect(output).toContain("Cannot find module 'pg'");
  }, 300_000);

  it('fails the build when packages/domain imports the adapter package', () => {
    writeViolation(
      "import { InMemoryHeartbeatAdapter } from '@stuwith/db';\n\nexport const leaked = InMemoryHeartbeatAdapter;\n",
    );

    const { status, output } = runTypecheck();

    expect(status).not.toBe(0);
    expect(output).toContain("Cannot find module '@stuwith/db'");
  }, 300_000);

  it('cannot be silenced by a local comment', () => {
    // `// eslint-disable-next-line` is the reason AD-1 is NOT enforced with ESLint.
    // A module-resolution failure has no equivalent escape hatch, and
    // @ts-expect-error only swallows the error at this line — the import still does
    // not resolve, so the symbol is `any` and the build still reports the file.
    writeViolation(
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
    writeViolation("import type { Pool } from 'pg';\n\nexport type Leaked = Pool;\n");

    const { status, output } = runDependencyCruiser();

    expect(status).not.toBe(0);
    expect(output).toContain('__ad1_violation__.ts');
  }, 300_000);

  it('fails on a dynamic import, which never appears in the type graph', () => {
    writeViolation(
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
    expect(output).toContain('__ad1_violation__.ts');
  }, 300_000);

  it('cruises a non-empty module graph — a green run on 0 modules is not a pass', () => {
    const { output } = runDependencyCruiser();
    const match = /(\d+) modules/.exec(output);
    expect(match, 'dependency-cruiser did not report a module count').not.toBeNull();
    expect(Number(match?.[1] ?? 0)).toBeGreaterThan(10);
  }, 300_000);
});
