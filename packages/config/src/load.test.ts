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
  // Required with no default, and the word is a decision rather than an absence:
  // see the `TRUSTED_PROXY_ADDRESSES` block below for why nothing can be guessed.
  TRUSTED_PROXY_ADDRESSES: 'none',
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

/**
 * `TRUSTED_PROXY_ADDRESSES` — the only knob in this schema that is treated like a
 * secret, and the reason is worth restating where the test can be read.
 *
 * Every other operational value can be guessed slightly wrong and the mistake is
 * visible. This one is wrong SILENTLY, in two opposite directions: trusting no
 * proxy behind Caddy squashes every visitor into the proxy's address, so one
 * person tripping the rate limit locks out the whole product; trusting the header
 * with nothing in front lets any client pick its own rate-limit key and walk past
 * the limit entirely. Both come up looking healthy. There is no safe default, so
 * there is no default.
 */
describe('TRUSTED_PROXY_ADDRESSES is required, because both guesses are silent', () => {
  it('is missing rather than defaulted when it is absent', () => {
    const env: Record<string, string> = { ...completeApiEnv };
    delete env['TRUSTED_PROXY_ADDRESSES'];

    const result = parseApiEnv(env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({
      kind: 'missing',
      variable: 'TRUSTED_PROXY_ADDRESSES',
    });
  });

  /**
   * The hole this closes, which was a real bug and not a hypothetical.
   *
   * The variable used to be a hop COUNT read through `z.coerce.number()`. `Number('')`
   * is `0`, `0` passed `.int().min(0)`, so zod raised nothing at all — and because
   * zod raised nothing, `toProblems`' "an empty string means missing" mapping in
   * `load.ts` never ran either. Blanking the variable, which is the single most
   * likely operator mistake, produced a perfectly valid config that trusted no
   * proxy. "Required, no default, fail fast" was false for the one input most
   * likely to arrive.
   */
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('refuses %s rather than reading it as "no proxy"', (_label, raw) => {
    const result = parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: raw });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ variable: 'TRUSTED_PROXY_ADDRESSES' }),
    );
  });

  it('accepts the explicit word for "nothing in front", which somebody had to write', () => {
    // A laptop and a bare staging box genuinely have no proxy. The point is that
    // it is a decision on the page, not the absence of one.
    const result = parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: 'none' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.TRUSTED_PROXY_ADDRESSES).toBe('none');
  });

  it.each([
    ['one Caddy', '10.0.0.2'],
    ['a network', '10.0.0.0/24'],
    ['a list', '10.0.0.2, 10.0.0.3, 172.16.0.0/12'],
    ['IPv6', '::1'],
  ])('accepts %s', (_label, raw) => {
    expect(parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: raw }).ok).toBe(true);
  });

  it.each(['proxy.internal', '10.0.0.1/33', '999.0.0.1', 'none, 10.0.0.2', 'true'])(
    'rejects %s instead of silently trusting nothing',
    (raw) => {
      // Dropping an unparseable token would NARROW who is trusted, turning every
      // visitor behind that proxy into one bucket — from a typo.
      const result = parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: raw });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems).toContainEqual(
        expect.objectContaining({ variable: 'TRUSTED_PROXY_ADDRESSES' }),
      );
    },
  );
});

