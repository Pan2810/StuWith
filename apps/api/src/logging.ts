import { loggerBaseOptions, resolveRequestId, sanitizeLoggedUrl } from '@stuwith/config';
import type { ApiEnv } from '@stuwith/config';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { DestinationStream } from 'pino';
import { randomUUID } from 'node:crypto';

/**
 * Structured JSON, one line per event, `request_id` carried across both processes
 * (spine, "Logging"). The redaction list itself lives in packages/config so the two
 * processes cannot drift apart on what counts as PII (AD-15).
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
    redact: { paths: [...base.redactPaths], remove: true },
    // An inbound request id is only reused when it already looks like an id
    // (see resolveRequestId in packages/config): otherwise a caller could inject
    // newlines into every log line this request produces, or hand us a
    // megabyte-long correlation id and have it repeated on each one. The value
    // echoed back in the response header is always the sanitised one.
    genReqId: (req, res) => {
      const requestId = resolveRequestId(req.headers[base.requestIdHeader], randomUUID);
      res.setHeader(base.requestIdHeader, requestId);
      return requestId;
    },
    customProps: (req) => ({ request_id: req.id }),
    // Whitelist, not deny-list: only these request/response fields are ever
    // serialised. A field added to a payload later is NOT logged by default.
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        // The query string is dropped, not filtered. `/v1/auth/google/callback`
        // arrives as `?code=...&state=...`, and a `redact` path cannot reach
        // inside a string — so the only way those values never reach a log line
        // is for the string never to contain them.
        url: sanitizeLoggedUrl(req.url),
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };

  // The tuple form is pino-http's own "write to this stream" signature. It exists
  // here so a test can read the lines this exact configuration produced, rather
  // than the lines a logger the test built itself would have produced — the whole
  // point of the AD-15 assertion is that the WIRING does not leak.
  return { pinoHttp: destination === undefined ? options : [options, destination] };
}
