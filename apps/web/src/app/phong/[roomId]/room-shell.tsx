import { useT } from '../../i18n/use-t';

/**
 * The vocabulary of a presence DECISION, and the shell that receives one.
 *
 * ## Why the types live here and not in `pre-join.tsx`
 *
 * `pre-join.tsx` renders this component on its `admitted` branch, so it imports
 * from here. If the face-mode union lived there, this file would have to import it
 * back — and `.dependency-cruiser.cjs` runs with `tsPreCompilationDeps: true`, so a
 * type-only import is an edge like any other and `no-circular` fails the build.
 * The decision is what this component CONSUMES, which makes it the natural owner
 * of the decision's shape; the screen that produces it reads the shape from here.
 *
 * ## What this shell is, in Story 2.3
 *
 * A summary and a promise: which face mode was chosen, whether the microphone is
 * on, and that nothing is recorded. It deliberately holds no `<video>`, opens no
 * `RTCPeerConnection`, and never prints the token. Story 2.4 mounts the media
 * plane HERE — this is the component that receives the token — and two things
 * about that hand-over are already decided:
 *
 * - **the token is requested exactly ONCE, when "Vào phòng" is pressed**, not on
 *   every device change and not on mount. `deferred-work.md` records why: the
 *   token's `sub` is `user.id`, LiveKit treats that as the participant identity,
 *   and a second connection under the same identity evicts the first. A pre-join
 *   screen that re-asked on every change of mind would hand 2.4 a stack of live
 *   tokens for one person; one press, one token, one connection is the shape that
 *   cannot produce a `DUPLICATE_IDENTITY` by accident;
 * - **the decision arrives in memory only.** `token` lives in React state on the
 *   page above and in the props of this component, never in `localStorage`,
 *   `sessionStorage`, a cookie or a log line. A reload lands on pre-join again,
 *   which is the intended behaviour rather than a lost session;
 * - **the pre-join streams are STOPPED before this renders.** The page ends every
 *   camera and microphone track and closes the analyser on the `201`, because a
 *   shell that displays nothing must not leave a camera light on. Story 2.4
 *   therefore starts from no open device: it either asks `getUserMedia` again
 *   under the decision it was handed, or changes the hand-over to carry the
 *   streams — that is 2.4's decision, recorded here so it is made rather than
 *   inherited.
 *
 * No `'use client'`, no state, no effect — so `renderToStaticMarkup` can prove
 * both what it says and that it says nothing it must not.
 */

/**
 * The three modes the group offers, in display order.
 *
 * `filter` is in the list and refused by the screen: it is rendered as a disabled
 * choice labelled "Sắp có" so the group has the shape Story 2.7 fills in, and
 * `faceModeAvailable` in `pre-join.tsx` is the one place that says no to it.
 */
export const FACE_MODES = ['show', 'hide', 'filter'] as const;

export type FaceMode = (typeof FACE_MODES)[number];

/**
 * "Để nguyên" is the default, not "Ẩn mặt", and that is a product decision rather
 * than a convenience: `EXPERIENCE.md` Flow 1 has the preview ON and only the person
 * seeing it, then the person CHOOSING to hide. The local preview exposes nothing —
 * no track leaves the machine in this story — and the warn-coloured sentence beside
 * the default is where the decision is made. Changing this is an "Ask First" item.
 */
export const DEFAULT_FACE_MODE: FaceMode = 'show';

/** Whether the microphone travels into the room, or the person only listens. */
export type AudioIntent = 'mic' | 'listen-only';

/**
 * What pre-join hands the room: the choice, and the admission that came back.
 *
 * `expiresAt` is the wire's `expires_at` — the instant BOTH the token and the
 * reserved seat lapse (`ROOM_TOKEN_TTL_SECONDS`). Story 2.4 connects before it, or
 * asks again; nothing here starts a clock.
 */
export interface RoomDecision {
  readonly roomId: string;
  readonly faceMode: FaceMode;
  readonly audio: AudioIntent;
  readonly token: string;
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * The ids the shell's own `<section aria-labelledby>` and summary carry. Exported
 * so a test can find the two by id rather than by sentence; nothing above the
 * shell references them.
 */
export const ROOM_SHELL_HEADING_ID = 'phong-tieu-de';
export const ROOM_SHELL_SUMMARY_ID = 'phong-tom-tat';

/**
 * The room, as far as Story 2.3 takes it.
 *
 * Rendered from ONE state of the page above — `admitted` — and from nothing else.
 * That is the whole of "pre-join cannot be skipped": there is no route, query
 * parameter or reload that produces a `RoomDecision` without a `201` from the
 * token endpoint after a press of "Vào phòng", so there is no way to stand here
 * without having decided.
 */
export function RoomShell({ decision }: { readonly decision: RoomDecision }) {
  const t = useT();

  return (
    <section className="card" aria-labelledby={ROOM_SHELL_HEADING_ID}>
      <h1 id={ROOM_SHELL_HEADING_ID}>{t('room.heading')}</h1>
      {/*
        `status`, because the summary is the first thing a screen-reader user
        should hear on arrival: what they decided, restated by the product. Two
        sentences rather than one with two slots — each half is a whole sentence a
        translator can reorder.
      */}
      <p id={ROOM_SHELL_SUMMARY_ID} role="status">
        {t(decision.faceMode === 'hide' ? 'room.faceHide' : 'room.faceShow')}{' '}
        {t(decision.audio === 'mic' ? 'room.audioMic' : 'room.audioListenOnly')}
      </p>
      {/*
        The one sentence pre-join already said, said again where the room begins.
        Epic 2's context puts it on pre-join because that is where somebody decides
        to show a face; it is repeated here because the promise is about the ROOM.
      */}
      <p className="meta">{t('room.notRecorded')}</p>
    </section>
  );
}
