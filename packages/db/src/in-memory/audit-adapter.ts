import type { AuditEventInput, AuditPort } from '@stuwith/domain';
import { assertValidAuditEvent } from '../pg/audit-adapter';

/**
 * The in-memory audit trail. Append-only here too: there is no method that edits
 * or removes a row, only `append` and a test-only `clear()` that resets the whole
 * store between examples.
 *
 * `apps/api`'s flow tests run in the `api` Vitest project, which has no Docker —
 * so without this adapter the assertion "exactly one `auth.signed_in` row per
 * login" could only be checked in the Postgres pass, i.e. not at all on a laptop.
 */
export class InMemoryAuditAdapter implements AuditPort {
  private readonly rows: AuditEventInput[] = [];

  async append(event: AuditEventInput): Promise<void> {
    assertValidAuditEvent(event);
    this.rows.push({ ...event, metadata: { ...event.metadata } });
  }

  all(): readonly AuditEventInput[] {
    return [...this.rows];
  }

  byAction(action: AuditEventInput['action']): readonly AuditEventInput[] {
    return this.rows.filter((row) => row.action === action);
  }

  clear(): void {
    this.rows.length = 0;
  }
}
