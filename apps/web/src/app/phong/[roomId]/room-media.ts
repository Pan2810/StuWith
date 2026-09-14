import type { MessageKey } from '../../i18n/messages';

/**
 * Every decision the room's media plane makes, as pure functions.
 *
 * ## Why this file has no React and no `livekit-client` value import
 *
 * The `web` Vitest project runs with `environment: 'node'` and no DOM
 * (`AGENTS.md` §6), so a module that touches `window` at import time cannot be
 * executed by a test at all. `livekit-client` is a browser SDK: importing it for
 * its enums would put the whole thing in this module's graph and take every
 * function below out of reach. So the SDK appears here only as a TYPE, and the
 * two enums whose values matter — `ConnectionState` and `DisconnectReason` — are
 * re-declared as the raw wire values they carry and mapped by
 * {@link roomConnectionStateFor} and {@link disconnectReasonKeyFor}. The shell is
 * where the SDK is loaded, and it is loaded dynamically for the same reason.
 *
 * ## Why it does not import `room-shell.tsx` either
 *
 * `room-shell.tsx` imports THIS file. `.dependency-cruiser.cjs` runs with
 * `tsPreCompilationDeps: true`, so a type-only import back would be an edge like
 * any other and `no-circular` would fail the build — the same trap
 * `room-shell.tsx`'s own docblock records about `pre-join.tsx`. {@link MediaDecision}
 * is therefore the HALF of the decision this file reads, declared structurally;
 * `RoomDecision` satisfies it without either file naming the other.
 */

/* -------------------------------------------------------------------------- *
 * Publishing
 * -------------------------------------------------------------------------- */

/**
 * What the microphone track is published with — spelled out, never inherited.
 *
 * Epic 2's context puts audio above video without exception, and the SDK's
 * defaults happen to agree today: `dtx` and `red` default to on for a mono track
 * and `AudioPresets.music` is the default preset. "Happens to agree" is the
 * problem. A default is a decision somebody else owns, it can change in a minor
 * release, and when Story 2.5 adds a video track the thing that must NOT yield is
 * this one — so it is declared here where a test can read it back.
 *
 * - `dtx` — the encoder stops sending during silence, which is most of a study
 *   room most of the time;
 * - `red` — each packet carries the previous one, so a single lost packet is not
 *   a gap in somebody's sentence. This is the half that pays for itself on the
 *   4G connection the epic is written for;
 * - `priority: 'high'` — the RTP sender's own priority, which is what the browser
 *   reads when it has to choose between two streams. The bitrate is the SDK's
 *   `AudioPresets.speech` value, written out rather than imported for the reason
 *   the docblock above gives.
 * - `forceStereo: false` — mono, because `dtx` and `red` are both mono-only in
 *   the SDK and a stereo capture would silently turn both of them off.
 */
export interface AudioPublishOptions {
  readonly dtx: true;
  readonly red: true;
  readonly forceStereo: false;
  readonly audioPreset: { readonly maxBitrate: number; readonly priority: 'high' };
}

export function audioPublishOptions(): AudioPublishOptions {
  return {
    dtx: true,
    red: true,
    forceStereo: false,
    audioPreset: { maxBitrate: 24_000, priority: 'high' },
  };
}

/**
 * The half of a `RoomDecision` the media plane and the panel read.
 *
 * Declared here rather than imported, for the cycle the file docblock explains —
 * and the SHAPE is doing a second job: there is no `token` and no `url` on it, so
 * `RoomPanel`, which takes one of these, cannot render either even by mistake.
 * `RoomDecision` satisfies it structurally, and only `RoomShell` holds the whole
 * thing.
 */
export type MediaFaceMode = 'show' | 'hide' | 'filter';

export interface MediaDecision {
  readonly faceMode: MediaFaceMode;
  readonly audio: 'mic' | 'listen-only';
}

