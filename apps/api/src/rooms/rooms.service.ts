import { Inject, Injectable } from '@nestjs/common';
import {
  CREATE_ROOM_INVALID_MESSAGE,
  PLAN_PARTICIPANT_LIMITS,
  UNAUTHENTICATED_MESSAGE,
  makeError,
  parseCreateRoomRequest,
  roomSchema,
} from '@stuwith/contracts';
import type { Room } from '@stuwith/domain';
import { SESSION_AUTHENTICATOR, SessionAuthenticator } from '../auth/session-authenticator';
import { ROOMS_RUNTIME, type RoomsRuntime } from './rooms.runtime';

/**
 * Creating a room, with no Fastify in it.
 *
 * Same arrangement as `AuthService`: every method returns a DESCRIPTION of a
 * response and the controller turns it into a reply. That is what lets the flow
 * test drive every row of the story's I/O matrix through real HTTP without a
 * browser, and it keeps this file readable as a sequence of decisions.
 *
 * The outcome type is smaller than `AuthOutcome` because this endpoint answers
 * only JSON — no redirect, no `Set-Cookie`, no empty body. Reusing the auth one
 * would give three branches to a route that has one, and every reader would have to
 * work out which two never happen.
 */
export interface RoomOutcome {
  readonly status: number;
  readonly body: unknown;
}

@Injectable()
export class RoomsService {
  private readonly rooms: RoomsRuntime['rooms'];

  constructor(
    @Inject(ROOMS_RUNTIME) runtime: RoomsRuntime,
    /**
     * The SAME instance `AuthService` and `MoneyGateGuard` authenticate through —
     * built once in `AppModule.forConfig` and exported globally.
     *
     * A second way of answering "who is calling" is the defect
     * `SessionAuthenticator` was extracted to prevent. Here it would mean the
     * participant cap could come from one person's plan while the room came out
     * owned by another.
     */
    @Inject(SESSION_AUTHENTICATOR) private readonly authenticator: SessionAuthenticator,
  ) {
    this.rooms = runtime.rooms;
  }

  /**
   * `POST /v1/rooms`
   *
   * ## The order of the three steps is the specification
   *
   * 1. **Who is calling.** No session is `401`, with the same sentence every other
   *    `401` in `/v1` carries — a caller that could tell "no session" from "no
   *    session, and also a bad body" has been told something about a request the
   *    system never looked at. Nothing has touched the room store at this point,
   *    and the flow test asserts that by counting rooms afterwards.
   * 2. **Is the body a room.** `parseCreateRoomRequest` is the shared judge from
   *    `packages/contracts`, so the string this endpoint accepts and the string the
   *    form pre-checks are one rule (AD-13). It is total over `unknown`: a body of
   *    `null`, an array or a string answers `null` rather than throwing, which is
   *    what keeps a malformed request a `400` instead of a `500`.
   * 3. **What is the cap.** `PLAN_PARTICIPANT_LIMITS[caller.plan]`, resolved HERE
   *    and nowhere else, and stored on the row. It is not read from the body — the
   *    field does not exist in the contract, so a client that sends one is ignored
   *    in silence rather than refused, and there is no spelling that influences it.
   *
   * ## Why the cap is not recomputed, ever
   *
   * Epic 2's context: "trần gói lưu cùng phòng lúc tạo, không tính lại mỗi lần có
   * người vào". Story 2.2 counts reservations against `rooms.max_participants` and
   * must never ask a plan again — otherwise a room's capacity changes under the
   * people already in it, on a billing event none of them can see.
   *
   * ## What is deliberately absent
   *
   * No audit row and no rate limit. Both are outside this story's ACs and both are
   * recorded in `deferred-work.md` with the evidence; neither is promised here,
   * because a docblock that says "audit arrives later" is a promise nothing keeps.
   */
  async createRoom(cookieHeader: unknown, body: unknown): Promise<RoomOutcome> {
    const caller = await this.authenticator.authenticate(cookieHeader);
    if (caller === null) {
      return { status: 401, body: makeError('unauthenticated', UNAUTHENTICATED_MESSAGE) };
    }

    const request = parseCreateRoomRequest(body);
    if (request === null) {
      return { status: 400, body: makeError('validation_failed', CREATE_ROOM_INVALID_MESSAGE) };
    }

    // ONE reading of the clock for the whole request: the instant the SESSION was
    // resolved at, not a fresh one. Two instants for one request is what Story 1.4
    // paid a review round to remove from the declaration path.
    const { user, at: now } = caller;

    const room = await this.rooms.createRoom(
      {
        ownerUserId: user.id,
        name: request.name,
        // `?? ''` because `description` is optional on the wire and `NOT NULL`
        // in the column. The bridge lives here rather than in the schema: a
        // `.default('')` in `packages/contracts` would publish the field as
        // required in the emitted document, which is the claim Story 2.1's review
        // retracted.
        description: request.description ?? '',
        topic: request.topic,
        visibility: request.visibility,
        // The whole of the capacity decision, in one expression. A `Record` over
        // the plan union, so a fourth plan is a typecheck error rather than an
        // `undefined` reaching a `NOT NULL` integer column.
        maxParticipants: PLAN_PARTICIPANT_LIMITS[user.plan],
      },
      now,
    );

    return { status: 201, body: toRoomBody(room) };
  }
}

/**
 * The room as it leaves this process, PARSED rather than cast.
 *
 * `roomSchema.parse` strips every key the schema does not declare, which is what
 * makes "adding a column cannot publish it" a property of the code rather than of
 * somebody's care — the same argument `toCurrentUser` makes for the profile
 * projection. If `Room` ever gains an owner's plan, a moderation flag or an
 * internal counter, this function keeps them off the wire without being edited.
 *
 * The two timestamps are converted here rather than by the JSON serialiser. A
 * `Date` reaching `JSON.stringify` becomes an ISO string anyway, so the behaviour
 * would look identical — and `roomSchema` would refuse the object before it got
 * there, which is exactly the drift the parse exists to catch. Doing it explicitly
 * means the contract and the body agree at the point the body is built.
 */
function toRoomBody(room: Room) {
  return roomSchema.parse({
    id: room.id,
    owner_user_id: room.ownerUserId,
    name: room.name,
    description: room.description,
    topic: room.topic,
    visibility: room.visibility,
    max_participants: room.maxParticipants,
    status: room.status,
    created_at: room.createdAt.toISOString(),
    updated_at: room.updatedAt.toISOString(),
  });
}
