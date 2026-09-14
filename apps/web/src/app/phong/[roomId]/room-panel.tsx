import type { MessageKey, Translate } from '../../i18n/messages';
import { useT } from '../../i18n/use-t';
import type { JoinPhase, MediaDecision, MediaFaceMode, ParticipantRow } from './room-media';

/**
 * The room, as markup, with no state and no effect in it.
 *
 * The same shape `pre-join.tsx` uses and for the same reason (`AGENTS.md` §6):
 * the `web` Vitest project has no DOM, so anything with a `useState`, a
 * `useEffect` or a `window` read cannot be executed by a test at all. Everything
 * here arrives as a prop, every decision that produced a prop is a pure function
 * in `room-media.ts`, and `renderToStaticMarkup` therefore renders the real HTML
 * of every row of the story's edge-case matrix.
 *
 * ## What it cannot render, by construction
 *
 * {@link MediaDecision} carries the face mode and the audio intent and NOT the
 * token or the URL, so there is no prop here that could put a credential in the
 * markup. `RoomShell` holds the whole `RoomDecision`; this file is never handed
 * one.
 *
 * ## Colour is never the only channel
 *
 * Epic 2's context is explicit about it — the palette's green/terracotta pair is
 * the hardest one for red-green colour blindness and it is carrying the three
 * facts that matter most. So every state on this screen is a SENTENCE first: the
 * connection chip has words in it, a speaking row says so, a muted row says so.
 * The chip's `ok`/`warn` variants are the second channel, not the first.
 */

/**
 * The ids this panel's landmarks carry.
 *
 * They are spelled here, in the file that writes the markup, and they are not
 * re-exported anywhere: Story 2.3's `ROOM_SHELL_HEADING_ID` / `ROOM_SHELL_SUMMARY_ID`
 * were removed rather than aliased, because `routes.test.ts`'s rule C refuses an
 * export nothing in the product reads and an alias nobody imports is exactly that.
 * Exported from here so `room-panel.test.tsx` and `tests/e2e/web/phong.spec.ts` can
 * find a landmark by id rather than by sentence — which matters more from Story 2.4
 * on, because the heading's sentence now depends on the phase.
 */
export const ROOM_HEADING_ID = 'phong-tieu-de';
export const ROOM_SUMMARY_ID = 'phong-tom-tat';
export const ROOM_STATUS_ID = 'phong-trang-thai';
export const ROOM_PARTICIPANTS_ID = 'phong-nguoi-tham-gia';
export const ROOM_COUNT_ID = 'phong-so-nguoi';

/**
 * The heading, per phase — because "Bạn đã vào phòng" is a CLAIM and it is false
 * in four of the six.
 *
 * The first version printed it unconditionally, so a refused join rendered
 * "Bạn đã vào phòng" directly above an alert reading "Không vào được phòng.", and
 * a lapsed token rendered it above "Chờ quá lâu, hãy vào lại." A screen-reader user
 * arriving at that page is told they are in a room they are not in, by the one
 * element that names the page.
 */
const HEADING_KEYS: Readonly<Record<JoinPhase, MessageKey>> = {
  connecting: 'room.headingJoining',
  connected: 'room.heading',
  reconnecting: 'room.heading',
  failed: 'room.headingOutside',
  expired: 'room.headingOutside',
  left: 'room.headingLeft',
};

/**
 * Which sentence restates the face decision — all three members, named.
 *
 * `faceMode === 'hide' ? … : …` told a `filter` participant "Bạn đang để nguyên
 * khuôn mặt", which is the wrong promise made by the one screen whose job is to
 * restate the promise. Pre-join disables Filter today and Story 2.7 enables it;
 * a `Record` over the union means that story cannot forget this line, because
 * adding a fourth mode would not compile.
 */
const FACE_KEYS: Readonly<Record<MediaFaceMode, MessageKey>> = {
  show: 'room.faceShow',
  hide: 'room.faceHide',
  filter: 'room.faceFilter',
};

/**
 * The chip's sentence, per phase.
 *
 * Six phases, four sentences: `failed` and `expired` are both "no longer in the
 * room", and what makes them different is the NOTICE underneath, which names the
 * cause and offers the way back. Saying it twice in two registers would be two
 * things for a screen reader to reconcile.
 */
const STATUS_KEYS: Readonly<Record<JoinPhase, MessageKey>> = {
  connecting: 'room.statusConnecting',
  connected: 'room.statusConnected',
  reconnecting: 'room.statusReconnecting',
  failed: 'room.statusLeft',
  expired: 'room.statusLeft',
  left: 'room.statusLeft',
};

/** `ok` only when the room is really up; `warn` for everything that is not. */
const STATUS_TONES: Readonly<Record<JoinPhase, string>> = {
  connecting: 'chip-status',
  connected: 'chip-status ok',
  reconnecting: 'chip-status warn',
  failed: 'chip-status warn',
  expired: 'chip-status warn',
  left: 'chip-status warn',
};

/** Whether the person is still in the room, or looking at a way back to pre-join. */
const IN_ROOM: ReadonlySet<JoinPhase> = new Set<JoinPhase>(['connecting', 'connected', 'reconnecting']);

/**
 * The list appears only once the room is really up AND there is somebody in it.
 *
 * While `connecting` there is nobody — not even the reader, who is not a
 * participant until the handshake finishes. And the `rows.length > 0` half at the
 * call site closes the gap between `Connected` arriving and the first `refresh()`
 * landing, in which the count rendered "Có 0 người trong phòng." inside a room the
 * reader is standing in. Both are the same sentence said wrong: an empty list is
 * read as "the room is empty", never as "we are not finished yet".
 */
