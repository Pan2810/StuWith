import { Inject, Injectable } from '@nestjs/common';
import {
  CREATE_ROOM_INVALID_MESSAGE,
  PLAN_PARTICIPANT_LIMITS,
  ROOM_ADMISSION_FORBIDDEN_MESSAGE,
  ROOM_CLOSED_MESSAGE,
  ROOM_FULL_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
  ROOM_TOKEN_TTL_SECONDS,
  UNAUTHENTICATED_MESSAGE,
  isRoomId,
  makeError,
  parseCreateRoomRequest,
  roomSchema,
  roomTokenResponseSchema,
} from '@stuwith/contracts';
import { fixedAt, roomAdmission, type Room } from '@stuwith/domain';
import { SESSION_AUTHENTICATOR, SessionAuthenticator } from '../auth/session-authenticator';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { recordRoomTokenIssued } from './audit';
import { mintRoomToken } from './room-token';
import { ROOMS_RUNTIME, type RoomsRuntime } from './rooms.runtime';

/**
 * Creating a room and issuing a token for one, with no Fastify in it.
 *
 * Same arrangement as `AuthService`: every method returns a DESCRIPTION of a
 * response and the controller turns it into a reply. That is what lets the flow
 * tests drive every row of both stories' I/O matrices through real HTTP without a
 * browser, and it keeps this file readable as a sequence of decisions.
 *
 * The outcome type is smaller than `AuthOutcome` because these endpoints answer
 * only JSON — no redirect, no `Set-Cookie`, no empty body. Reusing the auth one
 * would give three branches to routes that have one, and every reader would have
 * to work out which two never happen.
 */
export interface RoomOutcome {
  readonly status: number;
  readonly body: unknown;
}

@Injectable()
export class RoomsService {
  private readonly rooms: RoomsRuntime['rooms'];
  private readonly reservations: RoomsRuntime['reservations'];
  private readonly audit: RoomsRuntime['audit'];

