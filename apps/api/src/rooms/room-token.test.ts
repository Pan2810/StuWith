import { decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { mintRoomToken, type RoomTokenInput } from './room-token';

/**
 * What `mintRoomToken` signs, decoded and pinned claim by claim.
 *
 * This suite proves that we signed the right THING. It cannot prove that a real
 * `livekit-server` accepts it — that is `tests/gates/livekit-token.test.ts`, which
 * starts one and sends the upgrade. The two are deliberately different media.
 */
const SECRET = 'livekit-secret-for-this-suite-only-xx';
const KEY = 'livekit-key';
const ROOM = '019200f1-0000-7000-8000-000000000001';
const USER = '019200f0-0000-7000-8000-000000000001';
const ISSUED = new Date('2026-09-12T09:00:00.000Z');
const EXPIRES = new Date('2026-09-12T09:02:00.000Z');

const input = (overrides: Partial<RoomTokenInput> = {}): RoomTokenInput => ({
  apiKey: KEY,
  apiSecret: SECRET,
  roomId: ROOM,
  userId: USER,
  issuedAt: ISSUED,
  expiresAt: EXPIRES,
  ...overrides,
});

const decode = async (token: string, secret = SECRET) =>
  jwtVerify(token, new TextEncoder().encode(secret), {
    // `jose` checks `exp` against the wall clock; the fixture's instants are in
    // the past on the day this runs and in the future on the day it was written,
    // so the check is anchored to the token's own `iat`.
    currentDate: ISSUED,
  });

describe('mintRoomToken — the claims, one by one', () => {
  it('signs HS256 and nothing else', async () => {
    const token = await mintRoomToken(input());
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256' });
  });

  it('verifies with the API secret, and NOT with another', async () => {
    const token = await mintRoomToken(input());
    await expect(decode(token)).resolves.toBeDefined();
    await expect(decode(token, 'a-different-secret-of-the-same-length')).rejects.toThrow();
  });

  it('sets iss to the API key and sub to the person', async () => {
    const { payload } = await decode(await mintRoomToken(input()));
    expect(payload.iss).toBe(KEY);
    expect(payload.sub).toBe(USER);
  });

  it('sets iat and exp to the instants it was handed, in whole seconds', async () => {
    const { payload } = await decode(await mintRoomToken(input()));
    expect(payload.iat).toBe(ISSUED.getTime() / 1_000);
    expect(payload.exp).toBe(EXPIRES.getTime() / 1_000);
    // 120 seconds apart in this fixture — the reservation's TTL, not a second
    // reading of any clock.
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(120);
  });

  it('truncates a sub-second instant rather than rounding it up', async () => {
    const { payload } = await decode(
      await mintRoomToken(input({ expiresAt: new Date('2026-09-12T09:02:00.999Z') })),
    );
    expect(payload.exp).toBe(EXPIRES.getTime() / 1_000);
  });

  it('grants join, publish and subscribe for EXACTLY the one room, and nothing else', async () => {
    const { payload } = await decode(await mintRoomToken(input()));
    // `toEqual`, so a fifth key — any fifth key — is a failure, not a surprise.
    expect(payload['video']).toEqual({
      room: ROOM,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
  });

  it.each(['roomCreate', 'roomAdmin', 'roomList'])(
    'never carries the %s grant',
    async (grant) => {
      // Pinned by NAME on top of the exact-equality above, because these three are
      // the ones that turn "a token for this room" into "a token for the server".
      const { payload } = await decode(await mintRoomToken(input()));
      expect(payload['video']).not.toHaveProperty(grant);
      expect(JSON.stringify(payload)).not.toContain(grant);
    },
  );

  it('carries no claim beyond the five it is specified to', async () => {
    const { payload } = await decode(await mintRoomToken(input()));
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'iss', 'sub', 'video']);
  });

  it('mints a different token for a different room, and for a different person', async () => {
    const base = await mintRoomToken(input());
    const otherRoom = await mintRoomToken(
      input({ roomId: '019200f1-0000-7000-8000-000000000002' }),
    );
    const otherUser = await mintRoomToken(
      input({ userId: '019200f0-0000-7000-8000-000000000002' }),
    );
    expect(otherRoom).not.toBe(base);
    expect(otherUser).not.toBe(base);
    expect((await decode(otherRoom)).payload['video']).toMatchObject({
      room: '019200f1-0000-7000-8000-000000000002',
    });
  });
});
