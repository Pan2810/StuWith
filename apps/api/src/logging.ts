import { loggedScalar, loggerBaseOptions, sanitizeLoggedUrl } from '@stuwith/config';
import type { ApiEnv } from '@stuwith/config';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { DestinationStream } from 'pino';

/**
 * Structured JSON, one line per event, `request_id` carried across both processes
 * (spine, "Logging"). The policy itself lives in packages/config so the two
 * processes cannot drift apart on what counts as PII (AD-15); this file is the
 * WIRING, and the two are separate failures — a perfect allow-list protects
 * nothing if this file stops handing it to pino.
 */
export function buildLoggerParams(config: ApiEnv, destination?: DestinationStream): Params {
  const base = loggerBaseOptions({
    level: config.LOG_LEVEL,
    service: 'api',
    version: config.APP_VERSION,
  });

  const options: Options = {
    level: base.level,
    base: { service: base.base.service, version: base.base.version },
    /**
     * The allow-list (AD-15), and the whole of Story 1.7's control.
     *
     * `formatters.log` receives the merged object of EVERY line, so a field
     * nobody declared in `packages/config` is absent without anybody editing a
     * list — which is the property the spine mandates and the property the
     * deny-list below can never have. It has to be `formatters.log` rather than
     * `serializers`: a serializer is keyed by field name, so an undeclared field
     * has no serializer to call and sails straight through.
     */
    formatters: { log: base.logFormatter },
    /**
     * The belt behind the allow-list, kept deliberately.
     *
     * pino stitches child bindings — `req` and `customProps` here — into a line
     * WITHOUT passing them through `formatters.log`, and they do go through
     * `redact`. So this is not a rule nobody runs. Order matters and is pinned by
     * a test rather than assumed: `formatters.log` runs first, `serializers`
     * second, `redact` last.
     */
    redact: { paths: [...base.redactPaths], remove: true },
    /**
     * NO `genReqId` here, and its absence is the fix rather than an omission.
     *
     * It lived here until Story 1.7 and never ran once: `pino-http` writes
     * `req.id = req.id || genReqId(req, res)`, and Fastify has already assigned an
     * id by the time any middleware executes, so the `||` short-circuited on every
     * request since Story 1.1. An inbound `x-request-id` was therefore never
     * honoured, and every line carried Fastify's sequential counter — which BOTH
     * processes mint independently, so two unrelated requests collided on one id.
     *
     * Fastify now asks `resolveRequestId` itself, in `http-setup.ts`, and
     * `req.id` below is that answer. Putting a `genReqId` back here would be a
     * second decision point that never executes.
     */
    customProps: (req) => ({ request_id: req.id }),
    // Whitelist, not deny-list: only these request/response fields are ever
    // serialised. A field added to a payload later is NOT logged by default.
    serializers: {
      req: (req: { id: unknown; method: unknown; url: unknown }) => ({
        // `loggedScalar`, not `req.id` — these serializers were allow-lists over
        // field NAMES and not over field VALUES, so `logger.info({ req: { id:
        // someObject } })` reached the output through a key nobody had filtered.
        id: loggedScalar(req.id),
        method: loggedScalar(req.method),
        // The query string is dropped, not filtered. `/v1/auth/google/callback`
        // arrives as `?code=...&state=...`, and a `redact` path cannot reach
        // inside a string — so the only way those values never reach a log line
        // is for the string never to contain them.
        url: sanitizeLoggedUrl(req.url),
      }),
      res: (res: { statusCode: unknown }) => ({ statusCode: loggedScalar(res.statusCode) }),
      /**
       * The route that was actually open. pino's default error serializer copies
       * every enumerable own property of the thrown object, so an `Error` carrying
       * `error.token` or a whole provider response wrote it verbatim. This one
       * reads four declared names and nothing else — `err.code` among them,
       * because that is where an incident starts.
       */
      err: base.errorSerializer,
    },
  };

  // The tuple form is pino-http's own "write to this stream" signature. It exists
  // here so a test can read the lines this exact configuration produced, rather
  // than the lines a logger the test built itself would have produced — the whole
  // point of the AD-15 assertion is that the WIRING does not leak.
  return { pinoHttp: destination === undefined ? options : [options, destination] };
}
