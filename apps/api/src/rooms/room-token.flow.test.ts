import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  PLAN_PARTICIPANT_LIMITS,
  ROOMS_PATH,
  ROOM_ADMISSION_FORBIDDEN_MESSAGE,
  ROOM_CLOSED_MESSAGE,
  ROOM_FULL_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
  ROOM_TOKEN_PATH_TEMPLATE,
  ROOM_TOKEN_TTL_SECONDS,
  UNAUTHENTICATED_MESSAGE,
  errorEnvelopeSchema,
  roomSchema,
  roomTokenPath,
  roomTokenResponseSchema,
} from '@stuwith/contracts';
import type {
  FixedClock,
  IdentityPort,
  ReserveSeatInput,
  RoomReservationPort,
  User,
} from '@stuwith/domain';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, createAuthHarness, type AuthHarness } from '../auth/__testing__/auth-harness';
import { RoomsController } from './rooms.controller';

/**
 * Every row of Story 2.2's I/O matrix, driven through a real NestJS + Fastify
 * process over real HTTP.
 *
 * What this suite proves is the MAPPING: which condition becomes which status,
 * which body, which side effect. What it cannot prove is stated once: the
 * 130-concurrent cap lives in the adapter contract suite on a real PostgreSQL 18
 * (`packages/db/src/room-reservation-contract.pg.test.ts`), because the `api`
 * project has no Docker and the in-memory store cannot show a lock; and whether a
 * real `livekit-server` accepts the token is `tests/gates/livekit-token.test.ts`,
 * because a unit test on `jose` proves only that we signed something.
 */
let harness: AuthHarness;

/**
 * A ban, planted the one way this product can plant one today.
 *
 * Nothing writes `users.banned_at` until Story 4.7, so — exactly as
 * `rooms.flow.test.ts` reaches the Campus plan — the identity port is wrapped and
 * the ONE field under test is overridden on the way out of `findUserById`, which is
 * the method `SessionAuthenticator` calls. The login still happens for real.
 */
let bannedAtOverride: Date | null = null;

/** The "store lỗi giữa chừng" row: the reservation port throws when this is set. */
let reservationFault: Error | null = null;