/**
 * The options `new Room(...)` is built with.
 *
 * `adaptiveStream` and `dynacast` are both about VIDEO layers, and Story 2.4
 * publishes no video at all — they are set to `false` rather than left out so
 * that Story 2.5, which owns the degradation ladder, turns them on deliberately
 * instead of discovering they were already on.
 *
 * `publishDefaults` is present for `mic` and ABSENT for `listen-only`, and that
 * absence is the point rather than a saving: a listen-only room has nothing to
 * publish, so a set of publish defaults sitting there would describe a track that
 * must never exist.
 */
export interface MediaRoomOptions {
  readonly adaptiveStream: false;
  readonly dynacast: false;
  readonly stopLocalTrackOnUnpublish: true;
  readonly disconnectOnPageLeave: true;
  readonly publishDefaults?: AudioPublishOptions;
}

export function roomOptionsFor(decision: MediaDecision): MediaRoomOptions {
  const base = {
    adaptiveStream: false,
    dynacast: false,
    stopLocalTrackOnUnpublish: true,
    disconnectOnPageLeave: true,
  } as const;
  return decision.audio === 'mic' ? { ...base, publishDefaults: audioPublishOptions() } : base;
}

/* -------------------------------------------------------------------------- *
 * The token's clock
 * -------------------------------------------------------------------------- */

/**
 * Whether the admission has lapsed — `expires_at` from the wire, against a clock.
 *
 * `ROOM_TOKEN_TTL_SECONDS` is 120, and the SAME instant ends the token and the
 * reserved seat (`packages/contracts/src/rooms.ts`). Sitting on the shell past it
 * means holding a dead token against a seat somebody else can now take, so the
 * shell watches it and goes back to pre-join rather than connecting into a
 * refusal it cannot explain.
 *
 * An unparseable value answers `false`, deliberately. The body came through
 * `roomTokenResponseSchema`, so an unreadable instant is not a state the product
 * can reach; and if it ever did, refusing to enter a room over a clock we cannot
 * read would be a worse answer than letting LiveKit judge the token itself.
 */
export function tokenExpiredAt(expiresAt: string, now: number): boolean {
  const instant = Date.parse(expiresAt);
  return Number.isNaN(instant) ? false : instant <= now;
}

/* -------------------------------------------------------------------------- *
 * Where the join is
 * -------------------------------------------------------------------------- */

/**
 * `ConnectionState` from `livekit-client`, as the five strings it carries.
 *
 * A string enum is nominal in TypeScript, so `ConnectionState.Connected` is not
 * assignable to `'connected'` — which is exactly what makes this a function
 * rather than a cast. {@link roomConnectionStateFor} takes the raw value and
 * answers a word this file owns; a sixth state added by a future SDK lands on
 * `disconnected` instead of crashing a render.
 */
export type RoomConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'signalReconnecting';

const CONNECTION_STATES: ReadonlySet<string> = new Set<RoomConnectionState>([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'signalReconnecting',
]);

export function roomConnectionStateFor(raw: string): RoomConnectionState {
  return CONNECTION_STATES.has(raw) ? (raw as RoomConnectionState) : 'disconnected';
}

/**
 * Whether the room is UP — the one notion two different places need to agree on.
 *
 * {@link joinPhaseFor} uses it to decide that a lapsed token no longer matters,
 * and `RoomShell`'s expiry timer uses it to decide it must not tear anything down.
 * Written twice they drifted at once: the first spelling of `joinPhaseFor` left
 * `signalReconnecting` out, so a token that lapsed while the SDK was re-signalling
 * a live room reported `expired` and sent somebody back to pre-join out of a room
 * they were still in.
 */
export function isLiveConnection(state: RoomConnectionState): boolean {
  return state === 'connected' || state === 'reconnecting' || state === 'signalReconnecting';
}

/**
 * The six words the screen can be in, and the order they decide in.
 *
 * - `expired` wins over everything before the room is up, because it is the
 *   CAUSE: a token that lapsed while the handshake ran produces a refusal too,
 *   and reporting the refusal would send somebody to a retry that cannot work;
 * - `failed` is second — a refusal we did get, with a sentence and a way back;
 * - then the SDK's own state, which is the only thing that speaks once the room
 *   is really up. `expired` deliberately does NOT apply from `connected` on: the
 *   token buys the handshake, not the session, and a room that is up stays up.
 */
