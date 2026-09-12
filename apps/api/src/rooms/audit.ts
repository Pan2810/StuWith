import { toAuditWireTimestamp } from '@stuwith/contracts';
import type { AuditPort } from '@stuwith/domain';

/**
 * AD-12 — `room_token.issued`, the row `packages/contracts` has promised since
 * Story 1.1 and nothing wrote until now.
 *
 * Exactly one row per token issued. Not one per attempt: a refusal writes nothing,
 * because `room_token.refused` is not in `AUDIT_ACTIONS` and adding one is an
 * "Ask First" item — this table is append-only for ever, and a row for every
 * banned person's every click is a permanent record of somebody being refused.
 *
 * ## What goes in `metadata`
 *
 * Ids and instants, nothing else. `actor` is the person, `subject` is the room —
 * so "who entered which room" is answered by the two indexed columns, not by
 * parsing JSON. `reservation_id` joins the row to the seat it was issued against;
 * `expires_at` says how long the token lived, which is the one fact an
 * investigation needs that the row's own timestamp does not carry.
 *
 * Ids and instants ONLY — the spec's sentence, and a narrower one than "non-PII
 * scalars". Whether an issuance renewed a seat or took one is NOT here, although
 * `reserveSeat` reports it: two rows with the same `reservation_id` are a renewal,
 * so the fact is derivable from what is written and a flag would be a second
 * spelling of it. "How many people were in room X at 21:00" is `count(distinct
 * actor_user_id)` over the window, not a count of rows.
 *
 * No token, no secret, no display name. The token would let whoever reads the
 * table into the room for two minutes; the rest is PII in a table nobody can
 * correct.
 */
export interface RoomTokenIssuedInput {
  readonly requestId: string;
  readonly userId: string;
  readonly roomId: string;
  readonly reservationId: string;
  readonly occurredAt: Date;
  readonly expiresAt: Date;
}

export async function recordRoomTokenIssued(
  audit: AuditPort,
  input: RoomTokenIssuedInput,
): Promise<void> {
  await audit.append({
    sourceService: 'api',
    action: 'room_token.issued',
    actorUserId: input.userId,
    subjectId: input.roomId,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    metadata: {
      reservation_id: input.reservationId,
      expires_at: toAuditWireTimestamp(input.expiresAt),
    },
  });
}
