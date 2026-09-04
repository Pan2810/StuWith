import type { ReadSessionResult, SessionPort } from '@stuwith/domain';
import { InMemorySessionAdapter } from './in-memory/session-adapter';
import { assertValidDate, assertValidHash } from './pg/session-adapter';
import { runSessionPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 for `SessionPort`. Pass 2 is `session-contract.pg.test.ts`.
 */
class UnreachableSessionAdapter implements SessionPort {
  async open(): Promise<never> {
    throw new Error('simulated store outage');
  }

  async readByAccessTokenHash(accessTokenHash: string, now: Date): Promise<ReadSessionResult> {
    assertValidHash(accessTokenHash, 'accessTokenHash');
    assertValidDate(now, 'now');
    throw new Error('simulated store outage');
  }

  async rotate(): Promise<never> {
    throw new Error('simulated store outage');
  }

  async revokeChain(): Promise<never> {
    throw new Error('simulated store outage');
  }

  async revokeChainByRefreshTokenHash(): Promise<never> {
    throw new Error('simulated store outage');
  }

  async listChain(): Promise<never> {
    throw new Error('simulated store outage');
  }
}

let userCounter = 0;

runSessionPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const adapter = new InMemorySessionAdapter();
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
      },
      // No foreign key to satisfy here, but the id still has to LOOK like the ones
      // Postgres hands back, or the two passes stop testing the same thing.
      createUserId: async () => {
        userCounter += 1;
        return `019200f2-0000-7000-8000-${userCounter.toString(16).padStart(12, '0')}`;
      },
      createFaultingPort: async () => new UnreachableSessionAdapter(),
    };
  },
});
