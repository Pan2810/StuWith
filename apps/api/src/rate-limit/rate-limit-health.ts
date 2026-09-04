import { Injectable, Logger } from '@nestjs/common';

/**
 * Whether the counter store is answering, and — the whole reason this class
 * exists — how often to say so.
 *
 * The first version logged one `error` with a full stack **per request**, from two
 * call sites, with no deduplication. During exactly the incident this design
 * anticipates — Valkey down while the login page is being hammered — that is a log
 * storm: the one line an operator needs is buried under thousands of copies of
 * itself, and the log volume becomes a second incident.
 *
 * So the STATE is what is logged, not the event:
 *
 * - the first failure after a healthy period writes the `error` line, with the
 *   stack, carrying the string AGENTS.md tells operators to alert on;
 * - every failure after that is counted and silent;
 * - recovery is announced once, after {@link RECOVERY_STREAK} consecutive
 *   successes, with a count of how many operations went through unchecked.
 *
 * That is one line in, one line out, and a number that says how big the exposure
 * actually was — which is more useful than ten thousand identical stacks.
 *
 * ## Two limitations, stated rather than implied
 *
 * Recovery needs a STREAK, not a single success. Without it an intermittently
 * failing store — the shape a real incident usually takes — alternates failure and
 * success and writes an error line and a recovery line on every pair, which is the
 * same storm arriving through the other path.
 *
 * The streak does not distinguish WHICH operation succeeded. A partial outage where
 * `hit` fails while `clear` works can therefore declare recovery on three unrelated
 * successes. Bounding that properly means tracking a streak per operation family,
 * which is more machinery than a log-throttling class should carry; what saves it
 * is that the next failing `hit` re-opens the alert immediately.
 */
const RECOVERY_STREAK = 3;

@Injectable()
export class RateLimitHealth {
  private readonly logger = new Logger('RateLimit');
  private degraded = false;
  private uncheckedOperations = 0;
  private consecutiveSuccesses = 0;

  /**
   * Record that the store did not answer, and log only on the way in.
   *
   * `what` names the operation rather than the request: no address, no key, no
   * handle. Story 1.7's whitelist serializer has not landed, and a request-shaped
   * identifier in a log file is precisely what this repo has been careful about
   * since Story 1.2.
   */
  recordFailure(what: string, error: unknown): void {
    this.uncheckedOperations += 1;
    this.consecutiveSuccesses = 0;
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    this.logger.error(
      `rate limiting is not working: ${what} failed because the counter store did not answer. ` +
        'Requests to /v1/auth are being allowed through unchecked until it recovers.',
      diagnosableWithoutTheData(error),
    );
  }

  /** Record that the store answered, and log once the streak is complete. */
  recordSuccess(): void {
    if (!this.degraded) {
      return;
    }
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses < RECOVERY_STREAK) {
      return;
    }

    const unchecked = this.uncheckedOperations;
    this.degraded = false;
    this.uncheckedOperations = 0;
    this.consecutiveSuccesses = 0;
    /**
     * "check(s)", not "request(s)".
     *
     * The counter counts store OPERATIONS, and one request can be several: a
     * `/callback` spends the guard's `hit` and then `AuthService`'s brute-force
     * tick. Calling them requests overstated the exposure by roughly a factor of
     * two on exactly the endpoint an operator would be looking at.
     */
    this.logger.warn(
      `rate limiting is working again: the counter store is answering. ` +
        `${unchecked} check(s) were skipped while it was down.`,
    );
  }

  /** For tests and for anything that later wants to report degraded state. */
  isDegraded(): boolean {
    return this.degraded;
  }
}

/**
 * The error's TYPE and the code path it came from — never its message.
 *
 * A store error routinely carries the data it was operating on: `iovalkey` puts
 * the failing command and its arguments in the message, and the arguments are the
 * rate-limit key, which is built from an address or a hashed credential. Logging
 * `error.stack` therefore logged the key, and Story 1.7's whitelist serializer is
 * not here yet to catch it.
 *
 * The stack FRAMES are pure code locations and carry no data at all, so they are
 * kept: an operator still gets the type of failure and the exact line, which is
 * everything an investigation needs about our side. What is dropped is only the
 * part the client library filled in from the request.
 */
function diagnosableWithoutTheData(error: unknown): string {
  if (!(error instanceof Error)) {
    // A thrown non-Error has no message to separate from anything; its shape is
    // all we can safely say about it.
    return `non-error thrown: ${typeof error}`;
  }
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 12);
  return [error.name, ...frames].join('\n');
}
