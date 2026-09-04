import { parseApiEnv, formatProblems, type ApiEnv, type EnvSource } from '@stuwith/config';

/**
 * A real `ApiEnv`, built the way the process builds one at startup.
 *
 * ## Why a builder and not a literal
 *
 * Four test files used to write `{ ...a few fields } as unknown as ApiEnv`. The
 * cast let them compile and let them lie: each one stood in for a production
 * configuration while skipping the only thing `packages/config` exists to do.
 * Adding a required variable — the event AD-14 promises will stop the process —
 * left all four green, because a cast is not a check.
 *
 * A fully-typed literal would fix the compile-time half and none of the rest. It
 * satisfies the compiler while running no rule in the schema, so it would happily
 * hold `API_PORT: 0`, a `WEB_BASE_URL` carrying a path, or an eight-character
 * `SESSION_COOKIE_SECRET` — three values a deployment cannot have.
 *
 * So this feeds RAW STRINGS through `parseApiEnv`, the same function
 * `loadApiConfig` calls at startup. A test configuration is then valid by exactly
 * the rules a deployment is validated by, and a newly required variable makes
 * every caller throw with that variable named.
 *
 * ## Overrides are raw, not typed
 *
 * They are `process.env` shape — strings, before coercion — because that is what
 * has to survive the schema. `API_PORT: '39001'`, not `39001`. Passing `undefined`
 * for a key removes it, which is how a test proves a variable is required.
 */
const BASE: EnvSource = {
  NODE_ENV: 'test',
  // Quiet by default. A suite that reads log lines overrides this.
  LOG_LEVEL: 'fatal',
  APP_VERSION: '0.0.0-test',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'test-livekit-key',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  API_PORT: '39001',
  API_DATABASE_URL: 'postgres://unused@127.0.0.1:5432/unused',
  SESSION_COOKIE_SECRET: 'z'.repeat(48),
  // Bare origins. The schema rejects a path or a trailing slash, and these are
  // the values every URL in a test is built from, so they have to be legal ones.
  WEB_BASE_URL: 'http://127.0.0.1:39000',
  OAUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:39001',
  // Fail closed, matching the schema's own default: a test that wants a provider
  // says so, and then owes that provider's credentials.
  AUTH_ENABLED_PROVIDERS: '',
  // Nothing in front, so the socket address is the client and X-Forwarded-For is
  // ignored. A test that wants the proxy path names its peer.
  TRUSTED_PROXY_ADDRESSES: 'none',
};

export function testApiEnv(overrides: EnvSource = {}): ApiEnv {
  const result = parseApiEnv({ ...BASE, ...overrides });
  if (!result.ok) {
    // The same report the process prints before exiting 1, so a test that breaks
    // this way reads like the startup failure it is standing in for.
    throw new Error(formatProblems('api', result.problems));
  }
  return result.config;
}
