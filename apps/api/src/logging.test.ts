import type { ApiEnv } from '@stuwith/config';
import {
  LOG_ALLOWED_FIELDS,
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  loggerWiringProblems,
} from '@stuwith/config';
import {
  AUTH_COOKIE_PATH,
  AUTH_DATE_OF_BIRTH_PATH,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '@stuwith/contracts';
import pino from 'pino';
import { connect } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  createAuthHarness,
  type AuthHarness,
} from './auth/__testing__/auth-harness';
import { SIGN_IN_FAILURE_REASONS } from './auth/audit';
import { fastifyAdapterOptions } from './http-setup';
import { buildLoggerParams } from './logging';
import {
  MONEY_FIXTURE_FAILURE,
  MONEY_FIXTURE_IN_PATH,
  MONEY_FIXTURE_THROWS_PATH,
  MoneyFixtureController,
} from './money/__testing__/money-fixture.controller';

/**
 * The PII policy lives in packages/config and is tested there. What is tested HERE
 * is that this process actually applies it — the wiring, not the policy.
 *
 * Those are separate failures. Someone can leave `LOG_ALLOWED_FIELDS` untouched and
 * still leak everything by dropping `formatters` from the pino options, deleting
 * the `err` serializer, flipping `remove: true` to `false`, or removing the
 * serializers block. None of that was covered by anything before this file existed.
 *
 * Since Story 1.7 the control is an ALLOW-LIST at `formatters.log`, so the shape of
 * the assertions changed: the interesting claim is no longer "this named field was
 * removed" but "a field nobody declared never appears, and the line is still
 * written". The old anti-vacuity trick — assert a user id survived — had to go with
 * it, because a user id is not a declared field either. Its replacement is to read
 * the record back as JSON and assert the `msg` is there.
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
  /**
   * The records as pino wrote them, parsed.
   *
   * `lines.join('')` answers "does this string appear", which is the right question
   * for a leak and the wrong one for "was the line written at all". Under an
   * allow-list the second question is the one that keeps the first honest: every
   * `not.toContain` below passes perfectly against a logger that emitted nothing.
   */
  const records = (): Record<string, unknown>[] =>
    lines
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger: pino(options, stream), lines, options, records };
}

