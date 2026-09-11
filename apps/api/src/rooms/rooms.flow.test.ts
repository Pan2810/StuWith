import { RequestMethod } from '@nestjs/common';
// The metadata KEYS Nest itself writes with. They happen to be `'path'` and
// `'method'` today; they are Nest's to change, and a test that spells them by hand
// reads `undefined` on the day they do.
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  CREATE_ROOM_INVALID_MESSAGE,
  MAX_PARTICIPANTS_CEILING,
  MAX_ROOM_DESCRIPTION_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  PLAN_PARTICIPANT_LIMITS,
  ROOMS_PATH,
  UNAUTHENTICATED_MESSAGE,
  USER_PLANS,
  errorEnvelopeSchema,
  roomSchema,
  type UserPlan,
} from '@stuwith/contracts';
import type { IdentityPort, User } from '@stuwith/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, createAuthHarness, type AuthHarness } from '../auth/__testing__/auth-harness';
import { RoomsController } from './rooms.controller';

/**
 * Every row of Story 2.1's I/O matrix, driven through a real NestJS + Fastify
 * process over real HTTP.
 *
 * A matrix with no test is a matrix with no effect, so each `it` below names the
 * row it covers. What this suite CANNOT cover is stated once here rather than
 * repeated: Node's `fetch` ignores CORS entirely, so nothing in this file exercises
 * the browser↔API boundary the story's first probe is about — that lives in
 * `tests/e2e/web/tao-phong.spec.ts` and runs in Chromium. And nothing here runs
 * under a Postgres role, so the AD-8 half is `packages/db/src/rooms-migration.test.ts`.
 * Three suites, three media, no overlap.
 */
let harness: AuthHarness;

/**
 * Which plan the person behind a session is on, for the duration of one example.
 *
 * There is no way to change a plan through the product — Epic 5 owns payment and
 * upgrades, and `users.plan` is written only by its own `DEFAULT` today. So the
 * only honest way to reach the Study Circle and Campus rows of the matrix is to
 * make the identity port answer differently, which is exactly what `wrapIdentity`
 * exists for: it wraps the real adapter, so the login that has to happen first
 * still happens for real and only the one field under test is overridden.
 *
 * `null` means "no override", which is what every other example in this file runs
 * under.
 */
let planOverride: UserPlan | null = null;

