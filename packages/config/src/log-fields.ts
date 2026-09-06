/**
 * AD-15, the control itself: the fields a log line is ALLOWED to carry.
 *
 * ## Why this file replaces a deny-list, and why that deletes a whole class of bug
 *
 * `LOG_REDACT_PATHS` in `logging.ts` names the fields that must never be written.
 * Its default is the wrong way round — a field is written unless somebody
 * remembered to name it — and that default leaked twice for the same reason. Every
 * value in this product exists in two vocabularies: snake_case on the wire,
 * camelCase on the `packages/domain` types. A list naming one spelling protects one
 * of them. `date_of_birth` was named and `dateOfBirth` was not, so a single
 * `logger.info({ user })` wrote a date of birth to disk past a list that mentioned
 * the field twice. Three more pairs were found missing their camelCase half in the
 * round after that.
 *
 * `logging.test.ts` grew a rule that walked the deny-list demanding both spellings
 * of every path. That rule was correct and it is not inherited here — **and its
 * absence is the achievement of this story, not a gap in it**. With an allow-list
 * `dateOfBirth` never reaches a log line because it was never DECLARED, not
 * because somebody remembered to forbid it. The pairing problem does not get a
 * better rule; it stops existing. So does the "field added later" problem: a
 * `national_id` invented tomorrow is absent from every log line with no edit to
 * any file, which is the acceptance criterion this story was written for.
 *
 * ## Adding a name to any list here is a decision, and it is guarded twice
 *
 * A first review of this story found the shape of the residual risk: adding one
 * word to {@link LOG_ALLOWED_ERROR_FIELDS} — `detail`, say — left every test green
 * while a `pg` unique-violation then wrote `Key (email)=(someone@example.com)
 * already exists` to disk. An allow-list whose CONTENTS nothing asserts is only
 * safer than a deny-list by luck.
 *
 * So each list is pinned two ways. `logging.test.ts` asserts the exact set, so any
 * addition is red until somebody writes it down twice; and
 * {@link LOG_NEVER_LOGGABLE_FIELDS} is an oracle over all three lists, so an
 * addition that happens to be a forbidden word is red for a second, louder reason.
 * The one deliberate overlap between the oracle and a list is declared in
 * {@link LOG_ERROR_FIELD_CARVE_OUTS} rather than achieved by not looking.
 *
 * ## Where these names are applied, measured rather than assumed
 *
 * pino splits a log record across three paths and only ONE of them is the object
 * this list governs. Printed from a running `pino-http`, on both a hand-written
 * line and one `autoLogging` produced:
 *
 *  - `formatters.bindings` gets `base` — `service`, `version`. Those never reach
 *    `formatters.log`, so declaring them here would be a rule nobody runs.
 *  - `level` and `time` are attached by pino outside both formatters. `msg` is too
 *    when it is passed as the message ARGUMENT — but `logger.info({ msg })` puts it
 *    in the object, where this list governs it, so it is declared below.
 *  - CHILD bindings — `req` from `pino-http`, and `request_id` from its
 *    `customProps` — are stitched in by `asChindings`, and pino replaces a child's
 *    bindings formatter with an identity function (`resetChildingsFormatter`). So
 *    they pass through NEITHER formatter. The allow-list therefore cannot protect
 *    them and cannot break them; `serializers.req` is what governs `req`, and
 *    `request_id` survives by construction. That is the load-bearing half of AC4
 *    and it was checked by running pino, not by reading its README.
 *  - `formatters.log` gets the per-line object: everything a caller passed, plus
 *    `res`/`responseTime` on the completion line and `err` on a failure. That is
 *    what {@link LOG_ALLOWED_FIELDS} governs.
 *
 * Order inside `_asJson`, also measured: `formatters.log` runs FIRST, then the
 * per-key `serializers`, then `redact`'s stringifiers. Which is why `err` can be
 * passed through this filter untouched and still be narrowed afterwards — at
 * filter time it is still a live `Error`.
 */