beforeAll(async () => {
  harness = await createAuthHarness({
    wrapIdentity: (base: IdentityPort): IdentityPort => ({
      findOrCreateByIdentity: (identity, now) => base.findOrCreateByIdentity(identity, now),
      recordDateOfBirth: (userId, dateOfBirth, now) =>
        base.recordDateOfBirth(userId, dateOfBirth, now),
      findUserById: async (userId: string): Promise<User | null> => {
        const user = await base.findUserById(userId);
        if (user === null || bannedAtOverride === null) {
          return user;
        }
        return { ...user, bannedAt: bannedAtOverride };
      },
    }),
    wrapReservations: (base: RoomReservationPort): RoomReservationPort => ({
      reserveSeat: (input: ReserveSeatInput, now: Date) => {
        if (reservationFault !== null) {
          return Promise.reject(reservationFault);
        }
        return base.reserveSeat(input, now);
      },
    }),
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  bannedAtOverride = null;
  reservationFault = null;
  harness.identity.clear();
  harness.rooms.clear();
  harness.reservations.clear();
  harness.sessions.clear();
  harness.audit.clear();
});

/** A distinct person per subject, so "full" can be reached with real logins. */
const profile = (subject: string) => ({
  subject,
  email: `${subject}@fpt.edu.vn`,
  name: `Person ${subject}`,
  picture: `https://lh3.googleusercontent.com/a/${subject}`,
});

async function signedIn(subject = 'google-subject-1'): Promise<CookieJar> {
  const { jar } = await harness.login('google', profile(subject));
  return jar;
}

/** A room created over HTTP by whoever holds `jar`; its cap comes from their plan. */
async function createRoom(jar: CookieJar): Promise<string> {
  const response = await harness.request(ROOMS_PATH, {
    jar,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ôn thi cuối kỳ', topic: 'on_thi', visibility: 'public' }),
  });
  expect(response.status).toBe(201);
  return roomSchema.parse(await response.json()).id;
}

/** `POST /v1/rooms/{roomId}/token`, no body. */
async function askForToken(jar: CookieJar | undefined, roomId: string): Promise<Response> {
  return harness.request(roomTokenPath(roomId), {
    ...(jar === undefined ? {} : { jar }),
    method: 'POST',
  });
}

const me = async (jar: CookieJar): Promise<string> =>
  ((await (await harness.request('/v1/auth/me', { jar })).json()) as { id: string }).id;

const issued = () => harness.audit.byAction('room_token.issued');

const decode = async (token: string) =>
  jwtVerify(token, new TextEncoder().encode(harness.config.LIVEKIT_API_SECRET), {
    currentDate: harness.clock.now(),
  });

describe('Matrix: a valid request', () => {
  it('answers 201 with the four keys, and the token names exactly this room', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);

    const response = await askForToken(jar, roomId);

    expect(response.status).toBe(201);
    // PARSED against the published schema, so a fifth key — or a missing one — is
    // a failure of the contract and not a surprise for a client.
    const body = roomTokenResponseSchema.parse(await response.json());
    expect(body.room_id).toBe(roomId);
    expect(body.url).toBe(harness.config.LIVEKIT_URL);
    expect(body.expires_at).toBe(
      new Date(harness.clock.now().getTime() + ROOM_TOKEN_TTL_SECONDS * 1_000).toISOString(),
    );

    const { payload } = await decode(body.token);
    expect(payload.iss).toBe(harness.config.LIVEKIT_API_KEY);
    expect(payload.sub).toBe(await me(jar));
    expect(payload.exp).toBe(Math.floor(new Date(body.expires_at).getTime() / 1_000));
    expect(payload['video']).toEqual({
      room: roomId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
  });

  it('reserves exactly one seat and writes exactly one audit row', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);

    await askForToken(jar, roomId);

    expect(harness.reservations.countRows(roomId)).toBe(1);
    const rows = issued();
    expect(rows).toHaveLength(1);
    // actor = the person, subject = the room, metadata = ids and instants only.
    expect(rows[0]?.actorUserId).toBe(await me(jar));
    expect(rows[0]?.subjectId).toBe(roomId);
    expect(rows[0]?.sourceService).toBe('api');
    expect(rows[0]?.occurredAt.toISOString()).toBe(harness.clock.now().toISOString());
    expect(rows[0]?.requestId).toMatch(/\S/);
    expect(rows[0]?.metadata).toEqual({
      reservation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expires_at: new Date(
        harness.clock.now().getTime() + ROOM_TOKEN_TTL_SECONDS * 1_000,
      ).toISOString(),
    });
  });

  it('carries the inbound request id onto the audit row', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);

    const response = await harness.request(roomTokenPath(roomId), {
      jar,
      method: 'POST',
      headers: { 'x-request-id': 'room-token-flow-0001' },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('room-token-flow-0001');
    expect(issued()[0]?.requestId).toBe('room-token-flow-0001');
  });

  it('never puts the API secret, the key, or an admin grant on the wire', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);

    const raw = await (await askForToken(jar, roomId)).text();

    expect(raw).not.toContain(harness.config.LIVEKIT_API_SECRET);
    // The key IS inside the token as `iss` (base64url), but never as plain text
    // in the body — a client that needed it would have a credential.
    expect(JSON.parse(raw)).not.toHaveProperty('api_key');
    for (const grant of ['roomCreate', 'roomAdmin', 'roomList']) {
      const { payload } = await decode(roomTokenResponseSchema.parse(JSON.parse(raw)).token);
      expect(payload['video']).not.toHaveProperty(grant);
    }
  });

  it('lets somebody who did not create the room get a token for it', async () => {
    // The endpoint is for everybody who may enter, not for the owner.
    const owner = await signedIn('owner');
    const roomId = await createRoom(owner);
    const guest = await signedIn('guest');

    const response = await askForToken(guest, roomId);

    expect(response.status).toBe(201);
    const { payload } = await decode(roomTokenResponseSchema.parse(await response.json()).token);
    expect(payload.sub).toBe(await me(guest));
  });
});

describe('Matrix: who is calling', () => {
  it('answers 401 with no cookie, touches no room, writes nothing', async () => {
    const owner = await signedIn();
    const roomId = await createRoom(owner);

    const response = await askForToken(undefined, roomId);

    expect(response.status).toBe(401);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('unauthenticated');
    expect(envelope.error.message).toBe(UNAUTHENTICATED_MESSAGE);
    expect(harness.reservations.countRows(roomId)).toBe(0);
    expect(issued()).toHaveLength(0);
  });

  it('answers 401 for a session cookie this process never issued', async () => {
    const owner = await signedIn();
    const roomId = await createRoom(owner);
    const jar = new CookieJar();
    jar.set('stuwith_session', 'not-a-token-we-minted');

    expect((await askForToken(jar, roomId)).status).toBe(401);
    expect(harness.reservations.countRows(roomId)).toBe(0);
  });

  it('answers 401 BEFORE it looks at the room — a signed-out caller with rubbish still gets 401', async () => {
    // Not 404: a signed-out caller must learn nothing about which ids are rooms.
    expect((await askForToken(undefined, 'not-a-room')).status).toBe(401);
  });
});

