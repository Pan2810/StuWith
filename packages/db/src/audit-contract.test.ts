import type { AuditEventInput, AuditPort } from '@stuwith/domain';
import { InMemoryAuditAdapter } from './in-memory/audit-adapter';
import { assertValidAuditEvent } from './pg/audit-adapter';
import { runAuditPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 for `AuditPort`. Pass 2 is `audit-contract.pg.test.ts`.
 */
class UnreachableAuditAdapter implements AuditPort {
  async append(event: AuditEventInput): Promise<void> {
    // Validation first, so the suite's "and NOT an AuditInputError" assertion is
    // meaningful rather than accidental.
    assertValidAuditEvent(event);
    throw new Error('simulated store outage');
  }
}

runAuditPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const adapter = new InMemoryAuditAdapter();
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
      },
      rows: async () => adapter.all(),
      createFaultingPort: async () => new UnreachableAuditAdapter(),
    };
  },
});