/**
 * The field names that may appear in a log line's own object, at any depth.
 *
 * Deliberately short. Everything here is either a correlation id, the message, or
 * a fact about the HTTP exchange; none of it is a value a person typed or a
 * provider returned. The spine's own list of what makes a line worth keeping —
 * `msg`, `err.name`, `err.stack`, `err.code`, `req.method`, `req.url`,
 * `res.statusCode`, `responseTime`, `request_id` — is covered by this list plus
 * the three serializer-owned keys below.
 *
 * Adding a name here is a decision about what may be written FOREVER, in a file
 * that is copied into tickets and shipped to log aggregators. Do not add a name
 * because one debugging session wanted it — and note that `logging.test.ts`
 * asserts this exact set, so an addition is red until it is written down there too.
 *
 * No type annotation on purpose: `readonly string[]` would widen the literals away
 * and make the type-level check at the bottom of this file vacuous.
 */
export const LOG_ALLOWED_FIELDS = [
  /**
   * The single join between a log line and an `audit_events` row.
   *
   * `auth.controller.ts` argues that an audit row without a request id is not an
   * audit row, and `AuditPort` refuses one. On the auto-logged lines this arrives
   * as a child binding and never reaches this filter at all; it is declared here
   * so a hand-written `logger.info({ request_id })` behaves the same way.
   */
  'request_id',
  /**
   * The message, when it is passed in the OBJECT rather than as the second
   * argument.
   *
   * `logger.info({ request_id }, 'x')` puts `msg` outside this filter, and that is
   * how all six hand-written log calls in this repository are written. But
   * `logger.info({ msg: 'x' })` is legal pino and puts it inside — so without this
   * declaration the first person to write that form would get a message-less line
   * and no error anywhere. A control that silently deletes the sentence is the
   * "too strict makes the log useless" failure the spec names.
   */
  'msg',
  /**
   * Which part of the application spoke. `nestjs-pino` puts the `new Logger('x')`
   * argument here, and Nest's own bootstrap lines use it for `NestFactory`,
   * `RouterExplorer` and friends. Dropping it would leave forty startup lines
   * saying nothing about who wrote them.
   */
  'context',
  /**
   * `pino-http`'s own duration, in milliseconds — the only latency signal either
   * process emits.
   *
   * Declared AND asserted: a reviewer removed this name and every one of 719
   * examples stayed green while latency vanished from every request line in both
   * processes. `logging.test.ts` now parses an auto-logged line and demands a
   * number here.
   */
  'responseTime',
] as const;

/**
 * The three keys whose value is handed to a serializer instead of to this filter.
 *
 * They are allowed at the ROOT of a log object only. A `req` nested two levels
 * down is not the request — pino runs serializers on top-level keys and nothing
 * else — so passing a nested one through would hand a raw object to the output
 * with no filter in front of it at all.
 *
 * All three are narrowed by their serializer rather than by this file, and all
 * three now go through {@link LOG_SCALAR_KINDS} on the way out: a serializer that
 * copies `req.id` verbatim is one `logger.info({ req: { id: someObject } })` away
 * from being the same "sails straight through" hole one key over.
 */
export const LOG_SERIALIZED_FIELDS = ['req', 'res', 'err'] as const;

