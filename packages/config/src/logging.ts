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

  // ── Story 1.2, the OAuth handshake ────────────────────────────────────────
  //
  // Everything below is a value that, on its own, is enough to take over an
  // account or to identify a person. An authorization `code` can be exchanged for
  // tokens; `state` and `code_verifier` are what stop somebody else exchanging it;
  // an `id_token` carries the email and the provider subject in its payload.
  'req.query.code',
  'req.query.state',
  'req.body.code',
  'req.body.state',
  'req.body.code_verifier',
  'req.body.refresh_token',
  '*.code_verifier',
  '*.codeVerifier',
  '*.id_token',
  '*.idToken',
  '*.client_secret',
  '*.clientSecret',
  '*.session_token',
  '*.sessionToken',
  '*.provider_user_id',
  '*.providerUserId',
  '*.oauth_state',
  '*.authorization_code',
  '*.state',
];

/**
 * A bare `*.code` is deliberately NOT in the list above, and the omission is a
 * decision rather than an oversight.
 *
 * pino's one-level wildcard would match `err.code` — the Postgres SQLSTATE, the
 * Node errno, the HTTP status class — and deleting those makes every production
 * incident harder to read while protecting nothing that the specific paths above
 * do not already cover. The place an OAuth `code` would actually have reached a
 * log line is the request URL (`/v1/auth/google/callback?code=...&state=...`), and
 * a redaction path cannot reach inside a string. That leak is closed structurally
 * instead, by {@link sanitizeLoggedUrl}, which both processes put in front of
 * `req.url`.
 */
export const REDACTION_NOTES = {
  bareCodeExcluded:
    'req.query.code + sanitizeLoggedUrl cover the OAuth code; a bare *.code would delete err.code',
} as const;

/**
 * The path of a request URL, with the query string dropped entirely.
 *
 * Not "the query string with sensitive parameters removed": an allow-list of safe
 * parameters is a list that stops being complete the first time somebody adds an
 * endpoint, and the values at risk here (`code`, `state`, `id_token`) are exactly
 * the ones an incident makes you want to log. The path alone identifies the
 * endpoint, which is what a log line needs; the request id ties it to everything
 * else.
 *
 * The `?` is kept as a marker so a reader can tell "this request had no query"
 * from "the query was dropped" — a distinction that matters when the bug IS the
 * missing parameter.
 */
export function sanitizeLoggedUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') {
    return '';
  }
  const queryStart = rawUrl.indexOf('?');
  const fragmentStart = rawUrl.indexOf('#');
  if (queryStart === -1 && fragmentStart === -1) {
    return rawUrl;
  }
  const cut =
    queryStart === -1
      ? fragmentStart
      : fragmentStart === -1
        ? queryStart
        : Math.min(queryStart, fragmentStart);
  return `${rawUrl.slice(0, cut)}?<redacted>`;
}

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
