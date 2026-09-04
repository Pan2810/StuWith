import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitHealth } from './rate-limit-health';

/**
 * The class that decides HOW OFTEN an outage is spoken about, and the only place
 * the alert `AGENTS.md` tells operators to open is ever closed again.
 *
 * The recovery line had no test at all, which meant an operator could have been
 * left holding an alert that nothing would ever clear. The dedupe had one, but only
 * for a clean outage — an intermittently failing store, which is the shape a real
 * incident usually takes, flipped the state on every request and wrote two lines
 * per pair. That is the same storm from the other direction.
 *
 * A spy is fine here, unlike in the flow test: this is a unit test OF the logging
 * decision, not a claim about what production emits.
 */
describe('RateLimitHealth', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  let warnings: ReturnType<typeof vi.spyOn>;
  let health: RateLimitHealth;

  beforeEach(() => {
    errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    warnings = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    health = new RateLimitHealth();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fail = (times = 1) => {
    for (let index = 0; index < times; index += 1) {
      health.recordFailure('the auth_me check', new Error('Command timed out'));
    }
  };
  const succeed = (times = 1) => {
    for (let index = 0; index < times; index += 1) {
      health.recordSuccess();
    }
  };

  it('says nothing while the store is answering', () => {
    succeed(5);

    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(health.isDegraded()).toBe(false);
  });

  it('writes ONE error on the way into a degraded state', () => {
    fail(1);

    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain('rate limiting is not working');
    expect(health.isDegraded()).toBe(true);
  });

  it('is silent for every failure after the first', () => {
    // The storm this class exists to prevent: a full stack per request, from two
    // call sites, during exactly the incident somebody is trying to read the log.
    fail(500);

    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('writes ONE warning on recovery, carrying how many requests went unchecked', () => {
    fail(7);
    succeed(3);

    expect(warnings).toHaveBeenCalledTimes(1);
    const said = String(warnings.mock.calls[0]?.[0]);
    expect(said).toContain('rate limiting is working again');
    // The number is the whole point of the line: it says how big the exposure was.
    expect(said).toContain('7');
    expect(health.isDegraded()).toBe(false);
  });

  it('does not declare recovery on the first success alone', () => {
    fail(1);
    succeed(1);

    expect(warnings).not.toHaveBeenCalled();
    expect(health.isDegraded()).toBe(true);
  });

  /**
   * The hysteresis, and the reason for it. A store that fails every other request
   * would otherwise cross the boundary twice per pair and write an error line and
   * a recovery line each time — the storm, arriving through the recovery path.
   */
  it('stays quiet through an intermittently failing store', () => {
    fail(1);
    for (let round = 0; round < 50; round += 1) {
      succeed(1);
      fail(1);
    }

    expect(errors).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('reports a SECOND outage after a recovery, rather than staying quiet for ever', () => {
    fail(1);
    succeed(3);
    fail(1);

    expect(errors).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it('counts the unchecked requests of the second outage on their own', () => {
    fail(2);
    succeed(3);
    fail(4);
    succeed(3);

    expect(warnings).toHaveBeenCalledTimes(2);
    expect(String(warnings.mock.calls[1]?.[0])).toContain('4');
  });

  it('never puts an address, a key or a handle in ANY argument it logs', () => {
    // Story 1.7's whitelist serializer has not landed, and a request-shaped
    // identifier in a log file is what this repo has been careful about since 1.2.
    //
    // EVERY argument, not just the message. pino emits the second one too — it is
    // the stack — and that is where a leak would actually arrive, since an error
    // from the client library routinely carries the key it was operating on.
    health.recordFailure(
      'the auth_me check',
      new Error('WRONGTYPE against rl:ip:auth_me:203.0.113.7 for cookie stuwith_refresh=abc'),
    );
    succeed(3);

    const emitted = [...errors.mock.calls, ...warnings.mock.calls]
      .flat()
      .map((argument) => String(argument))
      .join('\n');

    for (const leak of ['rl:', '203.0.', 'cookie', 'stuwith_']) {
      expect(emitted, `"${leak}" must not reach a log line`).not.toContain(leak);
    }
  });
});
