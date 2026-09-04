import type { ApiEnv } from '@stuwith/config';
import { REQUEST_ID_HEADER } from '@stuwith/config';
import { REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME } from '@stuwith/contracts';
import pino from 'pino';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  createAuthHarness,
  type AuthHarness,
} from './auth/__testing__/auth-harness';
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
  WEB_BASE_URL: 'http://127.0.0.1:3000',
  OAUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:3001',
  AUTH_ENABLED_PROVIDERS: [],
  SESSION_TTL_SECONDS: 3600,
  SESSION_REFRESH_TTL_SECONDS: 2_592_000,
  OAUTH_STATE_TTL_SECONDS: 600,
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

/**
 * Story 1.2's last matrix row: run a WHOLE login — start, consent, callback,
 * refresh, `/me` — through the real process with a real pino behind it, then read
 * every line it wrote.
 *
 * This is a different claim from the examples above. Those build a logger and hand
 * it a payload; this one asserts that the running application, with its actual
 * middleware and its actual URLs, does not put an email, a provider subject, an
 * authorization `code`, a `state` or a token into its own log. The failure it
 * exists to catch is the one no field-level redaction can: `req.url` on the
 * callback is a single string containing both `code` and `state`.
 */
describe('a real login leaks nothing into a real pino (AD-15)', () => {
  const profile = {
    subject: 'google-subject-pii-check',
    email: 'pii.check@fpt.edu.vn',
    name: 'PII Check',
    picture: 'https://lh3.googleusercontent.com/a/pii',
  };

  let harness: AuthHarness;
  let output: string;
  let jar: CookieJar;

  beforeAll(async () => {
    harness = await createAuthHarness({ captureLogs: true });

    const started = await harness.login('google', profile);
    jar = started.jar;
    await harness.request('/v1/auth/refresh', { method: 'POST', jar });
    await harness.request('/v1/auth/me', { jar });

    output = harness.logLines.join('\n');
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('actually logged something — otherwise every assertion below is vacuous', () => {
    // A logger that was never wired up passes a "does not contain" test perfectly.
    expect(harness.logLines.length).toBeGreaterThan(0);
    expect(output).toContain('/v1/auth/me');
  });

  it('never writes the email or the provider subject', () => {
    expect(output).not.toContain(profile.email);
    expect(output).not.toContain(profile.subject);
  });

  it('never writes the authorization code or the state, which live in the URL', () => {
    const code = harness.fake.lastIssuedCode;
    expect(code.length).toBeGreaterThan(0);
    expect(output).not.toContain(code);
    expect(output).not.toContain('code=');
    expect(output).not.toContain('state=');
  });

  it('never writes a session or refresh cookie value', () => {
    const session = jar.get(SESSION_COOKIE_NAME) ?? '';
    const refresh = jar.get(REFRESH_COOKIE_NAME) ?? '';
    expect(session.length).toBeGreaterThan(0);
    expect(refresh.length).toBeGreaterThan(0);
    expect(output).not.toContain(session);
    expect(output).not.toContain(refresh);
  });

  it('never writes an id_token, an access token or a client secret', () => {
    // `eyJ` is the start of every base64url-encoded JWT header.
    expect(output).not.toContain('eyJ');
    expect(output).not.toContain('fake-access-');
    expect(output).not.toContain(harness.config.GOOGLE_CLIENT_SECRET ?? 'unset-client-secret');
  });

  it('still records the path and the request id, so the log is worth keeping', () => {
    // The redaction has to stop short of making the log useless: without these,
    // the test above would also pass against a logger that writes nothing at all.
    expect(output).toContain('/v1/auth/google/callback?<redacted>');
    expect(output).toContain('request_id');
  });
});
