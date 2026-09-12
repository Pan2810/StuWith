import type {
  ReserveSeatInput,
  ReserveSeatResult,
  RoomReservation,
  RoomReservationPort,
} from '@stuwith/domain';
import { RoomReservationInputError } from '@stuwith/domain';
import type { Pool, PoolClient } from 'pg';

interface ReservationRow {
  id: string;
  room_id: string;
  user_id: string;
  reserved_at: Date;
  expires_at: Date;
}

interface LockedRoomRow {
  status: string;
  max_participants: number;
}

const RESERVATION_COLUMNS = 'id, room_id, user_id, reserved_at, expires_at';

function toReservation(row: ReservationRow): RoomReservation {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    reservedAt: row.reserved_at,
    expiresAt: row.expires_at,
  };
}

/**
 * AD-22, as one transaction.
 *
 * ## `FOR UPDATE` on the room's row is the whole mechanism
 *
 * Every write to a room's reservations goes through this method, and this method
 * begins by locking the room's row in `rooms`. Two people racing for the last seat
 * therefore queue: the second waits on the first's row lock, and when it resumes
 * it counts a table the first has already committed to. Two DIFFERENT rooms share
 * no lock and never wait for each other. That is why it is a row lock and not an
 * advisory lock (a second mechanism beside the one the foreign key already gives
 * us) and not `SERIALIZABLE` (which would push a retry loop up into `apps/api`).
 *
 * `stuwith_api` already holds `UPDATE` on `rooms` from Story 2.1, which is the
 * privilege `SELECT ... FOR UPDATE` requires, so no new grant on `rooms` is needed
 * and none is made. The row is locked and never changed here: `status` is Story
 * 4.8's to move.
 *
 * ## The order inside the lock
 *
 * 1. lock the room, and answer `no_room` / `closed` from what the locked row says;
 * 2. delete this room's EXPIRED rows — after the lock, so the delete cannot
 *    interleave with another reservation for the same room;
 * 3. if the caller already holds a row, extend it and answer `reserved` with
 *    `renewed: true` — a person asking twice is one seat, not two;
 * 4. count what is left, answer `full` if the cap is reached, else insert.
 *
 * Steps 2 to 4 are three statements, and they are safe as three statements ONLY
 * because of step 1. Remove the `FOR UPDATE` and the count in step 4 is a read
 * followed by a write with a window in it — 130 people admitted to a room of 100,
 * measured on a real PostgreSQL 18 by the contract suite. The in-memory adapter
 * cannot show that difference, which is why the suite runs twice.
 *
 * ## What is NOT caught
 *
 * Driver and server errors propagate untouched, after a best-effort `ROLLBACK`. A
 * deadlock, a revoked GRANT or a dead pool is a fault, and a fault turned into
 * `full` would tell somebody the room is busy when the truth is that we are broken.
 */
export class PgRoomReservationAdapter implements RoomReservationPort {
  constructor(private readonly pool: Pool) {}

  async reserveSeat(input: ReserveSeatInput, now: Date): Promise<ReserveSeatResult> {
    assertValidReserveSeatInput(input, now);
    const expiresAt = expiryFor(now, input.holdForSeconds);

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Step 1 — the lock, and the two answers it gives for free.
      const locked = await client.query<LockedRoomRow>(
        `SELECT status, max_participants FROM rooms WHERE id = $1 FOR UPDATE`,
        [input.roomId],
      );
      const room = locked.rows[0];
      if (room === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'no_room' };
      }
      if (room.status !== 'open') {
        await client.query('ROLLBACK');
        return { kind: 'closed' };
      }

      // Step 2 — reap. `<=`: a seat is live while `now < expires_at`, so a row
      // whose instant has arrived is gone. This is the housekeeping AD-22 hands to
      // the writing process, and it happens under the lock so the count below is
      // exactly "seats somebody can still use".
      await client.query(
        `DELETE FROM room_reservations WHERE room_id = $1 AND expires_at <= $2`,
        [input.roomId, now],
      );

      // Step 3 — renewal. A live row for this person is extended, not doubled.
      // `reserved_at` is left as it was: the seat was taken the first time.
      const renewed = await client.query<ReservationRow>(
        `UPDATE room_reservations
            SET expires_at = $3
          WHERE room_id = $1 AND user_id = $2
          RETURNING ${RESERVATION_COLUMNS}`,
        [input.roomId, input.userId, expiresAt],
      );
      const extended = renewed.rows[0];
      if (extended !== undefined) {
        await client.query('COMMIT');
        return { kind: 'reserved', reservation: toReservation(extended), renewed: true };
      }

      // Step 4 — count, then write, under the lock taken in step 1.
      const counted = await client.query<{ live: string }>(
        `SELECT count(*)::text AS live FROM room_reservations WHERE room_id = $1`,
        [input.roomId],
      );
      const live = Number(counted.rows[0]?.live ?? '0');
      if (live >= Number(room.max_participants)) {
        await client.query('ROLLBACK');
        return { kind: 'full' };
      }

      const inserted = await client.query<ReservationRow>(
        `INSERT INTO room_reservations (room_id, user_id, reserved_at, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING ${RESERVATION_COLUMNS}`,
        [input.roomId, input.userId, now, expiresAt],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('room_reservations INSERT ... RETURNING produced no row');
      }

      await client.query('COMMIT');
      return { kind: 'reserved', reservation: toReservation(row), renewed: false };
    } catch (error) {
      // Best-effort rollback; the original fault is what the caller must see.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * The one arithmetic that turns a hold into an instant, shared by both adapters so
 * the row's `expires_at` and the in-memory store's cannot be a second apart.
 */
export function expiryFor(now: Date, holdForSeconds: number): Date {
  return new Date(now.getTime() + holdForSeconds * 1_000);
}

/**
 * Both adapters validate identically, for the reason every other pair does:
 * otherwise Postgres raises `22P02` for a non-UUID where the in-memory store would
 * simply miss, and the two are only discovered to disagree in production.
 */
export function assertValidReserveSeatInput(
  input: ReserveSeatInput,
  now: Date,
): asserts input is ReserveSeatInput {
  if (input === null || typeof input !== 'object') {
    throw new RoomReservationInputError('input must be an object');
  }
  assertUuidLike(input.roomId, 'roomId');
  assertUuidLike(input.userId, 'userId');
  if (
    typeof input.holdForSeconds !== 'number' ||
    !Number.isInteger(input.holdForSeconds) ||
    input.holdForSeconds <= 0
  ) {
    // Zero or negative would produce a row the CHECK refuses (`expires_at >
    // reserved_at`) in one store and a seat that is born expired in the other.
    throw new RoomReservationInputError('holdForSeconds must be a positive integer');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RoomReservationInputError('now must be a valid Date');
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidLike(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    throw new RoomReservationInputError(`${field} must be a UUID`);
  }
}