export type JoinPhase = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'expired' | 'left';

export function joinPhaseFor(
  connectionState: RoomConnectionState,
  error: MessageKey | null,
  expired: boolean,
): JoinPhase {
  if (expired && !isLiveConnection(connectionState)) {
    return 'expired';
  }
  if (error !== null) {
    return 'failed';
  }
  switch (connectionState) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'reconnecting':
    case 'signalReconnecting':
      return 'reconnecting';
    case 'disconnected':
      return 'left';
  }
}

/**
 * `DisconnectReason` from `@livekit/protocol`, as the numbers that matter here.
 *
 * `CLIENT_INITIATED` answers `null` — we are the client, "Rời phòng" was pressed
 * or the page went away, and announcing a disconnection somebody asked for reads
 * as a fault. `DUPLICATE_IDENTITY` is the one `deferred-work.md` predicted: the
 * token's `sub` IS the participant identity on LiveKit, so a second connection
 * under the same account evicts the first, and the person evicted has to be told
 * which of the two things happened. Everything else is one sentence and a way
 * back to pre-join; none of the remaining reasons is something a study room can
 * act on differently.
 */
export const DISCONNECT_CLIENT_INITIATED = 1;
export const DISCONNECT_DUPLICATE_IDENTITY = 2;

export function disconnectReasonKeyFor(reason: number | undefined): MessageKey | null {
  if (reason === DISCONNECT_CLIENT_INITIATED) {
    return null;
  }
  return reason === DISCONNECT_DUPLICATE_IDENTITY ? 'room.errorDuplicate' : 'room.errorDisconnected';
}

/* -------------------------------------------------------------------------- *
 * Who is in the room
 * -------------------------------------------------------------------------- */

/**
 * The letters on an avatar: first letter of the first and last word, tone marks
 * stripped, upper-cased, at most two.
 *
 * Diacritics come off by decomposition (`NFD` puts each mark in its own code
 * point, which the combining-mark range U+0300 to U+036F then removes); d with a
 * stroke (U+0111) is the one letter that is not a base plus a mark, so it is
 * mapped by hand. A name with nothing usable in it is `?` rather than an empty
 * tile.
 *
 * It lives HERE rather than in `pre-join.tsx`, where Story 2.3 wrote it, because
 * the participant list needs it too and `pre-join.tsx` cannot be imported from
 * this side of the graph without a cycle. `pre-join.tsx` re-exports it, so the
 * name it was tested under still resolves.
 */
export function avatarInitialsFor(displayName: string): string {
  const words = displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return '?';
  }
  // The first CODE POINT, not the first UTF-16 unit: a letter outside the BMP
  // would otherwise render half a surrogate pair as a broken glyph.
  const firstLetterOf = (word: string | undefined): string => [...(word ?? '')][0] ?? '';
  const first = firstLetterOf(words[0]);
  const last = words.length > 1 ? firstLetterOf(words[words.length - 1]) : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * The letters for somebody who arrived with no name at all — taken off the TAIL
 * of their identity, and the end is the whole point.
 *
 * {@link avatarInitialsFor} is built for a NAME: it splits on spaces and takes the
 * first letter of the first and last word. An identity is a uuidv7, which has no
 * spaces and whose leading characters are a millisecond timestamp — so every
 * person who joined in the same era is one word beginning with the same digit, and
 * the first version of this shipped a room in which every avatar read `0`. The
 * docblocks on both sides claimed the opposite ("everyone stays distinguishable"),
 * which is how a cosmetic bug becomes a false statement about the product.
 *
 * The last two alphanumerics are where a uuidv7's randomness lives, so two people
 * in one room reading the same pair is a 1-in-256 coincidence rather than a
 * certainty. It is still a coincidence that can happen, and nothing here pretends
 * otherwise: these letters are a hint beside a row, never the way somebody is
 * identified. A real display name is `deferred-work.md`'s item.
 */
