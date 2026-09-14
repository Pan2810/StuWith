import { describe, expect, it } from 'vitest';
import { PIPELINE_FPS } from './frame-pipeline';
import {
  DISCONNECT_CLIENT_INITIATED,
  DISCONNECT_DUPLICATE_IDENTITY,
  MEDIA_FACE_MODES,
  VIDEO_MAX_BITRATE,
  audioPublishOptions,
  cameraProblemFor,
  disconnectReasonKeyFor,
  faceModeAllowsVideo,
  faceModeSelectable,
  initialFaceModeFor,
  identityInitialsFor,
  isLiveConnection,
  joinPhaseFor,
  participantRowsFor,
  roomConnectionStateFor,
  roomOptionsFor,
  tokenExpiredAt,
  videoKeyFor,
  videoPublishOptions,
  type MediaParticipant,
  type MediaVideoPublication,
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
  videoKey: null,
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

/* -------------------------------------------------------------------------- *
 * Story 2.7 — the video decisions
 * -------------------------------------------------------------------------- */

describe('videoPublishOptions — the canvas track’s terms, declared rather than inherited', () => {
  it('names the camera source, which is the one the token grants', () => {
    /**
     * The mutation this row exists for, and it is the one `Verification` names:
     * delete `source: 'camera'` and this goes red. The string is the raw wire
     * value on purpose — importing `Track.Source` would drag a browser SDK into
     * this module's graph and take every function in this file out of reach of a
     * DOM-less test (`AGENTS.md` §6) — and `RoomShell` re-states it with the enum,
     * whose runtime value is this same string.
     */
    expect(videoPublishOptions().source).toBe('camera');
  });

  it('publishes ONE layer: simulcast is the ladder, and the ladder is Story 2.5', () => {
    // Typed `false` rather than `boolean`, so `simulcast: true` is a compile error
    // and `next build` refuses it — the same control `dtx`/`red` use above.
    expect(videoPublishOptions().simulcast).toBe(false);
  });

  it('keeps the framerate and drops resolution when the link narrows', () => {
    // A juddering face is harder to read than a soft one, and `epic-2-context.md`
    // lets video degrade.
    expect(videoPublishOptions().degradationPreference).toBe('maintain-framerate');
  });

  it('pins the bitrate and the framerate, and yields to audio by priority', () => {
    const encoding = videoPublishOptions().videoEncoding;
    /**
     * The NUMBER, not `> 0`. The docblock claims the bitrate is an explicit
     * decision, and "greater than zero" agrees with every value anybody could
     * typo — which is a test that reads like it pins a decision and pins nothing.
     */
    expect(encoding.maxBitrate).toBe(VIDEO_MAX_BITRATE);
    expect(VIDEO_MAX_BITRATE).toBe(500_000);
    /**
     * The SAME constant the canvas is captured at, not a second literal that
     * happens to match today. Two copies drift in silence: a canvas capturing 24
     * while the encoder is told 30 has a bitrate budgeted for a rate that does not
     * exist, and nothing anywhere goes red.
     */
    expect(encoding.maxFramerate).toBe(PIPELINE_FPS);
    // The other half of `audioPublishOptions().audioPreset.priority === 'high'`:
    // when the browser has to choose between the two streams, the epic has
    // already said which one gives way.
    expect(encoding.priority).toBe('low');
    expect(audioPublishOptions().audioPreset.priority).toBe('high');
  });
});

describe('faceModeAllowsVideo — the one place a camera is permitted', () => {
  it('allows the camera for "show" and for nothing else', () => {
    expect(faceModeAllowsVideo('show')).toBe(true);
    expect(faceModeAllowsVideo('hide')).toBe(false);
  });

  it('refuses "filter", because the ML pipeline is a separate deliverable', () => {
    /**
     * KEEP item (5) of the spec's change log. If this answered `true`, a person
     * selecting Filter would have a camera opened and an UNFILTERED face published
     * under a label that promises a filter — the worst possible reading of a mode
     * that is half built. `deferred-work.md` owns the rest.
     */
    expect(faceModeAllowsVideo('filter')).toBe(false);
  });

  it('is exhaustive over the mode list, so a fourth mode cannot default to "yes"', () => {
    // Every member answered, and only one of them `true`. A mode added later
    // starts life refused rather than permitted by omission.
    expect(MEDIA_FACE_MODES.filter((mode) => faceModeAllowsVideo(mode))).toEqual(['show']);
    expect([...MEDIA_FACE_MODES]).toEqual(['show', 'hide', 'filter']);
  });
});

describe('roomOptionsFor keeps the ladder’s two knobs off, deliberately', () => {
  it('leaves adaptiveStream and dynacast false now that video really is published', () => {
    /**
     * Story 2.4 set these to `false` because it published no video. With video on
     * the wire that reasoning has expired, so the decision is re-taken rather than
     * inherited: `adaptiveStream` measures the tile that Story 2.6 has not built
     * yet, and `dynacast` switches off simulcast layers that `videoPublishOptions()`
     * does not publish. Both are 2.5's, and `deferred-work.md` records it.
     */
    expect(roomOptionsFor({ faceMode: 'show', audio: 'mic' }).adaptiveStream).toBe(false);
    expect(roomOptionsFor({ faceMode: 'show', audio: 'mic' }).dynacast).toBe(false);
  });
});

describe('a row carries WHICH picture to draw', () => {
  it('carries the video key through from the participant', () => {
    const rows = participantRowsFor(
      participant({ identity: IDENTITY_A, videoKey: `${IDENTITY_A}:TR_ONE` }),
      [participant({ identity: IDENTITY_B, videoKey: null })],
      [],
    );
    expect(rows.map((each) => each.videoKey)).toEqual([`${IDENTITY_A}:TR_ONE`, null]);
  });

  it('keeps the picture independent of the microphone, because they fail separately', () => {
    // Camera on, microphone off is an ordinary state — somebody listening with
    // their face showing — and a row that conflated them would draw letters for a
    // person who is plainly on camera.
    const rows = participantRowsFor(
      participant({ identity: IDENTITY_A, micOn: false, videoKey: `${IDENTITY_A}:TR_ONE` }),
      [],
      [],
    );
    expect(rows[0]?.micOn).toBe(false);
    expect(rows[0]?.videoKey).toBe(`${IDENTITY_A}:TR_ONE`);
  });
});

describe('videoKeyFor — WHICH picture to draw, and when to draw none', () => {
  const publication = (overrides: Partial<MediaVideoPublication> = {}): MediaVideoPublication => ({
    trackSid: 'TR_AAAA',
    subscribed: true,
    muted: false,
    hasTrack: true,
    ...overrides,
  });

  it('answers identity:trackSid for a publication that is really arriving', () => {
    expect(videoKeyFor(IDENTITY_A, [publication()])).toBe(`${IDENTITY_A}:TR_AAAA`);
  });

  it.each([
    ['not subscribed', { subscribed: false }],
    ['muted', { muted: true }],
    ['carrying no track', { hasTrack: false }],
  ] as ReadonlyArray<readonly [string, Partial<MediaVideoPublication>]>)(
    'answers null for a publication that is %s',
    (_label, overrides) => {
      /**
       * Each of the three is a way a `<video>` would mount with nothing in it, and
       * each is reachable: an unsubscribed publication carries no frames, `muted`
       * is what BOTH a hidden tab and the instant before an unpublish look like,
       * and a publication with no track has nothing to attach.
       */
      expect(videoKeyFor(IDENTITY_A, [publication(overrides)])).toBeNull();
    },
  );

  it('answers null for somebody publishing no video at all', () => {
    expect(videoKeyFor(IDENTITY_A, [])).toBeNull();
  });

  it('keeps two publications of one person apart, and drops only the one that went', () => {
    /**
     * The defect this rule exists for. Keyed by IDENTITY alone, a second
     * publication overwrote the first and ONE unsubscribe blanked a tile whose
     * other track was still live. Two sids are two keys.
     */
    const first = publication({ trackSid: 'TR_ONE' });
    const second = publication({ trackSid: 'TR_TWO' });
    expect(videoKeyFor(IDENTITY_A, [first, second])).toBe(`${IDENTITY_A}:TR_ONE`);
    expect(videoKeyFor(IDENTITY_A, [{ ...first, subscribed: false }, second])).toBe(
      `${IDENTITY_A}:TR_TWO`,
    );
  });

  it('names the PERSON as well as the track, so two people never collide', () => {
    expect(videoKeyFor(IDENTITY_A, [publication()])).not.toBe(
      videoKeyFor(IDENTITY_B, [publication()]),
    );
  });
});

describe('a mode nobody may choose cannot reach the machine', () => {
  it('refuses filter as a selection while still listing it', () => {
    expect(faceModeSelectable('filter')).toBe(false);
    expect(faceModeSelectable('show')).toBe(true);
    expect(faceModeSelectable('hide')).toBe(true);
    // Listed, because the group has to show what is coming; refused, because the
    // pipeline behind it is a separate deliverable.
    expect([...MEDIA_FACE_MODES]).toContain('filter');
  });

  it('starts a room in "hide" when the admission carried a mode nobody may choose', () => {
    /**
     * Pre-join cannot produce `filter` today, which is exactly when a guard is
     * cheap. Without it the room renders a radio that is both checked and
     * disabled, and seeds the machine with a mode `faceModeAllowsVideo` will never
     * satisfy — a person stuck looking at a choice they cannot leave.
     */
    expect(initialFaceModeFor('filter')).toBe('hide');
    expect(initialFaceModeFor('show')).toBe('show');
    expect(initialFaceModeFor('hide')).toBe('hide');
  });
});

describe('cameraProblemFor — three different things went wrong, not two', () => {
  it('calls a missing device missing, under both spellings', () => {
    expect(cameraProblemFor('NotFoundError')).toBe('missing');
    // The spelling an older Chromium still uses. The shell's own inline version
    // did not have it, so the same unplugged camera was classified two ways on
    // two screens.
    expect(cameraProblemFor('DevicesNotFoundError')).toBe('missing');
    expect(cameraProblemFor('OverconstrainedError')).toBe('missing');
  });

  it('calls a refusal a refusal, including the two non-standard walls', () => {
    expect(cameraProblemFor('NotAllowedError')).toBe('blocked');
    expect(cameraProblemFor('PermissionDeniedError')).toBe('blocked');
    // Not a device problem and not a user decision, but for the person it is the
    // same wall with the same way round it.
    expect(cameraProblemFor('SecurityError')).toBe('blocked');
  });

  it('calls a device somebody else is holding BUSY, not a refusal', () => {
    /**
     * The row this function exists for. `NotReadableError` means the camera is
     * there and another application has it; reported as a refusal it tells
     * somebody to go and change a permission setting that is already correct.
     */
    expect(cameraProblemFor('NotReadableError')).toBe('busy');
    expect(cameraProblemFor('AbortError')).toBe('busy');
    expect(cameraProblemFor('UnknownError')).toBe('busy');
  });
});