describe('apps/api logger wiring (AD-15)', () => {
  it('satisfies the shared wiring contract, the same one the gateway is held to', () => {
    // One function in `packages/config`, called by both apps' tests. It checks the
    // allow-list is applied, the three serializers are present and no more, the
    // belt is wired with `remove: true`, `customProps` exists, and that no
    // `genReqId` has crept back into the pino options — the last of which is the
    // regression that hid for six stories.
    expect(loggerWiringProblems(loggerUnderTest().options)).toEqual([]);
  });

  /**
   * Headers, and an honest account of WHICH layer removes them.
   *
   * These two examples were green for a reason unrelated to the thing they were
   * named after. `{ req: { headers } }` reaches `serializers.req`, which emits
   * `id`, `method` and `url` and nothing else, so the headers are gone before
   * `redact` is ever consulted — deleting `req.headers.cookie` from
   * `LOG_REDACT_PATHS` left both passing. The claim they can actually make is the
   * stronger one, so that is the claim they now make; the deny-list's own live
   * ground is proved separately, below, through a real child binding.
   */
  it.each([
    ['a cookie header value', { cookie: 'session=super-secret-value' }, 'super-secret-value'],
    ['an authorization header value', { authorization: 'Bearer leak-me-please' }, 'leak-me-please'],
    ['a header nobody ever named', { 'x-internal-secret': 'never-listed-anywhere' }, 'never-listed-anywhere'],
  ])('never writes %s, because the req serializer emits three fields and no more', (
    _label,
    headers,
    leak,
  ) => {
    const { logger, lines, records } = loggerUnderTest();

    logger.info({ req: { id: 'r-1', method: 'GET', url: '/v1/auth/me', headers } }, 'inbound');

    expect(lines.join('')).not.toContain(leak);
    // The positive half: `headers` is absent as a KEY, not merely masked, and the
    // three declared fields are still there — so this cannot pass against a
    // serializer that returns nothing.
    expect(records()[0]?.['req']).toEqual({ id: 'r-1', method: 'GET', url: '/v1/auth/me' });
  });

  it('never copies a non-scalar out through req.id, either', () => {
    // `serializers.req` was an allow-list over field NAMES and not over field
    // VALUES: it wrote `id: req.id` whatever that was. An object there sailed
    // straight through a key that had supposedly been filtered.
    const { logger, lines, records } = loggerUnderTest();

    logger.info({ req: { id: { email: 'someone@example.com' }, method: 'GET', url: '/x' } }, 'odd');

    expect(lines.join('')).not.toContain('someone@example.com');
    expect((records()[0]?.['req'] as Record<string, unknown>)['id']).toBeUndefined();
  });

  /**
   * The deny-list's REAL ground, which five docblocks assert and nothing exercised.
   *
   * The belt is kept because pino stitches CHILD bindings into a line without
   * passing them through `formatters.log` — `asChindings` replaces a child's
   * bindings formatter with an identity function — while still running them
   * through `redact`'s stringifiers. That is the whole justification for keeping
   * `LOG_REDACT_PATHS` wired, and it was an argument rather than an example.
   *
   * Both halves are visible in one record: `user` SURVIVES as a key, which proves
   * the allow-list never saw it, and `email` is gone from inside it, which proves
   * `redact` did.
   */
  it('lets redact remove a field from a child binding the allow-list never sees', () => {
    const { logger, lines, records } = loggerUnderTest();

    logger.child({ user: { id: 'u-1', email: 'someone@example.com' } }).info('from a child');

    const output = lines.join('');
    expect(output).not.toContain('someone@example.com');
    // The allow-list did not touch this object: `user` is not a declared field, and
    // it is here. If a future pino ran child bindings through `formatters.log`,
    // this expectation flips and the belt's justification needs rewriting.
    const user = records()[0]?.['user'] as Record<string, unknown>;
    expect(user).toBeDefined();
    expect(user['id']).toBe('u-1');
    expect(user['email']).toBeUndefined();
  });

  it('removes rather than masks, so a redacted field leaves no trace of itself', () => {
    // `remove: false` writes `"[Redacted]"`, which every `not.toContain(<value>)`
    // assertion in this file is perfectly happy with — a reviewer flipped it and
    // only the structural check noticed. For a `provider_id` or an `email` on a
    // specific request, "this field was present" is itself a disclosure.
    const { logger, lines, records } = loggerUnderTest();

    logger.child({ user: { id: 'u-1', email: 'someone@example.com' } }).info('from a child');

    expect(lines.join('')).not.toContain('[Redacted]');
    expect(Object.keys(records()[0]?.['user'] as Record<string, unknown>)).toEqual(['id']);
  });

  /**
   * The allow-list, through the REAL pino this process configures.
   *
   * Story 1.7 turned the mechanism round. These fields are absent not because a
   * redaction path names them — several of these no longer need one — but because
   * `user` was never a declared field, so nothing under it can be written at any
   * depth. The camelCase halves are here for the same reason as before: `User` in
   * `packages/domain` carries `dateOfBirth`, and that object, not a request body,
   * is what `logger.info({ user })` writes.
   */
  it.each([
    ['email', 'someone@example.com'],
    ['date_of_birth', '1999-04-02'],
    ['access_token', 'ya29.leak'],
    ['provider_id', 'google-oauth2|1234567890'],
    ['dateOfBirth', '1999-04-02'],
    ['accessToken', 'ya29.leak'],
    ['refreshToken', 'refresh-leak-me'],
    ['providerId', 'google-oauth2|1234567890'],
  ])('never writes a %s one level down in the payload', (field, value) => {
    const { logger, lines, records } = loggerUnderTest();

    logger.info({ user: { id: 'u-1', [field]: value } }, 'profile touched');

    expect(lines.join('')).not.toContain(value);
    // The line itself was still written, so this example cannot pass against a
    // logger that emitted nothing at all.
    expect(records()).toHaveLength(1);
    expect(records()[0]?.['msg']).toBe('profile touched');
    expect(records()[0]?.['user']).toBeUndefined();
  });

  it('drops even the user id, because `id` is not a declared field either', () => {
    /**
     * The honest replacement for the old anti-vacuity guard, which asserted
     * `expect(output).toContain('u-1')` and now describes a leak.
     *
     * It gets its own example rather than a row in the table above: as a row it was
     * `{ user: { id: 'u-1', id: 'u-1' } }` — a duplicate key, so the parametrised
     * claim was never exercised and the assertion was a copy of one already in the
     * body.
     */
    const { logger, lines, records } = loggerUnderTest();

    logger.info({ user: { id: 'u-1' } }, 'profile touched');

    expect(lines.join('')).not.toContain('u-1');
    expect(LOG_ALLOWED_FIELDS).not.toContain('id');
    // And the line survives, which is what stops this passing against a logger
    // that wrote nothing.
    expect(records()[0]?.['msg']).toBe('profile touched');
  });

  /**
   * The claim the deny-list could never make, run through a real pino.
   *
   * `RecordDateOfBirthResult` is `{ ok: true, user: User }`, so a date of birth
   * sits two levels down — past every `*.` wildcard, which is why the deny-list
   * needed a hand-written `*.user.dateOfBirth` for that ONE shape and had nothing
   * for the next one. Under the allow-list the depth is irrelevant: `outcome` was
   * never declared.
   */
  it.each([['date_of_birth' as const], ['dateOfBirth' as const]])(
    'never writes a %s TWO levels down, inside a port result',
    (field) => {
      const { logger, lines, records } = loggerUnderTest();

      logger.info(
        { outcome: { ok: true, user: { id: 'u-1', [field]: '1999-04-02' } } },
        'date of birth recorded',
      );

      expect(lines.join('')).not.toContain('1999-04-02');
      expect(records()[0]?.['msg']).toBe('date of birth recorded');
      expect(records()[0]?.['outcome']).toBeUndefined();
    },
  );

  /**
   * AC4, through the real wiring: a field nobody has ever thought about.
   *
   * Nothing in this repository mentions `national_id`. No list forbids it, no test
   * was edited to accommodate it, and it does not reach the output — because the
   * mechanism's default is absence. This is the example a deny-list cannot pass
   * however carefully it is maintained, and it is the whole point of the story.
   */
  it('never writes a field invented today, with no edit to any list', () => {
    const { logger, lines, records } = loggerUnderTest();

    logger.info({ national_id: '079301004321', request_id: 'r-1' }, 'new field');

    expect(lines.join('')).not.toContain('079301004321');
    expect(records()[0]?.['national_id']).toBeUndefined();
    // And the declared field beside it survived, so the filter is not simply
    // deleting the object.
    expect(records()[0]?.['request_id']).toBe('r-1');
    expect(LOG_ALLOWED_FIELDS).not.toContain('national_id');
  });

  it('keeps the message when it is passed in the OBJECT rather than as an argument', () => {
    // `logger.info({ msg })` is legal pino and puts the sentence INSIDE the
    // filtered object. Undeclared, it produced a message-less line and no error
    // anywhere — the "too strict makes the log useless" failure, waiting for the
    // first person to write the other form.
    const { logger, records } = loggerUnderTest();

    logger.info({ msg: 'written the object way', request_id: 'r-1', email: 'someone@example.com' });

    expect(records()).toHaveLength(1);
    expect(records()[0]?.['msg']).toBe('written the object way');
    expect(records()[0]?.['request_id']).toBe('r-1');
    expect(records()[0]?.['email']).toBeUndefined();
  });

  /**
   * Every level, because a filter wired into one of them is a filter with a hole
   * shaped exactly like whichever level the incident happens at.
   */
  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)(
    'applies the allow-list at %s as well',
    (level) => {
      const params = buildLoggerParams({ ...config, LOG_LEVEL: 'trace' });
      const { lines, stream } = captureLines();
      const logger = pino(params.pinoHttp as pino.LoggerOptions, stream);

      logger[level]({ user: { email: 'someone@example.com' }, request_id: 'r-1' }, 'at a level');

      const record = JSON.parse(lines.join('').trim()) as Record<string, unknown>;
      expect(lines.join('')).not.toContain('someone@example.com');
      expect(record['msg']).toBe('at a level');
      expect(record['request_id']).toBe('r-1');
    },
  );

  /**
   * The route that was actually open, and the most valuable example in this file.
   *
   * pino's DEFAULT error serializer walks every enumerable own property of the
   * thrown object. Nothing in `apps/api` passes an object to a log call — all six
   * hand-written calls pass a string — so an allow-list over hand-written payloads
   * would have protected exactly nothing. What flows through the logger is what
   * `pino-http` writes by itself, and of those `req` and `res` were already
   * narrowed while `err` was not. An error carrying a token wrote it to disk.
   */
  it('never writes a custom property hung on an Error', () => {
    const { logger, lines, records } = loggerUnderTest();

    logger.error(
      {
        err: Object.assign(new Error('exchange failed'), {
          token: 'ya29.error-carried-leak',
          user: { email: 'someone@example.com' },
        }),
      },
      'exchange failed',
    );

    const output = lines.join('');
    expect(output).not.toContain('ya29.error-carried-leak');
    expect(output).not.toContain('someone@example.com');

    const err = records()[0]?.['err'] as Record<string, unknown>;
    // Still diagnosable: the type, the sentence and the frames survive.
    expect(err['name']).toBe('Error');
    expect(err['message']).toBe('exchange failed');
    expect(typeof err['stack']).toBe('string');
    expect(err['token']).toBeUndefined();
    expect(err['user']).toBeUndefined();
  });

  it('still writes err.code — the field every incident starts from', () => {
    // `REDACTION_NOTES.bareCodeExcluded` records why a bare `*.code` was kept out
    // of the deny-list. The allow-list re-declares it rather than inheriting it,
    // and this is where that declaration is proved through a real pino.
    const { logger, records } = loggerUnderTest();

    logger.error({ err: Object.assign(new Error('down'), { code: 'ECONNREFUSED' }) }, 'store down');

    expect((records()[0]?.['err'] as Record<string, unknown>)['code']).toBe('ECONNREFUSED');
  });

  it('applies the allow-list before redaction, so the two are ordered not redundant', () => {
    // `formatters.log` runs first, then `serializers`, then `redact`. Keeping the
    // deny-list as a belt is only defensible if that order is checked rather than
    // assumed: an undeclared field is gone before `redact` ever sees it, which is
    // why nothing here depends on the belt.
    const { logger, lines, options } = loggerUnderTest();
    expect((options.redact as { paths: string[] }).paths.length).toBeGreaterThan(0);

    logger.info({ nobody_declared_me: 'gone-before-redact' }, 'ordering');

    expect(lines.join('')).not.toContain('gone-before-redact');
  });

  it('stamps the service and version on every line', () => {
    const { logger, lines } = loggerUnderTest();
    logger.info('hello');
    const record = JSON.parse(lines[0] ?? '{}');
    expect(record.service).toBe('api');
    expect(record.version).toBe('0.1.0-test');
  });
});

