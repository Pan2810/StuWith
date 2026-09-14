import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_CLIENT_INITIATED,
  DISCONNECT_DUPLICATE_IDENTITY,
  audioPublishOptions,
  disconnectReasonKeyFor,
  identityInitialsFor,
  isLiveConnection,
  joinPhaseFor,
  participantRowsFor,
  roomConnectionStateFor,
  roomOptionsFor,
  tokenExpiredAt,
  type MediaParticipant,
  type RoomConnectionState,
} from './room-media';

/**
 * Every row of Story 2.4's edge-case matrix, run through the functions that
 * decide it.
 *
 * The division of labour is the one `AGENTS.md` §6 fixes: this file executes the
 * decisions, `room-panel.test.tsx` executes the markup they produce, and
 * `tests/e2e/livekit/phong-media.spec.ts` is the only thing that can claim sound
 * really crosses the browser ↔ LiveKit boundary. A function calling a function is
 * not a probe, so nothing here pretends to prove the last part.
 */

const NOW = Date.parse('2026-09-14T09:00:00.000Z');

const participant = (overrides: Partial<MediaParticipant> = {}): MediaParticipant => ({
  identity: '019200f1-0000-7000-8000-000000000001',
  micOn: true,
  ...overrides,
});

/** Real uuidv7 account ids: same timestamp head, different tails. */
const IDENTITY_A = '019200f1-0000-7000-8000-0000000000ab';
const IDENTITY_B = '019200f1-0000-7000-8000-0000000000cd';

describe('audioPublishOptions — Opus with DTX and RED, declared rather than inherited', () => {
  it('turns DTX and RED on, explicitly', () => {
    /**
     * The mutation this row exists for: deleting either flag from
     * `audioPublishOptions()` turns this red. Both default to ON in the SDK today
     * for a mono track, which is exactly why the assertion has to be here — a
     * default is somebody else's decision and can change in a minor release,
     * while Epic 2's "tiếng không bao giờ được rớt" is ours.
     */
    expect(audioPublishOptions().dtx).toBe(true);
    expect(audioPublishOptions().red).toBe(true);
  });

  it('asks for the sender priority instead of taking whatever the SDK picks', () => {
    expect(audioPublishOptions().audioPreset.priority).toBe('high');
    expect(audioPublishOptions().audioPreset.maxBitrate).toBeGreaterThan(0);
  });

  it('publishes mono, because DTX and RED are mono-only', () => {
    // A stereo capture silently switches both of the flags above off, so the two
    // claims are one claim and this is the half nobody would look for.
    expect(audioPublishOptions().forceStereo).toBe(false);
  });
});

describe('roomOptionsFor — no video machinery, and nothing to publish when listening', () => {
  it('carries the publish defaults on the mic branch', () => {
    const options = roomOptionsFor({ faceMode: 'show', audio: 'mic' });
    expect(options.publishDefaults).toEqual(audioPublishOptions());
  });

  it('carries NO publish defaults when the person only listens', () => {
    // Not a saving: a set of publish defaults on a listen-only room would describe
    // a track that must never exist.
    expect(roomOptionsFor({ faceMode: 'hide', audio: 'listen-only' }).publishDefaults).toBeUndefined();
  });

  it('leaves every video knob off, so Story 2.5 turns them on deliberately', () => {
    const options = roomOptionsFor({ faceMode: 'show', audio: 'mic' });
    expect(options.adaptiveStream).toBe(false);
    expect(options.dynacast).toBe(false);
  });

  it('stops local tracks on unpublish and disconnects when the page goes away', () => {
    const options = roomOptionsFor({ faceMode: 'show', audio: 'mic' });
    expect(options.stopLocalTrackOnUnpublish).toBe(true);
    expect(options.disconnectOnPageLeave).toBe(true);
  });
});

describe('tokenExpiredAt — the 120 second window the token and the seat share', () => {
  it('is not expired a second before, and IS expired at the instant itself', () => {
    expect(tokenExpiredAt('2026-09-14T09:00:01.000Z', NOW)).toBe(false);
    expect(tokenExpiredAt('2026-09-14T09:00:00.000Z', NOW)).toBe(true);
    expect(tokenExpiredAt('2026-09-14T08:59:59.000Z', NOW)).toBe(true);
  });

  it('answers false for an instant it cannot read', () => {
    // The body came through `roomTokenResponseSchema`, so this is unreachable
    // through the product — and refusing to enter a room over a clock we cannot
    // read would be a worse answer than letting LiveKit judge the token.
    expect(tokenExpiredAt('khong-phai-mot-moc-thoi-gian', NOW)).toBe(false);
  });
});