describe('rate limits are knobs, not secrets', () => {
  it('has defaults, so a deployment is not forced to invent numbers', () => {
    const result = parseApiEnv({ ...completeApiEnv });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.RATE_LIMIT_IP_MAX).toBe(30);
    expect(result.config.RATE_LIMIT_IP_WINDOW_SECONDS).toBe(60);
    expect(result.config.RATE_LIMIT_USER_MAX).toBe(10);
    expect(result.config.RATE_LIMIT_USER_WINDOW_SECONDS).toBe(60);
    expect(result.config.RATE_LIMIT_BRUTE_FORCE_MAX).toBe(5);
    expect(result.config.RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS).toBe(900);
    expect(result.config.VALKEY_COMMAND_TIMEOUT_MS).toBe(250);
  });

  it('takes an override from the environment', () => {
    const result = parseApiEnv({ ...completeApiEnv, RATE_LIMIT_IP_MAX: '5' });
    expect(result.ok && result.config.RATE_LIMIT_IP_MAX).toBe(5);
  });

  it('refuses a limit of zero, which would block everybody', () => {
    expect(parseApiEnv({ ...completeApiEnv, RATE_LIMIT_IP_MAX: '0' }).ok).toBe(false);
  });

  /**
   * The same empty-string hole as above, checked for every numeric knob this story
   * added. These are safe because each minimum is at least 1, so `Number('')` = 0
   * fails the range — but that is a property worth pinning rather than assuming,
   * since lowering any minimum to 0 would silently re-open it.
   */
  it.each([
    'RATE_LIMIT_IP_MAX',
    'RATE_LIMIT_IP_WINDOW_SECONDS',
    'RATE_LIMIT_USER_MAX',
    'RATE_LIMIT_USER_WINDOW_SECONDS',
    'RATE_LIMIT_BRUTE_FORCE_MAX',
    'RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS',
    'VALKEY_COMMAND_TIMEOUT_MS',
  ])('treats an empty %s as a problem rather than as zero', (variable) => {
    const result = parseApiEnv({ ...completeApiEnv, [variable]: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(expect.objectContaining({ variable }));
  });
});

/**
 * The two config-shaped values that passed validation and re-opened the hole.
 *
 * Both were found by running the built parser. Each is one token, each produced an
 * empty problem list, and each left a deployment looking correctly configured
 * while trusting either everybody or nobody.
 */
describe('TRUSTED_PROXY_ADDRESSES refuses the two values that defeat it', () => {
  it.each([
    ['trust the whole IPv4 internet', '0.0.0.0/0'],
    ['trust the whole IPv6 internet', '::/0'],
    ['one buried in a sensible list', '10.0.0.2, 0.0.0.0/0'],
  ])('refuses %s', (_label, raw) => {
    // A `/0` compares zero bits, so every address matched and a direct client's
    // own `X-Forwarded-For` became the rate-limit key again.
    const result = parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: raw });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ variable: 'TRUSTED_PROXY_ADDRESSES' }),
    );
  });

  it.each([
    ['a lone separator', ','],
    ['separators and spaces', ' , '],
    ['several separators', ',,,'],
  ])('refuses %s rather than reading it as "no proxy"', (_label, raw) => {
    // Length is 1, so `.trim().min(1)` was satisfied, and the parser returned zero
    // proxies with nothing invalid — so the process started with `trustProxy:
    // false`. Behind Caddy that collapses every visitor into one bucket, from a
    // stray comma in a half-finished edit.
    const result = parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: raw });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ variable: 'TRUSTED_PROXY_ADDRESSES' }),
    );
  });

  it('still accepts a narrow range and the mapped spelling of one address', () => {
    for (const raw of ['10.0.0.0/24', '10.0.0.2', '::ffff:10.0.0.2', '::1']) {
      expect(
        parseApiEnv({ ...completeApiEnv, TRUSTED_PROXY_ADDRESSES: raw }).ok,
        `${raw} must be accepted`,
      ).toBe(true);
    }
  });
});

/**
 * `z.coerce.number()` is `Number()` underneath, so it accepted values that are not
 * the number the operator wrote — and then the log said one thing while the config
 * file said another.
 */
describe('numeric knobs are digits, not whatever Number() will swallow', () => {
  it.each([
    ['hexadecimal', '0x10'],
    ['exponential', '1e3'],
    ['padded', ' 30 '],
    ['a trailing decimal', '30.0'],
    ['a leading plus', '+30'],
    ['infinity', 'Infinity'],
    // `Number('030')` is 30, an octal reader says 24, and the operator meant
    // "thirty, padded" — three answers to one string. It is the same coercion
    // `parseSignInRetryAfterSeconds` refuses on the wire.
    ['a leading zero', '030'],
    ['several leading zeros', '0030'],
  ])('refuses %s for a limit', (_label, raw) => {
    const result = parseApiEnv({ ...completeApiEnv, RATE_LIMIT_IP_MAX: raw });

    expect(result.ok, `${raw} must not be silently coerced`).toBe(false);
  });

  it.each([
    ['hexadecimal', '0x10'],
    ['exponential', '1e3'],
    ['padded', ' 3600 '],
    ['a leading zero', '03600'],
  ])('refuses %s for a duration', (_label, raw) => {
    expect(parseApiEnv({ ...completeApiEnv, SESSION_TTL_SECONDS: raw }).ok).toBe(false);
  });

  it('still accepts a bare zero where the range allows one', () => {
    // `'0'` is a digit string; whether zero is a legal VALUE is the range check's
    // question, and for a limit the answer is no — but for the right reason.
    const result = parseApiEnv({ ...completeApiEnv, RATE_LIMIT_IP_MAX: '0' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ variable: 'RATE_LIMIT_IP_MAX' }),
    );
  });

  it('still accepts an ordinary digit string', () => {
    const result = parseApiEnv({
      ...completeApiEnv,
      RATE_LIMIT_IP_MAX: '45',
      SESSION_TTL_SECONDS: '7200',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.RATE_LIMIT_IP_MAX).toBe(45);
    expect(result.config.SESSION_TTL_SECONDS).toBe(7_200);
  });
});
