import { loggedScalar, loggerBaseOptions, sanitizeLoggedUrl } from '@stuwith/config';
import type { RealtimeGatewayEnv } from '@stuwith/config';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { DestinationStream } from 'pino';

/**
 * Structured JSON, one line per event, `request_id` carried across both processes
 * (spine, "Logging"). The policy itself lives in packages/config so the two
 * processes cannot drift apart on what counts as PII (AD-15); this file is the
 * WIRING, and it is deliberately byte-for-byte the same decision as `apps/api`'s.
 *
 * A shared policy enforced in one of two processes is not a policy, and this is
 * the process that will carry room tokens and chat.
 */
export function buildLoggerParams(
  config: RealtimeGatewayEnv,
  destination?: DestinationStream,
): Params {
  const base = loggerBaseOptions({
    level: config.LOG_LEVEL,
    service: 'realtime-gateway',
    version: config.APP_VERSION,
  });

  const options: Options = {
    level: base.level,
    base: { service: base.base.service, version: base.base.version },
    /**
     * The allow-list (AD-15). See `apps/api/src/logging.ts` for the argument;
     * both processes read the same declaration out of `packages/config`, because
     * two copies of a PII policy drift the moment one of them gains a field.
     */
    formatters: { log: base.logFormatter },
    /** The belt behind it — child bindings never reach `formatters.log`. */
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
        // Query string dropped, not filtered — see `sanitizeLoggedUrl` in
        // packages/config for why. Both processes use it so the rule cannot
        // hold in one and not the other.
        url: sanitizeLoggedUrl(req.url),
      }),
      res: (res: { statusCode: unknown }) => ({ statusCode: loggedScalar(res.statusCode) }),
      /** pino's default walks every own property of a thrown object; this does not. */
      err: base.errorSerializer,
    },
  };

  /**
   * The destination seam `apps/api` has had since Story 1.2, added here for the
   * same reason.
   *
   * Without it a test can only inspect the OPTIONS this file returns and then
   * build its own logger, which proves what a logger the test wired up does — not
   * what this configuration does. With it, the tuple form is pino-http's own
   * "write to this stream" signature and the lines under assertion are the lines
   * this exact configuration produced.
   */
  return { pinoHttp: destination === undefined ? options : [options, destination] };
}
