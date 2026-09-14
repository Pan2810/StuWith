import type { MessageKey, Translate } from '../../i18n/messages';
import { useT } from '../../i18n/use-t';
import {
  MEDIA_FACE_MODES,
  offersCameraRestart,
  rungBannerKeyFor,
  rungChipKeyFor,
  rungChipToneFor,
} from './room-media';
import type {
  JoinPhase,
  MediaDecision,
  MediaFaceMode,
  NetworkRung,
  ParticipantRow,
} from './room-media';

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
/** Story 2.7's group, in the room. Story 2.6 moves it into a popover. */
export const ROOM_FACE_MODE_FIELD = 'phong-che-do-khuon-mat';
export const ROOM_FACE_MODE_LEGEND_ID = 'phong-che-do-khuon-mat-nhan';
export const ROOM_SELF_PREVIEW_ID = 'phong-xem-truoc';
/** Story 2.5's own landmarks: the ladder's chip, its banner, and the frozen list. */
export const ROOM_NETWORK_CHIP_ID = 'phong-mang';
export const ROOM_NETWORK_BANNER_ID = 'phong-mang-thong-bao';
export const ROOM_NETWORK_RESTART_ID = 'phong-mang-bat-lai';
export const ROOM_NETWORK_COUNTDOWN_ID = 'phong-mang-dem-nguoc';
export const ROOM_GRID_FROZEN_ID = 'phong-luoi-dong-bang';

/**
 * How a live `<video>` reaches this file: ONE callback ref for every tile.
 *
 * A tile appears and disappears as somebody turns their camera on and off, so
 * there is no single element to hold — the shell has to be told the moment one
 * mounts, which is what a callback ref is and what a ref object is not. It is also
 * what keeps this component effect-free: nothing here attaches a stream, reads
 * `srcObject` or calls `play()`, so `renderToStaticMarkup` still runs it.
 *
 * WHICH picture an element should play travels on the element, in
 * `data-video-key`, rather than in a ref manufactured per key. Two reasons and
 * both were defects: a per-key factory wrote into a cache during the render pass,
 * and it had to be memoised or React would detach and re-attach every tile on
 * every re-render. One stable function plus React 19's ref-cleanup contract has
 * neither problem, and the cleanup is what tells a detach WHICH element went.
 */
export type VideoRef = (element: HTMLVideoElement) => () => void;

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

/** The three labels of the group, in display order. A `Record`, for FACE_KEYS' reason. */
const MODE_KEYS: Readonly<Record<MediaFaceMode, MessageKey>> = {
  show: 'room.modeShow',
  hide: 'room.modeHide',
  filter: 'room.modeFilter',
};

/**
 * Which choices the group will accept, in the room.
 *
 * `filter` is `false` here and in `faceModeAllowsVideo` — two files saying no to
 * the same unfinished mode, one about the markup and one about the camera. That
 * is not duplication to remove: this one keeps a person from selecting it, the
 * other keeps a device from opening if anything ever did.
 *
 * `show` follows `showAvailable`, which is the matrix row "không có camera": the
 * choice is DISABLED rather than offered and then refused, so nobody presses a
 * button whose only possible answer is a sentence.
 */
function faceModeSelectable(mode: MediaFaceMode, showAvailable: boolean): boolean {
  switch (mode) {
    case 'filter':
      return false;
    case 'show':
      return showAvailable;
    case 'hide':
      return true;
  }
}

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
 * Which phases the LADDER is allowed to say anything on — Story 2.5.
 *
 * Deliberately NOT {@link IN_ROOM}, and the difference is `connecting`. Caught by
 * an existing case rather than by inspection: with the ladder gated on `IN_ROOM`,
 * the handshake rendered "Mạng tốt" beside "Đang vào phòng…" — a claim about the
 * quality of a line nobody has measured yet, made by the one element on the
 * screen whose job is to be trustworthy about the connection. It is the same
 * reason {@link networkRungFor} answers bậc 1 for every phase but `connected`:
 * before the room is up, `joinPhaseFor` owns the whole screen.
 *
 * And not {@link LISTS_PEOPLE} either, even though the two sets are equal today.
 * That one is about whether there is anybody to list; this one is about whether
 * there is a line to describe. Sharing the constant would tie two unrelated
 * decisions together for the next story to untangle.
 */