export function identityInitialsFor(identity: string): string {
  const usable = [...identity.replace(/[^\p{L}\p{N}]/gu, '')];
  if (usable.length === 0) {
    return '?';
  }
  return usable.slice(-2).join('').toUpperCase();
}

/**
 * A participant as the media plane sees one: who they are, and whether their
 * microphone is travelling.
 *
 * Structural, so a test can build one without a `Room`. `identity` is the
 * token's `sub`, which is the account id — never shown, only used as a key.
 */
export interface MediaParticipant {
  readonly identity: string;
  /** The display name LiveKit carries, when there is one. */
  readonly name?: string;
  readonly micOn: boolean;
}

/**
 * One row of the list.
 *
 * `label` is DATA — a name off the wire — and `isSelf` is what the panel reads to
 * put the catalogue's word for the reader in its place. The panel never composes
 * a sentence out of a name.
 *
 * **`label` is `''` for everybody today, and that is a fact about the wire rather
 * than about this function.** `mintRoomToken` sets `sub` and no `name` claim, so
 * LiveKit has no display name to carry and the only string a remote participant
 * arrives with is the account id. Putting that id on a screen in a product whose
 * whole argument is presence without identity would be the wrong answer, so an
 * unnamed row carries an empty label and the panel renders the catalogue's word
 * for a person instead. `initials` then comes from {@link identityInitialsFor} —
 * the TAIL of the identity, where a uuidv7's randomness is, because its head is a
 * timestamp everybody in the room shares. `deferred-work.md` records who owns a
 * real display name.
 */
export interface ParticipantRow {
  readonly id: string;
  readonly label: string;
  readonly initials: string;
  readonly speaking: boolean;
  readonly micOn: boolean;
  readonly isSelf: boolean;
}

/**
 * The rows, ordered: the reader first, then everybody else by name.
 *
 * The reader is pinned to the top rather than sorted among the rest so that the
 * row whose microphone state a person can DO something about does not move under
 * them every time somebody joins. `localeCompare` with `vi` is what puts
 * Vietnamese names in the order a Vietnamese reader expects; `identity` breaks a
 * tie so two people with one name have a stable order rather than a flickering
 * one.
 *
 * A remote carrying the reader's own identity is dropped. LiveKit does not
 * produce one — the eviction in `deferred-work.md` is the reason it cannot — and
 * a duplicate row would be a person seeing themselves twice, so it is refused
 * here rather than left to the server's good behaviour.
 */
export function participantRowsFor(
  local: MediaParticipant | null,
  remotes: readonly MediaParticipant[],
  speakers: readonly string[],
): readonly ParticipantRow[] {
  const speaking = new Set(speakers);
  const rowFor = (participant: MediaParticipant, isSelf: boolean): ParticipantRow => {
    const name = participant.name?.trim() ?? '';
    return {
      id: participant.identity,
      label: name,
      // Two different readers, because a name and a uuid are different shapes and
      // the name-shaped reader answers `0` for every uuid on earth.
      initials: name.length > 0 ? avatarInitialsFor(name) : identityInitialsFor(participant.identity),
      speaking: speaking.has(participant.identity) && participant.micOn,
      micOn: participant.micOn,
      isSelf,
    };
  };

  const seen = new Set<string>();
  const rows: ParticipantRow[] = [];
  if (local !== null) {
    seen.add(local.identity);
    rows.push(rowFor(local, true));
  }
  const others = remotes
    .filter((participant) => {
      if (seen.has(participant.identity)) {
        return false;
      }
      seen.add(participant.identity);
      return true;
    })
    .map((participant) => rowFor(participant, false))
    .sort((a, b) => a.label.localeCompare(b.label, 'vi') || a.id.localeCompare(b.id));

  return [...rows, ...others];
}