describe('Matrix: banned', () => {
  it('answers 403 forbidden, reserves nothing, records nothing', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);
    bannedAtOverride = new Date('2026-09-01T00:00:00.000Z');

    const response = await askForToken(jar, roomId);

    expect(response.status).toBe(403);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('forbidden');
    expect(envelope.error.message).toBe(ROOM_ADMISSION_FORBIDDEN_MESSAGE);
    expect(envelope.error.details).toBeUndefined();
    expect(harness.reservations.countRows(roomId)).toBe(0);
    expect(issued()).toHaveLength(0);
  });

  it('answers 403 before the room is looked at, so a banned person cannot probe ids', async () => {
    const jar = await signedIn();
    bannedAtOverride = new Date('2026-09-01T00:00:00.000Z');

    expect((await askForToken(jar, 'not-a-room')).status).toBe(403);
    expect((await askForToken(jar, '019200ff-0000-7000-8000-ffffffffffff')).status).toBe(403);
  });

  it('does not touch the money gate or the profile — the ban is the only reason', async () => {
    // The positive control for the override: with it cleared, the same person and
    // the same room answer 201. Without this, an override that broke the login
    // would satisfy every 403 example above.
    const jar = await signedIn();
    const roomId = await createRoom(jar);
    bannedAtOverride = new Date('2026-09-01T00:00:00.000Z');
    expect((await askForToken(jar, roomId)).status).toBe(403);

    bannedAtOverride = null;
    expect((await askForToken(jar, roomId)).status).toBe(201);
  });
});

describe('Matrix: no such room', () => {
  it('answers 404 not_found for a uuid nobody created', async () => {
    const jar = await signedIn();
    const response = await askForToken(jar, '019200ff-0000-7000-8000-ffffffffffff');

    expect(response.status).toBe(404);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('not_found');
    expect(envelope.error.message).toBe(ROOM_NOT_FOUND_MESSAGE);
    expect(issued()).toHaveLength(0);
  });

  it.each([
    ['a word', 'phong-hoc'],
    ['a number', '42'],
    ['a near-uuid', '019200ff-0000-7000-8000-ffffffffff'],
    ['a uuid with a bad variant nibble', '019200ff-0000-7000-0000-ffffffffffff'],
    // NOT `..`: `roomTokenPath('..')` is `/v1/rooms/../token`, and every URL
    // client — Node's `fetch` included — collapses that to `/v1/token` before it
    // leaves the machine, so the route never sees it. A row nothing can deliver
    // is a row that tests the client's URL parser, not this endpoint.
    ['a percent-encoded dotted segment', '%2e%2e'],
  ])('answers 404 for %s as the id, with the SAME body as an unknown uuid', async (_label, id) => {
    const jar = await signedIn();

    const unknown = await (await askForToken(jar, '019200ff-0000-7000-8000-ffffffffffff')).json();
    const response = await askForToken(jar, id);

    expect(response.status).toBe(404);
    // Byte-for-byte: a caller that could tell the two apart has learned the id
    // format from an error message.
    expect(await response.json()).toEqual(unknown);
  });
});

describe('Matrix: the room is closing or closed', () => {
  it.each(['closing', 'closed'] as const)(
    'answers 409 conflict with the closed sentence for a %s room, reserving nothing',
    async (status) => {
      const jar = await signedIn();
      const roomId = await createRoom(jar);
      // Planted, because nothing in the product can move a status yet (Story 4.8).
      harness.rooms.plantStatus(roomId, status);

      const response = await askForToken(jar, roomId);

      expect(response.status).toBe(409);
      const envelope = errorEnvelopeSchema.parse(await response.json());
      expect(envelope.error.code).toBe('conflict');
      expect(envelope.error.message).toBe(ROOM_CLOSED_MESSAGE);
      expect(harness.reservations.countRows(roomId)).toBe(0);
      expect(issued()).toHaveLength(0);
    },
  );
});

