import { loggerBaseOptions } from '@stuwith/config';
import type { ApiEnv } from '@stuwith/config';
import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

/**
 * Structured JSON, one line per event, `request_id` carried across both processes
 * (spine, "Logging"). The redaction list itself lives in packages/config so the two
 * processes cannot drift apart on what counts as PII (AD-15).
 */
export function buildLoggerParams(config: ApiEnv): Params {
  const base = loggerBaseOptions({
    level: config.LOG_LEVEL,
    service: 'api',
    version: config.APP_VERSION,
  });

  return {
    pinoHttp: {
      level: base.level,
      base: { service: base.base.service, version: base.base.version },
      redact: { paths: [...base.redactPaths], remove: true },
      genReqId: (req, res) => {
        const incoming = req.headers[base.requestIdHeader];
        const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
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
