import { describe, expect, it } from 'vitest';
import { testApiEnv } from './api-env';

/**
 * The builder's own guarantees, because the four suites that depend on it cannot
 * state them.
 *
 * Each case below fails if `testApiEnv` ever becomes a cast again: a cast returns
 * a value for all three of them.
 */
describe('testApiEnv', () => {
  it('returns a configuration the startup parser accepts', () => {
    const config = testApiEnv();
    expect(config.API_PORT).toBe(39_001);
    expect(config.AUTH_ENABLED_PROVIDERS).toEqual([]);
    // Coercion happened, which is proof the schema ran: the raw value is a string.
    expect(typeof config.SESSION_TTL_SECONDS).toBe('number');
  });

  it('refuses a missing required variable, naming it — this is the AD-14 guarantee', () => {
    expect(() => testApiEnv({ SESSION_COOKIE_SECRET: undefined })).toThrow(
      /SESSION_COOKIE_SECRET/,
    );
  });

  it('refuses an invalid override rather than passing it through', () => {
    // A base URL with a path is the exact configuration Story 1.3b made illegal:
    // `new URL(path, base)` discards the path while concatenation keeps it, so one
    // value produced two URLs for one page.
    expect(() => testApiEnv({ WEB_BASE_URL: 'https://stuwith.example/app' })).toThrow(
      /WEB_BASE_URL/,
    );
  });

  it('enforces the conditional half too: an enabled provider owes its credentials', () => {
    expect(() => testApiEnv({ AUTH_ENABLED_PROVIDERS: 'google' })).toThrow(/GOOGLE_CLIENT_ID/);
  });
});
