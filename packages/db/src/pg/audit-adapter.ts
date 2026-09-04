import { AUDIT_ACTIONS, SERVICE_NAMES } from '@stuwith/contracts';
import type { AuditEventInput, AuditPort } from '@stuwith/domain';
import { AuditInputError } from '@stuwith/domain';
import type { Pool } from 'pg';

/**
 * AD-12, write half. One statement, one verb.
 *
 * There is no `update` and no `delete` method on this class, and there is no
 * private helper that could grow into one. That is the code half of the rule the
 * migration enforces with GRANTs: the database refuses the statement, and this
 * file gives nobody a place to write the call.
 */
export class PgAuditAdapter implements AuditPort {
  constructor(private readonly pool: Pool) {}

  async append(event: AuditEventInput): Promise<void> {
    assertValidAuditEvent(event);

    await this.pool.query(
      `INSERT INTO audit_events
         (source_service, action, actor_user_id, subject_id, request_id, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        event.sourceService,
        event.action,
        event.actorUserId,
        event.subjectId,
        event.requestId,
        event.occurredAt,
        JSON.stringify(event.metadata),
      ],
    );
  }
}

/**
 * Validated in code as well as by the CHECK constraints, so both adapters reject
 * the same input with the same error rather than one throwing a driver error and
 * the other cheerfully storing it.
 *
 * The metadata check is the one that earns its keep: an object or an array in
 * there is how a whole provider response ends up in the one table that is kept
 * forever and cannot be edited afterwards.
 */
export function assertValidAuditEvent(event: AuditEventInput): void {
  if (event === null || typeof event !== 'object') {
    throw new AuditInputError('audit event must be an object');
  }
  if (!(SERVICE_NAMES as readonly string[]).includes(event.sourceService)) {
    throw new AuditInputError(`unknown source_service: ${String(event.sourceService)}`);
  }
  if (!(AUDIT_ACTIONS as readonly string[]).includes(event.action)) {
    throw new AuditInputError(`unknown audit action: ${String(event.action)}`);
  }
  if (typeof event.requestId !== 'string' || event.requestId.trim().length === 0) {
    throw new AuditInputError('request_id must be a non-empty string — a row nobody can trace is not an audit row');
  }
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    throw new AuditInputError('occurred_at must be a valid Date');
  }
  if (event.actorUserId !== null && typeof event.actorUserId !== 'string') {
    throw new AuditInputError('actor_user_id must be a string or null');
  }
  if (event.subjectId !== null && typeof event.subjectId !== 'string') {
    throw new AuditInputError('subject_id must be a string or null');
  }
  if (event.metadata === null || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) {
    throw new AuditInputError('metadata must be a plain object of scalars');
  }
  for (const [key, value] of Object.entries(event.metadata)) {
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new AuditInputError(
        `metadata.${key} must be a string, number or boolean — nested payloads are how PII reaches an immutable table`,
      );
    }
  }
}
