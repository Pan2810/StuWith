import type { AuditPort, RoomPort, RoomReservationPort } from '@stuwith/domain';
import { describe, expect, it } from 'vitest';
import { testApiEnv } from '../__testing__/api-env';
import { RoomsModule } from './rooms.module';
import { ROOMS_RUNTIME, type RoomsRuntime } from './rooms.runtime';
import { RoomsService } from './rooms.service';

/**
 * The fail-closed check in `RoomsModule.forRuntime`, executed.
 *
 * Until this file existed the `throw` was reached by nothing: `app.shutdown.test.ts`
 * proves a runtime WITHOUT `rooms` is refused only in the sense that the application
 * fails to build, and no example ever called `forRuntime` directly to read the
 * message or to see which shapes it rejects. A guard nobody runs is a guard that can
 * be deleted, inverted or narrowed with a full green suite — which is precisely the
 * class of hole the guard itself was written to close, arriving one level up.
 *
 * The cast at each call site is the point rather than an inconvenience. Every shape
 * below is one that ARRIVES here in practice — `apps/api/tsconfig.json` excludes
 * `src/**\/*.test.ts`, so an `AuthRuntime` object literal written in a test file is
 * typechecked by nothing at all, including one that annotates itself. So the
 * examples have to be able to spell what the type system says is unspellable.
 *
 * Story 2.2 added two members, so the shapes below cover three ports.
 */
const config = testApiEnv();

const usableRooms = (): RoomPort =>
  ({
    createRoom: () => {
      throw new Error('no example here calls the port');
    },
    findRoomById: () => {
      throw new Error('no example here calls the port');
    },
  }) as unknown as RoomPort;

const usableReservations = (): RoomReservationPort =>
  ({
    reserveSeat: () => {
      throw new Error('no example here calls the port');
    },
  }) as unknown as RoomReservationPort;

const usableAudit = (): AuditPort =>
  ({
    append: () => {
      throw new Error('no example here calls the port');
    },
  }) as unknown as AuditPort;

const complete = (): RoomsRuntime => ({
  rooms: usableRooms(),
  reservations: usableReservations(),
  audit: usableAudit(),
});

/** Every shape that is NOT a usable runtime, including the two that are not objects. */
const UNUSABLE: ReadonlyArray<readonly [string, unknown, RegExp]> = [
  ['undefined', undefined, /no usable RoomPort/],
  ['null', null, /no usable RoomPort/],
  ['a runtime with no `rooms` member at all', {}, /no usable RoomPort/],
  ['a runtime whose `rooms` is undefined', { rooms: undefined }, /no usable RoomPort/],
  // The disjunct that used to be written by hand as `port === null`. It is covered
  // by the one `typeof` condition, and this row is what says so — delete the check
  // and this goes red with the rest.
  ['a runtime whose `rooms` is null', { rooms: null }, /no usable RoomPort/],
  ['a runtime whose `rooms` is an object with no `createRoom`', { rooms: {} }, /no usable RoomPort/],
  [
    'a runtime whose `createRoom` is not callable',
    { rooms: { createRoom: 'yes' } },
    /no usable RoomPort/,
  ],
  // Every method of the port, not just the one this story calls. A `rooms` carrying
  // only `createRoom` builds, boots, serves a create and throws on the first READ —
  // the same "green until a request arrives" failure, one level in.
  [
    'a runtime whose `rooms` has createRoom but no findRoomById',
    { rooms: { createRoom: () => undefined } },
    /no usable RoomPort/,
  ],
  // Story 2.2's two members. A runtime complete for 2.1 and missing either is the
  // EXACT shape every `AuthRuntime` literal written before this story has.
  [
    'a runtime complete for Story 2.1 but with no `reservations`',
    { ...complete(), reservations: undefined },
    /no usable RoomReservationPort/,
  ],
  [
    'a runtime whose `reservations` has no reserveSeat',
    { ...complete(), reservations: {} },
    /no usable RoomReservationPort/,
  ],
  [
    'a runtime complete but with no `audit`',
    { ...complete(), audit: undefined },
    /no usable AuditPort/,
  ],
  [
    'a runtime whose `audit` has no append',
    { ...complete(), audit: { append: 'later' } },
    /no usable AuditPort/,
  ],
];

describe('RoomsModule.forRuntime refuses a runtime it cannot serve requests with', () => {
  it.each(UNUSABLE)('throws for %s', (_label, runtime, message) => {
    expect(() => RoomsModule.forRuntime(config, runtime as RoomsRuntime)).toThrow(message);
  });

  it('names the METHOD that is missing, not only the member', () => {
    // "your runtime is wrong" sends somebody reading the stack into the framework.
    // "your rooms port has no findRoomById" is one line from the fix.
    expect(() =>
      RoomsModule.forRuntime(config, {
        ...complete(),
        rooms: { createRoom: () => undefined },
      } as unknown as RoomsRuntime),
    ).toThrow(/findRoomById/);
    expect(() =>
      RoomsModule.forRuntime(config, { ...complete(), reservations: {} } as unknown as RoomsRuntime),
    ).toThrow(/reserveSeat/);
  });

  it('names the member that is missing, so the message is actionable', () => {
    // A fail-closed check whose message does not say WHAT is missing sends somebody
    // reading the stack into the framework instead of into their own runtime
    // literal — the posture `packages/config` takes with a missing variable.
    expect(() => RoomsModule.forRuntime(config, {} as RoomsRuntime)).toThrow(/`rooms` member/);
    expect(() =>
      RoomsModule.forRuntime(config, { ...complete(), audit: undefined } as unknown as RoomsRuntime),
    ).toThrow(/`audit` member/);
  });
});

describe('RoomsModule.forRuntime wires the module when every port is usable', () => {
  const runtime = complete();

  it('returns a dynamic module for this class', () => {
    // The positive control. Every refusal above is satisfied perfectly by a method
    // that throws unconditionally, so without this the suite would pass against a
    // module that can never be built at all.
    expect(RoomsModule.forRuntime(config, runtime).module).toBe(RoomsModule);
  });

  it('hands the WHOLE runtime through as the provider value, not a copy of the ports', () => {
    /**
     * `ROOMS_RUNTIME` resolves to the object `AppModule.forConfig` built, which is
     * what keeps ONE `pg` pool for the process. A provider that rebuilt a narrow
     * `{ rooms }` object here would pass every other example in this file and open a
     * second store the moment `RoomsRuntime` grows a member — which it just did.
     */
    const provider = RoomsModule.forRuntime(config, runtime).providers?.find(
      (candidate): candidate is { provide: symbol; useValue: unknown } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'provide' in candidate &&
        candidate.provide === ROOMS_RUNTIME,
    );

    expect(provider?.useValue).toBe(runtime);
  });

  it('provides the config it was handed, so the token issuer can read the LiveKit pair', () => {
    const provider = RoomsModule.forRuntime(config, runtime).providers?.find(
      (candidate): candidate is { provide: symbol; useValue: unknown } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'provide' in candidate &&
        candidate.useValue === config,
    );
    expect(provider?.useValue).toBe(config);
  });

  it('provides the service, so the controller has something to inject', () => {
    expect(RoomsModule.forRuntime(config, runtime).providers).toContain(RoomsService);
  });
});
