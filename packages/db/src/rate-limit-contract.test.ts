import type { RateLimitDecision, RateLimitPort } from '@stuwith/domain';
import { FixedClock, assertValidRateLimitKey } from '@stuwith/domain';
import { InMemoryRateLimitAdapter } from './in-memory/rate-limit-adapter';
import { runRateLimitPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 (AD-6 / TD-5): the shared rate-limit contract suite
 * against the in-memory adapter. Pass 2 lives in `rate-limit-contract.valkey.test.ts`
 * and runs the exact same suite against real Valkey 9.0.4.
 *
 * The clock is a `FixedClock`, so "wait three seconds" costs nothing here. The
 * Valkey pass really waits, which is why the windows in the suite are small.
 */

/**
 * A store with no natural outage, so the outage is simulated — and it is still
 * worth running here. The suite asserts that a fault surfaces as a THROW and never
 * as an allowance, and that assertion has to hold for every adapter or the two
 * implementations of one port will disagree about what a blind counter looks like.
 */
class UnreachableRateLimitAdapter implements RateLimitPort {
  async hit(key: string): Promise<RateLimitDecision> {
    // Input validation still runs first, so the suite's "this is not a
    // RateLimitInputError" assertion is meaningful rather than accidental.
    assertValidRateLimitKey(key);
    throw new Error('simulated valkey outage');
  }

  async remainingSeconds(key: string): Promise<number | null> {
    assertValidRateLimitKey(key);
    throw new Error('simulated valkey outage');
  }

  async lock(key: string): Promise<number> {
    assertValidRateLimitKey(key);
    throw new Error('simulated valkey outage');
  }

  async clear(key: string): Promise<void> {
    assertValidRateLimitKey(key);
    throw new Error('simulated valkey outage');
  }
}

runRateLimitPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const adapter = new InMemoryRateLimitAdapter(clock);
    return {
      port: adapter,
      reset: async () => {
        adapter.reset();
      },
      advance: async (milliseconds: number) => {
        clock.advance(milliseconds);
      },
      createFaultingPort: async () => new UnreachableRateLimitAdapter(),
    };
  },
});
