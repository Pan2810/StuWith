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
  'valkey',
  'redis',
];

/**
 * The built-in error types that are always a programming defect, never a store
 * fault — checked first so a message that happens to contain a marker word cannot
 * disguise one.
 */
function isProgrammingError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RateLimitInputError
  );
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