const NETWORK_SPEAKS: ReadonlySet<JoinPhase> = new Set<JoinPhase>(['connected', 'reconnecting']);

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
  faceMode,
  showAvailable,
  selfVideoOn,
  selfVideoKey,
  videoRef,
  errorKey,
  micNoticeKey,
  videoNoticeKey,
  audioBlocked,
  networkRung,
  networkChipRung,
  networkRetrySeconds,
  networkTookCamera,
  onLeave,
  onEnableAudio,
  onBackToPreJoin,
  onChangeFaceMode,
  onRestartCamera,
}: {
  readonly decision: MediaDecision;
  readonly phase: JoinPhase;
  /** Already ordered by `participantRowsFor`; this file does not sort. */
  readonly rows: readonly ParticipantRow[];
  /**
   * The mode IN FORCE right now, not the one pre-join ended on.
   *
   * `decision.faceMode` is still a prop and is still only the audio intent's
   * companion: reading it for the summary sentence is what made a person who had
   * pressed "Ẩn mặt" in the room go on being told they were showing their face.
   */
  readonly faceMode: MediaFaceMode;
  /** `false` once the camera answered `NotFoundError`: "Để nguyên" is disabled. */
  readonly showAvailable: boolean;
  /** The canvas track is really on the wire — the only state the preview may claim. */
  readonly selfVideoOn: boolean;
  /** The key the shell files the local picture under. See {@link VideoRef}. */
  readonly selfVideoKey: string;
  /** ONE ref for every `<video>` on the screen. See {@link VideoRef}. */
  readonly videoRef: VideoRef;
  /** The refusal that ended the join, or `null` while nothing has gone wrong. */
  readonly errorKey: MessageKey | null;
  /** The microphone's own bad news — refused, or ended from outside. Not fatal. */
  readonly micNoticeKey: MessageKey | null;
  /** The camera's own bad news. Never fatal to the room and never to the sound. */
  readonly videoNoticeKey: MessageKey | null;
  /** The browser is refusing to play the room until a gesture asks it to. */
  readonly audioBlocked: boolean;
  /**
   * Which rung of Story 2.5's ladder the room is on, RIGHT NOW.
   *
   * Everything on this screen that describes the room reads this one: the
   * banner, the frozen list, and whether a restart may be offered. The shell's
   * docblock states the invariant in full — there are two rung values and only
   * this one decides. Deriving any of the three from
   * {@link networkChipRung} meant the camera went off three seconds before a
   * sentence explained why, the list stayed unfrozen three seconds into bậc 4,
   * and the chip could read "Mạng tốt" beside "Đang nối lại…".
   */
  readonly networkRung: NetworkRung;
  /**
   * The same rung, held back by `--motion-network-chip-debounce`, FOR THE CHIP
   * AND NOTHING ELSE.
   *
   * A chip that followed the raw signal would flicker through three states while
   * somebody's wifi wobbled, which is the one failure the token exists to
   * prevent. That is the whole of its job: it must never reach a decision.
   */
  readonly networkChipRung: NetworkRung;
  /**
   * Seconds left on bậc 4's retry clock, or `null` when no clock is running.
   *
   * `0` is not `null`: it is the clock having run out, which is what turns the
   * banner from a promise into a way back out. Both halves are read by
   * {@link rungBannerKeyFor}.
   */
  readonly networkRetrySeconds: number | null;
  /** The ladder took a picture that really was on the wire. See {@link offersCameraRestart}. */
  readonly networkTookCamera: boolean;
  readonly onLeave: () => void;
  readonly onEnableAudio: () => void;
  readonly onBackToPreJoin: () => void;
  /** Instant, no confirmation dialog. The ONLY thing that changes the mode. */
  readonly onChangeFaceMode: (mode: MediaFaceMode) => void;
  /**
   * The only way back from bậc 3, and it is a PRESS.
   *
   * It does not change the face mode and it is not offered to somebody who chose
   * to hide — `epic-2-context.md` forbids any system event putting a person back
   * on "Để nguyên", and a button the network made appear would be the system
   * asking on their behalf if it were offered where the answer was already no.
   */
  readonly onRestartCamera: () => void;
}) {
  const t = useT();
  const inRoom = IN_ROOM.has(phase);
  const listsPeople = LISTS_PEOPLE.has(phase) && rows.length > 0;
  /**
   * The ladder speaks only while there is a room to speak about.
   *
   * `failed`, `expired` and `left` are screens whose whole subject is that the
   * person is OUT, with a sentence and a way back; a chip reading "Mạng tốt"
   * beside "Đã rời phòng" is the two-contradictory-chips failure in its most
   * obvious form.
   */
  const networkSpeaks = NETWORK_SPEAKS.has(phase);
  // The CHIP, and only the chip, reads the debounced rung.
  const networkChipKey = networkSpeaks ? rungChipKeyFor(networkChipRung) : null;
  // Everything below describes the room as it is.
  const retryExhausted = networkRetrySeconds === 0;
  const networkBannerKey = networkSpeaks ? rungBannerKeyFor(networkRung, retryExhausted) : null;
  const gridFrozen = networkSpeaks && networkRung === 4;
  const canRestartCamera =
    networkSpeaks && offersCameraRestart(networkRung, faceMode, networkTookCamera);
  const countingDown = networkSpeaks && networkRetrySeconds !== null && networkRetrySeconds > 0;

  return (
    <section className="card" aria-labelledby={ROOM_HEADING_ID}>
      <h1 id={ROOM_HEADING_ID}>{t(HEADING_KEYS[phase])}</h1>

      {/*
        `role="status"` on the chip's own line, not on the whole card: a polite
        live region announces what CHANGED, and a region wrapping the participant
        list would re-read the list every time somebody started speaking.
      */}
      {/*
        TWO chips on one line, and {@link rungChipKeyFor} is where the decision
        that they stand side by side rather than merge is written out. The phase
        chip answers "am I in this room"; the network chip answers "how good is
        the line". Both are words first and colour second.
      */}
      <p id={ROOM_STATUS_ID} className="room-status" role="status">
        <span className={STATUS_TONES[phase]}>{t(STATUS_KEYS[phase])}</span>
        {networkChipKey === null ? null : (
          <span id={ROOM_NETWORK_CHIP_ID} className={rungChipToneFor(networkChipRung)}>
            {t(networkChipKey)}
          </span>
        )}
      </p>

      {/*
        The two sentences Story 2.3 put here, with the `role="status"` it gave
        them. The summary is a restatement of what the person decided, and it is
        the first thing a screen-reader user should hear on arrival — the role is
        what makes that sentence true rather than a comment about an intention.
        It never changes after mount, so it competes with nothing.
      */}
      <p id={ROOM_SUMMARY_ID} role="status">
        {t(FACE_KEYS[faceMode])}{' '}
        {t(decision.audio === 'mic' ? 'room.audioMic' : 'room.audioListenOnly')}
      </p>

      {/*
        The group, in the room, beside the sentence it restates — Story 2.7.

        Offered from the FIRST frame, `connecting` included, which is why
        `IN_ROOM` rather than `LISTS_PEOPLE` gates it: somebody who wants their
        face off must not have to wait out a handshake first, and the shell's
        reconciler is built so that a press landing inside the handshake is the
        one that wins.

        A native radio group with a group label, not three buttons: the legend is
        what a screen reader announces with every option, and native radios are
        what make the arrow keys work without a line of script. `role` and
        `aria-checked` are written out as well as implied because the spec names
        them. No confirmation dialog anywhere — the change is the press.
      */}
      {inRoom ? (
        <fieldset
          className="field-group face-mode-group"
          role="radiogroup"
          aria-labelledby={ROOM_FACE_MODE_LEGEND_ID}
        >
          <legend className="form-label" id={ROOM_FACE_MODE_LEGEND_ID}>
            {t('room.faceModeLegend')}
          </legend>
          <div className="choice-list">
            {MEDIA_FACE_MODES.map((mode) => {
              const selectable = faceModeSelectable(mode, showAvailable);
              const checked = faceMode === mode;
              return (
                <label className="choice" key={mode}>
                  <input
                    type="radio"
                    role="radio"
                    name={ROOM_FACE_MODE_FIELD}
                    value={mode}
                    checked={checked}
                    aria-checked={checked}
                    disabled={!selectable}
                    onChange={() => {
                      onChangeFaceMode(mode);
                    }}
                  />
                  <span>{t(MODE_KEYS[mode])}</span>
                  {mode === 'filter' ? <span className="meta">{t('room.comingSoon')}</span> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {/*
        The preview of oneself, and the sentence under it is a CLAIM.

        Both halves have to be true before it renders: the person is asking to
        show a face AND the canvas track is really published. Review round 1 of
        this story found the state where only the second was checked — a live
        preview under "Đây là hình mọi người đang thấy" with "Ẩn mặt" selected
        beside it. Checking `faceMode` here as well makes that unrenderable.

        No `.preview-video`: that class mirrors the picture, which is right for a
        person looking at themselves before anybody else can and wrong for the
        frames on the wire, because the mirror is not what the room receives.
      */}
      {inRoom && faceMode === 'show' && selfVideoOn ? (
        <div className="room-self">
          <div className="room-video">
            {/*
              `aria-hidden` like every other picture in this panel, and for the
              same reason: the sentence underneath is what a screen reader should
              read. An unlabelled media element here would be announced as "video"
              with nothing said about whose it is or why it is on screen.
            */}
            <video
              id={ROOM_SELF_PREVIEW_ID}
              ref={videoRef}
              data-video-key={selfVideoKey}
              className="room-video-frame"
              aria-hidden="true"
              autoPlay
              muted
              playsInline
            />
          </div>
          <p className="meta">{t('room.selfPreview')}</p>
        </div>
      ) : null}

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
        The camera's bad news, kept separate from the microphone's on purpose: a
        person can lose one and keep the other, and one line holding both would
        have to choose which loss to report.
      */}
      {videoNoticeKey === null ? null : (
        <p className="notice notice-alert" role="alert">
          {t(videoNoticeKey)}
        </p>
      )}

      {/*
        Story 2.5's ladder, as three regions that are ALWAYS MOUNTED and filled
        when there is something to say.

        A live region inserted together with its content is commonly missed by
        assistive technology — the region has to exist before the text arrives
        for the change to be observed. The five sibling notices above mount once
        and never change their text, so they are left as they are; the ladder's
        do change (a retry promise becomes a give-up sentence, an invitation
        appears on recovery), which is exactly where a persistent region earns
        its cost. Empty, each collapses to `.sr` rather than `hidden`, because
        `hidden` would take it out of the accessibility tree and defeat the
        point.

        The COUNTDOWN is deliberately outside the alert. It rewrites itself once
        a second, and most screen readers re-announce a whole `role="alert"` on
        every mutation — thirty interruptions for one piece of news. It carries
        no live role at all: the sentence beside it has already said what is
        happening, and the number is detail for people who can see it.
      */}
      <p
        id={ROOM_NETWORK_BANNER_ID}
        className={networkBannerKey === null ? 'sr' : 'notice notice-alert room-network'}
        role="alert"
      >
        {networkBannerKey === null ? '' : t(networkBannerKey)}
      </p>

      {countingDown ? (
        <p id={ROOM_NETWORK_COUNTDOWN_ID} className="meta notice-countdown">
          {t.plural('countdown.retryIn', networkRetrySeconds ?? 0, {
            seconds: networkRetrySeconds ?? 0,
          })}
        </p>
      ) : null}

      {/*
        The way out, and it only appears once the clock has stopped promising.
        Before then the room really is still trying, and a button offering to
        abandon it would be inviting somebody to leave a session that is about to
        come back.

        Its label is its OWN key rather than `preJoin.retryJoin`. The sentence
        above it says to go back to the setup screen; a button reading "Thử lại"
        under that instruction names a different action from the one just given.
      */}
      {networkSpeaks && retryExhausted ? (
        <p className="room-network">
          <button type="button" className="button-primary" onClick={onBackToPreJoin}>
            {t('room.backToPreJoin')}
          </button>
        </p>
      ) : null}

      {/*
        The invitation, in a region of its own that outlives its content.

        {@link offersCameraRestart} only says yes below bậc 3 and
        {@link rungBannerKeyFor} only says anything from bậc 3 up, so this and
        the banner above can never be on screen together. That is the matrix row
        "hồi phục 3 → 1": the alert has gone, the chip has gone quietly back to
        "Mạng tốt", and this is the only thing left saying that something
        happened and that it is the person's to undo.

        `role="status"` and not `alert`: "lên bậc thì im lặng" means the recovery
        does not sound an alarm. It still has to be announced — a button nobody
        is told about is a button a screen-reader user never finds — and polite
        is what says it without interrupting.

        The sentence is PAST tense and its own key. Reusing bậc 3's
        "Mạng yếu nên video đã tắt để giữ tiếng." would put a present-tense claim
        about a weak line beside a chip that now reads "Mạng tốt".
      */}
      <p
        id={ROOM_NETWORK_RESTART_ID}
        className={canRestartCamera ? 'notice room-network' : 'sr'}
        role="status"
      >
        {canRestartCamera ? (
          <>
            <span>{t('room.networkVideoWasOff')}</span>
            <button type="button" className="button-primary" onClick={onRestartCamera}>
              {t('room.restartCamera')}
            </button>
          </>
        ) : (
          ''
        )}
      </p>

      {/*
        Bậc 4's frozen list says so IN WORDS, and the words are gated on the RUNG
        rather than on there being a list.

        Inside `listsPeople` this sentence disappeared exactly when it mattered
        most: a bậc 4 screen whose list has not arrived, or has emptied, is the
        case where a reader has least to go on, and it was the one case that
        froze in silence. A list that has stopped changing looks exactly like a
        list with nothing happening in it, and the difference is the whole of
        what a person needs to know — nobody has gone quiet, the room is not
        reaching us. The class on the `<ul>` is the second channel, never the
        first.
      */}
      <p id={ROOM_GRID_FROZEN_ID} className={gridFrozen ? 'meta' : 'sr'} role="status">
        {gridFrozen ? t('room.gridFrozen') : ''}
      </p>

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
          <ul
            id={ROOM_PARTICIPANTS_ID}
            className={gridFrozen ? 'participant-list participant-list-frozen' : 'participant-list'}
            aria-label={t('room.participants')}
          >
            {rows.map((row) => (
              <li key={row.id} className="participant-row">
                {/*
                  A face or the letters, never both — and `videoOn` is what decides.

                  The `<video>` is `aria-hidden` for the same reason the letters
                  are: it is a picture OF the person named on the next line, and a
                  screen reader announcing an unlabelled media element would read
                  the same person twice. It is muted because the room's SOUND comes
                  from the hidden audio host, so an unmuted tile would be a second
                  copy of everybody's voice.
                */}
                {row.videoKey === null ? (
                  <span className="avatar-letter" aria-hidden="true">
                    {row.initials}
                  </span>
                ) : (
                  <span className="participant-video" aria-hidden="true">
                    <video
                      ref={videoRef}
                      data-video-key={row.videoKey}
                      className="room-video-frame"
                      autoPlay
                      muted
                      playsInline
                    />
                  </span>
                )}
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
