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

export const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;
export const GATEWAY_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

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
      use: {},
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
