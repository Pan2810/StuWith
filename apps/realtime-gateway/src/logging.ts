import { loggerBaseOptions, resolveRequestId } from '@stuwith/config';
import type { RealtimeGatewayEnv } from '@stuwith/config';
import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

/**
 * Structured JSON, one line per event, `request_id` carried across both processes
 * (spine, "Logging"). The redaction list itself lives in packages/config so the two
 * processes cannot drift apart on what counts as PII (AD-15).
 */
export function buildLoggerParams(config: RealtimeGatewayEnv): Params {
  const base = loggerBaseOptions({
    level: config.LOG_LEVEL,
    service: 'realtime-gateway',
    version: config.APP_VERSION,
  });

  return {
    pinoHttp: {
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
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
