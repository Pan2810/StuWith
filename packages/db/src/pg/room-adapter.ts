import {
  MAX_PARTICIPANTS_CEILING,
  MAX_ROOM_DESCRIPTION_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  ROOM_TOPICS,
  ROOM_VISIBILITIES,
} from '@stuwith/contracts';
import type { RoomStatus, RoomTopic, RoomVisibility } from '@stuwith/contracts';
import type { CreateRoomInput, Room, RoomPort } from '@stuwith/domain';
import { RoomInputError } from '@stuwith/domain';
import type { Pool } from 'pg';

interface RoomRow {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  topic: string;
  visibility: string;
  max_participants: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * The select list, spelled once.
 *
 * Every column comes back as itself — there is no `to_char` here, because nothing
 * on this table is a calendar day. `created_at` and `updated_at` are `timestamptz`,
 * which the driver hands back as an instant, and an instant read on two machines is
 * the same instant.
 */
const ROOM_COLUMNS = [
  'id',
  'owner_user_id',
  'name',
  'description',
  'topic',
  'visibility',
  'max_participants',
  'status',
  'created_at',
  'updated_at',
].join(', ');

/**
 * `max_participants` arrives as a NUMBER, and that needs saying because most of
 * `pg`'s integer types do not.
 *
 * The driver parses `int8` (bigint) as a STRING, to avoid losing precision past
 * 2^53. `int4` — which is what this column is — is parsed as a number. So this cast
 * is honest for `integer` and would be a lie for `bigint`; `Number(...)` guards the
 * boundary anyway, so a column widened later cannot silently start handing the
 * domain a string that compares wrong against a numeric cap.
 */
function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    description: row.description,
    topic: row.topic as RoomTopic,
    visibility: row.visibility as RoomVisibility,
    maxParticipants: Number(row.max_participants),
    status: row.status as RoomStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * AD-1 keeps `pg` out of the domain; this is where it is allowed to live.
 *
 * ## One statement, no read-then-write, and nothing to arbitrate
 *
 * `findOrCreateByIdentity` needs a conditional write because two callbacks for one
 * identity race for one row. Creating a room has no such race: two people making
 * rooms with the same name are making two rooms, a name is a label rather than a
 * key, and there is no uniqueness rule for the database to arbitrate. So this is a
 * plain `INSERT ... RETURNING` and the absence of a transaction is a fact about the
 * problem rather than an omission.
 *
 * ## What is NOT caught
 *
 * Driver and server errors propagate untouched. A CHECK violation reaching here
 * means `parseCreateRoomRequest` and this file's own asserts both let something
 * through — that is a defect of ours, and laundering it into a normal-looking
 * result would hide the disagreement that produced it.
 *
 * ## There is no delete method, and that is load-bearing
 *
 * `stuwith_api` holds `INSERT, UPDATE` on `rooms` and nothing else, so a delete
 * written here would fail at the database with `42501` rather than work. The port
 * does not offer one either. Both halves are deliberate: Epic 2 forbids a hard
 * delete path for a room, and "the grant is missing" alone would leave the method
 * sitting there waiting for somebody to add the grant to make it work.
 */
export class PgRoomAdapter implements RoomPort {
  constructor(private readonly pool: Pool) {}

