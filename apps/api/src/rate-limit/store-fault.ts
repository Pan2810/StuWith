import { RateLimitInputError } from '@stuwith/domain';

/**
 * Whether a throwable is "the counter store could not answer" — the ONLY thing
 * that earns the fail-open.
 *
 * The branch used to be "anything that is not a `RateLimitInputError`", which is
 * every `TypeError`, `RangeError` and typo in `apps/api` as well. A property read
 * on `undefined` inside the guard was then reported for ever as "the counter store
 * did not answer": the alert pointed at Valkey, the layer stayed off, and nothing
 * in the log said the bug was ours. A defect must surface as the 500 it is.
 *
 * So the test is positive rather than negative. An `Error` from the store looks
 * like a connection, timeout or protocol failure, and `iovalkey` names all of them
 * — `MaxRetriesPerRequestError`, `ReplyError`, plus plain `Error`s carrying
 * `ECONNREFUSED`, `ETIMEDOUT`, "Stream isn't writeable" or "Command timed out".
 * Anything else, including the built-in error types, is ours.
 */
const STORE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'MaxRetriesPerRequestError',
  'ReplyError',
  'ClusterAllFailedError',
  'AbortError',
  'ConnectionError',
]);

/**
 * Substrings that only a transport failure produces.
 *
 * `valkey` and `redis` used to be on this list and are deliberately gone. They
 * matched the product NAME rather than a failure, so our own
 * `valkey: unexpected reply shape from the rate-limit script` — a bug in the
 * adapter or the script, thrown while Valkey is perfectly healthy — was read as
 * "the store could not answer": the layer failed open in silence and the alert
 * pointed at a service with nothing wrong with it. `iovalkey`'s real transport
 * failures all arrive with one of the names below or one of the errno markers
 * here, so nothing is lost by dropping two words that mean "this line mentions
 * the store" rather than "the store is unreachable".
 */
const STORE_MESSAGE_MARKERS: readonly string[] = [
  'econnrefused',
  'econnreset',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'epipe',
  'socket closed',
  'stream isn',
  'connection is closed',
  'command timed out',
  'connect etimedout',
];

/**
 * Errors this codebase raises about its OWN state, recognised by `name`.
 *
 * By name and not by `instanceof` on purpose: `ValkeyReplyShapeError` is declared
 * in `packages/db`, and importing it here would make the module that classifies
 * errors depend on the adapter package to answer a question about `apps/api`'s own
 * behaviour. The name is part of the class and is what a log line shows.
 */
const PROGRAMMING_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ValkeyReplyShapeError',
  'RateLimitInputError',
]);

/**
 * The error types that are always a programming defect, never a store fault —
 * checked first so a message that happens to contain a marker word cannot
 * disguise one.
 */
function isProgrammingError(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RateLimitInputError
  ) {
    return true;
  }
  return error instanceof Error && PROGRAMMING_ERROR_NAMES.has(error.name);
}

export function isStoreFault(error: unknown): boolean {
  if (isProgrammingError(error)) {
    return false;
  }
  if (!(error instanceof Error)) {
    // A thrown string or object is not something the client library does.
    return false;
  }
  if (STORE_ERROR_NAMES.has(error.name)) {
    return true;
  }
  const message = error.message.toLowerCase();
  return STORE_MESSAGE_MARKERS.some((marker) => message.includes(marker));
}
