import type {
  IdentityPort,
  ProviderIdentity,
  RecordDateOfBirthResult,
  ResolvedIdentity,
  User,
} from '@stuwith/domain';
import {
  assertValidDateOfBirth,
  assertValidIdentity,
  assertValidNow,
  assertValidUserId,
} from './pg/identity-adapter';
import { InMemoryIdentityAdapter } from './in-memory/identity-adapter';
import { runIdentityPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 for `IdentityPort`. Pass 2 is `identity-contract.pg.test.ts`
 * and runs the identical suite against real PostgreSQL 18.
 */
class UnreachableIdentityAdapter implements IdentityPort {
  async findOrCreateByIdentity(identity: ProviderIdentity, now: Date): Promise<ResolvedIdentity> {
    // Validation runs first, so the suite's "and NOT an IdentityInputError"
    // assertion is meaningful rather than accidental.
    assertValidIdentity(identity, now);
    throw new Error('simulated store outage');
  }

  async findUserById(): Promise<User | null> {
    throw new Error('simulated store outage');
  }

  async recordDateOfBirth(
    userId: string,
    dateOfBirth: string,
    now: Date,
  ): Promise<RecordDateOfBirthResult> {
    // Same reason as above: validating first is what makes "the rejection was NOT
    // an IdentityInputError" a statement about the outage path rather than an
    // accident of which check happened to run.
    assertValidUserId(userId);
    assertValidDateOfBirth(dateOfBirth);
    assertValidNow(now);
    throw new Error('simulated store outage');
  }
}

runIdentityPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const adapter = new InMemoryIdentityAdapter();
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
      },
      countUsers: async () => adapter.countUsers(),
      createFaultingPort: async () => new UnreachableIdentityAdapter(),
    };
  },
});
