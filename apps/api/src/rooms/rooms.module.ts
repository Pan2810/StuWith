import { Module, type DynamicModule } from '@nestjs/common';
import type { RoomPort } from '@stuwith/domain';
import { RoomsController } from './rooms.controller';
import { ROOMS_RUNTIME, type RoomsRuntime } from './rooms.runtime';
import { RoomsService } from './rooms.service';

@Module({})
export class RoomsModule {
  /**
   * Same shape as `AuthModule.forConfig`: the runtime is passed in rather than
   * built here.
   *
   * It is REQUIRED rather than optional, and there is no default. A default
   * constructed inside this module would open a SECOND `pg` pool against the same
   * database as the same role — and, in a test, a second store that the assertions
   * are not looking at. `AppModule.forConfig` builds the one runtime and hands it to
   * everybody who needs an adapter.
   *
   * No `config` parameter, unlike `AuthModule`: nothing about creating a room reads
   * the environment. Taking one "for symmetry" would be an unused dependency that
   * the next person assumes is load-bearing.
   *
   * `SessionAuthenticator` is not provided here — `SessionAuthenticatorModule` is
   * `@Global()` and exports the one instance for the process, which is what makes
   * "who is calling" have a single answer across the guard, `AuthService` and this
   * module.
   */
  static forRuntime(runtime: RoomsRuntime): DynamicModule {
    /**
     * Fails CLOSED on a runtime that forgot this port, and the check is not
     * defensive noise — it closes a hole that was MEASURED on this branch.
     *
     * `apps/api/tsconfig.json:17` excludes `src/**\/*.test.ts`, so an `AuthRuntime`
     * object literal built in a test is typechecked by NOTHING — including one that
     * writes `: AuthRuntime` on itself. `app.shutdown.test.ts:30` does exactly that
     * and omits `rooms`, so `runtime.rooms` arrives here as `undefined`; and
     * `useValue: undefined` is a perfectly legal Nest provider, so the application
     * boots, every example passes, and the only symptom is a 500 on the first
     * request to reach `RoomsService`. A green `pnpm typecheck` says nothing at all
     * about it, because the file it would have to read is not in the program.
     *
     * So the wiring checks itself at construction, the posture `packages/config`
     * takes with the environment: refuse before a port is open, and NAME what is
     * missing. The `unknown` hop is what lets the comparison be written — TypeScript
     * rejects `RoomPort === undefined` as a comparison between non-overlapping
     * types, which is precisely the confidence that turned out to be unfounded.
     */
    const port: unknown = (runtime as Partial<RoomsRuntime> | null | undefined)?.rooms;
    /**
     * BOTH methods, not only the one this story calls.
     *
     * `RoomPort` declares `createRoom` and `findRoomById`. Checking one of them is
     * the same hole one level in: a runtime literal carrying only `createRoom`
     * builds, boots, serves the create, and throws at request time on the first read
     * — which is exactly the "green until a request arrives" failure this whole
     * check exists to make impossible. The list is derived from the port so a third
     * method cannot be added without being checked.
     */
    const REQUIRED_METHODS: readonly (keyof RoomPort)[] = ['createRoom', 'findRoomById'];
    const missing = REQUIRED_METHODS.filter(
      (method) =>
        typeof (port as Partial<Record<keyof RoomPort, unknown>> | null | undefined)?.[method] !==
        'function',
    );
    /**
     * ONE condition per method, and no `port === null` beside it. An earlier version
     * wrote that disjunct and it could never decide anything: `null?.createRoom` is
     * `undefined` through the optional chain above, so the `typeof` test already
     * answers for `null`. A dead disjunct in a fail-closed check is worse than noise
     * — it reads like a case somebody thought about, so the next person trusts the
     * pair instead of the one test that covers it.
     */
    if (missing.length > 0) {
      throw new Error(
        'RoomsModule.forRuntime was given no usable RoomPort. The runtime handed to ' +
          'AppModule.forConfig is missing its `rooms` member, or that member is missing ' +
          `${missing.join(' and ')} — every AuthRuntime literal, including the ones in ` +
          'test files that nothing typechecks, has to carry a complete one.',
      );
    }

    return {
      module: RoomsModule,
      controllers: [RoomsController],
      providers: [RoomsService, { provide: ROOMS_RUNTIME, useValue: runtime }],
    };
  }
}