const LISTS_PEOPLE: ReadonlySet<JoinPhase> = new Set<JoinPhase>(['connected', 'reconnecting']);

/**
 * What a row is called: the reader by the catalogue's word for themselves, anybody
 * else by the name LiveKit carries — and by the catalogue's word for a person when
 * it carries none, which is every remote row today. See {@link ParticipantRow}.
 */
function participantName(row: ParticipantRow, t: Translate): string {
  if (row.isSelf) {
    return t('room.you');
  }
  return row.label === '' ? t('room.participantUnnamed') : row.label;
}

/**
 * The row's state, as WORDS. `null` is the ordinary case — microphone on, not
 * speaking — which needs no announcement at all.
 */
function participantState(row: ParticipantRow, t: Translate): string | null {
  if (row.speaking) {
    return t('room.speaking');
  }
  return row.micOn ? null : t('room.micOff');
}

export function RoomPanel({
  decision,
  phase,
  rows,
  errorKey,
  micNoticeKey,
  audioBlocked,
  onLeave,
  onEnableAudio,
  onBackToPreJoin,
}: {
  readonly decision: MediaDecision;
  readonly phase: JoinPhase;
  /** Already ordered by `participantRowsFor`; this file does not sort. */
  readonly rows: readonly ParticipantRow[];
  /** The refusal that ended the join, or `null` while nothing has gone wrong. */
  readonly errorKey: MessageKey | null;
  /** The microphone's own bad news — refused, or ended from outside. Not fatal. */
  readonly micNoticeKey: MessageKey | null;
  /** The browser is refusing to play the room until a gesture asks it to. */
  readonly audioBlocked: boolean;
  readonly onLeave: () => void;
  readonly onEnableAudio: () => void;
  readonly onBackToPreJoin: () => void;
}) {
  const t = useT();
  const inRoom = IN_ROOM.has(phase);
  const listsPeople = LISTS_PEOPLE.has(phase) && rows.length > 0;

  return (
    <section className="card" aria-labelledby={ROOM_HEADING_ID}>
      <h1 id={ROOM_HEADING_ID}>{t(HEADING_KEYS[phase])}</h1>

      {/*
        `role="status"` on the chip's own line, not on the whole card: a polite
        live region announces what CHANGED, and a region wrapping the participant
        list would re-read the list every time somebody started speaking.
      */}
      <p id={ROOM_STATUS_ID} className="room-status" role="status">
        <span className={STATUS_TONES[phase]}>{t(STATUS_KEYS[phase])}</span>
      </p>

      {/*
        The two sentences Story 2.3 put here, with the `role="status"` it gave
        them. The summary is a restatement of what the person decided, and it is
        the first thing a screen-reader user should hear on arrival — the role is
        what makes that sentence true rather than a comment about an intention.
        It never changes after mount, so it competes with nothing.
      */}
      <p id={ROOM_SUMMARY_ID} role="status">
        {t(FACE_KEYS[decision.faceMode])}{' '}
        {t(decision.audio === 'mic' ? 'room.audioMic' : 'room.audioListenOnly')}
      </p>

      {errorKey === null ? null : (
        <p className="notice notice-alert" role="alert">
          {t(errorKey)}
        </p>
      )}

      {micNoticeKey === null ? null : (
        <p className="notice notice-alert" role="alert">
          {t(micNoticeKey)}
        </p>
      )}

      {/*
        Autoplay refused. Everything else on this screen says the room is up, so
        without this the page is a complete lie: the chip reads "Đang ở trong
        phòng", everybody is listed, and there is silence. The sentence is an
        `alert` because it is the one thing between the reader and a session they
        cannot hear, and the button is the gesture the policy is waiting for.
      */}
      {audioBlocked ? (
        <p className="notice notice-alert" role="alert">
          {t('room.audioBlocked')}{' '}
          <button type="button" className="button-primary" onClick={onEnableAudio}>
            {t('room.enableAudio')}
          </button>
        </p>
      ) : null}

      {listsPeople ? (
        <>
          {/*
            The count is a polite live region, and it is the ONLY one on the list
            side. Somebody joining or leaving changes this sentence, so a screen
            reader hears "Có 3 người trong phòng." — which is the matrix row
            "hàng biến mất, đếm lại số người" actually reaching a person. The
            region is deliberately NOT around the `<ul>`: speaking changes a row
            every few seconds, and a region there would re-read every name.
          */}
          <p id={ROOM_COUNT_ID} className="meta" role="status">
            {t.plural('room.participantCount', rows.length, { count: rows.length })}
          </p>
          <ul id={ROOM_PARTICIPANTS_ID} className="participant-list" aria-label={t('room.participants')}>
            {rows.map((row) => (
              <li key={row.id} className="participant-row">
                {/*
                  `aria-hidden`, because the two letters are a picture OF the name
                  that is read out on the very next line. A screen reader that
                  spelled them would say the same person twice.
                */}
                <span className="avatar-letter" aria-hidden="true">
                  {row.initials}
                </span>
                <span className="participant-name">{participantName(row, t)}</span>
                <span className="participant-state">{participantState(row, t)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/*
        The one sentence pre-join already said, said again where the room begins.
        Epic 2's context puts it on pre-join because that is where somebody decides
        to show a face; it is repeated here because the promise is about the ROOM.
      */}
      <p className="meta">{t('room.notRecorded')}</p>

      {inRoom ? (
        <button type="button" className="button-secondary" onClick={onLeave}>
          {t('room.leave')}
        </button>
      ) : (
        <button type="button" className="button-primary" onClick={onBackToPreJoin}>
          {t('preJoin.retryJoin')}
        </button>
      )}
    </section>
  );
}