/**
 * The request id, end to end, through a REAL request.
 *
 * ## Why these examples had to be rewritten
 *
 * They used to call `params.pinoHttp.genReqId` directly and pass. That function
 * never ran: `pino-http` writes `req.id = req.id || genReqId(req, res)`, and
 * Fastify assigns an id before any middleware executes, so the branch was dead
 * from Story 1.1 to Story 1.7. Three green examples described a function nothing
 * called. Calling the seam directly is exactly how that survived six stories, so
 * the claim is now made against HTTP.
 *
 * ## What is being defended
 *
 * Wiring `genReqId` into Fastify means a value an outside caller controls now
 * reaches every log line for the request, every `audit_events` row it writes, and
 * a response header. `resolveRequestId` is the only thing between those and the
 * caller, and Story 1.7 is the first release in which it actually runs — so it is
 * exercised over a socket, not as a function.
 */
describe('apps/api request id handling', () => {
  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness({ captureLogs: true });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('asks Fastify, not pino-http — the seam that actually runs', () => {
    // The regression this file exists to prevent a second time. `pino-http`'s
    // `genReqId` is unreachable because Fastify has already set `req.id`; the
    // adapter's is the one Fastify asks. A `genReqId` reappearing in the pino
    // options would be a second decision point that never executes.
    const adapter = fastifyAdapterOptions(harness.config) as { genReqId?: unknown };
    const pinoOptions = buildLoggerParams(config).pinoHttp as { genReqId?: unknown };

    expect(typeof adapter.genReqId).toBe('function');
    expect(pinoOptions.genReqId).toBeUndefined();
  });

  /**
   * One request, with a hand-written header, read back from the response AND from
   * the log line the same request produced.
   *
   * `raw` rather than `fetch` for the hostile values: Node's `fetch` refuses to
   * SEND a header containing a control character (`UND_ERR_INVALID_ARG`), so the
   * cases that matter most could not be expressed through it. A socket writes the
   * bytes an attacker would write.
   */
  async function raw(headerValue: string | undefined): Promise<{
    status: string;
    echoed: string;
    logged: string;
  }> {
    const before = harness.logLines.length;
    const url = new URL(harness.baseUrl);
    const header = headerValue === undefined ? '' : `${REQUEST_ID_HEADER}: ${headerValue}\r\n`;
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(`GET /v1/auth/me HTTP/1.1\r\nHost: ${url.host}\r\n${header}Connection: close\r\n\r\n`);
      });
      let received = '';
      socket.setTimeout(10_000, () => {
        socket.destroy();
        reject(new Error('the server never answered'));
      });
      socket.on('data', (chunk) => {
        received += String(chunk);
      });
      socket.on('error', reject);
      socket.on('close', () => {
        resolve(received);
      });
    });

    const head = response.split('\r\n\r\n')[0] ?? '';
    const echoed = /^x-request-id:\s*(.*)$/im.exec(head)?.[1]?.trim() ?? '';
    return {
      status: head.split('\r\n')[0] ?? '',
      echoed,
      logged: harness.logLines.slice(before).join(''),
    };
  }

  it('reuses a well-formed inbound id, so a trace survives the process hop', async () => {
    const incoming = '018f9c2e-6a1b-7c3d-9e4f-a1b2c3d4e5f6';
    const { echoed, logged } = await raw(incoming);

    expect(echoed).toBe(incoming);
    // And the SAME value reached the log, which is the whole point of honouring it.
    expect(JSON.parse(logged.trim()) as Record<string, unknown>).toMatchObject({
      request_id: incoming,
    });
  }, 60_000);

  it('mints one when the header is absent, and echoes it', async () => {
    const { echoed, logged } = await raw(undefined);

    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect(logged).toContain(echoed);
  }, 60_000);

  /**
   * The hostile table, over a socket. Each row is a shape `REQUEST_ID_PATTERN` or
   * `REQUEST_ID_MAX_LENGTH` exists to refuse, and the assertion is the same for all
   * of them: the caller's bytes appear NOWHERE — not in the response header, not in
   * the log — and what is echoed is a freshly minted id.
   */
  it.each([
    ['a space, which would break a log line apart', 'has space here'],
    ['JSON, which would restructure the record', '{"level":50,"msg":"injected"}'],
    ['a quote', 'quote"inside'],
    ['an empty value', ''],
    ['a value over the length cap', `${'a'.repeat(REQUEST_ID_MAX_LENGTH + 1)}`],
  ])('replaces %s', async (_label, hostile) => {
    const { echoed, logged } = await raw(hostile);

    // A fresh id, not the caller's.
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect(echoed).not.toBe(hostile);
    // Echoing the raw value back would make this endpoint a reflection point for
    // whatever the caller sent; writing it to the log is the forging half.
    if (hostile.length > 0) {
      expect(echoed).not.toContain(hostile);
      expect(logged).not.toContain(hostile);
    }
    // And the log record is still ONE well-formed line, which is the property a
    // newline or a brace in the id would have destroyed.
    const lines = logged.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow();
  }, 60_000);

  /**
   * The two shapes that never reach `resolveRequestId` at all, and the honest
   * description of why.
   *
   * An ANSI escape and a bare control byte in a header value are rejected by
   * NODE'S OWN HTTP PARSER before Fastify sees the request, so the answer is a
   * refusal at the socket rather than a substituted id. That is a stronger outcome
   * than the guard's, and it is asserted rather than assumed because the earlier
   * version of this table demanded an echoed id here and failed — which is how the
   * layer was located. `resolveRequestId` still refuses both spellings as a unit
   * (`packages/config/src/logging.test.ts`), and that redundancy is the point: the
   * parser is a dependency's behaviour, not a promise this repository controls.
   */
  it.each([
    ['an ANSI escape, which corrupts a log viewer', 'abc\u001b[31mred'],
    ['a bare control character', 'abc\u0007bell'],
  ])('never lets %s reach the application at all', async (_label, hostile) => {
    const { status, echoed, logged } = await raw(hostile);

    expect(status).toContain('400');
    expect(echoed).toBe('');
    expect(logged).not.toContain(hostile);
  }, 60_000);

  it('still records the latency, which is the only such signal either process emits', async () => {
    // The allow-list's own named failure mode: too strict makes the log useless. A
    // reviewer deleted `responseTime` from the declared list and 719 examples
    // stayed green while latency vanished from every request line in BOTH
    // processes. It is a number on a real auto-logged line or it is nothing.
    const before = harness.logLines.length;
    await harness.request('/v1/auth/me');

    const record = JSON.parse(
      harness.logLines.slice(before).join('').trim(),
    ) as Record<string, unknown>;

    expect(typeof record['responseTime']).toBe('number');
    expect(record['msg']).toBe('request completed');
    expect((record['res'] as Record<string, unknown>)['statusCode']).toBe(401);
  }, 60_000);

  it('replaces a header sent twice, because there is no correct one to pick', async () => {
    // Node joins repeated headers into `a, b`; the comma and space are outside
    // REQUEST_ID_PATTERN, so the pair is refused rather than half-honoured.
    const before = harness.logLines.length;
    const url = new URL(harness.baseUrl);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(
          `GET /v1/auth/me HTTP/1.1\r\nHost: ${url.host}\r\n` +
            `${REQUEST_ID_HEADER}: first-id\r\n${REQUEST_ID_HEADER}: second-id\r\n` +
            'Connection: close\r\n\r\n',
        );
      });
      let received = '';
      socket.on('data', (chunk) => {
        received += String(chunk);
      });
      socket.on('error', reject);
      socket.on('close', () => {
        resolve(/^x-request-id:\s*(.*)$/im.exec(received)?.[1]?.trim() ?? '');
      });
    });

    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    const logged = harness.logLines.slice(before).join('');
    expect(logged).not.toContain('first-id');
    expect(logged).not.toContain('second-id');
  }, 60_000);
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

