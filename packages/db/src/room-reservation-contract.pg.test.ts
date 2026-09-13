import type { Pool } from 'pg';
import { PgRoomReservationAdapter } from './pg/room-reservation-adapter';
import { createPool } from './pool';
import { runRoomReservationPortContract } from './test-kit';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #3, pass 2 of 2 for `RoomReservationPort` — and the pass that matters.
 *
 * The 130-concurrent example in the shared suite is about `FOR UPDATE`, and only
 * a real database with real connections can show what its absence costs. It is
 * also the pass that proves the GRANTs from this story's migration are exactly
 * sufficient: the adapter connects as `stuwith_api` and runs a `SELECT ... FOR
 * UPDATE` on `rooms` (which needs `UPDATE`, held since 2.1) and `DELETE` on
 * `room_reservations` (granted by 2.2, to this role alone).
 *
 * `room-reservations-migration.test.ts` is the other half and does not overlap:
 * it is about posture (who may write, what a delete does), not about the port.
 */
let started: StartedPostgres | undefined;

runRoomReservationPortContract({
  label: 'postgres-18 (testcontainers)',
  skip: testcontainersDisabled,
  createHarness: async () => {
    started = await startPostgres();
    await applyMigrations(started.connectionString);

    /**
     * A WIDER pool than production's ten, on purpose. The property under test —
     * never more than the cap, at any instant — has to hold at every pool size,
     * and the mutation this suite exists to catch (dropping `FOR UPDATE`) is a
     * race in the count→insert window: with ten connections it lost 108–109 of
     * 130 on a cold pool and, once in a while, exactly 100 on a warm one, which
     * is a mutation that is red "usually". Thirty-two transactions in flight
     * collide in that window on every run.
     */
    const pool = createPool(
      started.connectionStringFor('stuwith_api', TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD),
      { max: 32 },
    );
    const adminUrl = started.connectionString;
    const faultingPools: Pool[] = [];

    const createUserId = async (): Promise<string> => {
      const result = await withClient(adminUrl, (client) =>
        client.query<{ id: string }>(
          `INSERT INTO users (display_name) VALUES ('Seat Taker') RETURNING id`,
        ),
      );
      const id = result.rows[0]?.id;
      if (id === undefined) {
        throw new Error('could not create a user for the reservation contract suite');
      }
      return id;
    };

    return {
      port: new PgRoomReservationAdapter(pool),

      // As the OWNER: neither process role holds TRUNCATE on anything. `CASCADE`
      // because `room_reservations` references both `rooms` and `users` with
      // RESTRICT, so truncating those alone would be refused by the constraints
      // this story added.
      reset: async () => {
        await withClient(adminUrl, (client) =>
          client.query(
            'TRUNCATE TABLE room_reservations, rooms, user_identities, sessions, users CASCADE',
          ),
        );
      },

      // A `closing`/`closed` room is planted as the OWNER, because no port and no
      // role can move a room's status today (Story 4.8). Same posture as the
      // in-memory harness's `plantStatus`.
      createRoom: async ({ maxParticipants, status }) => {
        const ownerId = await createUserId();
        const result = await withClient(adminUrl, (client) =>
          client.query<{ id: string }>(
            `INSERT INTO rooms (owner_user_id, name, topic, visibility, max_participants, status)
             VALUES ($1, 'Phong hoc', 'on_thi', 'public', $2, $3) RETURNING id`,
            [ownerId, maxParticipants, status ?? 'open'],
          ),
        );
        const id = result.rows[0]?.id;
        if (id === undefined) {
          throw new Error('could not create a room for the reservation contract suite');
        }
        return id;
      },

      createUserId,

      countRows: async (roomId) => {
        const result = await withClient(adminUrl, (client) =>
          client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM room_reservations WHERE room_id = $1',
            [roomId],
          ),
        );
        return Number(result.rows[0]?.count ?? '0');
      },

      // A connection of its OWN per read, never the adapter's pool: under READ
      // COMMITTED a fresh client sees committed rows only, so a sample taken
      // mid-burst is a true reading of what other transactions could see — the
      // number the port's "at no instant" promise is about.
      countLive: async (roomId, now) => {
        const result = await withClient(adminUrl, (client) =>
          client.query<{ live: string }>(
            'SELECT count(*)::text AS live FROM room_reservations WHERE room_id = $1 AND expires_at > $2',
            [roomId, now],
          ),
        );
        return Number(result.rows[0]?.live ?? '0');
      },

      createFaultingPort: async () => {
        const deadPool = createPool('postgres://nobody:nobody@127.0.0.1:1/nowhere', {
          connectionTimeoutMillis: 2_000,
        });
        deadPool.on('error', () => {});
        faultingPools.push(deadPool);
        return new PgRoomReservationAdapter(deadPool);
      },

      teardown: async () => {
        const failures: unknown[] = [];
        const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
          try {
            await fn();
          } catch (error) {
            failures.push(new Error(`${label} failed: ${String(error)}`));
          }
        };

        for (const deadPool of faultingPools) {
          await attempt('faulting pool end', () => deadPool.end());
        }
        await attempt('pool end', () => pool.end());
        await attempt('container stop', async () => {
          await started?.stop();
        });
        started = undefined;

        if (failures.length > 0) {
          throw new AggregateError(failures, 'teardown did not complete cleanly');
        }
      },
    };
  },
});