  async createRoom(input: CreateRoomInput, now: Date): Promise<Room> {
    assertValidCreateRoomInput(input, now);

    const result = await this.pool.query<RoomRow>(
      // `status` is deliberately absent from the column list: the schema's default
      // is `open`, and a caller able to choose could create a room already closed.
      `INSERT INTO rooms
         (owner_user_id, name, description, topic, visibility, max_participants, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING ${ROOM_COLUMNS}`,
      [
        input.ownerUserId,
        input.name,
        input.description,
        input.topic,
        input.visibility,
        input.maxParticipants,
        now,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('rooms INSERT ... RETURNING produced no row');
    }
    return toRoom(row);
  }

  async findRoomById(roomId: string): Promise<Room | null> {
    assertValidRoomId(roomId);
    const result = await this.pool.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`,
      [roomId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRoom(row);
  }
}

/**
 * Both adapters validate identically, for the same reason the identity adapters do:
 * otherwise Postgres raises a driver error where the in-memory store happily
 * accepts the value, and the two are only discovered to disagree in production —
 * against whichever implementation the author did NOT develop against.
 *
 * Every bound below is imported from `packages/contracts`, never retyped, so the
 * string the wire will accept and the string an adapter will accept cannot drift
 * (AD-13). The SCHEMA holds the same bounds a third time, which is not duplication
 * for its own sake: this layer produces a `RoomInputError` a caller can read, and
 * the column produces a refusal that survives a caller who skipped this layer.
 */
export function assertValidCreateRoomInput(
  input: CreateRoomInput,
  now: Date,
): asserts input is CreateRoomInput {
  if (input === null || typeof input !== 'object') {
    throw new RoomInputError('input must be an object');
  }
  assertValidUuidLike(input.ownerUserId, 'ownerUserId');
  assertValidRoomNow(now);

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new RoomInputError('name must be a non-empty string');
  }
  // The trimmed length, because that is the length the column stores and the
  // length `parseCreateRoomRequest` measured. Measuring the raw string here would
  // let a value this layer accepted be refused by the CHECK constraint.
  if (input.name.trim().length > MAX_ROOM_NAME_LENGTH) {
    throw new RoomInputError(`name must be at most ${String(MAX_ROOM_NAME_LENGTH)} characters`);
  }
  if (typeof input.description !== 'string') {
    // Never `null`: "no description" and "an empty description" are one fact, and
    // the column is `NOT NULL DEFAULT ''` for the same reason.
    throw new RoomInputError('description must be a string');
  }
  if (input.description.length > MAX_ROOM_DESCRIPTION_LENGTH) {
    throw new RoomInputError(
      `description must be at most ${String(MAX_ROOM_DESCRIPTION_LENGTH)} characters`,
    );
  }
  if (!(ROOM_TOPICS as readonly string[]).includes(input.topic)) {
    throw new RoomInputError('topic must be one of the declared room topics');
  }
  if (!(ROOM_VISIBILITIES as readonly string[]).includes(input.visibility)) {
    throw new RoomInputError('visibility must be one of the declared room visibilities');
  }
  assertValidMaxParticipants(input.maxParticipants);
}

/**
 * The cap, judged as a NUMBER rather than as a plan.
 *
 * A port has no idea what plan anybody is on and must not acquire one — that is
 * `apps/api`'s single lookup. What an adapter can say is that the number it was
 * handed is one the column will accept, which is the difference between a
 * `RoomInputError` naming the field and a `23514` from Postgres naming a
 * constraint.
 */
export function assertValidMaxParticipants(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RoomInputError('maxParticipants must be an integer');
  }
  if (value < 1 || value > MAX_PARTICIPANTS_CEILING) {
    throw new RoomInputError(
      `maxParticipants must be between 1 and ${String(MAX_PARTICIPANTS_CEILING)}`,
    );
  }
}

export function assertValidRoomId(roomId: unknown): asserts roomId is string {
  assertValidUuidLike(roomId, 'roomId');
}

export function assertValidRoomNow(now: unknown): asserts now is Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RoomInputError('now must be a valid Date');
  }
}

/**
 * A UUID, checked HERE rather than left to the driver.
 *
 * `rooms.id` and `rooms.owner_user_id` are `uuid` columns, so Postgres refuses a
 * non-UUID string with `22P02` — a syntax error whose message quotes the value the
 * caller supplied. The in-memory adapter has no such column and would happily store
 * `'nope'`, so without this the two adapters answer differently for the same call,
 * which is precisely what the shared contract suite exists to make impossible.
 *
 * The shape check is deliberately loose about the version nibble: the product mints
 * v7 through `uuidv7()`, the in-memory adapter mints something v7-shaped, and a
 * fixture in some later story may reasonably use a v4. What must be refused is a
 * string that is not a UUID at all.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuidLike(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    throw new RoomInputError(`${field} must be a UUID`);
  }
}
