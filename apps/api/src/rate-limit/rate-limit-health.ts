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
 * So the state is what is logged, not the event:
 *
 * - the FIRST failure after a healthy period writes the `error` line, with the
 *   stack, carrying the string AGENTS.md tells operators to alert on;
 * - every failure after that is counted and silent;
 * - the first success afterwards writes one recovery line saying how many requests
 *   went through unchecked.
 *
 * That is one line in, one line out, and a number that says how big the exposure
 * actually was — which is more useful than ten thousand identical stacks.
 */
/**
 * How many consecutive successes it takes to call the store healthy again.
 *
 * Without hysteresis an INTERMITTENTLY failing store — the common shape of a real
 * incident, not a clean outage — alternates failure, success, failure, success and
 * writes an error line and a recovery line on every pair. That is the log storm
 * this class exists to prevent, arriving through the recovery path instead of the
 * failure one. Three in a row is enough to distinguish "it is back" from "that one
 * happened to work".
 */
const RECOVERY_STREAK = 3;

@Injectable()
export class RateLimitHealth {
  private readonly logger = new Logger('RateLimit');
  private degraded = false;
  private unchecked = 0;
  private consecutiveSuccesses = 0;

  /**
   * Record that the store did not answer, and log only on the way in.
   *
   * `what` names the operation rather than the request: no address, no key, no
   * handle. Story 1.7's whitelist serializer has not landed, and a
   * request-shaped identifier in a log file is precisely what this repo has been
   * careful about since Story 1.2.
   */
  recordFailure(what: string, error: unknown): void {
    this.unchecked += 1;
    this.consecutiveSuccesses = 0;
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    this.logger.error(
      `rate limiting is not working: ${what} failed because the counter store did not answer. ` +
        'Requests to /v1/auth are being allowed through unchecked until it recovers.',
      error instanceof Error ? error.stack : String(error),
    );
  }

  /**
   * Record that the store answered, and log once — after {@link RECOVERY_STREAK}
   * in a row — if it had been failing.
   *
   * The streak is the hysteresis: a store that fails every other request would
   * otherwise flip the state twice per pair and write two lines each time.
   */
  recordSuccess(): void {
    if (!this.degraded) {
      return;
    }
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses < RECOVERY_STREAK) {
      return;
    }

    const unchecked = this.unchecked;
    this.degraded = false;
    this.unchecked = 0;
    this.consecutiveSuccesses = 0;
    this.logger.warn(
      `rate limiting is working again: the counter store is answering. ` +
        `${unchecked} request(s) went through unchecked while it was down.`,
    );
  }

  /** For tests and for anything that later wants to report degraded state. */
  isDegraded(): boolean {
    return this.degraded;
  }
}
