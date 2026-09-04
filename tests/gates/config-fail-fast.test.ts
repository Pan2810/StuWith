import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * AD-14, I/O matrix row 2: "remove a required variable, start any process, and it
 * exits non-zero — naming the exact missing variable — BEFORE opening its port."
 *
 * `packages/config/src/load.test.ts` tests the pure function with an injected
 * exit. That is a good test of the function and no test at all of the claim: move
 * `loadApiConfig()` below `app.listen()` in main.ts and every one of those
 * assertions still passes, while the process happily accepts traffic with a
 * half-configured environment. "Before the port opens" is a property of the
 * PROCESS, so it is checked by running the process.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const API_ENTRY = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'main.js');

/**
 * Everything apps/api needs, minus the port (each example supplies its own).
 * Assembled at runtime rather than written as literals so nothing here reads as a
 * credential to CI gate #1.
 */
function completeEnv(port: number): Record<string, string> {
  const placeholder = (label: string) => `gate-${label}-${'x'.repeat(32)}`;
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    APP_VERSION: '0.0.0-gate',
    VALKEY_URL: 'redis://127.0.0.1:6379',
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: placeholder('livekit-key'),
    LIVEKIT_API_SECRET: placeholder('livekit-secret'),
    API_PORT: String(port),
    API_DATABASE_URL: 'postgres://gate@127.0.0.1:5432/gate',
    SESSION_COOKIE_SECRET: placeholder('session'),
    WEB_BASE_URL: 'http://127.0.0.1:3000',
    OAUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:3001',
    // Windows needs these to start a process at all; nothing else is inherited,
    // so a developer's real .env cannot accidentally satisfy a variable the test
    // is trying to remove.
    ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
    ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not obtain a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

interface Run {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly everBound: boolean;
}

function start(env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [API_ENTRY], { cwd: REPO_ROOT, env });
}

/**
 * Runs the process to completion while continuously probing the port. `everBound`
 * is the assertion that matters: checking only after exit would miss a process
 * that binds, then crashes.
 */
async function runToExit(env: Record<string, string>, port: number): Promise<Run> {
  const child = start(env);
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });

  let everBound = false;
  let running = true;
  const probe = (async () => {
    while (running) {
      if (await canConnect(port, 100)) {
        everBound = true;
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  running = false;
  await probe;

  // One last check after exit, in case it bound and released in the gap.
  if (!everBound) {
    everBound = await canConnect(port, 100);
  }

  return { exitCode: exit.code, signal: exit.signal, stderr, stdout, everBound };
}

async function waitUntilBound(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port, 200)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

beforeAll(() => {
  if (!existsSync(API_ENTRY)) {
    // Loud, not skipped. A gate that quietly opts out when a precondition is
    // missing is the failure mode this whole directory exists to prevent.
    throw new Error(
      `${API_ENTRY} is missing. Build it first: \`pnpm run build:packages && pnpm --filter api build\`.`,
    );
  }
});

describe('AD-14 — the process refuses to start on an incomplete environment', () => {
  /**
   * The control. Without it, every assertion below is satisfiable by a process
   * that never starts for ANY reason — a typo in the entry path would "prove"
   * fail-fast works.
   */
  it('binds its port when the environment IS complete', async () => {
    const port = await freePort();
    const child = start(completeEnv(port));
    try {
      await expect(waitUntilBound(port, 30_000)).resolves.toBe(true);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }, 60_000);

  it.each([
    'API_DATABASE_URL',
    'SESSION_COOKIE_SECRET',
    'LIVEKIT_API_SECRET',
    'VALKEY_URL',
  ])('exits non-zero naming %s, without ever binding the port', async (variable) => {
    const port = await freePort();
    const env = completeEnv(port);
    delete env[variable];

    const run = await runToExit(env, port);

    expect(run.exitCode, 'the process must exit non-zero').not.toBe(0);
    expect(run.exitCode, 'and must exit on its own, not be killed').not.toBeNull();
    // The exact name, not a generic "configuration error". Naming the variable is
    // the difference between a 30-second fix and an afternoon.
    expect(run.stderr).toContain(variable);
    expect(
      run.everBound,
      'the port must never accept a connection with an invalid environment',
    ).toBe(false);
  }, 60_000);

  it('names only the variable that is actually missing', async () => {
    const port = await freePort();
    const env = completeEnv(port);
    delete env['API_DATABASE_URL'];

    const run = await runToExit(env, port);

    expect(run.stderr).toContain('API_DATABASE_URL');
    // Guards against a canned message that lists every required variable, which
    // would satisfy the assertion above while telling the operator nothing.
    expect(run.stderr).not.toContain('SESSION_COOKIE_SECRET');
    expect(run.stderr).not.toContain('LIVEKIT_API_SECRET');
  }, 60_000);

  /**
   * Story 1.2's half of AD-14: a provider that is switched on must be switched on
   * COMPLETELY.
   *
   * The failure this rules out is the tempting one — noticing at startup that a
   * credential is missing and quietly disabling that provider. The deployment
   * would then come up looking perfectly healthy while silently no longer offering
   * a login its users had yesterday, and nothing would say so.
   */
  function allFourProviders(port: number): Record<string, string> {
    const placeholder = (label: string) => `gate-${label}-${'x'.repeat(24)}`;
    return {
      ...completeEnv(port),
      AUTH_ENABLED_PROVIDERS: 'google,facebook,apple,microsoft',
      GOOGLE_CLIENT_ID: placeholder('google-id'),
      GOOGLE_CLIENT_SECRET: placeholder('google-secret'),
      FACEBOOK_CLIENT_ID: placeholder('facebook-id'),
      FACEBOOK_CLIENT_SECRET: placeholder('facebook-secret'),
      MICROSOFT_CLIENT_ID: placeholder('microsoft-id'),
      MICROSOFT_CLIENT_SECRET: placeholder('microsoft-secret'),
      MICROSOFT_TENANT_ID: 'organizations',
      APPLE_CLIENT_ID: 'vn.stuwith.gate',
      APPLE_TEAM_ID: 'TEAMGATE12',
      APPLE_KEY_ID: 'KEYGATE123',
      APPLE_PRIVATE_KEY: placeholder('apple-key'),
    };
  }

  it.each([
    'GOOGLE_CLIENT_SECRET',
    'FACEBOOK_CLIENT_SECRET',
    'MICROSOFT_TENANT_ID',
    'APPLE_PRIVATE_KEY',
  ])('exits naming %s when that provider is enabled but incompletely configured', async (variable) => {
    const port = await freePort();
    const env = allFourProviders(port);
    delete env[variable];

    const run = await runToExit(env, port);

    expect(run.exitCode, 'the process must exit non-zero').not.toBe(0);
    expect(run.stderr).toContain(variable);
    expect(
      run.everBound,
      'a half-configured provider must not reach a listening socket',
    ).toBe(false);
  }, 60_000);

  it('starts happily with all four providers fully configured', async () => {
    // The control for the four examples above: without it they would also pass
    // against a build that refuses to start no matter what is set.
    const port = await freePort();
    const child = start(allFourProviders(port));
    try {
      await expect(waitUntilBound(port, 30_000)).resolves.toBe(true);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }, 60_000);

  it('does not print the value of any variable it rejects', async () => {
    const port = await freePort();
    const env = completeEnv(port);
    env['LIVEKIT_API_SECRET'] = 'too-short';

    const run = await runToExit(env, port);

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain('LIVEKIT_API_SECRET');
    // A "bad value: <value>" message is how a secret reaches a CI log.
    expect(run.stderr).not.toContain('too-short');
    expect(run.everBound).toBe(false);
  }, 60_000);
});
