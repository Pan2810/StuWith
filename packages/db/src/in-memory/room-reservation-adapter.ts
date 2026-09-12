import type {
  ReserveSeatInput,
  ReserveSeatResult,
  Room,
  RoomReservation,
  RoomReservationPort,
} from '@stuwith/domain';
import { assertValidReserveSeatInput, expiryFor } from '../pg/room-reservation-adapter';

/**
 * Where the in-memory store reads rooms from. `InMemoryRoomAdapter` satisfies it;
 * taking the narrow shape rather than the class keeps this adapter from reaching
 * for `createRoom` or `clear` on a store it does not own.
 */
export interface RoomLookup {
  findRoomById(roomId: string): Promise<Room | null>;
}

/**
 * TD-5 — the second implementation, so the shared contract suite runs twice.
 *
 * ## The same rules as Postgres, reached a different way
 *
 * Postgres serialises writers with `FOR UPDATE`. Here there is one JavaScript
 * thread, and the guarantee is that there is NO `await` between reading the room's
 * live count and writing the new row: the reap, the renewal check, the count and
 * the insert are one synchronous block, so two callers interleaved by `Promise.all`
 * cannot both see "one seat left". The one `await` — looking the room up — happens
 * BEFORE that block, and looking a room up changes nothing.
 *
 * Insert an `await` anywhere between `reap(...)` and `seats.set(...)` and the
 * 130-concurrent example in the contract suite admits more than the cap. That is
 * the in-memory shape of the same defect removing `FOR UPDATE` produces in the
 * Postgres adapter — and the reason the suite runs against both.
 *
 * ## What it cannot show
 *
 * A single thread cannot demonstrate that the lock is what makes the Postgres
 * adapter correct; it can only demonstrate the rule. The concurrency proof lives
 * in `room-reservation-contract.pg.test.ts`, on a real PostgreSQL 18.
 */
export class InMemoryRoomReservationAdapter implements RoomReservationPort {
  /** room id -> (user id -> reservation) */
  private readonly seats = new Map<string, Map<string, RoomReservation>>();
  private counter = 0;

  constructor(private readonly rooms: RoomLookup) {}

  async reserveSeat(input: ReserveSeatInput, now: Date): Promise<ReserveSeatResult> {
    assertValidReserveSeatInput(input, now);
    const expiresAt = expiryFor(now, input.holdForSeconds);

    // The ONE await, and it is a read of a different store.
    const room = await this.rooms.findRoomById(input.roomId);
    if (room === null) {
      return { kind: 'no_room' };
    }
    if (room.status !== 'open') {
      return { kind: 'closed' };
    }

    // ---- no `await` from here to the write ----------------------------------
    const seats = this.seatsOf(input.roomId);

    // Reap, under the same rule as the SQL: live while `now < expiresAt`.
    for (const [userId, seat] of seats) {
      if (seat.expiresAt.getTime() <= now.getTime()) {
        seats.delete(userId);
      }
    }

    const held = seats.get(input.userId);
    if (held !== undefined) {
      const extended: RoomReservation = { ...held, expiresAt: new Date(expiresAt.getTime()) };
      seats.set(input.userId, extended);
      return { kind: 'reserved', reservation: extended, renewed: true };
    }

    if (seats.size >= room.maxParticipants) {
      return { kind: 'full' };
    }

    const reservation: RoomReservation = {
      id: this.nextId(),
      roomId: input.roomId,
      userId: input.userId,
      reservedAt: new Date(now.getTime()),
      expiresAt: new Date(expiresAt.getTime()),
    };
    seats.set(input.userId, reservation);
    return { kind: 'reserved', reservation, renewed: false };
  }

  /**
   * Test affordance: rows for this room regardless of expiry — the count that
   * says "the expired seat was really removed" rather than "it is not counted".
   */
  countRows(roomId: string): number {
    return this.seats.get(roomId)?.size ?? 0;
  }

  clear(): void {
    this.seats.clear();
    this.counter = 0;
  }

  private seatsOf(roomId: string): Map<string, RoomReservation> {
    let seats = this.seats.get(roomId);
    if (seats === undefined) {
      seats = new Map();
      this.seats.set(roomId, seats);
    }
    return seats;
  }

  /**
   * A syntactically valid UUIDv7, with a prefix distinct from the identity and
   * room adapters' so that a reservation id can never equal a user id or a room id
   * from the same fixture.
   */
  private nextId(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `019200f3-0000-7000-8000-${suffix}`;
  }
}
