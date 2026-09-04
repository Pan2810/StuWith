import type { ApiEnv } from '@stuwith/config';
import { REQUEST_ID_HEADER } from '@stuwith/config';
import {
  AUTH_DATE_OF_BIRTH_PATH,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '@stuwith/contracts';
import pino from 'pino';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  createAuthHarness,
  type AuthHarness,
} from './auth/__testing__/auth-harness';
import { SIGN_IN_FAILURE_REASONS } from './auth/audit';
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
    // The camelCase halves, run through a REAL pino rather than only checked for
    // membership in an array. `packages/domain`'s `User` carries `dateOfBirth`,
    // and that object — not a request body — is what `logger.info({ user })`
    // writes; until this table had these four rows, no camelCase path had ever
    // been exercised by a logger.
    ['dateOfBirth', '1999-04-02'],
    ['accessToken', 'ya29.leak'],
    ['refreshToken', 'refresh-leak-me'],
    ['providerId', 'google-oauth2|1234567890'],
  ])('never writes a %s one level down in the payload', (field, value) => {
    const { logger, lines } = loggerUnderTest();

    logger.info({ user: { id: 'u-1', [field]: value } }, 'profile touched');

    const output = lines.join('');
    expect(output).not.toContain(value);
    // The id is not PII and must still be there — otherwise this test would pass
    // just as well against a logger that writes nothing at all.
    expect(output).toContain('u-1');
  });

  /**
   * The one two-level shape Story 1.4 created, run through a real pino.
   *
   * `RecordDateOfBirthResult` is `{ ok: true, user: User }`, so `logger.info({
   * outcome })` puts the date of birth at `outcome.user.dateOfBirth` — two levels
   * down, which the `*.` wildcard cannot reach. `*.user.dateOfBirth` is the named
   * path that does. Nothing in `apps/api` logs that object today; the point is
   * that the return type made the shape expressible, and the covering path is
   * cheaper than trusting nobody writes the line. Depth beyond this is Story 1.7's
   * whitelist serializer and is recorded in `deferred-work.md`.
   */
  it.each([
    ['date_of_birth' as const],
    ['dateOfBirth' as const],
  ])('never writes a %s TWO levels down, inside a port result', (field) => {
    const { logger, lines } = loggerUnderTest();

    logger.info(
      { outcome: { ok: true, user: { id: 'u-1', [field]: '1999-04-02' } } },
      'date of birth recorded',
    );

    const output = lines.join('');
    expect(output).not.toContain('1999-04-02');
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
/**
 * Story 1.3's half of the same claim. The callback leg now has two outcomes that
 * did not exist before — the provider refusing, and the person cancelling — and
 * both arrive with a `?error=...` in the URL.
 *
 * That is the shape no field-level redaction can reach: `req.url` is one string
 * carrying the provider's error code, and pino cannot redact inside a string. What
 * closes it is `sanitizeLoggedUrl` dropping the query entirely, and this suite is
 * what proves it still does — for the failure path as well as the happy one.
 *
 * The second assertion is the internal vocabulary: `provider_authorize_failed`
 * and friends belong in `audit_events` and nowhere else. A log line is read by
 * more people, kept in more places and pasted into more tickets than an audit row
 * ever is.
 */
describe('a failed and a cancelled login leak nothing into a real pino (AD-15)', () => {
  let harness: AuthHarness;
  let output: string;

  beforeAll(async () => {
    harness = await createAuthHarness({ captureLogs: true });

    // 1. A technical failure: the provider sent the browser back with an error.
    const failing = new CookieJar();
    const startedFailing = await harness.request('/v1/auth/google/start', { jar: failing });
    const failingCallback = new URL(startedFailing.headers.get('location') ?? '');
    await harness.request(
      `/v1/auth/google/callback?state=${failingCallback.searchParams.get('state') ?? ''}` +
        '&error=server_error&error_description=Google%20is%20unwell',
      { jar: failing },
    );

    // 2. A cancellation at the consent screen.
    const cancelling = new CookieJar();
    const startedCancel = await harness.request('/v1/auth/google/start', { jar: cancelling });
    const cancelCallback = new URL(startedCancel.headers.get('location') ?? '');
    await harness.request(
      `/v1/auth/google/callback?state=${cancelCallback.searchParams.get('state') ?? ''}` +
        '&error=access_denied',
      { jar: cancelling },
    );

    output = harness.logLines.join('\n');
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('actually logged both callbacks — otherwise every assertion below is vacuous', () => {
    expect(harness.logLines.length).toBeGreaterThan(0);
    // The path survives; only the query string is dropped.
    expect(output).toContain('/v1/auth/google/callback?<redacted>');
  });

  it.each([
    'server_error',
    'access_denied',
    'error=',
    // The ENCODED form. The suite sends `error_description=Google%20is%20unwell`,
    // so the decoded sentence is not a string that could ever appear in a log
    // line — asserting on it was a row that could not fail.
    'Google%20is%20unwell',
    'error_description',
  ])('never writes the provider error detail %s', (fragment) => {
    expect(output).not.toContain(fragment);
  });

  it.each([...SIGN_IN_FAILURE_REASONS])('never writes the internal reason %s', (reason) => {
    expect(output).not.toContain(reason);
  });

  it('never writes the state, which rides in the same URL as the error', () => {
    expect(output).not.toContain('state=');
  });
});

/**
 * Story 1.4's half of the same claim, and the story's own release gate: "run
 * `apps/api` for real, declare a date of birth over HTTP, then read every line it
 * wrote."
 *
 * This is a different claim from the field-level examples at the top of this
 * file. Those hand a payload to a logger the test built. This one drives the
 * declaration through the real controller, the real service, the real adapter and
 * the real pino, and then greps everything that reached the output stream — which
 * is the only way to catch the leaks no redaction path can reach: a value inside
 * `req.url`, a value inside an error message, a value inside a serialised body.
 *
 * The date is a REAL one for the profile being logged in, not a random-looking
 * string, because a value that also appears in `apps/api`'s own vocabulary would
 * make a "does not contain" assertion pass for the wrong reason.
 */
describe('a declared date of birth leaks nothing into a real pino (AD-15)', () => {
  const profile = {
    subject: 'google-subject-dob-check',
    email: 'dob.check@fpt.edu.vn',
    name: 'Dob Check',
    picture: 'https://lh3.googleusercontent.com/a/dob',
  };
  /** Distinctive enough that a substring match cannot hit it by accident. */
  const declared = '1993-07-19';

  let harness: AuthHarness;
  let output: string;
  let declaration: Response;

  beforeAll(async () => {
    harness = await createAuthHarness({ captureLogs: true });

    const { jar } = await harness.login('google', profile);
    declaration = await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date_of_birth: declared }),
    });
    // A second, refused attempt: the 409 path builds a different response and
    // touches the stored value, so it is a second chance to write it somewhere.
    await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '1970-01-01' }),
    });
    // And a rejected one, whose validation error is the classic place an input
    // value gets echoed into a log line.
    await harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date_of_birth: '2026-02-30' }),
    });
    await harness.request('/v1/auth/me', { jar });

    output = harness.logLines.join('\n');
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('actually declared it — otherwise every assertion below is vacuous', () => {
    // A test asserting "the log does not contain X" passes perfectly against a run
    // in which X was never submitted. This is the assertion that makes the rest
    // mean something.
    expect(declaration.status).toBe(200);
    expect(harness.logLines.length).toBeGreaterThan(0);
    expect(output).toContain('/v1/auth/date-of-birth');
  });

  it('never writes the declared date, in any spelling', () => {
    expect(output).not.toContain(declared);
    // The year alone is enough to narrow somebody down, and it is also what a
    // partially-redacted structure would leave behind.
    expect(output).not.toContain('1993');
    // The refused values travelled the same road and must be just as absent.
    expect(output).not.toContain('1970-01-01');
    expect(output).not.toContain('2026-02-30');
  });

  it('never writes the field name with a value beside it, in either vocabulary', () => {
    // `date_of_birth` on the wire, `dateOfBirth` on the domain type. The
    // camelCase half was the hole this story found: `*.date_of_birth` covered the
    // request body while `User` carries `dateOfBirth`, which is the object
    // anything in `apps/api` would actually log.
    expect(output).not.toMatch(/"date_of_birth"\s*:\s*"/);
    expect(output).not.toMatch(/"dateOfBirth"\s*:\s*"/);
  });

  it('still records the path and the request id, so the log is worth keeping', () => {
    // The redaction has to stop short of making the log useless: without this, the
    // assertions above would pass against a logger that writes nothing at all.
    expect(output).toContain('request_id');
    expect(output).toContain('/v1/auth/me');
  });
});