describe('roomConnectionStateFor — the SDK enum, as a word this app owns', () => {
  it.each([
    ['disconnected', 'disconnected'],
    ['connecting', 'connecting'],
    ['connected', 'connected'],
    ['reconnecting', 'reconnecting'],
    ['signalReconnecting', 'signalReconnecting'],
  ] as ReadonlyArray<readonly [string, RoomConnectionState]>)('reads %s', (raw, expected) => {
    expect(roomConnectionStateFor(raw)).toBe(expected);
  });

  it('lands a state this build has never heard of on disconnected', () => {
    expect(roomConnectionStateFor('quantum')).toBe('disconnected');
  });
});

describe('joinPhaseFor — which of the six words the screen is in', () => {
  it('is connecting while the handshake runs', () => {
    expect(joinPhaseFor('connecting', null, false)).toBe('connecting');
  });

  it('is connected once the room is up', () => {
    expect(joinPhaseFor('connected', null, false)).toBe('connected');
  });

  it('is reconnecting for both of the SDK’s two reconnect states', () => {
    expect(joinPhaseFor('reconnecting', null, false)).toBe('reconnecting');
    expect(joinPhaseFor('signalReconnecting', null, false)).toBe('reconnecting');
  });

  it('is left when the room ends with nothing to explain', () => {
    expect(joinPhaseFor('disconnected', null, false)).toBe('left');
  });

  it('is failed when a refusal came back', () => {
    expect(joinPhaseFor('disconnected', 'room.errorConnect', false)).toBe('failed');
  });

  it('prefers expired over failed, because the lapsed token is the CAUSE', () => {
    /**
     * A token that lapsed mid-handshake produces a refusal too. Reporting the
     * refusal would offer a retry that cannot work; reporting the expiry sends
     * somebody back to pre-join, which can.
     */
    expect(joinPhaseFor('disconnected', 'room.errorConnect', true)).toBe('expired');
    expect(joinPhaseFor('connecting', null, true)).toBe('expired');
  });

  it('ignores an expiry once the room is really up', () => {
    // The token buys the handshake, not the session. A room that is up stays up.
    expect(joinPhaseFor('connected', null, true)).toBe('connected');
    expect(joinPhaseFor('reconnecting', null, true)).toBe('reconnecting');
    // Including the state the first spelling of this left out: a token lapsing
    // while the SDK re-signals a LIVE room used to report `expired` and send
    // somebody back to pre-join out of a room they were still in.
    expect(joinPhaseFor('signalReconnecting', null, true)).toBe('reconnecting');
  });
});

describe('isLiveConnection — the one notion two places have to agree on', () => {
  it.each(['connected', 'reconnecting', 'signalReconnecting'] as const)('%s is live', (state) => {
    expect(isLiveConnection(state)).toBe(true);
  });

  it.each(['connecting', 'disconnected'] as const)('%s is not', (state) => {
    expect(isLiveConnection(state)).toBe(false);
  });
});

describe('disconnectReasonKeyFor — one sentence, and the one case that needs its own', () => {
  it('says nothing when we are the ones who left', () => {
    expect(disconnectReasonKeyFor(DISCONNECT_CLIENT_INITIATED)).toBeNull();
  });

  it('names the duplicate identity, which is the case nobody would guess', () => {
    expect(disconnectReasonKeyFor(DISCONNECT_DUPLICATE_IDENTITY)).toBe('room.errorDuplicate');
  });

  it.each([undefined, 0, 3, 7, 9, 99])('falls back to the lost-connection sentence for %s', (reason) => {
    expect(disconnectReasonKeyFor(reason)).toBe('room.errorDisconnected');
  });

  it('the two numbers are the SDK’s, checked against the SDK rather than remembered', async () => {
    /**
     * `room-media.ts` cannot import `livekit-client` at module scope — see its own
     * docblock — so the two reasons are written out as numbers. Written out, they
     * are a copy of somebody else's enum with nothing holding the two together:
     * a renumbering in a `@livekit/protocol` release would turn a voluntary
     * "Rời phòng" into "Mất kết nối tới phòng." for everybody, silently.
     *
     * The import is dynamic and inside the example, which is what keeps this file
     * runnable in the DOM-less `web` project: the SDK is evaluated only when this
     * one example runs, and it is `import()` rather than a top-level import for
     * exactly the reason the product module gives.
     */
    const { DisconnectReason } = await import('livekit-client');
    expect(DISCONNECT_CLIENT_INITIATED).toBe(DisconnectReason.CLIENT_INITIATED);
    expect(DISCONNECT_DUPLICATE_IDENTITY).toBe(DisconnectReason.DUPLICATE_IDENTITY);
    // And the reader still agrees with the enum it was checked against, so a
    // renamed member cannot leave the two constants correct and the mapping wrong.
    expect(disconnectReasonKeyFor(DisconnectReason.CLIENT_INITIATED)).toBeNull();
    expect(disconnectReasonKeyFor(DisconnectReason.DUPLICATE_IDENTITY)).toBe('room.errorDuplicate');
  });
});

