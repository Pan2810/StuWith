import { InMemoryHeartbeatAdapter } from './in-memory/heartbeat-adapter';
import { runHeartbeatPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 (AD-6 / TD-5): the shared contract suite against the
 * in-memory adapter. Pass 2 lives in heartbeat-contract.pg.test.ts and runs the
 * exact same suite against real PostgreSQL 18.
 */
runHeartbeatPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const adapter = new InMemoryHeartbeatAdapter();
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
      },
    };
  },
});
