import type { LogLevel } from './schema';

/**
 * AD-15 — PII never reaches a log line.
 *
 * The list lives here, once, because both processes log and two copies of a
 * redaction list drift the moment one of them gains a field. Story 1.7 replaces
 * this deny-list with the whitelist serializer the spine actually mandates ("only
 * ids and declared fields get written; a newly added payload field defaults to NOT
 * being logged"). Until then this is the floor, not the finished control.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'req.body.email',
  'req.body.password',
  'req.body.date_of_birth',
  'req.body.dateOfBirth',
  'req.body.token',
  'req.body.access_token',
  'req.body.id_token',
  'req.body.provider_id',
  'req.body.message',
  '*.email',
  '*.date_of_birth',
  '*.access_token',
  '*.refresh_token',
  '*.provider_id',
];

/** Header carrying the request id across both processes (spine, "Logging"). */
export const REQUEST_ID_HEADER = 'x-request-id';

export interface LoggerBaseOptions {
  readonly level: LogLevel;
  readonly redactPaths: readonly string[];
  readonly requestIdHeader: string;
  readonly base: { readonly service: string; readonly version: string };
}

export function loggerBaseOptions(input: {
  level: LogLevel;
  service: string;
  version: string;
}): LoggerBaseOptions {
  return {
    level: input.level,
    redactPaths: LOG_REDACT_PATHS,
    requestIdHeader: REQUEST_ID_HEADER,
    base: { service: input.service, version: input.version },
  };
}
