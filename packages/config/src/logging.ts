import { REQUEST_ID_HEADER } from '@stuwith/contracts';
import { LOG_ALLOWED_FIELDS } from './log-fields';
import { filterLoggedFields, serializeLoggedError } from './log-filter';
import type { LogLevel } from './schema';

/**
 * AD-15 — PII never reaches a log line.
 *
 * ## This list is no longer the control. It is the belt behind it.
 *
 * Story 1.7 replaced the mechanism: the allow-list in `log-fields.ts`, applied at
 * `formatters.log` by `log-filter.ts`, is what decides whether a field is written.
 * A field nobody declared is absent because it was never declared — which is the
 * property the spine mandates and the property a deny-list can never have.
 *
 * This array stays wired anyway, for one measured reason rather than out of
 * caution. pino stitches CHILD bindings into a line without passing them through
 * either formatter (`asChindings` replaces a child's bindings formatter with an
 * identity function), and `pino-http` puts `req` and its `customProps` there. Those
 * bindings DO go through `redact`'s stringifiers. So the belt still covers ground
 * the allow-list cannot reach, and it is not a rule nobody runs.
 *
 * Removing it entirely is a decision for a human, not for whoever next tidies this
 * file: `formatters.log` runs BEFORE `redact`, so the two are ordered rather than
 * redundant, and `logging.test.ts` pins that order rather than assuming it.
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
  /**
   * The same decision, carried into the mechanism that replaced the deny-list.
   *
   * Turning the rule round could have dropped `err.code` silently — an allow-list
   * that simply forgot to declare it would look tidy and delete the field every
   * incident starts from. `LOG_ALLOWED_ERROR_FIELDS` names it explicitly, and both
   * apps' tests assert it survives a real pino.
   */
  errorCodeDeclared:
    'err.code is declared in LOG_ALLOWED_ERROR_FIELDS, so the diagnostic field survives the allow-list',
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

/**
 * Header carrying the request id across both processes (spine, "Logging").
 *
 * Re-exported rather than declared, so there is exactly one spelling of it in the
 * repo. It used to be a second literal here, and a second literal is how the
 * echo (`http-setup.ts`) and the CORS exposure list (`BROWSER_READABLE_RESPONSE_HEADERS`)
 * could have drifted apart with nothing failing — which is the shape of the bug
 * `Retry-After` actually hit.
 *
 * The direction is legal: `packages/config` already depends on
 * `@stuwith/contracts`, and `ad13-contracts-stay-standalone` forbids only the
 * reverse.
 */
export { REQUEST_ID_HEADER };

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
 *
 * ## This became TRUE in Story 1.7. It was a description of an intention before.
 *
 * The paragraph above says the value is stamped on every log line and echoed in a
 * response header. Neither happened between Story 1.1 and Story 1.7, and nothing
 * said so: the caller was `genReqId` in each app's `logging.ts`, handed to
 * `pino-http`, which writes `req.id = req.id || genReqId(req, res)` — and Fastify
 * had already assigned an id before any middleware ran, so the branch never
 * executed. This function, the most heavily tested one in this package, had never
 * run on a real request; every line carried Fastify's `req-1`, `req-2` counter,
 * which BOTH processes mint independently and therefore collide on.
 *
 * The caller is now Fastify's own `genReqId`, in each app's `http-setup.ts`, which
 * is the single place Fastify asks. Do not re-implement it per app, and do not put
 * one back in the pino options: that would be a second decision point that never
 * executes. `apps/api/src/logging.test.ts` drives hostile headers through a real
 * HTTP request rather than through this function alone, because the difference
 * between the two is exactly what went unnoticed for six stories.
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

/**
 * Everything both processes need to build an identical logger, declared once.
 *
 * The two apps' `logging.ts` files are near-identical by design; anything they
 * would otherwise each spell out belongs here, because two copies of a PII policy
 * drift the moment one of them gains a field. That is not a hypothetical — it is
 * the argument that moved the redaction list here in the first place.
 */
export interface LoggerBaseOptions {
  readonly level: LogLevel;
  /**
   * The belt, not the control. See {@link LOG_REDACT_PATHS}; it is still handed
   * out because child bindings never reach `formatters.log`.
   */
  readonly redactPaths: readonly string[];
  /** The declared field names, exposed so a test can assert against the policy. */
  readonly allowedFields: readonly string[];
  /**
   * `formatters.log`. The allow-list itself, and the reason a field nobody
   * declared is absent from a log line without anybody editing anything.
   */
  readonly logFormatter: (object: Record<string, unknown>) => Record<string, unknown>;
  /**
   * `serializers.err`. pino's default walks every enumerable own property of a
   * thrown object, which is the one route this repository was measurably leaking
   * through.
   */
  readonly errorSerializer: (value: unknown) => Record<string, unknown>;
  readonly requestIdHeader: string;
  readonly base: { readonly service: string; readonly version: string };
}

/**
 * The wiring both processes must have, as an assertion both processes can run.
 *
 * `apps/realtime-gateway/src/logging.test.ts` had an example named "is the same
 * wiring as apps/api, field for field" that compared the gateway to nothing at
 * all — it asserted the gateway's own key names, so the two files could drift and
 * both stay green while each described itself.
 *
 * The answer is not a third copy of the expectations: it is one function, here,
 * beside the policy it is about. A `pinoHttp` options object either satisfies it
 * or does not, and both apps' tests call it with their own.
 *
 * It returns problems rather than throwing, so a failing test names every
 * difference at once instead of the first one.
 */
export function loggerWiringProblems(options: {
  formatters?: { log?: unknown } | undefined;
  serializers?: Record<string, unknown> | undefined;
  redact?: unknown;
  genReqId?: unknown;
  customProps?: unknown;
}): readonly string[] {
  const problems: string[] = [];

  if (typeof options.formatters?.log !== 'function') {
    problems.push('formatters.log is missing — the allow-list is not applied at all');
  }
  const serializers = Object.keys(options.serializers ?? {}).sort();
  if (serializers.join(',') !== 'err,req,res') {
    problems.push(`serializers must be exactly err, req, res — found ${serializers.join(', ')}`);
  }
  const redact = options.redact as { paths?: unknown; remove?: unknown } | undefined;
  if (!Array.isArray(redact?.paths) || redact.paths.length === 0) {
    problems.push('the deny-list belt is not wired');
  }
  if (redact?.remove !== true) {
    problems.push('redact must REMOVE rather than mask: "[Redacted]" still discloses presence');
  }
  if (typeof options.customProps !== 'function') {
    problems.push('customProps is missing — request_id would never reach a line');
  }
  if (options.genReqId !== undefined) {
    // The regression that hid for six stories. `pino-http` writes
    // `req.id = req.id || genReqId(...)` and Fastify has already set `req.id`, so
    // a `genReqId` here is a decision point that never executes. It belongs to
    // Fastify, in each app's `http-setup.ts`.
    problems.push('genReqId must live on the Fastify adapter, not in the pino options');
  }
  return problems;
}

export function loggerBaseOptions(input: {
  level: LogLevel;
  service: string;
  version: string;
}): LoggerBaseOptions {
  return {
    level: input.level,
    redactPaths: LOG_REDACT_PATHS,
    allowedFields: LOG_ALLOWED_FIELDS,
    logFormatter: filterLoggedFields,
    errorSerializer: serializeLoggedError,
    requestIdHeader: REQUEST_ID_HEADER,
    base: { service: input.service, version: input.version },
  };
}
