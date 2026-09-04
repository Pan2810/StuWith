import type { AuditAction, ServiceName } from '@stuwith/contracts';

/**
 * AD-12 — the append-only trail, as a port.
 *
 * The interface has exactly one method, and it is `append`. There is no `update`
 * and no `delete`, on purpose: the database GRANTs make those impossible, and this
 * type makes them unwritable. Both halves are needed — a GRANT stops the statement,
 * an interface with no such method stops anyone from writing the call in the first
 * place and then discovering at 3am that production had the privilege after all.
 *
 * The row SHAPE lives in `packages/contracts` (`auditEventSchema`) because both
 * processes write this table and two copies of the shape would drift.
 */

/**
 * What a caller supplies.
 *
 * `id` is the store's business; `occurredAt` is deliberately the CALLER's, and the
 * distinction is worth stating because it looks like an oversight.
 *
 * A request reads the clock once, through `ClockPort`, and every row it writes
 * carries that instant. Letting each adapter stamp `now()` instead would make two
 * rows from one request disagree by however long the request took, and would make
 * the trail untestable — `FixedClock` is what lets a test assert "this login
 * produced exactly one row, at this moment". The threat that argument has to
 * answer is a caller back-dating a row: the answer is that the only callers are
 * this repository's two processes, both of which pass the request clock, and that
 * a row's position in the trail is fixed by its UUIDv7 `id` (assigned by the
 * store, ordered by insertion time) rather than by this field.
 */
export interface AuditEventInput {
  readonly sourceService: ServiceName;
  readonly action: AuditAction;
  /** Null for events with no actor (a failed sign-in has no known user yet). */
  readonly actorUserId: string | null;
  readonly subjectId: string | null;
  readonly requestId: string;
  /** The instant the REQUEST read from its clock, not the instant of the INSERT. */
  readonly occurredAt: Date;
  /**
   * Whitelisted, non-PII scalars only. An email, a provider id, a token or a
   * `code` in here defeats the entire PII posture, because the audit table is the
   * one place data is kept forever and cannot be edited afterwards.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A caller handed something that cannot be an audit row. Throws rather than
 * refusing: there is no valid reason to decline an append.
 */
export class AuditInputError extends Error {
  override readonly name = 'AuditInputError';

  constructor(message: string) {
    super(message);
  }
}

export interface AuditPort {
  /**
   * Append one row. Never returns a refusal branch — the only way this fails is a
   * fault, and a fault propagates.
   *
   * @throws {AuditInputError} when the input cannot describe a row.
   */
  append(event: AuditEventInput): Promise<void>;
}
