import { describe, expect, it } from 'vitest';
import { formatProblems, parseApiEnv, parseRealtimeGatewayEnv, loadApiConfig } from './load';
import { enabledProviderCredentials } from './schema';

const completeApiEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  APP_VERSION: '0.1.0',
  VALKEY_URL: 'redis://localhost:6379',
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  API_PORT: '3001',
  API_DATABASE_URL: 'postgres://stuwith_api@localhost:5432/stuwith',
  SESSION_COOKIE_SECRET: 'y'.repeat(32),
  WEB_BASE_URL: 'http://localhost:3000',
  OAUTH_REDIRECT_BASE_URL: 'http://localhost:3001',
} as const;

describe('parseApiEnv', () => {
  it('accepts a complete environment', () => {
    const result = parseApiEnv({ ...completeApiEnv });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.API_PORT).toBe(3001);
    }
  });

  it('names the exact missing variable', () => {
    const { SESSION_COOKIE_SECRET, ...rest } = completeApiEnv;
    void SESSION_COOKIE_SECRET;
    const result = parseApiEnv({ ...rest });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([{ kind: 'missing', variable: 'SESSION_COOKIE_SECRET' }]);
    }
  });

  it('treats an empty string as missing, not as a valid value', () => {
    const result = parseApiEnv({ ...completeApiEnv, LIVEKIT_API_KEY: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({ kind: 'missing', variable: 'LIVEKIT_API_KEY' });
    }
  });

  it('reports a set-but-wrong value as invalid', () => {
    const result = parseApiEnv({ ...completeApiEnv, API_PORT: '70000' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]?.kind).toBe('invalid');
      expect(result.problems[0]?.variable).toBe('API_PORT');
    }
  });

  it('supplies no default for any secret', () => {
    const result = parseApiEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const missing = result.problems.map((p) => p.variable);
      for (const secretName of [
        'API_DATABASE_URL',
        'SESSION_COOKIE_SECRET',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
      ]) {
        expect(missing).toContain(secretName);
      }
    }
  });
});

describe('parseRealtimeGatewayEnv', () => {
  it('requires its own database url and port', () => {
    const result = parseRealtimeGatewayEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const missing = result.problems.map((p) => p.variable);
      expect(missing).toContain('GATEWAY_PORT');
      expect(missing).toContain('REALTIME_DATABASE_URL');
    }
  });
});

describe('formatProblems', () => {
  it('prints the variable name and never the value', () => {
    const message = formatProblems('api', [
      { kind: 'missing', variable: 'API_DATABASE_URL' },
      { kind: 'invalid', variable: 'API_PORT', reason: 'must be a TCP port number' },
    ]);
    expect(message).toContain('API_DATABASE_URL');
    expect(message).toContain('API_PORT');
    expect(message).toContain('No secret has a default value.');
  });
});

describe('loadApiConfig', () => {
  it('exits non-zero, after naming the variable, instead of returning', () => {
    const written: string[] = [];
    let exitCode: number | undefined;
    const thrown = new Error('exit');

    expect(() =>
      loadApiConfig(
        {},
        {
          write: (m) => written.push(m),
          exit: (code) => {
            exitCode = code;
            throw thrown;
          },
        },
      ),
    ).toThrow(thrown);

    expect(exitCode).toBe(1);
    expect(written.join('\n')).toContain('API_DATABASE_URL');
  });
});

/**
 * Obviously-fake and assembled at runtime, per the repo convention: a value that is
 * not a secret has to prove it, or CI gate #1 has to be told to ignore a path.
 */
const fake = (label: string): string => `not-a-secret-${label}-${'x'.repeat(12)}`;

describe('AUTH_ENABLED_PROVIDERS (Story 1.2)', () => {
  it('defaults to no providers — fail closed, never guess which apps are registered', () => {
    const result = parseApiEnv({ ...completeApiEnv });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.AUTH_ENABLED_PROVIDERS).toEqual([]);
    }
  });

  it('parses a comma-separated list, tolerating spacing and case', () => {
    const result = parseApiEnv({
      ...completeApiEnv,
      AUTH_ENABLED_PROVIDERS: ' Google , facebook ',
      GOOGLE_CLIENT_ID: fake('google-id'),
      GOOGLE_CLIENT_SECRET: fake('google-secret'),
      FACEBOOK_CLIENT_ID: fake('facebook-id'),
      FACEBOOK_CLIENT_SECRET: fake('facebook-secret'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.AUTH_ENABLED_PROVIDERS).toEqual(['google', 'facebook']);
    }
  });

  it('rejects the same provider listed twice', () => {
    // Without this the duplicate-detection clause in the schema could be deleted
    // and every test would still pass. A repeated entry is a typo in a hand-edited
    // env file, and silently de-duplicating it hides the typo rather than the
    // symptom.
    const result = parseApiEnv({
      ...completeApiEnv,
      AUTH_ENABLED_PROVIDERS: 'google,google',
      GOOGLE_CLIENT_ID: fake('google-id'),
      GOOGLE_CLIENT_SECRET: fake('google-secret'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((p) => p.variable)).toContain('AUTH_ENABLED_PROVIDERS');
    }
  });

  it('rejects a provider nobody implemented, instead of ignoring it', () => {
    // Silently dropping an unknown name is how "we enabled Zalo" becomes "the
    // button does nothing" three weeks later.
    const result = parseApiEnv({ ...completeApiEnv, AUTH_ENABLED_PROVIDERS: 'google,zalo' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((p) => p.variable)).toContain('AUTH_ENABLED_PROVIDERS');
    }
  });
});

