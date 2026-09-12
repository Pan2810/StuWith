import { INITIAL_ROOM_STATUS } from '@stuwith/contracts';
import type { CreateRoomInput, Room, RoomPort } from '@stuwith/domain';
import {
  assertValidCreateRoomInput,
  assertValidRoomId,
  normalizedCreateRoomInput,
} from '../pg/room-adapter';

/**
 * TD-5 — the second implementation, so the shared contract suite runs twice.
 *
 * It lives in `packages/db` and not in `packages/domain`: an in-memory store is
 * still an adapter, and AD-1 says the domain imports no adapter at all.
 *
 * The validation helpers are imported from the Postgres adapter rather than
 * re-written here. Re-writing them is exactly how two adapters end up disagreeing
 * about what a legal call is, and the disagreement only ever surfaces against the
 * implementation you did NOT develop against — which for `apps/api`'s flow suite is
 * always the Postgres one.
 *
 * ## No owner check, deliberately, and it is a real difference
 *
 * Postgres refuses a room whose `owner_user_id` names no `users` row: that is the
 * foreign key, and it is the same mechanism `ON DELETE RESTRICT` rides on. This
 * store has no `users` table to point at, so it cannot reproduce that refusal and
 * does not pretend to — the shared contract suite therefore asks only for what BOTH
 * can answer, and the foreign-key half is proved against a real PostgreSQL in
 * `rooms-migration.test.ts`. Faking it here would mean inventing a user registry
 * inside a room adapter, which is a second source of truth about people.
 */
export class InMemoryRoomAdapter implements RoomPort {
  private readonly rooms = new Map<string, Room>();
  private counter = 0;

  async createRoom(input: CreateRoomInput, now: Date): Promise<Room> {
    assertValidCreateRoomInput(input, now);
    // The SAME normalisation the PG adapter applies, from the same function. Doing
    // it in only one of the two is how the pair drifts: this store has no CHECK
    // constraint to disagree with a raw value, so it would accept forever what
    // Postgres refuses with `23514`.
    const stored = normalizedCreateRoomInput(input);

    const room: Room = {
      id: this.nextId(),
      ownerUserId: stored.ownerUserId,
      name: stored.name,
      description: stored.description,
      topic: stored.topic,
      visibility: stored.visibility,
      maxParticipants: stored.maxParticipants,
      // The schema's DEFAULT, spelled through the contract's constant rather than
      // as a literal — a room that started `closed` in one adapter and `open` in
      // the other would pass every test written against the one it was developed on.
      status: INITIAL_ROOM_STATUS,
      // Copied rather than shared: a caller that mutated the `Date` it passed in
      // would otherwise change what this store believes it recorded.
      createdAt: new Date(now.getTime()),
      updatedAt: new Date(now.getTime()),
    };
    this.rooms.set(room.id, room);
    return room;
  }

  async findRoomById(roomId: string): Promise<Room | null> {
    assertValidRoomId(roomId);
    return this.rooms.get(roomId) ?? null;
  }

  /** Test affordance: "no room was created" is a claim worth being able to make. */
  countRooms(): number {
    return this.rooms.size;
  }

  clear(): void {
    this.rooms.clear();
    this.counter = 0;
  }

  /**
   * A syntactically valid UUIDv7, for the reason `InMemoryIdentityAdapter` gives
   * about its own: an adapter that hands back `room-1` passes every test written
   * against itself and fails the moment a response is validated by `roomSchema`.
   *
   * The prefix differs from the identity adapter's, so a room id and a user id from
   * the same fixture are never the same string — an assertion that confused the two
   * would otherwise pass.
   */
  private nextId(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `019200f1-0000-7000-8000-${suffix}`;
  }
}