describe('participantRowsFor — who is in the room, in an order that does not move', () => {
  const self = participant({ identity: 'self-id', name: 'Trâm Anh' });

  it('puts the reader first and marks the row as theirs', () => {
    const rows = participantRowsFor(self, [participant({ identity: 'a-id', name: 'An' })], []);
    expect(rows.map((row) => row.id)).toEqual(['self-id', 'a-id']);
    expect(rows[0]?.isSelf).toBe(true);
    expect(rows[1]?.isSelf).toBe(false);
  });

  it('orders everybody else by name, with the identity breaking a tie', () => {
    const rows = participantRowsFor(
      null,
      [
        participant({ identity: 'z', name: 'Bình' }),
        participant({ identity: 'b', name: 'An' }),
        participant({ identity: 'a', name: 'An' }),
      ],
      [],
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'z']);
  });

  it('carries the letters for the avatar and leaves the label empty when there is no name', () => {
    const rows = participantRowsFor(null, [participant({ identity: IDENTITY_A })], []);
    expect(rows[0]?.label).toBe('');
    // The TAIL of the identity, not the head: a uuidv7 begins with a millisecond
    // timestamp, so everybody in one room shares its first characters.
    expect(rows[0]?.initials).toBe('AB');
  });

  it('gives two people who joined in the same millisecond DIFFERENT letters', () => {
    /**
     * The bug this row exists for, and it shipped: `avatarInitialsFor` splits on
     * spaces and a uuid has none, so it answered the first character of a
     * timestamp — `0` — for every participant in the product, while two docblocks
     * said everybody stayed distinguishable.
     */
    const rows = participantRowsFor(
      null,
      [participant({ identity: IDENTITY_A }), participant({ identity: IDENTITY_B })],
      [],
    );
    const initials = rows.map((each) => each.initials);
    expect(initials).toEqual(['AB', 'CD']);
    expect(new Set(initials).size).toBe(2);
  });

  it('never answers the same letter for every uuid, which is what a name-shaped reader does', () => {
    const many = [
      '019200f1-0000-7000-8000-000000000001',
      '019200f1-0000-7000-8000-00000000004e',
      '019200f1-0000-7000-8000-0000000000ff',
    ].map(identityInitialsFor);
    expect(new Set(many).size).toBe(3);
    expect(identityInitialsFor('')).toBe('?');
    expect(identityInitialsFor('----')).toBe('?');
  });

  it('takes the initials from the name when there is one', () => {
    const rows = participantRowsFor(self, [], []);
    expect(rows[0]?.initials).toBe('TA');
    expect(rows[0]?.label).toBe('Trâm Anh');
  });

  it('marks the speakers, and only the ones whose microphone is on', () => {
    const rows = participantRowsFor(
      self,
      [participant({ identity: 'muted', micOn: false })],
      ['self-id', 'muted'],
    );
    expect(rows[0]?.speaking).toBe(true);
    // A muted person cannot be speaking, whatever the server says: the row would
    // read "Đang nói" and "Đang tắt micro" at once.
    expect(rows[1]?.speaking).toBe(false);
  });

  it('reads listen-only as a microphone that is off', () => {
    const rows = participantRowsFor(participant({ identity: 'self-id', micOn: false }), [], []);
    expect(rows[0]?.micOn).toBe(false);
  });

  it('drops a remote carrying the reader’s own identity', () => {
    // LiveKit cannot produce one — the same identity evicts the older connection —
    // and a duplicate row would be a person seeing themselves twice.
    const rows = participantRowsFor(self, [participant({ identity: 'self-id', name: 'Trâm Anh' })], []);
    expect(rows).toHaveLength(1);
  });

  it('drops a remote repeated twice in one snapshot', () => {
    const rows = participantRowsFor(null, [participant({ identity: 'a' }), participant({ identity: 'a' })], []);
    expect(rows).toHaveLength(1);
  });

  it('is empty before anybody is in the room', () => {
    expect(participantRowsFor(null, [], [])).toEqual([]);
  });

  it('loses the row of somebody who left, and counts again', () => {
    const before = participantRowsFor(self, [participant({ identity: 'a' }), participant({ identity: 'b' })], []);
    const after = participantRowsFor(self, [participant({ identity: 'a' })], []);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(2);
  });
});
