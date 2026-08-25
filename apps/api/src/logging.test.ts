import type { ApiEnv } from '@stuwith/config';
import { REQUEST_ID_HEADER } from '@stuwith/config';
import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildLoggerParams } from './logging';

/**
 * The redaction list lives in packages/config and is tested there. What is tested
 * HERE is that this process actually applies it — the wiring, not the policy.
 *
 * Those are separate failures. Someone can leave `LOG_REDACT_PATHS` untouched and
 * still leak everything by dropping `redact` from the pino options, flipping
 * `remove: true` to `false`, or deleting the serializers block. None of that was
 * covered by anything before this file existed.
 */
const config: ApiEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  APP_VERSION: '0.1.0-test',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  API_PORT: 3001,
  API_DATABASE_URL: 'postgres://test@127.0.0.1:5432/test',
  SESSION_COOKIE_SECRET: 'y'.repeat(32),
};

/** Captures what pino would have written, line by line. */
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

function loggerUnderTest() {
  const params = buildLoggerParams(config);
  const options = params.pinoHttp as pino.LoggerOptions;
  const { lines, stream } = captureLines();
  return { logger: pino(options, stream), lines, options };
}

describe('apps/api logger wiring (AD-15)', () => {
  it('applies redaction with remove: true, not just masking', () => {
    const { options } = loggerUnderTest();
    const redact = options.redact as { paths: string[]; remove: boolean };

    expect(redact.paths.length).toBeGreaterThan(0);
    // `remove: true` deletes the key. Masking with "[Redacted]" would still prove
    // the field was present, which for a `provider_id` or an `email` on a specific
    // request is itself a disclosure.
    expect(redact.remove).toBe(true);
  });

  it('never writes a cookie header value', () => {
    const { logger, lines } = loggerUnderTest();

    logger.info(
      { req: { headers: { cookie: 'session=super-secret-value', accept: 'application/json' } } },
      'inbound',
    );

    const output = lines.join('');
    expect(output).not.toContain('super-secret-value');
    expect(output).not.toContain('session=');
  });

  it('never writes an authorization header value', () => {
    const { logger, lines } = loggerUnderTest();

    logger.info({ req: { headers: { authorization: 'Bearer leak-me-please' } } }, 'inbound');

    expect(lines.join('')).not.toContain('leak-me-please');
  });

  /**
   * Scope, stated plainly so nobody reads more into a green run than is there:
   * pino's `*.field` wildcard matches exactly ONE level, so this proves redaction
   * at depth 1. A `req.body.user.email` is NOT covered and is not claimed to be —
   * that is the known deny-list limitation recorded in `deferred-work.md` and
   * owned by Story 1.7's whitelist serializer. What this pins is that the floor
   * cannot be removed silently.
   */
  it.each([
    ['email', 'someone@example.com'],
    ['date_of_birth', '1999-04-02'],
    ['access_token', 'ya29.leak'],
    ['provider_id', 'google-oauth2|1234567890'],
  ])('never writes a %s one level down in the payload', (field, value) => {
    const { logger, lines } = loggerUnderTest();

    logger.info({ user: { id: 'u-1', [field]: value } }, 'profile touched');

    const output = lines.join('');
    expect(output).not.toContain(value);
    // The id is not PII and must still be there — otherwise this test would pass
    // just as well against a logger that writes nothing at all.
    expect(output).toContain('u-1');
  });

  it('stamps the service and version on every line', () => {
    const { logger, lines } = loggerUnderTest();
    logger.info('hello');
    const record = JSON.parse(lines[0] ?? '{}');
    expect(record.service).toBe('api');
    expect(record.version).toBe('0.1.0-test');
  });
});

describe('apps/api request id handling', () => {
  type Headers = Record<string, string | string[] | undefined>;

  function genReqId(headers: Headers): { id: string; echoed: string | undefined } {
    const params = buildLoggerParams(config);
    const gen = (params.pinoHttp as { genReqId: (req: unknown, res: unknown) => string }).genReqId;

    let echoed: string | undefined;
    const res = {
      setHeader: (name: string, value: string) => {
        if (name === REQUEST_ID_HEADER) echoed = value;
      },
    };
    return { id: gen({ headers }, res), echoed };
  }

  it('reuses a well-formed inbound id so a trace survives the process hop', () => {
    const incoming = '018f9c2e-6a1b-7c3d-9e4f-a1b2c3d4e5f6';
    const { id, echoed } = genReqId({ [REQUEST_ID_HEADER]: incoming });
    expect(id).toBe(incoming);
    expect(echoed).toBe(incoming);
  });

  it('replaces a forged inbound id and echoes back only the sanitised one', () => {
    const forged = 'abc\n{"level":50,"msg":"injected"}';
    const { id, echoed } = genReqId({ [REQUEST_ID_HEADER]: forged });

    expect(id).not.toBe(forged);
    expect(id).not.toContain('\n');
    // The response header matters as much as the log: echoing the raw value back
    // makes this endpoint a reflection point for whatever the caller sent.
    expect(echoed).toBe(id);
    expect(echoed).not.toContain('\n');
  });

  it('mints one when the header is absent', () => {
    const { id } = genReqId({});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