describe('AD-14 — an enabled provider must be COMPLETELY configured', () => {
  const allFour = {
    ...completeApiEnv,
    AUTH_ENABLED_PROVIDERS: 'google,facebook,apple,microsoft',
    GOOGLE_CLIENT_ID: fake('google-id'),
    GOOGLE_CLIENT_SECRET: fake('google-secret'),
    FACEBOOK_CLIENT_ID: fake('facebook-id'),
    FACEBOOK_CLIENT_SECRET: fake('facebook-secret'),
    MICROSOFT_CLIENT_ID: fake('microsoft-id'),
    MICROSOFT_CLIENT_SECRET: fake('microsoft-secret'),
    MICROSOFT_TENANT_ID: 'organizations',
    APPLE_CLIENT_ID: fake('apple-services-id'),
    APPLE_TEAM_ID: fake('apple-team'),
    APPLE_KEY_ID: fake('apple-key-id'),
    APPLE_PRIVATE_KEY: fake('apple-private-key'),
  } as const;

  it('accepts all four when every credential is present', () => {
    const result = parseApiEnv({ ...allFour });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.AUTH_ENABLED_PROVIDERS).toEqual([
        'google',
        'facebook',
        'apple',
        'microsoft',
      ]);
    }
  });

  it.each([
    'GOOGLE_CLIENT_SECRET',
    'FACEBOOK_CLIENT_SECRET',
    'MICROSOFT_TENANT_ID',
    'APPLE_PRIVATE_KEY',
  ])('names %s exactly when it is the one that is missing', (variable) => {
    const env: Record<string, string> = { ...allFour };
    delete env[variable];

    const result = parseApiEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([{ kind: 'missing', variable }]);
      // The report must name the variable and nothing about its value.
      expect(formatProblems('api', result.problems)).toContain(variable);
    }
  });

  it('does NOT require a credential for a provider that is not enabled', () => {
    // The whole point of the enabled list: a developer with no Apple team can
    // still start the process. Requiring all four would make `api` unstartable on
    // every laptop; defaulting the credential would break AD-14.
    const result = parseApiEnv({
      ...completeApiEnv,
      AUTH_ENABLED_PROVIDERS: 'google',
      GOOGLE_CLIENT_ID: fake('google-id'),
      GOOGLE_CLIENT_SECRET: fake('google-secret'),
    });
    expect(result.ok).toBe(true);
  });

  it('treats an empty credential as missing rather than as a value', () => {
    const result = parseApiEnv({ ...allFour, GOOGLE_CLIENT_SECRET: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({ kind: 'missing', variable: 'GOOGLE_CLIENT_SECRET' });
    }
  });

  it('hands apps/api credentials with no `undefined` in them', () => {
    const result = parseApiEnv({ ...allFour });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const credentials = enabledProviderCredentials(result.config);
    expect(credentials.map((c) => c.provider)).toEqual([
      'google',
      'facebook',
      'apple',
      'microsoft',
    ]);
    for (const credential of credentials) {
      for (const value of Object.values(credential)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it('carries the Microsoft tenant through, because the authority URL depends on it', () => {
    const result = parseApiEnv({ ...allFour, MICROSOFT_TENANT_ID: 'fpt-tenant-id' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const microsoft = enabledProviderCredentials(result.config).find(
      (c) => c.provider === 'microsoft',
    );
    expect(microsoft).toMatchObject({ provider: 'microsoft', tenantId: 'fpt-tenant-id' });
  });
});

describe('session TTLs are knobs, not secrets', () => {
  it('has sane defaults so a deployment is not forced to invent them', () => {
    const result = parseApiEnv({ ...completeApiEnv });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.SESSION_TTL_SECONDS).toBe(3_600);
      expect(result.config.SESSION_REFRESH_TTL_SECONDS).toBe(2_592_000);
      expect(result.config.OAUTH_STATE_TTL_SECONDS).toBe(600);
    }
  });

  it('rejects a TTL outside the allowed range rather than accepting a typo', () => {
    const result = parseApiEnv({ ...completeApiEnv, SESSION_TTL_SECONDS: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatchObject({ kind: 'invalid', variable: 'SESSION_TTL_SECONDS' });
    }
  });
});

describe('the redirect origins', () => {
  it.each(['WEB_BASE_URL', 'OAUTH_REDIRECT_BASE_URL'])('requires %s', (variable) => {
    const env: Record<string, string> = { ...completeApiEnv };
    delete env[variable];
    const result = parseApiEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({ kind: 'missing', variable });
    }
  });

  it('rejects a trailing slash, which providers report as a redirect_uri mismatch', () => {
    const result = parseApiEnv({ ...completeApiEnv, OAUTH_REDIRECT_BASE_URL: 'https://api.stuwith.vn/' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatchObject({
        kind: 'invalid',
        variable: 'OAUTH_REDIRECT_BASE_URL',
      });
    }
  });

  it('rejects a value with no scheme, which no browser will follow', () => {
    const result = parseApiEnv({ ...completeApiEnv, WEB_BASE_URL: 'stuwith.vn' });
    expect(result.ok).toBe(false);
  });
});
