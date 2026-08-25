import { z } from 'zod';
import { serviceNameSchema } from './health';

/**
 * AD-8 / AD-12: `audit_events` is written by BOTH processes and is append-only.
 * Because there are two writers, the row shape is declared once, here, so the two
 * processes cannot drift into writing two different shapes.
 *
 * Field names are snake_case to match the DB convention in the spine.
 * PII (AD-15) never belongs in `metadata` — only ids and already-declared fields.
 */
export const AUDIT_ACTIONS = [
  'auth.signed_in',
  'auth.sign_in_failed',
  'room_token.issued',
  'balance.changed',
  'report.submitted',
  'moderation.applied',
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEventSchema = z.object({
  /** UUIDv7 — sortable by time, does not leak volume like a serial would. */
  id: z.uuid(),
  /** Which process wrote the row. */
  source_service: serviceNameSchema,
  action: auditActionSchema,
  /** Actor is nullable: system-originated events have no user. */
  actor_user_id: z.uuid().nullable(),
  subject_id: z.uuid().nullable(),
  /** Traceable across both processes — spine "Logging". */
  request_id: z.string().min(1),
  /**
   * `timestamptz`, always UTC, carried on the wire as an ISO-8601 string.
   *
   * NOT `z.date()`. A JSON payload never contains a Date instance, so a Date
   * schema rejects every row that has been through `JSON.parse` — including the
   * ones this process just wrote — and it has no JSON Schema representation, so
   * it cannot be emitted for OpenAPI either. The audit row has to survive both,
   * because it crosses a process boundary AND is part of the published contract.
   */
  occurred_at: z.iso.datetime({ offset: true }),
  /** Whitelisted, non-PII scalars only. */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

/**
 * Convenience for the write path: the two processes hold a Date and the wire
 * wants a string, and this is the one place that conversion is allowed to live.
 */
export function toAuditWireTimestamp(instant: Date): string {
  return instant.toISOString();
}
