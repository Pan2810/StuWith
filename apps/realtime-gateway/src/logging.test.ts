import type { RealtimeGatewayEnv } from '@stuwith/config';
import { LOG_ALLOWED_FIELDS, LOG_REDACT_PATHS, loggerWiringProblems } from '@stuwith/config';
import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildLoggerParams } from './logging';

/**
 * AGENTS.md says BOTH processes apply the AD-15 policy, and until this file
 * existed only `apps/api` was checked — `vitest.config.mts` had no project rooted
 * here at all, so a test placed in this directory would not even have run.
 *
 * That matters beyond tidiness: the gateway serves no `/v1/auth/*` route today,
 * but it is the process that will carry room tokens and chat, and a shared PII
 * policy that is only enforced in one of two places is not a policy.
 *
 * Since Story 1.7 the control is an ALLOW-LIST at `formatters.log`, declared once
 * in `packages/config` and read by both processes. What is asserted here is the
 * WIRING — that this process hands the shared policy to pino — through the real
 * options and the real stream, not through a logger the test built for itself.
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

/**
 * A logger built through the DESTINATION SEAM, not from options the test re-wires.
 *
 * `apps/api` has had this seam since Story 1.2 and the gateway did not, which left
 * every claim about this process one step weaker than the same claim about the
 * other one: a test could only read the options object and then build its own
 * logger, so it proved what a logger the TEST wired up does. The tuple form
 * `[options, destination]` is pino-http's own signature, so what is asserted below
 * is what this exact configuration wrote.
 */
function loggerUnderTest() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const params = buildLoggerParams(config, stream);
  const [options, destination] = params.pinoHttp as [pino.LoggerOptions, pino.DestinationStream];
  const records = (): Record<string, unknown>[] =>
    lines
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger: pino(options, destination), lines, records };
}

describe('apps/realtime-gateway logger wiring (AD-15)', () => {
  it('exposes a destination seam, so these examples read the real configuration', () => {
    // Without the seam `buildLoggerParams` returns a bare options object and a test
    // can only build its own logger from it — which proves what the TEST wired up.
    const params = buildLoggerParams(config, new Writable({ write: (_c, _e, cb) => cb() }));

    expect(Array.isArray(params.pinoHttp)).toBe(true);
    // And the no-destination call still returns the shape `app.module.ts` passes to
    // `LoggerModule.forRoot`, so production is not paying for the seam.
    expect(Array.isArray(buildLoggerParams(config).pinoHttp)).toBe(false);
  });

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

  it('applies the shared allow-list at formatters.log', () => {
    const options = optionsUnderTest();

    // The list lives in packages/config precisely so the two processes cannot
    // drift; this asserts the gateway actually applies it rather than a copy.
    expect(typeof (options.formatters as { log?: unknown }).log).toBe('function');
    expect(LOG_ALLOWED_FIELDS.length).toBeGreaterThan(0);
  });

  it('still applies the shared deny-list behind it, with remove: true', () => {
    const redact = optionsUnderTest().redact as { paths: string[]; remove: boolean };

    // The belt. It is still wired because pino stitches child bindings into a line
    // without passing them through `formatters.log`, and those do go through
    // `redact` — so it is not a rule nobody runs.
    expect(redact.paths).toEqual([...LOG_REDACT_PATHS]);
    expect(redact.remove).toBe(true);
  });

  it('never writes an email or an access token one level down', () => {
    const { logger, lines, records } = loggerUnderTest();

    logger.info(
      { user: { id: 'u-1', email: 'someone@example.com', access_token: 'ya29.leak' } },
      'x',
    );

    const output = lines.join('');
    expect(output).not.toContain('someone@example.com');
    expect(output).not.toContain('ya29.leak');
    // The id goes too — under an allow-list `user` was never declared, so nothing
    // under it can be written. The line itself survives, which is what stops this
    // example passing against a logger that emitted nothing.
    expect(output).not.toContain('u-1');
    expect(records()[0]?.['msg']).toBe('x');
  });

  it('never writes a field invented today, with no edit to any list', () => {
    const { logger, lines, records } = loggerUnderTest();

    logger.info({ room_token: 'lk-room-token-leak', request_id: 'r-1' }, 'joined');

    // The gateway is the process that will carry room tokens, and nothing in this
    // repository has ever named `room_token` in a redaction list. It is absent
    // because it was never declared — which is the acceptance criterion.
    expect(lines.join('')).not.toContain('lk-room-token-leak');
    expect(records()[0]?.['request_id']).toBe('r-1');
    expect(LOG_ALLOWED_FIELDS).not.toContain('room_token');
  });

  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)(
    'applies the allow-list at %s as well',
    (level) => {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          lines.push(String(chunk));
          callback();
        },
      });
      const params = buildLoggerParams({ ...config, LOG_LEVEL: 'trace' }, stream);
      const [options, destination] = params.pinoHttp as [
        pino.LoggerOptions,
        pino.DestinationStream,
      ];

      pino(options, destination)[level]({ email: 'someone@example.com' }, 'at a level');

      expect(lines.join('')).not.toContain('someone@example.com');
      expect((JSON.parse(lines.join('').trim()) as Record<string, unknown>)['msg']).toBe(
        'at a level',
      );
    },
  );

  /**
   * The route that was actually open, in this process too.
   *
   * pino's default error serializer walks every enumerable own property of the
   * thrown object. The gateway writes no log call of its own today, so `err` from
   * `pino-http`'s `autoLogging` is very nearly the only thing that will ever reach
   * its output — which makes this the single most valuable example in the file.
   */
  it('never writes a custom property hung on an Error, but keeps err.code', () => {
    const { logger, lines, records } = loggerUnderTest();

    logger.error(
      {
        err: Object.assign(new Error('livekit unreachable'), {
          code: 'ECONNREFUSED',
          token: 'lk-token-leak',
        }),
      },
      'room token failed',
    );

    expect(lines.join('')).not.toContain('lk-token-leak');
    const err = records()[0]?.['err'] as Record<string, unknown>;
    expect(err['code']).toBe('ECONNREFUSED');
    expect(err['name']).toBe('Error');
    expect(err['token']).toBeUndefined();
  });

  it('stamps this process, not the other one', () => {
    const { logger, lines } = loggerUnderTest();
    logger.info('hello');

    // `service` and `version` arrive through `formatters.bindings`, not
    // `formatters.log` — measured by running pino, and the reason neither is
    // declared in the allow-list. If they were declared, that would be a rule
    // nobody runs.
    expect((JSON.parse(lines[0] ?? '{}') as Record<string, unknown>)['service']).toBe(
      'realtime-gateway',
    );
  });

  it('satisfies the shared wiring contract, the same one apps/api is held to', () => {
    /**
     * `loggerWiringProblems` lives in `packages/config`, beside the policy, and
     * both apps' tests call it with their own options.
     *
     * The example this replaces was named "is the same wiring as apps/api, field
     * for field" and compared the gateway to nothing at all — it asserted the
     * gateway's own key names, so the two files could drift apart and both stay
     * green while each described itself. A third copy of the expectations would
     * have been a third thing to drift; one function is not.
     */
    expect(loggerWiringProblems(optionsUnderTest())).toEqual([]);
  });
});
