import type { RoomPort } from '@stuwith/domain';
import { describe, expect, it } from 'vitest';
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
 */

const usablePort = (): RoomPort =>
  ({
    createRoom: () => {
      throw new Error('no example here calls the port');
    },
    findRoomById: () => {
      throw new Error('no example here calls the port');
    },
  }) as unknown as RoomPort;

/** Every shape that is NOT a usable runtime, including the two that are not objects. */
const UNUSABLE: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['a runtime with no `rooms` member at all', {}],
  ['a runtime whose `rooms` is undefined', { rooms: undefined }],
  // The disjunct that used to be written by hand as `port === null`. It is covered
  // by the one `typeof` condition, and this row is what says so — delete the check
  // and this goes red with the rest.
  ['a runtime whose `rooms` is null', { rooms: null }],
  ['a runtime whose `rooms` is an object with no `createRoom`', { rooms: {} }],
  ['a runtime whose `createRoom` is not callable', { rooms: { createRoom: 'yes' } }],
  // Every method of the port, not just the one this story calls. A `rooms` carrying
  // only `createRoom` builds, boots, serves a create and throws on the first READ —
  // the same "green until a request arrives" failure, one level in.
  [
    'a runtime whose `rooms` has createRoom but no findRoomById',
    { rooms: { createRoom: () => undefined } },
  ],
];

describe('RoomsModule.forRuntime refuses a runtime it cannot serve requests with', () => {
  it.each(UNUSABLE)('throws for %s', (_label, runtime) => {
    expect(() => RoomsModule.forRuntime(runtime as RoomsRuntime)).toThrow(/no usable RoomPort/);
  });

  it('names the METHOD that is missing, not only the member', () => {
    // "your runtime is wrong" sends somebody reading the stack into the framework.
    // "your rooms port has no findRoomById" is one line from the fix.
    expect(() =>
      RoomsModule.forRuntime({ rooms: { createRoom: () => undefined } } as unknown as RoomsRuntime),
    ).toThrow(/findRoomById/);
  });

  it('names the member that is missing, so the message is actionable', () => {
    // A fail-closed check whose message does not say WHAT is missing sends somebody
    // reading the stack into the framework instead of into their own runtime
    // literal — the posture `packages/config` takes with a missing variable.
    expect(() => RoomsModule.forRuntime({} as RoomsRuntime)).toThrow(/`rooms` member/);
  });
});

describe('RoomsModule.forRuntime wires the module when the port is usable', () => {
  const runtime = { rooms: usablePort() } satisfies RoomsRuntime;

  it('returns a dynamic module for this class', () => {
    // The positive control. Every refusal above is satisfied perfectly by a method
    // that throws unconditionally, so without this the suite would pass against a
    // module that can never be built at all.
    expect(RoomsModule.forRuntime(runtime).module).toBe(RoomsModule);
  });

  it('hands the WHOLE runtime through as the provider value, not a copy of the port', () => {
    /**
     * `ROOMS_RUNTIME` resolves to the object `AppModule.forConfig` built, which is
     * what keeps ONE `pg` pool for the process. A provider that rebuilt a narrow
     * `{ rooms }` object here would pass every other example in this file and open a
     * second store the moment `RoomsRuntime` grows a second member.
     */
    const provider = RoomsModule.forRuntime(runtime).providers?.find(
      (candidate): candidate is { provide: symbol; useValue: unknown } =>
        typeof candidate === 'object' && candidate !== null && 'provide' in candidate,
    );

    expect(provider?.provide).toBe(ROOMS_RUNTIME);
    expect(provider?.useValue).toBe(runtime);
  });

  it('provides the service, so the controller has something to inject', () => {
    expect(RoomsModule.forRuntime(runtime).providers).toContain(RoomsService);
  });
});
