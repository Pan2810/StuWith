/**
 * The counter behind "rate limit theo IP **và** theo user; khoá brute-force đăng
 * nhập" (Epic 1, Chống tấn công).
 *
 * ## Three outcomes, three mechanisms — the same shape `heartbeat-port.ts` fixed
 *
 * | Outcome | Mechanism | Example |
 * | --- | --- | --- |
 * | **Refusal** — the caller is over the limit | returns `{ ok: false, reason: 'RateLimited', retryAfterSeconds }` | the eleventh attempt in a minute |
 * | **Invalid input** — the caller has a bug | throws {@link RateLimitInputError} | empty key, a window of zero seconds |
 * | **Fault** — the store could not answer | the underlying error propagates | Valkey is down, or answered too slowly |
 *
 * A fault must NEVER become a refusal, and — the direction that matters more here
 * — it must never become an *allowance* either. An adapter that catches its own
 * connection error and returns "allowed" has silently turned the blocking layer
 * off, and every gate stays green while nothing is being counted. Whether a blind
 * system lets people through is a decision that needs the context to write a log
 * line about it, so it belongs to the caller in `apps/api`, not to the adapter.
 *
 * ## Why `retryAfterSeconds` comes back from the store rather than from config
 *
 * The acceptance criterion says the countdown is *real*. A constant read out of
 * configuration is not: the window started when the first attempt landed, so
 * somebody who waits exactly the configured number of seconds is refused again,
 * with the same number, forever. The only thing that knows the truth is the key
 * that is currently alive in the store, which is why every refusal carries the
 * store's own remaining time-to-live.
 */

/** Long enough for `rl:<dimension>:<action>:<value>` with an IPv6 address in it. */
export const MAX_RATE_LIMIT_KEY_LENGTH = 200;

/**
 * A caller passed something that cannot be a rate-limit question. A defect in the
 * calling code, not an outcome of the rule, so it throws rather than occupying a
 * branch every correct caller would have to handle.
 *
 * It lives in the domain because both adapters have to raise the *same* error for
 * the *same* input: left to themselves, the in-memory Map would cheerfully key on
 * an empty string and Valkey would too, and the disagreement would only be found
 * when a production key collided with every other empty-keyed caller.
 */
export class RateLimitInputError extends Error {
  override readonly name = 'RateLimitInputError';

  constructor(message: string) {
    super(message);
  }
}

export type RateLimitDecision =
  | {
      readonly ok: true;
      /** How many hits this key has taken inside the current window, this one included. */
      readonly count: number;
      /** Hits still available before the next one is refused. Never negative. */
      readonly remaining: number;
    }
  /**
   * Not an error to throw. Being over the limit is an ordinary, expected answer
   * that the caller must deal with, and the shared contract suite checks every
   * adapter returns it rather than raising.
   */
  | {
      readonly ok: false;
      readonly reason: 'RateLimited';
      /**
       * The store's real remaining time-to-live, in whole seconds, rounded UP so a
       * client that waits exactly this long is never refused for the same window
       * a second time. At least 1: a `Retry-After: 0` invites an immediate retry.
       */
      readonly retryAfterSeconds: number;
    };

export interface RateLimitPort {
  /**
   * Count one attempt against `key` and say whether it is allowed.
   *
   * Must be ONE atomic step. Read-then-write loses the race that matters most:
   * the burst of parallel requests a script produces is exactly when the counter
   * has to be right, and two workers that both read `9` and both write `10` let
   * twice the limit through.
   *
   * The window is fixed, not sliding-per-request: the first hit creates the key
   * with `windowSeconds` to live and later hits inside that window do not extend
   * it. That is what makes the countdown finite — a window renewed on every
   * attempt can never expire for somebody who keeps hammering it, and the
   * "wait it out" row of the matrix becomes untrue.
   *
   * @throws {RateLimitInputError} when the arguments cannot describe a limit.
   */
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;

  /**
   * The remaining seconds on `key`, or `null` when there is nothing to wait for.
   *
   * Never creates the key and never counts an attempt — this is how a lock is
   * checked without the check itself extending the lock.
   *
   * @throws {RateLimitInputError} when `key` is not a usable key.
   */
  remainingSeconds(key: string): Promise<number | null>;

  /**
   * Start a lock on `key` for `seconds`, and answer with its REAL remaining time.
   *
   * Never shortens a lock that is already running. Re-locking on every subsequent
   * failure would restart the clock, so the countdown a person is watching would
   * jump back up each time anything else touched the same key — and a lock that
   * cannot run out is a ban, which is not what was designed.
   *
   * @throws {RateLimitInputError} when the arguments cannot describe a lock.
   */
  lock(key: string, seconds: number): Promise<number>;

  /**
   * Forget `key` entirely. Used when a real success proves the failures before it
   * were noise — never to release a lock, which has to run its own course.
   *
   * @throws {RateLimitInputError} when `key` is not a usable key.
   */
  clear(key: string): Promise<void>;
}

export function assertValidRateLimitKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new RateLimitInputError('key must be a non-empty string');
  }
  if (key.length > MAX_RATE_LIMIT_KEY_LENGTH) {
    throw new RateLimitInputError(
      `key must be at most ${MAX_RATE_LIMIT_KEY_LENGTH} characters`,
    );
  }
  // Whitespace is not a stylistic objection. Keys are built from values a
  // stranger controls (a header, a cookie), and a newline in one is how a key
  // ends up spanning two lines of anything that ever prints it.
  if (/[\s]/.test(key)) {
    throw new RateLimitInputError('key must not contain whitespace');
  }
}

export function assertValidLimit(limit: unknown): asserts limit is number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new RateLimitInputError('limit must be a positive integer');
  }
}

export function assertValidWindowSeconds(windowSeconds: unknown): asserts windowSeconds is number {
  if (
    typeof windowSeconds !== 'number' ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1
  ) {
    throw new RateLimitInputError('windowSeconds must be a positive integer');
  }
}
