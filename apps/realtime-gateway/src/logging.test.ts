import type { RealtimeGatewayEnv } from '@stuwith/config';
import { LOG_REDACT_PATHS } from '@stuwith/config';
import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildLoggerParams } from './logging';

/**
 * AGENTS.md says BOTH processes drop the query string from `req.url`, and until
 * this file existed only `apps/api` was checked — `vitest.config.mts` had no
 * project rooted here at all, so a test placed in this directory would not even
 * have run.
 *
 * That matters beyond tidiness: the gateway serves no `/v1/auth/*` route today,
 * but it is the process that will carry room tokens and chat, and a shared
 * redaction policy that is only enforced in one of two places is not a policy.
 */
const config: RealtimeGatewayEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  APP_VERSION: '0.1.0-test',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  GATEWAY_PORT: 3002,
  REALTIME_DATABASE_URL: 'postgres://test@127.0.0.1:5432/test',
};

type ReqSerializer = (req: { id: unknown; method: string; url: string }) => { url: string };

function optionsUnderTest() {
  const params = buildLoggerParams(config);
  return params.pinoHttp as pino.LoggerOptions & {
    serializers: { req: ReqSerializer };
  };
}

function captureLines(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream };
}

describe('apps/realtime-gateway logger wiring (AD-15)', () => {
  it('drops the query string from a logged URL', () => {
    const { serializers } = optionsUnderTest();

    const serialised = serializers.req({
      id: 'req-1',
      method: 'GET',
      url: '/ws?token=super-secret-room-token&room=abc',
    });

    expect(serialised.url).toBe('/ws?<redacted>');
    expect(serialised.url).not.toContain('super-secret-room-token');
    expect(serialised.url).not.toContain('token=');
  });

  it('leaves a plain path readable, so the log is still worth keeping', () => {
    expect(optionsUnderTest().serializers.req({ id: 'r', method: 'GET', url: '/healthz' }).url).toBe(
      '/healthz',
    );
  });

  it('applies the shared redaction list with remove: true', () => {
    const options = optionsUnderTest();
    const redact = options.redact as { paths: string[]; remove: boolean };

    // The list lives in packages/config precisely so the two processes cannot
    // drift; this asserts the gateway actually uses it rather than a copy.
    expect(redact.paths).toEqual([...LOG_REDACT_PATHS]);
    expect(redact.remove).toBe(true);
  });

  it('never writes an email or an access token one level down', () => {
    const { lines, stream } = captureLines();
    const logger = pino(optionsUnderTest(), stream);

    logger.info({ user: { id: 'u-1', email: 'someone@example.com', access_token: 'ya29.leak' } }, 'x');

    const output = lines.join('');
    expect(output).not.toContain('someone@example.com');
    expect(output).not.toContain('ya29.leak');
    expect(output).toContain('u-1');
  });

  it('stamps this process, not the other one', () => {
    const { lines, stream } = captureLines();
    pino(optionsUnderTest(), stream).info('hello');
    expect(JSON.parse(lines[0] ?? '{}').service).toBe('realtime-gateway');
  });
});
