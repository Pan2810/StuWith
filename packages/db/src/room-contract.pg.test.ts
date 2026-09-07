import type { Pool } from 'pg';
import { PgRoomAdapter } from './pg/room-adapter';
import { createPool } from './pool';
import { runRoomPortContract } from './test-kit';
import {
  applyMigrations,
  startPostgres,
  testcontainersDisabled,
  withClient,
  TEST_ROLE_PASSWORDS,
  type StartedPostgres,
} from './__testing__/postgres';

/**
 * CI gate #3, pass 2 of 2 for `RoomPort`.
 *
 * This is the pass the in-memory adapter cannot substitute for, and the reason is
 * not concurrency this time — it is the SCHEMA. Every bound the contract suite
 * asserts exists three times over: in `parseCreateRoomRequest`, in the shared
 * asserts, and as a CHECK constraint. Only this pass runs the third, and only this
 * pass proves the GRANTs from the story's migration are exactly sufficient for the
 * writes this adapter performs — it connects as `stuwith_api`, not as the owner.
 *
 * `rooms-migration.test.ts` is the other half and does not overlap: it is about the
 * posture (who may write, what a delete does), not about the port.
 */
let started: StartedPostgres | undefined;

runRoomPortContract({
  label: 'postgres-18 (testcontainers)',
  skip: testcontainersDisabled,
  createHarness: async () => {
    started = await startPostgres();
    await applyMigrations(started.connectionString);

    const pool = createPool(
      started.connectionStringFor('stuwith_api', TEST_ROLE_PASSWORDS.DB_ROLE_API_PASSWORD),
    );
    const adminUrl = started.connectionString;
    const faultingPools: Pool[] = [];

    return {
      port: new PgRoomAdapter(pool),

      // Truncated as the OWNER, not as `stuwith_api`: neither process role holds
      // DELETE or TRUNCATE on `rooms` — that is the whole point of the story — and
      // a reset that worked through the app role would be exercising a privilege
      // the product must never have.
      //
      // `rooms` before `users`, and `CASCADE` on the statement: `rooms.owner_user_id`
      // is ON DELETE RESTRICT, so truncating `users` alone would be refused by the
      // very constraint this story added.
      reset: async () => {
        await withClient(adminUrl, (client) =>
          client.query('TRUNCATE TABLE rooms, user_identities, sessions, users CASCADE'),
        );
      },

      // A REAL `users` row, because `rooms.owner_user_id` is a foreign key. Written
      // as the owner rather than through `PgIdentityAdapter`: this suite is about
      // rooms, and reaching for the identity adapter would make a room example fail
      // for an identity reason.
      createOwnerUserId: async () => {
        const result = await withClient(adminUrl, (client) =>
          client.query<{ id: string }>(
            `INSERT INTO users (display_name) VALUES ('Room Owner') RETURNING id`,
          ),
        );
        const id = result.rows[0]?.id;
        if (id === undefined) {
          throw new Error('could not create an owner for the room contract suite');
        }
        return id;
      },

      countRooms: async () => {
        const result = await withClient(adminUrl, (client) =>
          client.query<{ count: string }>('SELECT count(*)::text AS count FROM rooms'),
        );
        return Number(result.rows[0]?.count ?? '0');
      },

      createFaultingPort: async () => {
        const deadPool = createPool('postgres://nobody:nobody@127.0.0.1:1/nowhere', {
          connectionTimeoutMillis: 2_000,
        });
        deadPool.on('error', () => {});
        faultingPools.push(deadPool);
        return new PgRoomAdapter(deadPool);
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