/**
 * Story 1.5's half of the same claim, and the reason it is here rather than in
 * `deferred-work.md`.
 *
 * The money gate creates a NEW route by which a date of birth can reach a log
 * line, and it is not one any earlier story had: `MoneyGateGuard` resolves the
 * caller and leaves the whole `User` — `dateOfBirth` included — ON THE REQUEST
 * OBJECT, which is the one object a web framework serialises without being asked.
 * The spec's frozen boundary says "không ngày sinh trong log ở bất kỳ mức nào
 * (AD-15)", and that sentence is about the surface as it is today, not as it was
 * before the guard existed.
 *
 * ## What is already closed structurally, measured rather than assumed
 *
 * Two of the three obvious leak routes cannot fire today, and both were checked by
 * mutation rather than reasoned about:
 *
 * - The caller is stored under a `Symbol`, which `Object.keys` and
 *   `JSON.stringify` skip, so no generic serialisation of that object reaches it.
 * - pino's `req` serialiser in `logging.ts` never sees this object AT ALL.
 *   `pino-http` serialises the raw Node request; the guard attaches to the FASTIFY
 *   request that wraps it. A serialiser rewritten to walk `Object.getOwnPropertySymbols(req)`
 *   and read `.user.dateOfBirth` was tried here and changed nothing — it is looking
 *   at a different object.
 *
 * So the honest description of what this suite catches is narrower than "any
 * serialiser", and saying so is the point: the live route is anything in
 * `apps/api` that reads the resolved caller into a MESSAGE, a metadata object or
 * an error — the value is now in scope for every handler, filter and interceptor
 * that runs after the guard, which it was not before this story. Making the
 * fixture's throw carry the date turns two of the examples below red, which is how
 * that was confirmed to be a live assertion rather than a decorative one.
 *
 * Three requests, chosen because each hands the request object to a different
 * piece of machinery:
 *
 *  1. **Allowed (200).** The guard attached the caller and the handler ran. The
 *     ordinary path, and the one every later money endpoint will take.
 *  2. **Refused (403).** The user has been LOADED — `canReceiveMoney` was asked
 *     about them — but the throw happens before `attachMoneyInCaller`, so the
 *     caller never reaches the request object on this path. What is in scope at the
 *     moment the refusal is built is the local variable inside `canActivate`, which
 *     is the shape a hand-written "helpful" refusal message would leak from, and
 *     the exception layer serialising a request the guard has already read.
 *  3. **Failed (500).** An unhandled throw inside a gated handler, where Nest's own
 *     exception layer writes an error line nobody in this repository wrote. This is
 *     the only one of the three where the logging is out of our hands.
 */