/**
 * What survives of an `Error`, and the reason each one does.
 *
 * `name` and `stack` are the shape `rate-limit-health.ts`'s
 * `diagnosableWithoutTheData` already established in this repo: a type and a set
 * of code locations carry no data about the request that failed.
 *
 * `message` is kept, and that is a deliberate narrowing of the same argument
 * rather than an oversight. A `stack` begins with `"<name>: <message>"`, so
 * dropping `message` while keeping `stack` would remove nothing and only make the
 * rule look stricter than it is. The place a message genuinely carries request
 * data is a client library's — `iovalkey` puts the failing command's arguments in
 * it — and that path already goes through `diagnosableWithoutTheData`, which
 * builds a message-free stack before the logger ever sees it. Callers who learn a
 * new such library must do the same; this list is not a licence to log a driver's
 * raw error.
 *
 * `code` is the field this repo already argued about once. `REDACTION_NOTES`
 * records that a bare `*.code` was deliberately left out of the deny-list because
 * it would have deleted the SQLSTATE, the errno and the HTTP status class — the
 * field every incident starts from. Turning the mechanism round would have dropped
 * that decision silently, so it is re-declared here rather than inherited.
 *
 * ## What is NOT here, and why
 *
 * `detail` is the worked example of why this list is now pinned as an exact set.
 * `pg` puts `Key (email)=(someone@example.com) already exists` in it on a unique
 * violation, so one plausible-looking addition would have written an email to disk
 * past the whole of this story.
 *
 * `type` — pino's default serializer emits the constructor name there — is dropped
 * because `name` already carries it for every `Error`, and a second spelling of the
 * same fact is a field to maintain rather than a field to read.
 *
 * `cause` is NOT in this list because it is not a scalar; it is handled
 * separately, recursively, through this same list. See `log-filter.ts`.
 */
export const LOG_ALLOWED_ERROR_FIELDS = ['name', 'message', 'stack', 'code'] as const;

/**
 * The one place a never-loggable word is deliberately declared anyway.
 *
 * `message` appears in {@link LOG_NEVER_LOGGABLE_FIELDS} and in
 * {@link LOG_ALLOWED_ERROR_FIELDS}, and that is not a contradiction — it is one
 * word carrying two unrelated meanings:
 *
 *  - the spine forbids `message` meaning **chat content**: what one person typed to
 *    another. That is PII of the highest order and is why `req.body.message` is in
 *    the deny-list;
 *  - `err.message` is a **failure string** produced by our own code or by a library,
 *    reachable only through the `err` serializer, which reads it off a thrown object
 *    and never off a payload. A chat message cannot arrive there.
 *
 * The carve-out is declared rather than achieved by pointing the oracle away from
 * the list. A carve-out that is asserted is a decision; one that exists because
 * nobody looked is an accident, and this file already has a story about the second
 * kind. `logging.test.ts` asserts both halves: that every carve-out really is in
 * both lists (so a stale entry fails) and that no OTHER never-loggable word has
 * quietly joined the error list.
 */
export const LOG_ERROR_FIELD_CARVE_OUTS = {
  message:
    'the spine forbids `message` meaning chat content; `err.message` is a failure ' +
    'string read off a thrown object, which a chat payload can never reach',
} as const;

/**
 * How many `at ...` frames of a stack are kept.
 *
 * The same twelve `diagnosableWithoutTheData` settles on. A stack is the cheapest
 * thing in a log line to make enormous — a deep async chain in a hot loop is
 * kilobytes per event — and twelve frames is more than enough to name the code
 * path that failed.
 */
export const LOG_ERROR_STACK_FRAME_LIMIT = 12;

/**
 * Length caps on the two error fields that are free text.
 *
 * AD-15 already names unbounded log growth as an attack, for the request id: a
 * value repeated on every line of a request is paid for by whoever stores the log,
 * not by whoever sent it. An error message is the same lever with a different
 * handle — a validation library echoing a 10 MB body into `error.message` needs no
 * malice to do it — and capping frames while leaving the text unbounded closes
 * half of one door.
 */
export const LOG_ERROR_MESSAGE_MAX_LENGTH = 2_000;
export const LOG_ERROR_STACK_MAX_LENGTH = 8_000;

/**
 * How far a `cause` chain is followed.
 *
 * A wrapped failure's real origin lives in `cause`, so dropping it entirely loses
 * the only useful half of a rethrow. Following it forever is a way to make one log
 * line unbounded, and `cause` can be circular. Three links is deeper than any
 * rethrow in this repository.
 */
export const LOG_ERROR_CAUSE_DEPTH_LIMIT = 3;

