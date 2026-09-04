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
  'req.body.accessToken',
  'req.body.id_token',
  'req.body.idToken',
  'req.body.provider_id',
  'req.body.providerId',
  'req.body.message',
  '*.email',
  '*.date_of_birth',
  /**
   * The camelCase half, and it was a real hole rather than symmetry.
   *
   * `*.date_of_birth` covered the WIRE spelling — the field name in a request
   * body — while `User` in `packages/domain` carries `dateOfBirth`, and that is
   * the object anything in `apps/api` would actually log. A single
   * `logger.info({ user })` therefore wrote a date of birth to disk, past a
   * redaction list that named the field twice in the wrong case.
   *
   * Every other pair in this list already comes in both spellings
   * (`code_verifier`/`codeVerifier`, `id_token`/`idToken`) for exactly this
   * reason; this one was missed when the domain type was written.
   */
  '*.dateOfBirth',
  '*.access_token',
  '*.refresh_token',
  '*.provider_id',
  /**
   * The other three halves of the same hole, closed at the same time.
   *
   * `*.dateOfBirth` was the one Story 1.4 went looking for, and finding it made
   * the shape obvious: every value here crosses two vocabularies — snake_case on
   * the wire, camelCase on the `packages/domain` types — and a list naming only
   * one spelling protects only one of them. The handshake fields added in Story
   * 1.2 already come in pairs (`code_verifier`/`codeVerifier`,
   * `id_token`/`idToken`); these three predate that convention and were left
   * behind by it.
   *
   * Patching only the reported example is the failure mode `AGENTS.md` records at
   * length for the trusted-proxy list. `logging.test.ts` asserts the pairing by
   * WALKING THIS ARRAY — for every path whose last segment is snake_case there
   * must be a sibling path with the camelCase spelling and the same prefix, and
   * the other way round — so a fifth field added in one spelling fails there. The
   * previous version of that test iterated a hand-written list of four field
   * names, which is a list of examples wearing the words "as a rule over the set";
   * it was green while `*.oauth_state`, `*.authorization_code` and three
   * `req.body.*` entries had no camelCase half at all.
   */
  '*.accessToken',
  '*.refreshToken',
  '*.providerId',

  /**
   * Two levels down, for the ONE shape Story 1.4 introduced.
   *
   * pino's `*` wildcard matches exactly one level, so `*.dateOfBirth` covers
   * `{ user: { dateOfBirth } }` and nothing deeper. `RecordDateOfBirthResult` is
   * `{ ok: true, user: User }`, so a single `logger.info({ outcome })` in
   * `apps/api` would put the date of birth two levels down — past every path
   * above. Nothing logs it today; the point is that the new return type made the
   * dangerous shape expressible, and one named path is cheaper than trusting that
   * nobody ever writes that line. The general answer is Story 1.7's whitelist
   * serializer, and `deferred-work.md` records the remaining depth.
   */
  '*.user.date_of_birth',
  '*.user.dateOfBirth',

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
  'req.body.codeVerifier',
  'req.body.refresh_token',
  'req.body.refreshToken',
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
  '*.oauthState',
  '*.authorization_code',
  '*.authorizationCode',
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