describe('a request through the money gate leaks nothing into a real pino (AD-15)', () => {
  const adult = {
    subject: 'google-subject-money-gate-adult',
    email: 'money.gate.adult@fpt.edu.vn',
    name: 'Money Gate Adult',
    picture: 'https://lh3.googleusercontent.com/a/mga',
  };
  const minor = {
    subject: 'google-subject-money-gate-minor',
    email: 'money.gate.minor@fpt.edu.vn',
    name: 'Money Gate Minor',
    picture: 'https://lh3.googleusercontent.com/a/mgm',
  };

  /**
   * Two REAL dates for the two profiles being logged in, distinctive enough that a
   * substring match cannot hit either by accident — and, more importantly, dates
   * that are actually stored on the users whose requests are being made. A
   * random-looking string that was never written to a row would make every
   * assertion below pass for the wrong reason.
   *
   * The harness clock is fixed at 2026-09-04, so `1988-11-07` is an adult for ever
   * and `2012-04-17` is under eighteen for ever.
   */
  const ADULT_DOB = '1988-11-07';
  const MINOR_DOB = '2012-04-17';

  let harness: AuthHarness;
  let output: string;
  let allowed: Response;
  let refused: Response;
  let failed: Response;

  const declare = (jar: CookieJar, dateOfBirth: string): Promise<Response> =>
    harness.request(AUTH_DATE_OF_BIRTH_PATH, {
      method: 'POST',
      jar,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date_of_birth: dateOfBirth }),
    });

  beforeAll(async () => {
    harness = await createAuthHarness({
      captureLogs: true,
      controllers: [MoneyFixtureController],
    });

    const grownUp = await harness.login('google', adult);
    expect((await declare(grownUp.jar, ADULT_DOB)).status).toBe(200);

    const child = await harness.login('google', minor);
    expect((await declare(child.jar, MINOR_DOB)).status).toBe(200);

    // 1. Allowed: the guard attached the caller, the handler ran.
    allowed = await harness.request(MONEY_FIXTURE_IN_PATH, {
      method: 'POST',
      jar: grownUp.jar,
    });
    // 2. Refused: the 403 is built from a request whose user has been loaded.
    refused = await harness.request(MONEY_FIXTURE_IN_PATH, {
      method: 'POST',
      jar: child.jar,
    });
    // 3. Failed: an unhandled throw, logged by machinery nobody here wrote.
    failed = await harness.request(MONEY_FIXTURE_THROWS_PATH, {
      method: 'POST',
      jar: grownUp.jar,
    });

    output = harness.logLines.join('\n');
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('actually drove all three paths — otherwise every assertion below is vacuous', () => {
    // The golden rule of this file: a "does not contain" test passes perfectly
    // against a run in which nothing happened. These are the assertions that make
    // the rest mean something.
    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(failed.status).toBe(500);
    expect(harness.logLines.length).toBeGreaterThan(0);
    expect(output).toContain(MONEY_FIXTURE_IN_PATH);
    expect(output).toContain(MONEY_FIXTURE_THROWS_PATH);
    // The 500 really was logged as an error, so path 3 exercised the branch it was
    // written for rather than being swallowed somewhere silent.
    expect(output).toContain(MONEY_FIXTURE_FAILURE);
  });

  it('never writes either declared date, on the allowed, refused or failed path', () => {
    expect(output).not.toContain(ADULT_DOB);
    expect(output).not.toContain(MINOR_DOB);
  });

  it('never writes a date-shaped fragment of either year', () => {
    /**
     * A partially-redacted structure leaves the year behind, and a year alone is
     * enough to narrow somebody down.
     *
     * Anchored to a date-SHAPED token rather than asserted as a bare substring:
     * the harness listens on an ephemeral port, and a port like `51988` would
     * otherwise fail this for a reason that has nothing to do with a date of
     * birth. The anchored form still catches every spelling the product could
     * produce, because `User.dateOfBirth` is only ever `YYYY-MM-DD`.
     */
    expect(output).not.toMatch(/\b1988-\d{2}/);
    expect(output).not.toMatch(/\b2012-\d{2}/);
  });

  it('never writes the field name with a value beside it, in either vocabulary', () => {
    // `date_of_birth` on the wire, `dateOfBirth` on the domain type — and it is the
    // camelCase half that this story put on the request object.
    expect(output).not.toMatch(/"date_of_birth"\s*:\s*"/);
    expect(output).not.toMatch(/"dateOfBirth"\s*:\s*"/);
  });

  it('never writes the caller the guard attached, by any of its parts', () => {
    // The rest of the object, not just the date. `User` also carries the email,
    // which is PII under the same release gate, and the symbol's own description
    // is what would appear as a key beside whatever dragged it into a line.
    expect(output).not.toContain('money-in-caller');
    expect(output).not.toContain(adult.email);
    expect(output).not.toContain(minor.email);
  });

  it('still records the paths and the request id, so the log is worth keeping', () => {
    // The redaction has to stop short of making the log useless: without this, the
    // assertions above would pass against a logger that writes nothing at all.
    // The 1.4 suite this mirrors asserts the PATH as well as the id, and the name
    // of this example promised the same thing before it did so.
    expect(output).toContain('request_id');
    expect(output).toContain(MONEY_FIXTURE_IN_PATH);
    expect(output).toContain(MONEY_FIXTURE_THROWS_PATH);
    expect(output).toContain(AUTH_DATE_OF_BIRTH_PATH);
  });
});


/**
 * AD-12 meets AD-15: one attempt, one audit row, and the SAME request id on the
 * log line that attempt wrote.
 *
 * The two halves were each tested and the join between them was not.
 * `auth.flow.test.ts` counts rows and reads their `reason`; `logging.test.ts`
 * greps the log for values that must not be there. Neither asks the question an
 * investigation actually asks — "here is an audit row, show me what that request
 * did" — and that question is answerable only if the id on the row is the id on
 * the line.
 *
 * It is not a theoretical join. `requestIdOf` in `auth.controller.ts` reads three
 * sources in order (the header the logger stamped, `request.raw.id`, then a
 * freshly derived one) precisely because an audit row without a request id is not
 * an audit row — `AuditPort` refuses one. If the first two sources stopped
 * agreeing with the logger, the third would still produce a perfectly valid row
 * that joins to nothing, and every existing test would stay green.
 *
 * `request_id` is also the one field of this story that the allow-list can neither
 * protect nor break: `pino-http` merges it as a CHILD BINDING, and pino replaces a
 * child's bindings formatter with an identity function, so it never passes through
 * `formatters.log` at all. That was measured rather than reasoned about, and this
 * suite is what keeps the measurement true.
 */
describe('every sign-in attempt joins its audit row to its own log line', () => {
  const profile = {
    subject: 'google-subject-audit-join',
    email: 'audit.join@fpt.edu.vn',
    name: 'Audit Join',
    picture: 'https://lh3.googleusercontent.com/a/join',
  };

  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness({ captureLogs: true, enabledProviders: ['google'] });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  /**
   * Drive one attempt and return the rows it wrote plus the lines it wrote.
   *
   * The log slice is taken from the length BEFORE the attempt, so a suite of eight
   * attempts cannot pass because some earlier request happened to carry the id.
   */
  async function attempt(run: () => Promise<unknown>): Promise<{
    rows: readonly { readonly action: string; readonly requestId: string }[];
    lines: Record<string, unknown>[];
  }> {
    harness.audit.clear();
    const before = harness.logLines.length;
    await run();
    /**
     * Wait for the completion line before reading.
     *
     * `pino-http` writes it from the response's `finish` hook, which can fire after
     * the client's promise resolves — so reading `logLines` on the next tick is a
     * race, and the eight examples below would have been eight flaky ones. Polling
     * for the line rather than sleeping a fixed amount keeps a slow CI box honest
     * and a fast one quick.
     */
    for (let waited = 0; waited < 200 && harness.logLines.length === before; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const lines = harness.logLines
      .slice(before)
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { rows: harness.audit.all(), lines };
  }

  /**
   * A `/start` that leaves a signed state cookie in the jar, and its callback URL.
   *
   * Called OUTSIDE `attempt()` by every example, success and failure alike. The
   * failure rows used to call it inside the measured window, which made
   * `expect(rows).toEqual([action])` quietly depend on `/start` writing no audit
   * row — a fact nothing stated and nothing asserted. It is asserted below now, and
   * the window measures one leg either way.
   */
  async function startedLogin(jar: CookieJar): Promise<URL> {
    const started = await harness.request('/v1/auth/google/start', { jar });
    const location = started.headers.get('location');
    // Not `?? ''`: `new URL('')` throws `TypeError: Invalid URL`, which would mask
    // "the start leg did not redirect" behind a failure that names nothing.
    expect(location, `/v1/auth/google/start answered ${started.status} with no Location`).toBeTruthy();
    return new URL(location ?? '');
  }

  function expectJoin(
    rows: readonly { readonly action: string; readonly requestId: string }[],
    lines: Record<string, unknown>[],
    action: string,
  ): void {
    // Before anything is indexed: an emitted-nothing run must say so, rather than
    // failing later with "cannot read 'requestId' of undefined".
    expect(lines.length, 'the attempt wrote no log line at all').toBeGreaterThan(0);
    // Exactly one. Not zero — an outcome that leaves no row is the hardest possible
    // incident to investigate — and not one per internal step, or "how many people
    // signed in today" stops being answerable without reading the implementation.
    expect(rows.map((row) => row.action)).toEqual([action]);

    const requestId = rows[0]?.requestId ?? '';
    expect(requestId.length).toBeGreaterThan(0);

    // And the id really is on a line this request wrote, rather than being a
    // plausible-looking string the controller invented for the row.
    const joined = lines.filter((line) => line['request_id'] === requestId);
    expect(joined.length, `no log line carries request_id ${requestId}`).toBeGreaterThan(0);
  }

  it('joins a successful sign-in', async () => {
    const jar = new CookieJar();
    const authorizeUrl = await startedLogin(jar);
    const authorized = harness.fake.authorize(authorizeUrl.toString(), profile);

    const { rows, lines } = await attempt(() => harness.request(authorized.callbackUrl, { jar }));

    expectJoin(rows, lines, 'auth.signed_in');
  }, 60_000);

  /**
   * Each row prepares OUTSIDE the measured window and then makes exactly one
   * request inside it, the same shape as the success case above.
   *
   * `prepare` returns the jar and the callback query; `run` makes the one request
   * that is supposed to produce one row. Mixing the two — preparation inside the
   * window for some rows and outside it for others — is what made the count
   * assertion depend on an unstated fact.
   */
  it.each([
    [
      'a callback with no state cookie at all',
      null,
      () => '/v1/auth/google/callback?code=nope&state=nope',
    ],
    [
      'a callback whose state does not match a signed one',
      'start' as const,
      () => '/v1/auth/google/callback?code=nope&state=not-the-one',
    ],
    [
      'a callback carrying a state but no code',
      'start' as const,
      (state: string) => `/v1/auth/google/callback?state=${state}`,
    ],
    [
      'a person cancelling at the consent screen',
      'start' as const,
      (state: string) => `/v1/auth/google/callback?state=${state}&error=access_denied`,
    ],
    [
      'the provider itself refusing before a code was ever issued',
      'start' as const,
      (state: string) => `/v1/auth/google/callback?state=${state}&error=server_error`,
    ],
    ['a refresh presented with no cookie', null, () => '/v1/auth/refresh'],
    ['a refresh token nobody ever issued', 'refresh-cookie' as const, () => '/v1/auth/refresh'],
  ])('joins %s', async (_label, prepare, path) => {
    const jar = new CookieJar();
    let state = '';
    if (prepare === 'start') {
      state = (await startedLogin(jar)).searchParams.get('state') ?? '';
    }
    if (prepare === 'refresh-cookie') {
      jar.set(REFRESH_COOKIE_NAME, 'not-a-token-we-ever-minted', AUTH_COOKIE_PATH);
    }
    const target = path(state);

    const { rows, lines } = await attempt(() =>
      harness.request(target, target.includes('/refresh') ? { method: 'POST', jar } : { jar }),
    );

    expectJoin(rows, lines, 'auth.sign_in_failed');
  }, 60_000);

  it('and the start leg really does write no row, which the counts above assume', async () => {
    // The unstated fact the `toEqual([action])` assertions rest on. If `/start`
    // ever gained an audit row, every example in this suite would fail with "two
    // rows" and name nothing about why — so it is asserted once, here.
    const { rows, lines } = await attempt(() => startedLogin(new CookieJar()));

    expect(rows).toEqual([]);
    // …and the leg really happened, so this is not a claim about a request that
    // never went out. A "no rows" assertion is perfectly satisfied by a request
    // nobody made.
    expect(
      lines.some(
        (line) =>
          String((line['req'] as Record<string, unknown> | undefined)?.['url'] ?? '').startsWith(
            '/v1/auth/google/start',
          ),
      ),
    ).toBe(true);
  }, 60_000);

  it('writes no PII into the rows it just joined', async () => {
    // The join is only worth having if the thing being joined is safe to keep for
    // ever: `audit_events` holds no DELETE grant for any role (AD-12).
    const jar = new CookieJar();
    const authorizeUrl = await startedLogin(jar);
    const authorized = harness.fake.authorize(authorizeUrl.toString(), profile);

    const { rows } = await attempt(() => harness.request(authorized.callbackUrl, { jar }));

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(profile.email);
    expect(serialised).not.toContain(profile.subject);
  }, 60_000);
});