/**
 * How deep the filter walks, and how many array elements it keeps.
 *
 * Both are bounds on WORK done inside `formatters.log`, which runs on the request
 * path: a deeply nested or enormous object handed to a log call would otherwise
 * cost the request rather than the caller. The cycle guard in `log-filter.ts`
 * handles the pathological case; these two handle the merely large one.
 */
export const LOG_MAX_DEPTH = 8;
export const LOG_MAX_ARRAY_LENGTH = 100;

/**
 * The spine's never-loggable vocabulary, kept for TESTS and consulted by nothing
 * at runtime.
 *
 * This is not a second deny-list: no code path filters against it. It is the
 * oracle for the rule that replaced "every path is declared in both spellings" —
 * `logging.test.ts` asserts that none of these names, in EITHER vocabulary, has
 * been quietly added to any of the three lists above, with the single declared
 * exception in {@link LOG_ERROR_FIELD_CARVE_OUTS}. A deny-list has to be complete
 * to be useful; this list only has to be non-empty to be useful, which is the whole
 * difference between the two mechanisms.
 *
 * The last group is not from the spine. Those are the names a DRIVER or a framework
 * uses when it hands back the data it was operating on — `pg` fills `detail` with
 * the conflicting column value, `where` with the failing constraint context — and
 * they are here because the review of this story showed that one such word added to
 * the error list writes an email to disk with every test still green.
 */
export const LOG_NEVER_LOGGABLE_FIELDS = [
  'email',
  'date_of_birth',
  'dateOfBirth',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'provider_id',
  'providerId',
  'provider_user_id',
  'providerUserId',
  'id_token',
  'idToken',
  'code_verifier',
  'codeVerifier',
  'client_secret',
  'clientSecret',
  'session_token',
  'sessionToken',
  'oauth_state',
  'oauthState',
  'authorization_code',
  'authorizationCode',
  'state',
  'password',
  'cookie',
  'authorization',
  'message',

  // Where a driver or a framework puts the data it was handling.
  'detail',
  'where',
  'query',
  'body',
  'params',
  'headers',
] as const;

export type LogAllowedField = (typeof LOG_ALLOWED_FIELDS)[number];
export type LogSerializedField = (typeof LOG_SERIALIZED_FIELDS)[number];
export type LogAllowedErrorField = (typeof LOG_ALLOWED_ERROR_FIELDS)[number];
export type LogNeverLoggableField = (typeof LOG_NEVER_LOGGABLE_FIELDS)[number];

/** Fails to compile unless `T` is `never`. */
type AssertNever<T extends never> = T;

/**
 * The oracle, at the type level as well as at runtime.
 *
 * A runtime test says "this is wrong" after somebody runs it. This says it in the
 * editor, in `tsc -b`, and in the dependency-cruiser parse — before a test is ever
 * chosen to run. It works only because the three arrays above carry no
 * `readonly string[]` annotation: that annotation widens `'email'` to `string` and
 * would make every one of these checks trivially satisfied.
 *
 * The error list is checked with the declared carve-out subtracted, which is what
 * makes the `message` overlap a decision rather than an omission.
 */
export type NoForbiddenFieldIsLoggable = AssertNever<
  Extract<LogAllowedField | LogSerializedField, LogNeverLoggableField>
>;

export type NoUndeclaredForbiddenErrorField = AssertNever<
  Exclude<
    Extract<LogAllowedErrorField, LogNeverLoggableField>,
    keyof typeof LOG_ERROR_FIELD_CARVE_OUTS
  >
>;

/**
 * The value kinds that may be written at all.
 *
 * Exported so the two apps' `req`/`res` serializers can use the same answer the
 * filter does, rather than copying a value straight out of an object they were
 * handed. `logger.info({ req: { id: someObject } })` reaches `serializers.req`,
 * and a serializer that writes `id: req.id` without checking is the same
 * "undeclared thing sails through" hole one key over.
 */
export const LOG_SCALAR_KINDS = ['string', 'number', 'boolean'] as const;
