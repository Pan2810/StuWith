import type { CreateRoomInput, Room, RoomPort } from '@stuwith/domain';
import { InMemoryRoomAdapter } from './in-memory/room-adapter';
import { assertValidCreateRoomInput, assertValidRoomId } from './pg/room-adapter';
import { runRoomPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 for `RoomPort`. Pass 2 is `room-contract.pg.test.ts` and
 * runs the identical suite against real PostgreSQL 18.
 */
class UnreachableRoomAdapter implements RoomPort {
  async createRoom(input: CreateRoomInput, now: Date): Promise<Room> {
    // Validation runs first, so the suite's "and NOT a RoomInputError" assertion is
    // meaningful rather than an accident of which check happened to run.
    assertValidCreateRoomInput(input, now);
    throw new Error('simulated store outage');
  }

  async findRoomById(roomId: string): Promise<Room | null> {
    assertValidRoomId(roomId);
    throw new Error('simulated store outage');
  }
}

/**
 * Owner ids for the in-memory pass.
 *
 * They are UUID-shaped because `assertValidCreateRoomInput` refuses anything else —
 * the shared assert is what stops this store accepting an owner Postgres would
 * reject with `22P02`. They point at no `users` row, and cannot: this adapter has no
 * user registry and inventing one inside a ROOM store would be a second source of
 * truth about people. The foreign key itself is proved against a real database in
 * `rooms-migration.test.ts`, which is where it can be proved at all.
 */
let owners = 0;
const nextOwnerId = (): string => {
  owners += 1;
  return `019200f2-0000-7000-8000-${owners.toString(16).padStart(12, '0')}`;
};

runRoomPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const adapter = new InMemoryRoomAdapter();
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
      },
      createOwnerUserId: async () => nextOwnerId(),
      countRooms: async () => adapter.countRooms(),
      createFaultingPort: async () => new UnreachableRoomAdapter(),
    };
  },
});
