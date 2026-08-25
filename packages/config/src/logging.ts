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

/**
 * An inbound `x-request-id` is attacker-controlled text. It ends up stamped on
 * every log line for the request and echoed back in a response header, so an
 * unvalidated value buys two things at once:
 *
 *  - **log forging.** A newline lets the caller inject whole fake log records;
 *    ANSI escapes and control characters corrupt terminals and log viewers.
 *  - **unbounded log growth.** A 10 MB header multiplies by the number of lines
 *    the request produces, in a log the caller does not pay for.
 *
 * So the id is accepted only when it already looks like an id. Anything else is
 * silently replaced with a fresh one — dropping a malformed correlation id costs
 * a trace; trusting it costs the log.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/** Conservative on purpose: UUIDs, ULIDs, and hyphenated trace ids all fit. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function isAcceptableRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= REQUEST_ID_MAX_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

/**
 * Single decision point for both processes: reuse the caller's id when it is
 * well-formed, otherwise mint one. `generate` is injected so the caller supplies
 * the randomness source (packages/config imports no Node builtin).
 */
export function resolveRequestId(incoming: unknown, generate: () => string): string {
  return isAcceptableRequestId(incoming) ? incoming : generate();
}

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
