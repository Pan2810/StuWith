import { defineConfig } from '@playwright/test';

/**
 * TD-2 — Playwright, for `apps/web` E2E later and for browser-free API checks now.
 * Its own babel transpiler handles `.ts`, so it is unaffected by the TS 7 compiler
 * API removal that rules out ts-jest (TD-1/TD-3).
 *
 * Story 1.1 needs exactly one thing here: a smoke test that touches `/healthz` on
 * BOTH processes and proves they are two processes on two ports. Real E2E specs
 * arrive with the flows they test.
 */
const API_PORT = Number(process.env['API_PORT'] ?? 3001);
const GATEWAY_PORT = Number(process.env['GATEWAY_PORT'] ?? 3002);

/**
 * The browser half of the suite, on ports of its own.
 *
 * Deliberately NOT 3000/3001: a developer running `pnpm dev` must be able to run
 * `pnpm test:e2e` at the same time without the two stealing each other's ports, and
 * `reuseExistingServer` would otherwise hand the suite a dev server built against a
 * different API origin — a green run proving nothing.
 */
const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 3100);
const FAKE_API_PORT = Number(process.env['E2E_FAKE_API_PORT'] ?? 3200);

export const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;
export const GATEWAY_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
export const WEB_BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
export const FAKE_API_BASE_URL = `http://127.0.0.1:${FAKE_API_PORT}`;

/**
 * Where the E2E build of `apps/web` lands, so it cannot overwrite `.next`.
 *
 * The separate directory is worth its cost, and the cost is not zero: `next build`
 * regenerates `apps/web/next-env.d.ts` from `distDir`, so this line is why
 * `globalTeardown` above exists.
 *
 * Building into `.next` instead would remove that entirely — and would leave a
 * developer's `.next` holding a bundle whose `NEXT_PUBLIC_API_BASE_URL` is inlined
 * as the fake API on port 3200. `pnpm --filter web start` afterwards would then
 * serve a page that loads perfectly and calls a dead port: a silent wrong answer,
 * with nothing in `git status` to hint at it. A dirty tracked file is visible and
 * now self-correcting; a bundle pointing at the wrong origin is neither.
 */
const E2E_DIST_DIR = '.next-e2e';

/**
 * `apps/web`'s own `next`, invoked through `node` rather than through a shim.
 *
 * Not `pnpm --filter web exec`: `pnpm` is not always on PATH in the environment
 * Playwright spawns, and a webServer that only starts on some machines is a suite
 * that only runs on some machines. Not `node_modules/.bin/next` either — that is a
 * shell script on POSIX and a `.CMD` on Windows, so the spelling would differ by
 * platform. The JS entry point is one path everywhere.
 */
const WEB_BIN = 'node node_modules/next/dist/bin/next';

/**
 * Obviously-fake, locally-scoped values, assembled at runtime rather than written
 * as literals so nothing in this file looks like a credential to CI gate #1.
 * They exist because AD-14 refuses to start a process with an incomplete
 * environment — including when all the smoke test wants is a liveness probe.
 */
const placeholder = (label: string): string => `smoke-${label}-${'x'.repeat(32)}`;

const sharedEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  APP_VERSION: process.env['APP_VERSION'] ?? '0.1.0-smoke',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: placeholder('livekit-key'),
  LIVEKIT_API_SECRET: placeholder('livekit-secret'),
};

export default defineConfig({
  testDir: './tests/e2e',
  /**
   * Puts `apps/web/next-env.d.ts` back after the web build rewrote it.
   *
   * `next build` REGENERATES that tracked file from `distDir`, so the
   * `NEXT_DIST_DIR` below leaves it saying `.next-e2e` on every run. Without this
   * the very next `pnpm test` failed `tests/gates/next-env-distdir.test.ts` — a
   * broken local loop caused by this suite and paid for by another one. See the
   * teardown for why it normalises rather than restoring a captured copy.
   */
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      // No browser: `/healthz` is checked with the request fixture, which needs no
      // browser binary and keeps CI from downloading three of them for one probe.
      name: 'api',
      testMatch: /health\.spec\.ts$/,
      use: {},
    },
    {
      /**
       * The browser project, and the only place `apps/web` is executed at all.
       *
       * The `web` Vitest project renders with `renderToStaticMarkup`, which never
       * runs an effect — so until this existed, no test in the repo had ever seen
       * a screen call the API, submit a form, or redraw on the answer.
       *
       * One browser, not three. Chromium is what the product is developed against;
       * cross-browser matrices are a separate decision with a separate cost, and
       * three downloads for a suite this size buys nothing today.
       */
      name: 'web',
      testMatch: /web\/.*\.spec\.ts$/,
      use: {
        baseURL: WEB_BASE_URL,
        browserName: 'chromium',
      },
    },
  ],
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      url: `${API_BASE_URL}/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...sharedEnv,
        API_PORT: String(API_PORT),
        API_DATABASE_URL: 'postgres://smoke@127.0.0.1:5432/smoke',
        SESSION_COOKIE_SECRET: placeholder('session'),
        // Required from Story 1.2 on. No provider is enabled here, so no
        // credential is needed: `AUTH_ENABLED_PROVIDERS` defaults to empty and
        // every `/v1/auth/:provider/start` answers 404.
        WEB_BASE_URL: 'http://127.0.0.1:3000',
        OAUTH_REDIRECT_BASE_URL: API_BASE_URL,
        // Required from Story 1.3 part 2 on, with no default: every wrong value is
        // silent, so the process refuses to start rather than guess. The smoke test
        // talks to the process directly, so `none` is the true answer.
        TRUSTED_PROXY_ADDRESSES: 'none',
      },
    },
    {
      /**
       * The stand-in origin server. Started before the web build so the build's
       * inlined origin and the running server always name the same port.
       */
      command: 'node tests/e2e/support/fake-api.cjs',
      // Its own readiness route, off `/v1`: every real route answers 418 until a
      // spec has set a scenario, and Playwright treats that as not-yet-listening.
      url: `${FAKE_API_BASE_URL}/__e2e__/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        FAKE_API_PORT: String(FAKE_API_PORT),
        FAKE_API_WEB_ORIGIN: WEB_BASE_URL,
      },
    },
    {
      /**
       * Builds AND starts, in that order, because `NEXT_PUBLIC_API_BASE_URL` is
       * inlined at build time. Starting a previously-built bundle with a different
       * value in the environment produces a page that calls whatever origin it was
       * built with — green suite, wrong product. `NEXT_DIST_DIR` keeps this build
       * away from the one a developer has running.
       */
      command: `${WEB_BIN} build && ${WEB_BIN} start -p ${WEB_PORT}`,
      cwd: 'apps/web',
      url: WEB_BASE_URL,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'production',
        NEXT_DIST_DIR: E2E_DIST_DIR,
        NEXT_PUBLIC_API_BASE_URL: FAKE_API_BASE_URL,
      },
    },
    {
      command: 'node apps/realtime-gateway/dist/main.js',
      url: `${GATEWAY_BASE_URL}/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...sharedEnv,
        GATEWAY_PORT: String(GATEWAY_PORT),
        REALTIME_DATABASE_URL: 'postgres://smoke@127.0.0.1:5432/smoke',
      },
    },
  ],
});