describe('Matrix: the room is full', () => {
  it('answers 409 conflict with the full sentence once the cap is reached, and the count does not move', async () => {
    const cap = PLAN_PARTICIPANT_LIMITS.study_buddy;
    const owner = await signedIn('owner');
    const roomId = await createRoom(owner);

    // `cap` distinct people, the owner among them, each with a real login.
    const jars = [owner];
    for (let i = 1; i < cap; i += 1) {
      jars.push(await signedIn(`person-${String(i)}`));
    }
    for (const jar of jars) {
      expect((await askForToken(jar, roomId)).status).toBe(201);
    }
    expect(harness.reservations.countRows(roomId)).toBe(cap);

    const late = await signedIn('latecomer');
    const response = await askForToken(late, roomId);

    expect(response.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(await response.json());
    expect(envelope.error.code).toBe('conflict');
    expect(envelope.error.message).toBe(ROOM_FULL_MESSAGE);
    expect(harness.reservations.countRows(roomId)).toBe(cap);
    expect(issued()).toHaveLength(cap);
  }, 30_000);

  it('does not count the seat holder against themselves — the last person in can still renew', async () => {
    const cap = PLAN_PARTICIPANT_LIMITS.study_buddy;
    const owner = await signedIn('owner');
    const roomId = await createRoom(owner);
    const jars = [owner];
    for (let i = 1; i < cap; i += 1) {
      jars.push(await signedIn(`person-${String(i)}`));
    }
    for (const jar of jars) {
      await askForToken(jar, roomId);
    }

    // The sixth person asks again in a full room: 201, renewed, count unchanged.
    const last = jars[cap - 1];
    expect((await askForToken(last, roomId)).status).toBe(201);
    expect(harness.reservations.countRows(roomId)).toBe(cap);
  }, 30_000);
});

describe('Matrix: asking again', () => {
  it('answers 201 with a later expires_at and a new token, and the seat count does not move', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);

    const first = roomTokenResponseSchema.parse(await (await askForToken(jar, roomId)).json());
    (harness.clock as FixedClock).advance(30_000);
    const second = roomTokenResponseSchema.parse(await (await askForToken(jar, roomId)).json());

    expect(new Date(second.expires_at).getTime()).toBe(
      new Date(first.expires_at).getTime() + 30_000,
    );
    expect(second.token).not.toBe(first.token);
    expect(second.room_id).toBe(roomId);
    expect(harness.reservations.countRows(roomId)).toBe(1);
    // Both issuances are recorded, against the SAME reservation — which is how a
    // renewal reads in the trail without a flag of its own.
    const rows = issued();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.metadata['reservation_id']).toBe(rows[0]?.metadata['reservation_id']);
    expect(rows[1]?.metadata['expires_at']).toBe(second.expires_at);
  });

  it('gives the same person one seat per room, and a seat in each of two rooms', async () => {
    const jar = await signedIn();
    const a = await createRoom(jar);
    const b = await createRoom(jar);

    expect((await askForToken(jar, a)).status).toBe(201);
    expect((await askForToken(jar, a)).status).toBe(201);
    expect((await askForToken(jar, b)).status).toBe(201);

    expect(harness.reservations.countRows(a)).toBe(1);
    expect(harness.reservations.countRows(b)).toBe(1);
  });
});

describe('Matrix: the store fails mid-request', () => {
  it('answers 500, issues no token, writes no audit row, leaves no stray seat', async () => {
    const jar = await signedIn();
    const roomId = await createRoom(jar);
    reservationFault = new Error('simulated pool outage');

    const response = await askForToken(jar, roomId);

    // The fault PROPAGATES: it becomes the 500 it is, never a 409 telling somebody
    // the room is full when we are broken, and never a 201 with a token in it.
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('"token"');
    expect(text).not.toContain('simulated pool outage');
    expect(harness.reservations.countRows(roomId)).toBe(0);
    expect(issued()).toHaveLength(0);
  });

  it('recovers on the next request once the store answers again', async () => {
    // The positive control for the fault seam.
    const jar = await signedIn();
    const roomId = await createRoom(jar);
    reservationFault = new Error('simulated pool outage');
    expect((await askForToken(jar, roomId)).status).toBe(500);

    reservationFault = null;
    expect((await askForToken(jar, roomId)).status).toBe(201);
  });
});

describe('the route as Nest actually mounts it', () => {
  it('mounts POST at the path the contract publishes, under the same controller as create', () => {
    const handler = (RoomsController.prototype as unknown as Record<string, object>)['issueToken'];
    const controllerPath = Reflect.getMetadata(PATH_METADATA, RoomsController) as string;
    const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string;

    expect(typeof handlerPath).toBe('string');
    // Nest's `:roomId` and OpenAPI's `{roomId}` are the same parameter in two
    // syntaxes; this is what holds the decorator to the document.
    expect(`/${controllerPath}/${handlerPath}`).toBe(
      ROOM_TOKEN_PATH_TEMPLATE.replace('{roomId}', ':roomId'),
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });
});
