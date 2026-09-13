import type { ReserveSeatInput, ReserveSeatResult, RoomReservationPort } from '@stuwith/domain';
import { InMemoryRoomAdapter } from './in-memory/room-adapter';
import { InMemoryRoomReservationAdapter } from './in-memory/room-reservation-adapter';
import { assertValidReserveSeatInput } from './pg/room-reservation-adapter';
import { runRoomReservationPortContract } from './test-kit';

/**
 * CI gate #3, pass 1 of 2 for `RoomReservationPort`. Pass 2 is
 * `room-reservation-contract.pg.test.ts` and runs the identical suite against a
 * real PostgreSQL 18 — which is the pass the 130-concurrent example is really
 * about; here it proves only that there is no `await` between count and write.
 */
class UnreachableReservationAdapter implements RoomReservationPort {
  async reserveSeat(input: ReserveSeatInput, now: Date): Promise<ReserveSeatResult> {
    // Validation first, so the suite's "and NOT an input error" assertion is
    // meaningful rather than an accident of which check happened to run.
    assertValidReserveSeatInput(input, now);
    throw new Error('simulated store outage');
  }
}

let owners = 0;
const nextUserId = (): string => {
  owners += 1;
  return `019200f2-0000-7000-8000-${owners.toString(16).padStart(12, '0')}`;
};

runRoomReservationPortContract({
  label: 'in-memory',
  createHarness: async () => {
    const rooms = new InMemoryRoomAdapter();
    const adapter = new InMemoryRoomReservationAdapter(rooms);
    return {
      port: adapter,
      reset: async () => {
        adapter.clear();
        rooms.clear();
      },
      createRoom: async ({ maxParticipants, status }) => {
        const room = await rooms.createRoom(
          {
            ownerUserId: nextUserId(),
            name: 'Phong hoc',
            description: '',
            topic: 'on_thi',
            visibility: 'public',
            maxParticipants,
          },
          new Date('2026-09-12T08:00:00.000Z'),
        );
        if (status !== undefined) {
          // The fixture standing in for Story 4.8's write; see `plantStatus`.
          rooms.plantStatus(room.id, status);
        }
        return room.id;
      },
      createUserId: async () => nextUserId(),
      countRows: async (roomId) => adapter.countRows(roomId),
      countLive: async (roomId, now) => adapter.countLive(roomId, now),
      createFaultingPort: async () => new UnreachableReservationAdapter(),
    };
  },
});