beforeAll(async () => {
  harness = await createAuthHarness({
    wrapIdentity: (base: IdentityPort): IdentityPort => ({
      findOrCreateByIdentity: (identity, now) => base.findOrCreateByIdentity(identity, now),
      recordDateOfBirth: (userId, dateOfBirth, now) =>
        base.recordDateOfBirth(userId, dateOfBirth, now),
      // The ONE method the override touches, and it is the one
      // `SessionAuthenticator` calls — so the plan that reaches `RoomsService` is
      // the plan a real signed-in person's row would have carried.
      findUserById: async (userId: string): Promise<User | null> => {
        const user = await base.findUserById(userId);
        if (user === null || planOverride === null) {
          return user;
        }
        return { ...user, plan: planOverride };
      },
    }),
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  planOverride = null;
  harness.identity.clear();
  harness.rooms.clear();
  harness.sessions.clear();
  harness.audit.clear();
});

const googleProfile = {
  subject: 'google-subject-1',
  email: 'an.nguyen@fpt.edu.vn',
  name: 'An Nguyen',
  picture: 'https://lh3.googleusercontent.com/a/an',
};

/** A body that every field-level example starts from and overrides one field of. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Ôn thi cuối kỳ môn Giải tích',
    description: 'Học nhóm buổi tối, bật mic khi cần.',
    topic: 'on_thi',
    visibility: 'public',
    ...overrides,
  };
}

/** `POST /v1/rooms` with a JSON body, through the jar a login produced. */
async function createRoom(jar: CookieJar | undefined, body: unknown): Promise<Response> {
  return harness.request(ROOMS_PATH, {
    ...(jar === undefined ? {} : { jar }),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A signed-in browser, on whichever plan `planOverride` currently names. */
async function signedIn(): Promise<CookieJar> {
  const { jar } = await harness.login('google', googleProfile);
  return jar;
}

describe('Matrix: a valid create', () => {
  it('answers 201 with an open room owned by the caller, capped by their plan', async () => {
    const jar = await signedIn();

    const response = await createRoom(jar, validBody());

    // 201, not 200: a resource was created, and the status is the only part of the
    // answer a client can branch on before parsing anything.
    expect(response.status).toBe(201);
    // PARSED against the published schema, not read field by field. A body that is
    // not a `Room` is a body a mobile client could not use, and asserting three
    // fields out of it would not have noticed a fourth going missing.
    const room = roomSchema.parse(await response.json());

    expect(room.status).toBe('open');
    expect(room.max_participants).toBe(PLAN_PARTICIPANT_LIMITS.study_buddy);
    expect(room.name).toBe('Ôn thi cuối kỳ môn Giải tích');
    expect(room.topic).toBe('on_thi');
    expect(room.visibility).toBe('public');
  });

  it('owns the room to the person holding the session, not to anybody named in the body', async () => {
    const jar = await signedIn();
    const me = await harness.request('/v1/auth/me', { jar });
    const profile = (await me.json()) as { id: string };

    const response = await createRoom(
      jar,
      // A body naming somebody else. `owner_user_id` is not in the contract, so it
      // is stripped rather than refused — and the owner still comes from the session.
      validBody({ owner_user_id: '019200f0-0000-7000-8000-0000000000ff' }),
    );

    const room = roomSchema.parse(await response.json());
    expect(room.owner_user_id).toBe(profile.id);
  });

  it('really stored it — the room is readable from the port afterwards', async () => {
    // A 201 carrying a plausible body proves nothing about the store. This is the
    // assertion that says the row exists rather than that the response was built.
    const jar = await signedIn();
    const room = roomSchema.parse(await (await createRoom(jar, validBody())).json());

    const stored = await harness.rooms.findRoomById(room.id);

    expect(stored).not.toBeNull();
    expect(stored?.name).toBe(room.name);
    expect(stored?.maxParticipants).toBe(room.max_participants);
    expect(await harness.rooms.countRooms()).toBe(1);
  });

  it('keeps an empty description as an empty string', async () => {
    const jar = await signedIn();
    const room = roomSchema.parse(
      await (await createRoom(jar, validBody({ description: '' }))).json(),
    );
    expect(room.description).toBe('');
  });

  it('trims a name before storing it, so one room name has one spelling', async () => {
    const jar = await signedIn();
    const room = roomSchema.parse(
      await (await createRoom(jar, validBody({ name: '   Lớp tối   ' }))).json(),
    );
    expect(room.name).toBe('Lớp tối');
  });
});

describe('Matrix: the cap comes from the plan, and from nothing else', () => {
  /**
   * All three plans, through real HTTP, ending at the numbers the epic publishes.
   *
   * Campus is the row worth naming: the epic writes the band as "45–100", and 45 is
   * the DEFAULT while 100 is the technical ceiling the column refuses to store past.
   * Reading the top of the band as the default would give every Campus room a cap
   * more than twice what the plan promises — a capacity decision made by reading a
   * range from the wrong end, and one that nothing downstream would question.
   */
  it.each(USER_PLANS.map((plan) => [plan, PLAN_PARTICIPANT_LIMITS[plan]] as const))(
    'a %s room is created with a cap of %d',
    async (plan, limit) => {
      planOverride = plan;
      const jar = await signedIn();

      const room = roomSchema.parse(await (await createRoom(jar, validBody())).json());

      expect(room.max_participants).toBe(limit);
    },
  );

  it('gives a Campus room 45, and specifically not the technical ceiling', async () => {
    planOverride = 'campus';
    const jar = await signedIn();

    const room = roomSchema.parse(await (await createRoom(jar, validBody())).json());

    expect(room.max_participants).toBe(45);
    expect(room.max_participants).not.toBe(MAX_PARTICIPANTS_CEILING);
  });

  /**
   * Matrix row: "Client tự đặt trần — bỏ qua; trần vẫn từ gói. Không báo lỗi."
   *
   * Ignored in SILENCE rather than refused, and the silence is deliberate: a `400`
   * here would make `max_participants` part of the contract in the negative and
   * tell a caller exactly which lever exists to look for. The field is not in
   * `createRoomRequestSchema`, so zod strips it and nothing downstream can see that
   * it was ever sent.
   */
  it.each([
    ['a bigger number', 100],
    ['a smaller number', 2],
    ['the technical ceiling', MAX_PARTICIPANTS_CEILING],
    ['a nonsense value', 'lots'],
  ])('ignores %s sent as max_participants, without refusing the request', async (_label, sent) => {
    const jar = await signedIn();

    const response = await createRoom(jar, validBody({ max_participants: sent }));

    expect(response.status).toBe(201);
    const room = roomSchema.parse(await response.json());
    expect(room.max_participants).toBe(PLAN_PARTICIPANT_LIMITS.study_buddy);
  });

  it('does not publish the plan itself, only the number it resolved to', async () => {
    // A plan is a BILLING fact. Story 2.2 hands this body to everybody who joins,
    // and the cap is the whole of what anybody joining needs to know.
    planOverride = 'campus';
    const jar = await signedIn();

    const body = (await (await createRoom(jar, validBody())).json()) as Record<string, unknown>;

    expect(Object.keys(body)).not.toContain('plan');
    expect(JSON.stringify(body)).not.toContain('campus');
  });

  it('never recomputes it — the stored number is what a later read reports', async () => {
    // The acceptance criterion's second half. The cap is fixed at creation, so a
    // plan that changes afterwards does not move it. The plan is changed here in
    // the one way this product can change one at all.
    planOverride = 'campus';
    const jar = await signedIn();
    const room = roomSchema.parse(await (await createRoom(jar, validBody())).json());

    planOverride = 'study_buddy';

    expect((await harness.rooms.findRoomById(room.id))?.maxParticipants).toBe(45);
  });
});

describe('Matrix: who is calling', () => {
  it('answers 401 with no cookie at all, and writes nothing', async () => {
    const response = await createRoom(undefined, validBody());

    expect(response.status).toBe(401);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('unauthenticated');
    // The SAME sentence every other 401 in `/v1` carries. A caller that could tell
    // two 401s apart has been told something about a request the system never
    // looked at.
    expect(envelope.error.message).toBe(UNAUTHENTICATED_MESSAGE);
    // "Không chạm DB": the body was never even parsed, and no room exists.
    expect(await harness.rooms.countRooms()).toBe(0);
  });

  it('answers 401 for a session cookie this process never issued', async () => {
    const jar = new CookieJar();
    jar.set('stuwith_session', 'not-a-token-we-minted');

    const response = await createRoom(jar, validBody());

    expect(response.status).toBe(401);
    expect(await harness.rooms.countRooms()).toBe(0);
  });

  it('refuses BEFORE it judges the body — a signed-out caller with rubbish still gets 401', async () => {
    // The order matters: answering 400 here would tell somebody with no session
    // that their body was the problem, which is a fact about a request nobody was
    // authorised to make.
    const response = await createRoom(undefined, { name: '' });

    expect(response.status).toBe(401);
  });
});

describe('Matrix: the body', () => {
  const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
    ['a blank name', validBody({ name: '  ' })],
    ['an empty name', validBody({ name: '' })],
    ['a missing name', { description: '', topic: 'khac', visibility: 'public' }],
    ['a name past the ceiling', validBody({ name: 'x'.repeat(MAX_ROOM_NAME_LENGTH + 1) })],
    [
      'a description past the ceiling',
      validBody({ description: 'x'.repeat(MAX_ROOM_DESCRIPTION_LENGTH + 1) }),
    ],
    ['a topic nobody declared', validBody({ topic: 'xyz' })],
    ['a missing topic', { name: 'Lớp tối', description: '', visibility: 'public' }],
    ['a visibility nobody declared', validBody({ visibility: 'secret' })],
    ['a missing visibility', { name: 'Lớp tối', description: '', topic: 'khac' }],
    ['a name that is not a string', validBody({ name: 42 })],
    ['a description that is not a string', validBody({ description: null })],
  ];

  it.each(REFUSED)('answers 400 for %s, and writes nothing', async (_label, body) => {
    const jar = await signedIn();

    const response = await createRoom(jar, body);

    expect(response.status).toBe(400);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('validation_failed');
    // One sentence for one mistake, shared with `apps/web` so the person cannot get
    // two different explanations depending on whether the network was involved.
    expect(envelope.error.message).toBe(CREATE_ROOM_INVALID_MESSAGE);
    expect(await harness.rooms.countRooms()).toBe(0);
  });

  /**
   * Matrix row: "Body không phải object — `null`, mảng, chuỗi. Không ném, không 500."
   *
   * These are sent as RAW strings rather than as objects, so what arrives at Fastify
   * is exactly the byte sequence named. `parseCreateRoomRequest` is total over
   * `unknown` for this reason: `body.name` on a `null` throws, and a throw here
   * would be a 500 on a malformed request — which tells a prober they found
   * something.
   */
  it.each([
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON array of rooms', '[{"name":"a","description":"","topic":"khac","visibility":"public"}]'],
    ['a JSON string', '"a room"'],
    ['a JSON number', '7'],
    ['a JSON boolean', 'true'],
  ])('answers 400 for %s, never 500', async (_label, raw) => {
    const jar = await signedIn();

    const response = await createRoom(jar, raw);

    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe('validation_failed');
    expect(await harness.rooms.countRooms()).toBe(0);
  });

  it('answers 400 rather than 500 for a body that is not JSON at all', async () => {
    // Fastify's own parser refuses this before any handler runs, so the status is
    // its decision rather than ours. What matters for the matrix is the class: a
    // malformed request is never a 500.
    const jar = await signedIn();

    const response = await harness.request(ROOMS_PATH, {
      jar,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(await harness.rooms.countRooms()).toBe(0);
  });

  it('carries no diagnostic details in the refusal', async () => {
    // Every diagnostic in an error body is a diagnostic in somebody's screenshot,
    // and naming the offending field publishes the schema to whoever sent rubbish.
    const jar = await signedIn();

    const envelope = errorEnvelopeSchema.parse(
      await (await createRoom(jar, validBody({ topic: 'xyz' }))).json(),
    );

    expect(envelope.error.details).toBeUndefined();
    expect(envelope.error.message).not.toContain('topic');
    expect(envelope.error.message).not.toContain('xyz');
  });

  it('accepts every topic and every visibility the contract declares', async () => {
    // The other direction of the refusals above: a parser that rejected everything
    // would satisfy all of them perfectly.
    const jar = await signedIn();

    for (const topic of ['ngoai_ngu', 'khoa_hoc_tu_nhien', 'khoa_hoc_xa_hoi', 'lap_trinh_cong_nghe', 'on_thi', 'khac']) {
      for (const visibility of ['public', 'private']) {
        const response = await createRoom(jar, validBody({ topic, visibility }));
        expect(response.status, `${topic} / ${visibility} must be accepted`).toBe(201);
      }
    }
  });

  it('accepts a name and a description exactly at the ceiling', async () => {
    const jar = await signedIn();

    const response = await createRoom(
      jar,
      validBody({
        name: 'x'.repeat(MAX_ROOM_NAME_LENGTH),
        description: 'y'.repeat(MAX_ROOM_DESCRIPTION_LENGTH),
      }),
    );

    // The boundary is inclusive on both sides of the pair above: `MAX` is allowed,
    // `MAX + 1` is not. Testing only the refusal leaves an off-by-one invisible.
    expect(response.status).toBe(201);
  });
});

describe('the route as Nest actually mounts it', () => {
  it('mounts POST at the path the contract publishes', () => {
    const handler = (RoomsController.prototype as unknown as Record<string, object>)['create'];
    const controllerPath = Reflect.getMetadata(PATH_METADATA, RoomsController) as string;

    // The positive control: metadata was READ at all. A `Reflect.getMetadata`
    // returning `undefined` would make `/undefined` the thing compared, which fails
    // for the wrong reason — or silently weakens the comparison.
    expect(typeof controllerPath).toBe('string');
    expect(controllerPath.length).toBeGreaterThan(0);

    expect(`/${controllerPath}`).toBe(ROOMS_PATH);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it('mounts exactly one route, so no DELETE or PATCH sits beside it', () => {
    /**
     * The framework-level half of AC5. `tests/gates/no-hard-delete-rooms.test.ts`
     * reads the SOURCE for a `@Delete`; this reads what Nest actually registered,
     * which is the thing that would serve the request. Two mechanisms, because they
     * fail differently: a decorator imported under another name defeats the text
     * scan, and a controller nobody mounted defeats this one.
     */
    const methods = Object.getOwnPropertyNames(RoomsController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (RoomsController.prototype as unknown as Record<string, object>)[name];
        return Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      })
      .filter((method): method is number => method !== undefined);

    expect(methods).toEqual([RequestMethod.POST]);
    expect(methods).not.toContain(RequestMethod.DELETE);
  });
});
