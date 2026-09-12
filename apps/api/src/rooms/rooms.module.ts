import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import type { AuditPort, RoomPort, RoomReservationPort } from '@stuwith/domain';
import { APP_CONFIG } from '../config.token';
import { RoomsController } from './rooms.controller';
import { ROOMS_RUNTIME, type RoomsRuntime } from './rooms.runtime';
import { RoomsService } from './rooms.service';

/**
 * What a usable runtime has to carry, member by member and method by method.
 *
 * Derived from the port types, so a method added to a port cannot be added
 * without being checked here — the `satisfies` is what makes a typo in a method
 * name a compile error rather than a check that silently looks for nothing.
 */
const REQUIRED: ReadonlyArray<{
  readonly member: keyof RoomsRuntime;
  readonly port: string;
  readonly methods: readonly string[];
}> = [
  {
    member: 'rooms',
    port: 'RoomPort',
    methods: ['createRoom', 'findRoomById'] satisfies readonly (keyof RoomPort)[],
  },
  {
    member: 'reservations',
    port: 'RoomReservationPort',
    methods: ['reserveSeat'] satisfies readonly (keyof RoomReservationPort)[],
  },
  {
    member: 'audit',
    port: 'AuditPort',
    methods: ['append'] satisfies readonly (keyof AuditPort)[],
  },
];

@Module({})
export class RoomsModule {
  /**
   * Same shape as `AuthModule.forConfig`: the config and the runtime are passed in
   * rather than built here.
   *
   * The runtime is REQUIRED rather than optional, and there is no default. A
   * default constructed inside this module would open a SECOND `pg` pool against
   * the same database as the same role — and, in a test, a second store that the
   * assertions are not looking at. `AppModule.forConfig` builds the one runtime
   * and hands it to everybody who needs an adapter.
   *
   * ## `config` arrived with Story 2.2, and the docblock that said "no config" is
   * ## gone with it
   *
   * Story 2.1's module took no `ApiEnv` because nothing about creating a room read
   * the environment, and taking one "for symmetry" would have been an unused
   * dependency the next person assumed was load-bearing. Issuing a token reads
   * three variables — `LIVEKIT_API_KEY` for `iss`, `LIVEKIT_API_SECRET` to sign,
   * `LIVEKIT_URL` for the response — so the parameter is now load-bearing, and it
   * is the SAME already-validated object `main.ts` built before a port was opened
   * (AD-14). It is provided under `APP_CONFIG` for this module's own injector,
   * exactly as `AuthModule` provides it for its own.
   *
   * `SessionAuthenticator` is not provided here — `SessionAuthenticatorModule` is
   * `@Global()` and exports the one instance for the process, which is what makes
   * "who is calling" have a single answer across the guard, `AuthService` and this
   * module.
   */
  static forRuntime(config: ApiEnv, runtime: RoomsRuntime): DynamicModule {
    /**
     * Fails CLOSED on a runtime that forgot a port, and the check is not defensive
     * noise — it closes a hole that was MEASURED on the 2.1 branch.
     *
     * `apps/api/tsconfig.json` excludes `src/**\/*.test.ts`, so an `AuthRuntime`
     * object literal built in a test is typechecked by NOTHING — including one
     * that writes `: AuthRuntime` on itself. `app.shutdown.test.ts` did exactly
     * that and omitted `rooms`, so `runtime.rooms` arrived here as `undefined`;
     * `useValue: undefined` is a perfectly legal Nest provider, so the application
     * booted, every example passed, and the only symptom was a 500 on the first
     * request to reach `RoomsService`. Story 2.2 adds two members to the runtime,
     * which is two more ways for the same literal to be incomplete.
     *
     * So the wiring checks itself at construction, the posture `packages/config`
     * takes with the environment: refuse before a port is open, and NAME what is
     * missing — the member AND the method, every method of every port, because a
     * `rooms` carrying only `createRoom` builds, boots, serves the create and
     * throws on the first read. The `unknown` hop is what lets the comparison be
     * written at all.
     */
    const partial = runtime as Partial<Record<keyof RoomsRuntime, unknown>> | null | undefined;
    for (const { member, port, methods } of REQUIRED) {
      const value = partial?.[member] as Partial<Record<string, unknown>> | null | undefined;
      // ONE condition per method, and no `value === null` beside it: `null?.x` is
      // `undefined` through the optional chain, so `typeof` already answers for it.
      const missing = methods.filter((method) => typeof value?.[method] !== 'function');
      if (missing.length > 0) {
        throw new Error(
          `RoomsModule.forRuntime was given no usable ${port}. The runtime handed to ` +
            `AppModule.forConfig is missing its \`${member}\` member, or that member is ` +
            `missing ${missing.join(' and ')} — every AuthRuntime literal, including the ` +
            'ones in test files that nothing typechecks, has to carry a complete one.',
        );
      }
    }

    return {
      module: RoomsModule,
      controllers: [RoomsController],
      providers: [
        RoomsService,
        { provide: APP_CONFIG, useValue: config },
        { provide: ROOMS_RUNTIME, useValue: runtime },
      ],
    };
  }
}