  constructor(
    @Inject(ROOMS_RUNTIME) runtime: RoomsRuntime,
    /**
     * The SAME instance `AuthService` and `MoneyGateGuard` authenticate through —
     * built once in `AppModule.forConfig` and exported globally.
     *
     * A second way of answering "who is calling" is the defect
     * `SessionAuthenticator` was extracted to prevent. Here it would mean the
     * participant cap could come from one person's plan while the room came out
     * owned by another — or a token could be issued to one person against
     * another's ban.
     */
    @Inject(SESSION_AUTHENTICATOR) private readonly authenticator: SessionAuthenticator,
    /**
     * The already-validated environment (Story 2.2). Three values are read from
     * it, all LiveKit's: the key that becomes `iss`, the secret that signs, and the
     * URL the client is told to present the token to. The secret is read HERE and
     * handed to `mintRoomToken`; it is never put on an outcome.
     */
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.rooms = runtime.rooms;
    this.reservations = runtime.reservations;
    this.audit = runtime.audit;
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
   * The audit port this service now holds is for `issueRoomToken` and does not
   * change that.
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

  /**
   * `POST /v1/rooms/{roomId}/token` — Story 2.2, the one admission decision (AD-9).
   *
   * ## Four conditions, one method, in this order
   *
   * 1. **Who is calling.** No session is `401`, before anything else is looked at:
   *    the room store is not touched, the path parameter is not even read. A
   *    signed-out caller learns nothing about which rooms exist.
   * 2. **May this person enter rooms at all.** `roomAdmission` in
   *    `packages/domain` — the ONE reading of `bannedAt`, and the one place a
   *    future age rule goes. `banned` is `403`, and it is answered BEFORE the room
   *    is looked at, so a banned person cannot use this endpoint to probe which
   *    room ids exist. `underage` is declared and unreachable today (PRD US-0.5
   *    AC3: no floor on entering a room); it maps to `403` too, so the day a rule
   *    arrives the mapping is already here.
   * 3. **Is this a room, and is there a seat.** ONE call, `reserveSeat`, answers
   *    both inside one transaction with the room's row locked — `no_room` and
   *    `closed` come from the locked row, `full` from a count made under the lock,
   *    and `reserved` means a row exists. There is deliberately no `findRoomById`
   *    before it: a read outside the transaction is a hint, not a gate (AD-22),
   *    and everything it could say the transaction says better. A path parameter
   *    that is not a room id at all is `404` with the SAME body as "no such room",
   *    decided by the contract's own `isRoomId`, so the error does not publish the
   *    id format.
   * 4. **Mint, then record.** The token's `exp` is the RESERVATION's `expiresAt`,
   *    not `now + TTL` computed again here: one arithmetic, done once, in the
   *    adapter, so the seat and the token cannot disagree by a millisecond. The
   *    audit row is written after the token is minted and before the outcome is
   *    returned — an issuance that failed to record is a `500` without a token
   *    reaching anybody, which is the fail-closed direction.
   *
   * ## Refusals return, faults throw
   *
   * Every branch above that says no is a RETURN. A store that cannot answer — the
   * pool is gone, the transaction deadlocked — throws out of here, becomes the
   * `500` it is, and reserves nothing and records nothing. The matrix row "Store
   * lỗi giữa chừng" is that path, and there is no `try/catch` that could turn it
   * into a `409` telling somebody the room is full when we are broken.
   *
   * ## The same person asking twice
   *
   * `reserveSeat` renews rather than doubles, so a pre-join screen may call this
   * on every device change and a double-clicked "Vào phòng" eats one seat. The
   * response is a fresh token either way; the audit row carries the same
   * `reservation_id` both times, which is how a renewal reads in the trail.
   */
  async issueRoomToken(
    cookieHeader: unknown,
    params: unknown,
    requestId: string,
  ): Promise<RoomOutcome> {
    const caller = await this.authenticator.authenticate(cookieHeader);
    if (caller === null) {
      return { status: 401, body: makeError('unauthenticated', UNAUTHENTICATED_MESSAGE) };
    }
    const { user, at: now } = caller;

    // The person half of the decision, through the domain. `fixedAt(now)` hands
    // the rule the request's ONE instant, exactly as `MoneyGateGuard` does.
    if (roomAdmission(user, fixedAt(now)) !== 'admitted') {
      return { status: 403, body: makeError('forbidden', ROOM_ADMISSION_FORBIDDEN_MESSAGE) };
    }

    const roomId = readRoomIdParam(params);
    if (roomId === null) {
      return { status: 404, body: makeError('not_found', ROOM_NOT_FOUND_MESSAGE) };
    }

    const seat = await this.reservations.reserveSeat(
      { roomId, userId: user.id, holdForSeconds: ROOM_TOKEN_TTL_SECONDS },
      now,
    );
    switch (seat.kind) {
      case 'no_room':
        // Byte-identical to the not-a-room-id body above, on purpose.
        return { status: 404, body: makeError('not_found', ROOM_NOT_FOUND_MESSAGE) };
      case 'closed':
        return { status: 409, body: makeError('conflict', ROOM_CLOSED_MESSAGE) };
      case 'full':
        return { status: 409, body: makeError('conflict', ROOM_FULL_MESSAGE) };
      case 'reserved':
        break;
    }

    const { reservation } = seat;
    const token = await mintRoomToken({
      apiKey: this.config.LIVEKIT_API_KEY,
      apiSecret: this.config.LIVEKIT_API_SECRET,
      roomId,
      userId: user.id,
      issuedAt: now,
      expiresAt: reservation.expiresAt,
    });

    await recordRoomTokenIssued(this.audit, {
      requestId,
      userId: user.id,
      roomId,
      reservationId: reservation.id,
      occurredAt: now,
      expiresAt: reservation.expiresAt,
    });

    return {
      status: 201,
      // PARSED, not cast, for the reason `toRoomBody` gives: the schema is what
      // keeps a fifth key — the secret, say — off the wire without anybody's care.
      body: roomTokenResponseSchema.parse({
        token,
        url: this.config.LIVEKIT_URL,
        expires_at: reservation.expiresAt.toISOString(),
        room_id: roomId,
      }),
    };
  }
}

/**
 * `{roomId}` out of whatever Fastify put in `request.params`, or `null`.
 *
 * Total over `unknown`, like `parseCreateRoomRequest`: a params object that is
 * not an object, has no `roomId`, or carries one that is not a room id all answer
 * `null`, and `null` is a `404` — never a throw, never a `400` that names the
 * parameter.
 */
function readRoomIdParam(params: unknown): string | null {
  if (params === null || typeof params !== 'object') {
    return null;
  }
  const candidate = (params as Record<string, unknown>)['roomId'];
  return isRoomId(candidate) ? candidate : null;
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
