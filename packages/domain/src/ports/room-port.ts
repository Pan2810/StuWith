import type { RoomStatus, RoomTopic, RoomVisibility } from '@stuwith/contracts';

/**
 * AD-1 — "what is a room, and what does creating one mean" is a domain question.
 * The `pg` driver, the NestJS controller and the HTTP body that answer it live in
 * `packages/db` and `apps/api`; this file names no library at all.
 *
 * ## What is deliberately NOT here
 *
 * No `deleteRoom`, and not because nobody has needed one yet. Epic 2's constraint
 * is that no hard-delete path for a room exists — the lifecycle is a status
 * (`open` -> `closing` -> `closed`) and the protocol that moves it is a later
 * story. A port method is the cheapest place for such a path to appear, and an
 * adapter that implemented one would satisfy every architecture rule while doing
 * it, so the absence is stated rather than left to be noticed.
 *
 * No `listRooms`, `findRooms` or `updateRoom` either. Story 2.1 creates a room and
 * reads one back; a port method with no caller is an interface somebody implements
 * twice and nobody exercises once.
 */

/**
 * A stored room.
 *
 * `maxParticipants` is a NUMBER on the room and not a plan on the owner, and that
 * split is the whole capacity decision: the cap is resolved from the creator's plan
 * once, at creation, and is never recomputed. Reading a plan at join time would let
 * a room's capacity change under the people already in it, on a billing event none
 * of them can see. Story 2.2 counts reservations against this field and must never
 * ask a plan again.
 */
export interface Room {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  /** Never `null`: "no description" and "an empty description" are one fact. */
  readonly description: string;
  readonly topic: RoomTopic;
  readonly visibility: RoomVisibility;
  readonly maxParticipants: number;
  readonly status: RoomStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What creating a room takes.
 *
 * `maxParticipants` is an INPUT here while it is absent from the wire contract, and
 * the difference is deliberate rather than inconsistent. On the wire it must not
 * exist, because a client that could name it could choose its own capacity. At this
 * boundary it must exist, because the alternative is a port that reads a plan — and
 * a port that reads a plan is a port that reads it AGAIN later, which is the exact
 * recomputation the field exists to prevent. `apps/api` resolves
 * `PLAN_PARTICIPANT_LIMITS[user.plan]` in one place and hands the number down.
 *
 * `status` is not an input at all: every room starts `open`, the schema's default
 * says so, and a caller that could choose would be able to create one already
 * closed.
 */
export interface CreateRoomInput {
  readonly ownerUserId: string;
  readonly name: string;
  readonly description: string;
  readonly topic: RoomTopic;
  readonly visibility: RoomVisibility;
  readonly maxParticipants: number;
}

/**
 * A caller handed something that cannot describe a room. Like `IdentityInputError`,
 * this is a defect in the calling code rather than an outcome of a rule, so it
 * throws instead of occupying a branch every correct caller would have to handle —
 * and it lives here so BOTH adapters raise the same error for the same input.
 *
 * It is NOT how a bad request body is refused. `parseCreateRoomRequest` in
 * `packages/contracts` judges what arrived from outside and answers `null`; by the
 * time a value reaches this port it has already been judged, so anything unusable
 * here means `apps/api` skipped that step.
 */
export class RoomInputError extends Error {
  override readonly name = 'RoomInputError';

  constructor(message: string) {
    super(message);
  }
}

export interface RoomPort {
  /**
   * Create a room owned by `ownerUserId`, at `now`.
   *
   * A single `INSERT ... RETURNING`, with no read before it: there is nothing to
   * check first. Two people creating rooms with the same name is not a conflict —
   * a name is a label, not a key — so unlike `findOrCreateByIdentity` there is no
   * race to arbitrate and no uniqueness rule to hand to the database.
   *
   * The refusals that DO exist live in the schema (a blank name, an unknown topic,
   * a cap outside the ceiling) and in `parseCreateRoomRequest` before that. This
   * method's failure mode is therefore a fault — a constraint violation here means
   * the two layers in front of it disagreed — and a fault must propagate rather
   * than become a return branch.
   *
   * @throws {RoomInputError} when the input cannot be stored as given.
   */
  createRoom(input: CreateRoomInput, now: Date): Promise<Room>;

  /**
   * The room with this id, or `null`.
   *
   * `null` is "no such room", not "an error". Story 2.2 asks this before it issues
   * a token, and a thrown not-found there would be indistinguishable at the call
   * site from the store being down.
   *
   * @throws {RoomInputError} when `roomId` is not a usable id.
   */
  findRoomById(roomId: string): Promise<Room | null>;
}
