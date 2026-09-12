import { SignJWT } from 'jose';

/**
 * AD-9 — the room token, minted by `apps/api` and by nothing else.
 *
 * ## What it is
 *
 * A LiveKit access token: a JWT signed HS256 with the deployment's
 * `LIVEKIT_API_SECRET`, whose `iss` is the matching `LIVEKIT_API_KEY`, whose `sub`
 * is the person, and whose `video` claim is the grant LiveKit reads. The secret is
 * read here, in this process, and never travels: a client receives a token, not a
 * credential, and there is no static LiveKit credential anywhere on the client
 * side (`tests/gates/livekit-token.test.ts` scans for one).
 *
 * ## What it grants, and — more importantly — what it does not
 *
 * `roomJoin`, `canPublish`, `canSubscribe`, for exactly ONE room. Not `roomCreate`,
 * not `roomAdmin`, not `roomList`: a token that could create rooms would let any
 * signed-in person bypass the plan cap by inventing a room LiveKit knows and
 * `rooms` does not; one that could administer would let them remove others; one
 * that could list would publish which rooms exist to anybody with a token. The
 * grant object is built as a literal so a key cannot arrive by spreading something
 * in, and `room-token.test.ts` pins the absence of all three by name.
 *
 * ## The room's name on LiveKit IS `rooms.id`
 *
 * `video.room` is the uuid. There is no slug and no mapping table, because a
 * mapping is a place where the two sides can disagree about which room a token
 * opens. The gateway (Story 2.4) compares uuids.
 *
 * ## The instants are the caller's
 *
 * `issuedAt` is the request's single instant and `expiresAt` is the reserved
 * seat's `expiresAt` — the same row this token was issued against. No clock is
 * read here: a token whose `exp` came from a second reading would outlive or
 * undershoot its seat by however long the request took.
 */
export interface RoomTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly roomId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The `video` claim, spelled once as a TYPE so the test can decode into it.
 *
 * Exactly these four keys. The three admin grants are not optional members that
 * happen to be absent — they are not members at all, so a value carrying one does
 * not typecheck as this.
 */
export interface RoomVideoGrant {
  readonly room: string;
  readonly roomJoin: true;
  readonly canPublish: true;
  readonly canSubscribe: true;
}

export async function mintRoomToken(input: RoomTokenInput): Promise<string> {
  const video: RoomVideoGrant = {
    room: input.roomId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  };

  return new SignJWT({ video })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(input.apiKey)
    .setSubject(input.userId)
    // Whole seconds, because that is what the JWT registered claims are and what
    // LiveKit compares against; `jose` would otherwise accept a `Date` and
    // truncate it itself, which is the same result reached less visibly.
    .setIssuedAt(Math.floor(input.issuedAt.getTime() / 1_000))
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1_000))
    .sign(new TextEncoder().encode(input.apiSecret));
}
