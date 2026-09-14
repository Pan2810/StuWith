import { describe, expect, it } from 'vitest';
import { PIPELINE_FPS } from './frame-pipeline';
import {
  DISCONNECT_CLIENT_INITIATED,
  DISCONNECT_DUPLICATE_IDENTITY,
  MEDIA_FACE_MODES,
  NETWORK_CHIP_DEBOUNCE_FALLBACK_MS,
  NETWORK_RETRY_SECONDS,
  NETWORK_RUNGS,
  VIDEO_MAX_BITRATE,
  audioPublishOptions,
  cameraProblemFor,
  chipDebounceMsFor,
  connectionQualityFor,
  disconnectReasonKeyFor,
  faceModeAllowsVideo,
  faceModeSelectable,
  initialFaceModeFor,
  identityInitialsFor,
  isLiveConnection,
  joinPhaseFor,
  networkRungFor,
  offersCameraRestart,
  participantRowsFor,
  roomConnectionStateFor,
  roomOptionsFor,
  rungAllowsVideo,
  rungBannerKeyFor,
  rungChipKeyFor,
  rungChipToneFor,
  tokenExpiredAt,
  videoKeyFor,
  videoPublishOptions,
  type MediaConnectionQuality,
  type MediaFaceMode,
  type MediaParticipant,
  type MediaVideoPublication,
  type NetworkRung,
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

  it('decides the ladder’s two knobs, and decides them differently', () => {
    const options = roomOptionsFor({ faceMode: 'show', audio: 'mic' });
    // Not one answer for both: `dynacast` is the publish-side half of the ladder
    // and has something to switch off now that simulcast is on; `adaptiveStream`
    // measures the tile Story 2.6 has not built, and would make bậc 3's own
    // measurement ambiguous. See the docblock on `roomOptionsFor`.
    expect(options.adaptiveStream).toBe(false);
    expect(options.dynacast).toBe(true);
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

  it('publishes SIMULCAST, because the ladder needs rungs to fall down', () => {
    /**
     * Story 2.5 turns it on, and this assertion is the cheap half of pinning it.
     * The expensive half is on the wire: `a=simulcast:send` plus two `a=rid:`
     * lines in the negotiated description
     * (`tests/e2e/livekit/phong-media.spec.ts`). The field is typed `boolean`
     * rather than literal `true` — unlike `dtx`/`red` above — precisely so that
     * the probe's mutation is one edit that RUNS rather than a compile error
     * nobody can execute.
     */
    expect(videoPublishOptions().simulcast).toBe(true);
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

describe('roomOptionsFor decides the ladder’s two knobs, one each way', () => {
  it('turns dynacast ON now that there are simulcast layers to switch off', () => {
    /**
     * Story 2.4 set both to `false` because it published no video; Story 2.7 kept
     * them and recorded the debt so that THIS story would decide rather than
     * discover. `dynacast` stops sending the layers nobody subscribes to, which
     * is uplink taken back from the person on bad wifi without touching a byte of
     * audio — and it had nothing to switch off until `videoPublishOptions()`
     * started publishing more than one layer.
     */
    expect(roomOptionsFor({ faceMode: 'show', audio: 'mic' }).dynacast).toBe(true);
  });

  it('leaves adaptiveStream OFF, and the second reason is the ladder’s own', () => {
    /**
     * Two reasons, and the second is why this is 2.5's decision rather than a
     * carry-over: it measures the `<video>` that Story 2.6 has not built yet, and
     * it would make bậc 3's measurement ambiguous — an empty tile at the far end
     * could be the ladder or an element measurement, and the probe would stop
     * discriminating between them.
     */
    expect(roomOptionsFor({ faceMode: 'show', audio: 'mic' }).adaptiveStream).toBe(false);
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

/* -------------------------------------------------------------------------- *
 * Story 2.5 — thang suy giảm mạng bốn bậc
 * -------------------------------------------------------------------------- */

/**
 * Every row of the story's matrix, through the functions that decide it.
 *
 * The ladder is the third "wanted" dimension in `room-shell.tsx`'s reconciler,
 * and that file has no unit coverage at all (`deferred-work.md` owns it). So the
 * discipline these cases enforce is that every DECISION lives here, where a
 * DOM-less project can execute it, and the shell is left holding only the wiring.
 */

const QUALITIES: readonly MediaConnectionQuality[] = [
  'excellent',
  'good',
  'poor',
  'lost',
  'unknown',
];

describe('the rung is read from TWO signals, and the connection state is the veto', () => {
  it.each([
    ['excellent', 1],
    ['good', 2],
    ['poor', 3],
    ['lost', 4],
  ] as ReadonlyArray<readonly [MediaConnectionQuality, NetworkRung]>)(
    'a connected room reporting %s is bậc %i',
    (quality, rung) => {
      expect(networkRungFor(quality, 'connected')).toBe(rung);
    },
  );

  it('treats an unmeasured line as bậc 1, so nobody is greeted with bad news', () => {
    /**
     * `unknown` is what the SDK reports until it has measured something, which
     * every single join passes through. Answering bậc 3 there would put a warning
     * chip on screen — and take somebody's camera off — over a line nobody has
     * looked at yet.
     */
    expect(networkRungFor('unknown', 'connected')).toBe(1);
    expect(rungAllowsVideo(networkRungFor('unknown', 'connected'))).toBe(true);
  });

  it.each(['reconnecting', 'signalReconnecting'] as readonly RoomConnectionState[])(
    'a room that is %s is bậc 4 whatever the quality last said',
    (state) => {
      /**
       * The VETO, and it is the half the container-stop probe drives. Quality
       * goes on reporting `excellent` for a moment after the socket has gone, so
       * a ladder that read quality alone would paint "Mạng tốt" over a room that
       * had stopped existing.
       */
      for (const quality of QUALITIES) {
        expect(networkRungFor(quality, state)).toBe(4);
      }
    },
  );

  it.each(['connecting', 'disconnected'] as readonly RoomConnectionState[])(
    'says nothing about the line while the phase is %s',
    (state) => {
      // `joinPhaseFor` owns the whole screen at these phases. A rung reading here
      // would be a second, quieter answer to a question already answered loudly.
      for (const quality of QUALITIES) {
        expect(networkRungFor(quality, state)).toBe(1);
      }
    },
  );

  it('maps an unrecognised quality onto unknown rather than crashing a render', () => {
    expect(connectionQualityFor('excellent')).toBe('excellent');
    expect(connectionQualityFor('lost')).toBe('lost');
    // A sixth quality invented by a future SDK.
    expect(connectionQualityFor('catastrophic')).toBe('unknown');
    expect(connectionQualityFor('')).toBe('unknown');
  });
});

describe('only bậc 3 takes the picture off the wire', () => {
  it('lets bậc 1 and bậc 2 carry video, and refuses at bậc 3', () => {
    expect(rungAllowsVideo(1)).toBe(true);
    expect(rungAllowsVideo(2)).toBe(true);
    expect(rungAllowsVideo(3)).toBe(false);
  });

  it('leaves bậc 4 alone, because a frozen grid is not a teardown', () => {
    /**
     * The assertion that reads wrong and is right. At bậc 4 the SDK is running
     * its own resume and the publication is untouched; tearing video down there
     * would mean a two-second blip costs somebody their camera until they press a
     * button — the ladder punishing the recovery it is supposed to be riding out.
     */
    expect(rungAllowsVideo(4)).toBe(true);
  });

  it('is total over the rungs, so a fifth one could not be forgotten', () => {
    expect(NETWORK_RUNGS.map((rung) => rungAllowsVideo(rung))).toEqual([true, true, false, true]);
  });
});

describe('the chip has two levels, and bậc 4 has none', () => {
  it('says the same thing at bậc 1 and bậc 2 — there is nothing for you to do', () => {
    expect(rungChipKeyFor(1)).toBe('room.networkOk');
    expect(rungChipKeyFor(2)).toBe('room.networkOk');
  });

  it('names the weak line at bậc 3', () => {
    expect(rungChipKeyFor(3)).toBe('room.networkWeak');
  });

  it('renders NO network chip at bậc 4, so two chips cannot contradict each other', () => {
    /**
     * The spec's own question — "hợp nhất hay đứng cạnh nhau" — answered. They
     * stand side by side, and bậc 4 is the one rung where they would say the same
     * news twice (beside "Đang nối lại…") or deny it (beside "Đang ở trong
     * phòng"). There the phase chip owns the state and the banner carries the
     * rest.
     */
    expect(rungChipKeyFor(4)).toBeNull();
  });

  it('keeps a tone for every rung even where there is no chip to paint', () => {
    // Total on purpose: a tone that went `null` in sympathy would be one more
    // place a future rung has to remember to fill in.
    expect(NETWORK_RUNGS.map((rung) => rungChipToneFor(rung))).toEqual([
      'chip-status ok',
      'chip-status ok',
      'chip-status warn',
      'chip-status warn',
    ]);
  });
});

describe('bậc 2 is SILENT, and that is an assertion rather than an empty cell', () => {
  it('produces no banner at bậc 1 or bậc 2', () => {
    /**
     * The mutation `Verification` names: make bậc 2 return a banner key and this
     * goes red. Telling somebody their video just dropped a simulcast layer turns
     * a thing that is working into a thing that looks broken.
     */
    expect(rungBannerKeyFor(1, false)).toBeNull();
    expect(rungBannerKeyFor(2, false)).toBeNull();
    // And the retry clock cannot conjure one at a rung that has no clock.
    expect(rungBannerKeyFor(1, true)).toBeNull();
    expect(rungBannerKeyFor(2, true)).toBeNull();
  });

  it('says at bậc 3 both what happened and what it bought', () => {
    // "Video off" alone reads as a fault; "video off TO KEEP THE SOUND" is the
    // trade `epic-2-context.md` ranks, said to the person paying it.
    expect(rungBannerKeyFor(3, false)).toBe('room.networkWeakBanner');
    expect(rungBannerKeyFor(3, true)).toBe('room.networkWeakBanner');
  });

  it('stops promising at bậc 4 once the clock has run out', () => {
    expect(rungBannerKeyFor(4, false)).toBe('room.networkLostBanner');
    expect(rungBannerKeyFor(4, true)).toBe('room.networkGaveUp');
  });
});

describe('the camera comes back only by a press, and only where that makes sense', () => {
  it('offers the button once the line recovers from a drop that really took a picture', () => {
    expect(offersCameraRestart(1, 'show', true)).toBe(true);
    expect(offersCameraRestart(2, 'show', true)).toBe(true);
  });

  it('offers nothing when no picture was on the wire to begin with', () => {
    // Somebody who joined hidden, or whose camera had already failed, has nothing
    // to restore — and a button implying they lost something would be a lie.
    expect(offersCameraRestart(1, 'show', false)).toBe(false);
    expect(offersCameraRestart(2, 'show', false)).toBe(false);
  });

  it.each(['hide', 'filter'] as readonly MediaFaceMode[])(
    'offers nothing to somebody who chose %s, even after a drop that took their picture',
    (faceMode) => {
      /**
       * The matrix row "hồi phục khi người dùng đã tự bấm Ẩn mặt ở bậc 3": their
       * press outranks the network's, so the offer disappears rather than
       * inviting them to undo their own decision. `filter` is refused by the same
       * rule rather than by a second one — `faceModeAllowsVideo` is the single
       * place that says which modes may open a camera.
       */
      expect(offersCameraRestart(1, faceMode, true)).toBe(false);
      expect(offersCameraRestart(2, faceMode, true)).toBe(false);
    },
  );

  it.each([3, 4] as readonly NetworkRung[])(
    'offers nothing at bậc %i, where the press could not be honoured anyway',
    (rung) => {
      // At bậc 3 the button would publish into the conditions the ladder just
      // refused; at bậc 4 there is no room to publish into.
      expect(offersCameraRestart(rung, 'show', true)).toBe(false);
    },
  );

  it('never offers on a rung or a mode that forbids video, for every combination', () => {
    // The class rather than the examples above: the offer can never disagree with
    // the two rules that decide whether a picture may exist at all.
    for (const rung of NETWORK_RUNGS) {
      for (const faceMode of MEDIA_FACE_MODES) {
        if (offersCameraRestart(rung, faceMode, true)) {
          expect(rungAllowsVideo(rung)).toBe(true);
          expect(faceModeAllowsVideo(faceMode)).toBe(true);
        }
      }
    }
  });
});

describe('the chip debounce is READ from the design token, in both spellings', () => {
  it('reads the authored value, milliseconds', () => {
    // `tokens.css` spells it `3000ms`.
    expect(chipDebounceMsFor('3000ms')).toBe(3_000);
    expect(chipDebounceMsFor('  3000ms  ')).toBe(3_000);
  });

  it('reads the SHIPPED value, seconds — which is the one that would have broken', () => {
    /**
     * Measured, not imagined: the production CSS Next emits minifies `3000ms` to
     * `3s`. A parser that knew only milliseconds would work all through
     * development and then answer THREE MILLISECONDS in the build that ships — a
     * debounce that does nothing, in the one environment no unit test runs
     * against.
     */
    expect(chipDebounceMsFor('3s')).toBe(3_000);
    expect(chipDebounceMsFor('0.5s')).toBe(500);
    expect(chipDebounceMsFor('3S')).toBe(3_000);
  });

  it('reads a leading-dot time, which is the other spelling a minifier emits', () => {
    // `0.5s` minifies to `.5s`. Requiring a digit before the point rejected a
    // perfectly ordinary CSS time and silently fell back.
    expect(chipDebounceMsFor('.5s')).toBe(500);
    expect(chipDebounceMsFor('.25s')).toBe(250);
  });

  it('takes an authored 0ms as an instruction, not as an unreadable value', () => {
    /**
     * `0ms` is somebody in the stylesheet saying "no debounce". Answering the
     * fallback there overrides a decision made where the decision belongs with
     * one made in TypeScript, and does it invisibly.
     */
    expect(chipDebounceMsFor('0ms')).toBe(0);
    expect(chipDebounceMsFor('0s')).toBe(0);
  });

  it('falls back rather than inventing a meaning when the stylesheet cannot be read', () => {
    // A chip with no debounce flickers on every quality sample, which is the one
    // failure this token exists to prevent. Wrong in the direction people notice.
    expect(chipDebounceMsFor('')).toBe(NETWORK_CHIP_DEBOUNCE_FALLBACK_MS);
    expect(chipDebounceMsFor('var(--something-else)')).toBe(NETWORK_CHIP_DEBOUNCE_FALLBACK_MS);
    // A bare number: a unit is what makes a CSS time value readable at all, and
    // guessing milliseconds would be reading a meaning the stylesheet never gave.
    expect(chipDebounceMsFor('3')).toBe(NETWORK_CHIP_DEBOUNCE_FALLBACK_MS);
    expect(chipDebounceMsFor('3px')).toBe(NETWORK_CHIP_DEBOUNCE_FALLBACK_MS);
  });

  it('pins bậc 4’s window at the number the spec names', () => {
    expect(NETWORK_RETRY_SECONDS).toBe(30);
  });
});
