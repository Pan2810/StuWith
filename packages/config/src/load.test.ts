import { describe, expect, it } from 'vitest';
import { formatProblems, parseApiEnv, parseRealtimeGatewayEnv, loadApiConfig } from './load';

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
