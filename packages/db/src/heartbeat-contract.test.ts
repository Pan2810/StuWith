import type { Heartbeat, HeartbeatPort, RecordHeartbeatResult } from '@stuwith/domain';
import { assertValidHeartbeatInput } from '@stuwith/domain';
import { InMemoryHeartbeatAdapter } from './in-memory/heartbeat-adapter';
import { runHeartbeatPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 (AD-6 / TD-5): the shared contract suite against the
 * in-memory adapter. Pass 2 lives in heartbeat-contract.pg.test.ts and runs the
 * exact same suite against real PostgreSQL 18.
 */

/**
 * An in-memory store has no natural outage, so the fault case is simulated. It is
 * still worth running here: the suite asserts that a fault surfaces as a THROW and
 * never as `{ ok: false }`, and that assertion has to hold for every adapter — a
 * future Valkey- or SQLite-backed one included — or the two implementations of the
 * same port will disagree about what an outage looks like.
 */
class UnreachableHeartbeatAdapter implements HeartbeatPort {
  async record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult> {
    // Input validation still runs first, so the suite's "this is not a
    // HeartbeatInputError" assertion is meaningful rather than accidental.
    assertValidHeartbeatInput(serviceKey, observedAt);
    throw new Error('simulated store outage');
  }

  async latest(): Promise<Heartbeat | null> {
    throw new Error('simulated store outage');
  }
}

runHeartbeatPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const adapter = new InMemoryHeartbeatAdapter();
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
      },
      createFaultingPort: async () => new UnreachableHeartbeatAdapter(),
    };
  },
});
