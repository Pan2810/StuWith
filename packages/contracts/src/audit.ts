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
  /** timestamptz, always UTC. */
  occurred_at: z.date(),
  /** Whitelisted, non-PII scalars only. */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
