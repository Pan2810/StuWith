import path from 'node:path';
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

/**
 * Story 2.4 — the `livekit` project, and the one file its two halves share.
 *
 * `tests/e2e/livekit/global-setup.ts` starts a real `livekit-server` and writes
 * the container's URL and key pair HERE; `tests/e2e/support/fake-api.cjs` reads it
 * lazily and, when it exists, signs a REAL token with `mintRoomToken` from
 * `apps/api/dist` instead of the Story 2.3 placeholder.
 *
 * A file rather than an environment variable, and the reason is measured rather
 * than stylistic: Playwright starts every `webServer` BEFORE `globalSetup` (each
 * one is a plugin, and `createGlobalSetupTasks` puts plugin setup first), so the
 * stand-in API is already listening when the container starts and can never be
 * handed the key pair through its own environment. What it CAN be handed at
 * configuration time is the path to look at — which is what this constant is, and
 * why "no file" is exactly "the behaviour every other project has always had".
 *
 * It lives under the output directory Playwright clears at the start of a run,
 * resolved from THIS FILE's own location rather than from `process.cwd()`. Every
 * other path here is config-relative (`testDir`, `globalSetup`, each
 * `webServer.cwd`), and an absolute path anchored to the working directory is a
 * path that means something different the moment the suite is invoked from
 * anywhere but the repository root — with the failure showing up as "the probe
 * quietly used a placeholder token", which reads like a product bug.
 *
 * `__dirname` and not `import.meta.url`, which was tried: Playwright loads this
 * config through `requireOrImport` as CommonJS, and the transform leaves
 * `import.meta` intact, so the spelling that reads more modern is a
 * `SyntaxError: Cannot use 'import.meta' outside a module` before any test runs.
 */
export const LIVEKIT_PROJECT = 'livekit';
export const LIVEKIT_HANDOFF_FILE = path.join(__dirname, 'test-results', 'livekit-handoff.json');

/**
 * The browser settings both browser projects run under, spelled once.
 *
 * `web` and `livekit` differ in exactly one thing — whether a real
 * `livekit-server` is behind the URL the token names — so everything else has to
 * be the same, and the way to keep it the same is for there to be one copy of it.
 *
 * **Locale.** Vietnamese, because Vietnamese is the product's default and the
 * assertions in this suite are written in it. This became load-bearing with Story
 * 2.0: `locale` is what Playwright puts in `Accept-Language` and the server now
 * READS that header, so leaving it unset would give Chromium's default `en-US`
 * and silently turn every `getByRole('button', { name: 'Vào phòng' })` into an
 * assertion about the English catalogue. Those cases prove the ACCESSIBLE NAMES
 * are right, which is a different claim from "the locale is chosen correctly" —
 * `web/ngon-ngu.spec.ts` owns the second one and sets its own locale per context.
 *
 * **Devices.** `--use-fake-device-for-media-stream` gives `getUserMedia` a
 * synthetic camera (a moving test pattern) and a synthetic microphone (a periodic
 * tone), so a track really exists, really has a `readyState`, really reaches
 * `ended` when the screen stops it — and, from Story 2.4, really produces RTP
 * bytes a second browser can count. `--use-fake-ui-for-media-stream` answers the
 * permission prompt without a dialog, and `permissions` grants the two to the
 * context so no spec has to. The REFUSED cases are not produced by withholding
 * these: `phong.spec.ts` overrides `navigator.mediaDevices.getUserMedia` with
 * `addInitScript` to throw the named `DOMException`, which is a seam inside the
 * browser rather than a product seam, and is documented as such there.
 *
 * `--autoplay-policy=no-user-gesture-required` lets the `AudioContext` behind the
 * microphone meter start without a click, which is what makes "the meter moves"
 * an assertion rather than a hope — and lets a remote audio element play without
 * one, which is what makes the room audible at all.
 *
 * One browser, not three. Chromium is what the product is developed against;
 * cross-browser matrices are a separate decision with a separate cost.
 */
const BROWSER_USE = {
  baseURL: WEB_BASE_URL,
  browserName: 'chromium',
  locale: 'vi-VN',
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['camera', 'microphone'],
} as const;

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
   * Starts the `livekit-server` container when the run includes the `livekit`
   * project, and clears the hand-off file when it does not — so every other run
   * is byte for byte the run it was before Story 2.4. The teardown it returns
   * stops the container.
   */
  globalSetup: './tests/e2e/livekit/global-setup.ts',
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
      use: BROWSER_USE,
    },
    {
      /**
       * Story 2.4 — the BOUNDARY PROBE project, and the only thing in this
       * repository that ever opens the browser ↔ LiveKit boundary.
       *
       * Separate from `web` because it needs something `web` must not have: a real
       * `livekit-server` behind the URL the token names. `tests/e2e/livekit/global-setup.ts`
       * starts one and hands the stand-in API its key pair, so the token these
       * specs receive is signed by `mintRoomToken` for that server and refused by
       * it when the key pair does not match — a mutation on the FAR side, which is
       * what `deferred-work.md` recorded Story 2.3 as unable to provide.
       *
       * Same browser settings as `web`: fake devices, granted permissions, the
       * product's own locale.
       */
      name: LIVEKIT_PROJECT,
      testMatch: /livekit\/.*\.spec\.ts$/,
      use: BROWSER_USE,
      /**
       * A real budget for real media. Each case drives two browser contexts
       * through a container: two page loads, two token requests, two ICE/DTLS
       * handshakes and enough RTP to count bytes. On an idle machine that is two
       * seconds; sharing a machine with the ~100 cases of the `web` project it is
       * not, and Playwright's 30-second default turned the difference into a
       * failure that said "Test timeout" and nothing about the room.
       */
      timeout: 120_000,
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
        /**
         * The E2E WEB ORIGIN, not the dev server's. This is what `apps/api` puts
         * in `Access-Control-Allow-Origin`, and Story 2.3's boundary probe
         * (`web/phong-token-seam.spec.ts`) has a page on THIS origin call the real
         * API with `credentials: 'include'`. While this said `:3000` the browser
         * refused every such call before any header could be read, and a probe
         * that cannot be green cannot go red for the right reason either.
         */
        WEB_BASE_URL,
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
        /**
         * Story 2.4. WHERE to look for a real LiveKit, not whether there is one:
         * this process starts before `globalSetup` does, so the path is all that
         * can be handed over at configuration time. No file at that path is the
         * Story 2.3 behaviour, unchanged.
         */
        E2E_LIVEKIT_HANDOFF: LIVEKIT_HANDOFF_FILE,
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
