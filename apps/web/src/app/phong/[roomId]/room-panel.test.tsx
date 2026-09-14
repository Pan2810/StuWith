import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale } from '../../i18n/locale';
import { VI_TRANSLATE, translatorFor } from '../../i18n/messages';
import { I18nProvider } from '../../i18n/use-t';
import type { JoinPhase, MediaDecision, MediaFaceMode, ParticipantRow } from './room-media';
import {
  ROOM_COUNT_ID,
  ROOM_FACE_MODE_LEGEND_ID,
  ROOM_HEADING_ID,
  ROOM_PARTICIPANTS_ID,
  ROOM_SELF_PREVIEW_ID,
  ROOM_STATUS_ID,
  RoomPanel,
} from './room-panel';

/**
 * The room's markup, for every phase and every row shape, as real HTML.
 *
 * `RoomPanel` has no state, no effect and no `window` read — which is the whole
 * reason it is a separate file from `RoomShell` — so `renderToStaticMarkup` can
 * run it in the DOM-less `web` project and these assertions are about output
 * rather than about a value on its way to a renderer.
 */

const DECISION: MediaDecision = { faceMode: 'show', audio: 'mic' };

/**
 * A REAL identity shape — the token's `sub`, which is a uuidv7 account id.
 *
 * The first version of this file used `'x'`, and a one-character id made two
 * assertions near-vacuous at once: it hid the fact that `avatarInitialsFor`
 * answers `0` for every uuid on earth, and it turned "the account id is not in
 * the markup" into a search for the letter x.
 */
const REMOTE_IDENTITY = '019200f1-0000-7000-8000-0000000000ab';

const row = (overrides: Partial<ParticipantRow> = {}): ParticipantRow => ({
  id: '019200f1-0000-7000-8000-000000000001',
  label: '',
  initials: 'A1',
  speaking: false,
  micOn: true,
  videoKey: null,
  isSelf: false,
  ...overrides,
});

/** The callback ref the panel is handed. Never invoked here — SSR calls no ref. */
const noVideoRef = (): void => undefined;

/**
 * One `<input>` tag, pulled out whole, so an assertion about its attributes does
 * not depend on the ORDER ReactDOMServer happens to serialise them in.
 *
 * The first spelling matched `/aria-checked="true"[^>]*value="hide"/` across the
 * document, which is three tests that go red on a React upgrade that reorders
 * attributes — for no product reason at all, and in a way whose failure message
 * says nothing about what actually broke.
 */
function inputWithValue(html: string, value: string): string {
  const match = new RegExp(`<input[^>]*value="${value}"[^>]*>`).exec(html);
  return match?.[0] ?? '';
}

function render(
  phase: JoinPhase,
  options: {
    readonly decision?: MediaDecision;
    readonly rows?: readonly ParticipantRow[];
    /** Defaults to the decision's mode, which is what the shell starts from. */
    readonly faceMode?: MediaFaceMode;
    readonly showAvailable?: boolean;
    readonly selfVideoOn?: boolean;
    readonly errorKey?: Parameters<typeof RoomPanel>[0]['errorKey'];
    readonly micNoticeKey?: Parameters<typeof RoomPanel>[0]['micNoticeKey'];
    readonly videoNoticeKey?: Parameters<typeof RoomPanel>[0]['videoNoticeKey'];
    readonly audioBlocked?: boolean;
    readonly locale?: Locale;
  } = {},
): string {
  const decision = options.decision ?? DECISION;
  const panel = (
    <RoomPanel
      decision={decision}
      phase={phase}
      rows={options.rows ?? []}
      faceMode={options.faceMode ?? decision.faceMode}
      showAvailable={options.showAvailable ?? true}
      selfVideoOn={options.selfVideoOn ?? false}
      selfVideoKey="@self"
      videoRef={noVideoRef}
      errorKey={options.errorKey ?? null}
      micNoticeKey={options.micNoticeKey ?? null}
      videoNoticeKey={options.videoNoticeKey ?? null}
      audioBlocked={options.audioBlocked ?? false}
      onLeave={() => undefined}
      onEnableAudio={() => undefined}
      onBackToPreJoin={() => undefined}
      onChangeFaceMode={() => undefined}
    />
  );
  return renderToStaticMarkup(
    options.locale === undefined ? panel : <I18nProvider locale={options.locale}>{panel}</I18nProvider>,
  );
}

describe('the heading is a claim, so it follows the phase', () => {
  it.each([
    ['connecting', 'room.headingJoining'],
    ['connected', 'room.heading'],
    ['reconnecting', 'room.heading'],
    ['failed', 'room.headingOutside'],
    ['expired', 'room.headingOutside'],
    ['left', 'room.headingLeft'],
  ] as ReadonlyArray<readonly [JoinPhase, Parameters<typeof VI_TRANSLATE>[0]]>)(
    '%s is headed by %s',
    (phase, key) => {
      expect(render(phase)).toContain(`<h1 id="${ROOM_HEADING_ID}">${VI_TRANSLATE(key)}</h1>`);
    },
  );

  it.each(['failed', 'expired', 'left'] as const)(
    'never claims the person is in the room while %s',
    (phase) => {
      /**
       * The mutation this row exists for: printing `room.heading`
       * unconditionally puts "Bạn đã vào phòng" directly above the alert that
       * says the join failed, in the element that names the page.
       */
      expect(render(phase, { errorKey: 'room.errorConnect' })).not.toContain(
        VI_TRANSLATE('room.heading'),
      );
    },
  );
});

describe('the connection state is a SENTENCE, never only a colour', () => {
  it.each([
    ['connecting', 'room.statusConnecting'],
    ['connected', 'room.statusConnected'],
    ['reconnecting', 'room.statusReconnecting'],
    ['left', 'room.statusLeft'],
    ['failed', 'room.statusLeft'],
    ['expired', 'room.statusLeft'],
  ] as ReadonlyArray<readonly [JoinPhase, Parameters<typeof VI_TRANSLATE>[0]]>)(
    '%s says so in words',
    (phase, key) => {
      expect(render(phase)).toContain(VI_TRANSLATE(key));
    },
  );

  it('puts the chip in a polite live region of its own', () => {
    /**
     * `role="status"` on the chip's line and NOT on the card: a region wrapping
     * the participant list would re-read every name each time somebody started
     * speaking.
     */
    const html = render('connected');
    expect(html).toContain(`id="${ROOM_STATUS_ID}"`);
    expect(html).toMatch(new RegExp(`id="${ROOM_STATUS_ID}"[^>]*role="status"`));
  });

  it('reaches for the ok tone only when the room is really up', () => {
    expect(render('connected')).toContain('chip-status ok');
    expect(render('reconnecting')).toContain('chip-status warn');
    expect(render('connecting')).not.toContain('chip-status ok');
  });
});

describe('the decision is restated, and the token is not in the markup at all', () => {
  it.each([
    ['show', 'room.faceShow'],
    ['hide', 'room.faceHide'],
    ['filter', 'room.faceFilter'],
  ] as ReadonlyArray<readonly ['show' | 'hide' | 'filter', Parameters<typeof VI_TRANSLATE>[0]]>)(
    'restates %s with its OWN sentence',
    (faceMode, key) => {
      /**
       * `faceMode === 'hide' ? … : …` told a `filter` participant "Bạn đang để
       * nguyên khuôn mặt" — the wrong promise, made by the screen whose job is to
       * restate the promise. Story 2.7 turns Filter on; this row is what stops it
       * shipping that sentence.
       */
      const html = render('connected', { decision: { faceMode, audio: 'mic' }, rows: [row()] });
      expect(html).toContain(VI_TRANSLATE(key));
    },
  );

  it('says which audio intent', () => {
    const html = render('connected', { decision: { faceMode: 'hide', audio: 'listen-only' } });
    expect(html).toContain(VI_TRANSLATE('room.audioListenOnly'));
  });

  it('repeats the promise that nothing is recorded', () => {
    expect(render('connected')).toContain(VI_TRANSLATE('room.notRecorded'));
  });

  it('is handed a shape with no token on it', () => {
    /**
     * The structural half of "the token never reaches the DOM": `MediaDecision`
     * carries the face mode and the audio intent and nothing else, so there is no
     * prop here that COULD render a credential. A `token` added to the props would
     * fail this line before anybody had to notice it in output.
     */
    expect(Object.keys(DECISION).sort()).toEqual(['audio', 'faceMode']);
  });
});

describe('the participant list', () => {
  const ROWS: readonly ParticipantRow[] = [
    row({ id: 'self-id', initials: 'TA', isSelf: true }),
    row({ id: 'a-id', label: 'An', initials: 'A' }),
  ];

  it('appears once the room is up and not before', () => {
    expect(render('connected', { rows: ROWS })).toContain(`id="${ROOM_PARTICIPANTS_ID}"`);
    // Nobody is in a room that is still being joined — not even the reader.
    expect(render('connecting')).not.toContain(`id="${ROOM_PARTICIPANTS_ID}"`);
    expect(render('failed')).not.toContain(`id="${ROOM_PARTICIPANTS_ID}"`);
  });

  it('says nothing at all rather than "0 people" in the gap before the first refresh', () => {
    /**
     * `Connected` arrives as an event and the first `refresh()` lands after it, so
     * there is a frame in which the phase is `connected` and `rows` is still empty.
     * Rendering the count there put "Có 0 người trong phòng." inside a room the
     * reader was standing in.
     */
    const html = render('connected', { rows: [] });
    expect(html).not.toContain(`id="${ROOM_PARTICIPANTS_ID}"`);
    expect(html).not.toContain(VI_TRANSLATE.plural('room.participantCount', 0, { count: 0 }));
  });

  it('announces the count politely, so a join or a departure reaches a screen reader', () => {
    // The matrix row "Người khác rời → hàng biến mất, đếm lại số người" only
    // reaches a person through a live region, and it has to be on the COUNT: a
    // region around the list would re-read every name whenever somebody speaks.
    const html = render('connected', { rows: ROWS });
    expect(html).toMatch(new RegExp(`id="${ROOM_COUNT_ID}"[^>]*role="status"`));
    expect(html).not.toMatch(new RegExp(`id="${ROOM_PARTICIPANTS_ID}"[^>]*role="status"`));
  });

  it('counts the people in it, through the plural', () => {
    const html = render('connected', { rows: ROWS });
    expect(html).toContain(VI_TRANSLATE.plural('room.participantCount', 2, { count: 2 }));
  });

  it('names the reader by the catalogue rather than by their own name', () => {
    const html = render('connected', { rows: ROWS });
    expect(html).toContain(VI_TRANSLATE('room.you'));
  });

  it('names a remote by the name LiveKit carries', () => {
    expect(render('connected', { rows: ROWS })).toContain('An');
  });

  it('has a word for a remote that arrives with no name, which is all of them today', () => {
    const html = render('connected', {
      rows: [row({ id: REMOTE_IDENTITY, label: '', initials: 'AB' })],
    });
    expect(html).toContain(VI_TRANSLATE('room.participantUnnamed'));
    // And the ACCOUNT ID is not what fills the gap. Asserted against a real uuid:
    // the previous spelling looked for the letter `x` in a page full of markup.
    expect(html).not.toContain(REMOTE_IDENTITY);
  });

  it('says "speaking" in words, not only in colour', () => {
    const html = render('connected', { rows: [row({ speaking: true })] });
    expect(html).toContain(VI_TRANSLATE('room.speaking'));
  });

  it('says a microphone is off in words too', () => {
    const html = render('connected', { rows: [row({ micOn: false })] });
    expect(html).toContain(VI_TRANSLATE('room.micOff'));
  });

  it('says nothing at all about an ordinary row', () => {
    const html = render('connected', { rows: [row()] });
    expect(html).not.toContain(VI_TRANSLATE('room.speaking'));
    expect(html).not.toContain(VI_TRANSLATE('room.micOff'));
  });

  it('hides the avatar letters from a screen reader, because the name follows them', () => {
    expect(render('connected', { rows: ROWS })).toContain('aria-hidden="true">TA<');
  });
});

describe('the six refusals of the matrix', () => {
  it.each([
    'room.errorMicDenied',
    'room.errorMicEnded',
    'room.errorDuplicate',
    'room.errorExpired',
    'room.errorConnect',
    'room.errorDisconnected',
  ] as const)('renders %s as an alert when it is the one that happened', (key) => {
    const html = render('failed', { errorKey: key });
    expect(html).toContain(VI_TRANSLATE(key));
    expect(html).toContain('role="alert"');
  });

  it('shows the microphone’s own bad news WITHOUT leaving the room', () => {
    // Losing a microphone is not losing the room: the list stays, the leave button
    // stays, and the sentence says which half is missing.
    const html = render('connected', { rows: [row()], micNoticeKey: 'room.errorMicEnded' });
    expect(html).toContain(VI_TRANSLATE('room.errorMicEnded'));
    expect(html).toContain(`id="${ROOM_PARTICIPANTS_ID}"`);
    expect(html).toContain(VI_TRANSLATE('room.leave'));
  });

  it('says nothing when nothing has gone wrong', () => {
    expect(render('connected')).not.toContain('role="alert"');
  });
});

describe('a browser that refuses to play the room says so, and offers the gesture', () => {
  it('shows the sentence and a real button when playback is blocked', () => {
    const html = render('connected', { rows: [row()], audioBlocked: true });
    expect(html).toContain(VI_TRANSLATE('room.audioBlocked'));
    expect(html).toContain(VI_TRANSLATE('room.enableAudio'));
    expect(html).toContain('role="alert"');
  });

  it('says nothing when the room is audible', () => {
    /**
     * The failure this covers is the one that looks like success: chip up,
     * everybody listed, complete silence, nothing on screen admitting it.
     */
    const html = render('connected', { rows: [row()] });
    expect(html).not.toContain(VI_TRANSLATE('room.audioBlocked'));
    expect(html).not.toContain(VI_TRANSLATE('room.enableAudio'));
  });
});

describe('the way out', () => {
  it.each(['connecting', 'connected', 'reconnecting'] as const)('offers "leave" while %s', (phase) => {
    expect(render(phase)).toContain(VI_TRANSLATE('room.leave'));
  });

  it.each(['failed', 'expired', 'left'] as const)('offers the way back to pre-join after %s', (phase) => {
    const html = render(phase);
    expect(html).toContain(VI_TRANSLATE('preJoin.retryJoin'));
    expect(html).not.toContain(VI_TRANSLATE('room.leave'));
  });

  it('renders a real button, so the branch is never a dead end', () => {
    expect(render('connected')).toContain('<button type="button"');
    expect(render('expired')).toContain('<button type="button"');
  });
});

const HEADINGS: Readonly<Record<JoinPhase, Parameters<typeof VI_TRANSLATE>[0]>> = {
  connecting: 'room.headingJoining',
  connected: 'room.heading',
  reconnecting: 'room.heading',
  failed: 'room.headingOutside',
  expired: 'room.headingOutside',
  left: 'room.headingLeft',
};

describe('both locales', () => {
  it.each(LOCALES)('renders every phase in %s with no key leaking through', (locale) => {
    const t = translatorFor(locale);
    for (const phase of ['connecting', 'connected', 'reconnecting', 'failed', 'expired', 'left'] as const) {
      const html = render(phase, {
        locale,
        rows: [row({ isSelf: true, speaking: true }), row({ id: REMOTE_IDENTITY, micOn: false })],
        errorKey: 'room.errorConnect',
        micNoticeKey: 'room.errorMicEnded',
        videoNoticeKey: 'room.errorCameraEnded',
        selfVideoOn: true,
        audioBlocked: true,
      });
      // The phase's OWN heading, because there are four of them now.
      expect(html).toContain(t(HEADINGS[phase]));
      expect(html).not.toMatch(/room\.[a-zA-Z]+/);
      expect(html).not.toMatch(/preJoin\.[a-zA-Z]+/);
    }
  });

  it('says different things in the two languages', () => {
    const en = render('connected', { locale: 'en', rows: [row({ micOn: false })] });
    expect(en).toContain(translatorFor('en')('room.micOff'));
    expect(en).not.toContain(VI_TRANSLATE('room.micOff'));
  });

  it('counts with the English plural pair, which Vietnamese does not have', () => {
    const t = translatorFor('en');
    const one = render('connected', { locale: 'en', rows: [row()] });
    const many = render('connected', { locale: 'en', rows: [row(), row({ id: 'b' })] });
    expect(one).toContain(t.plural('room.participantCount', 1, { count: 1 }));
    expect(many).toContain(t.plural('room.participantCount', 2, { count: 2 }));
    expect(t.plural('room.participantCount', 1, { count: 1 })).not.toBe(
      t.plural('room.participantCount', 2, { count: 2 }),
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Story 2.7 — the mode group, the preview, and a face in a row
 * -------------------------------------------------------------------------- */

describe('the face-mode group, in the room', () => {
  it.each(['connecting', 'connected', 'reconnecting'] as const)(
    'is offered from the first frame — %s included',
    (phase) => {
      /**
       * `connecting` is the row that matters and it is the one a "render it when
       * the list renders" version would drop. Somebody who pressed "Vào phòng" by
       * mistake, or changed their mind during a slow handshake, must be able to
       * take their face off the wire before the wire exists — and the shell's
       * reconciler is built so that press is the one that wins.
       */
      const html = render(phase);
      expect(html).toContain('role="radiogroup"');
      expect(html).toContain(`id="${ROOM_FACE_MODE_LEGEND_ID}"`);
      expect(html).toContain(VI_TRANSLATE('room.faceModeLegend'));
    },
  );

  it.each(['failed', 'expired', 'left'] as const)('is gone once the room is not there — %s', (phase) => {
    // A group that could still be pressed after the room ended would be three
    // controls whose only possible effect is on a connection nobody has.
    expect(render(phase)).not.toContain('role="radiogroup"');
  });

  it('is a labelled group of three radios, with exactly one of them checked', () => {
    const html = render('connected', { faceMode: 'hide' });
    for (const label of ['room.modeShow', 'room.modeHide', 'room.modeFilter'] as const) {
      expect(html).toContain(VI_TRANSLATE(label));
    }
    expect(html).toContain(`aria-labelledby="${ROOM_FACE_MODE_LEGEND_ID}"`);
    // `aria-checked` written out as well as implied, and on exactly the one in force.
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
    expect(inputWithValue(html, 'hide')).toContain('aria-checked="true"');
  });

  it('checks the mode IN FORCE, not the one the admission carried', () => {
    /**
     * The defect review round 1 reproduced, in its markup form: the person pressed
     * "Ẩn mặt" in the room, and the screen went on reading the snapshot pre-join
     * handed over. One prop decides both the radio and the sentence beside it, so
     * the two cannot disagree.
     */
    const html = render('connected', {
      decision: { faceMode: 'show', audio: 'mic' },
      faceMode: 'hide',
    });
    expect(html).toContain(VI_TRANSLATE('room.faceHide'));
    expect(html).not.toContain(VI_TRANSLATE('room.faceShow'));
    expect(inputWithValue(html, 'hide')).toContain('aria-checked="true"');
    expect(inputWithValue(html, 'show')).toContain('aria-checked="false"');
  });

  it('offers Filter and refuses it, labelled "Sắp có"', () => {
    // The ML pipeline is a separate deliverable (`deferred-work.md`). A selectable
    // Filter today would open a camera and publish an UNFILTERED face under a
    // label promising a filter.
    const html = render('connected');
    expect(html).toContain(VI_TRANSLATE('room.modeFilter'));
    expect(html).toContain(VI_TRANSLATE('room.comingSoon'));
    expect(inputWithValue(html, 'filter')).toContain('disabled=""');
  });

  it('disables "Để nguyên" when there is no camera, and leaves "Ẩn mặt" alone', () => {
    const html = render('connected', { showAvailable: false, faceMode: 'hide' });
    expect(inputWithValue(html, 'show')).toContain('disabled=""');
    expect(inputWithValue(html, 'hide')).not.toContain('disabled=""');
  });

  it('keeps "Để nguyên" selectable while a camera exists', () => {
    expect(inputWithValue(render('connected'), 'show')).not.toContain('disabled=""');
  });
});

describe('the preview of oneself is a CLAIM, so both halves have to be true', () => {
  it('renders only when the mode is "show" AND the canvas track is published', () => {
    const html = render('connected', { faceMode: 'show', selfVideoOn: true });
    expect(html).toContain(`id="${ROOM_SELF_PREVIEW_ID}"`);
    expect(html).toContain(VI_TRANSLATE('room.selfPreview'));
  });

  it('is absent while nothing is published, even in "show"', () => {
    // The window between pressing "Để nguyên" and the publish landing. A preview
    // here would promise a picture the room has not been sent.
    const html = render('connected', { faceMode: 'show', selfVideoOn: false });
    expect(html).not.toContain(`id="${ROOM_SELF_PREVIEW_ID}"`);
    expect(html).not.toContain(VI_TRANSLATE('room.selfPreview'));
  });

  it('is absent in "hide" even if a publish is still coming down', () => {
    /**
     * THE state review round 1 found: a live preview under "Đây là hình mọi người
     * đang thấy" with "Ẩn mặt" selected beside it. Checking `faceMode` here as
     * well as `selfVideoOn` makes it unrenderable rather than unlikely.
     */
    const html = render('connected', { faceMode: 'hide', selfVideoOn: true });
    expect(html).not.toContain(`id="${ROOM_SELF_PREVIEW_ID}"`);
  });

  it('never uses the mirrored pre-join class, because the wire is not a mirror', () => {
    // `.preview-video` flips the picture (`scaleX(-1)`), which is right for
    // somebody looking at themselves and wrong for the frames the room receives.
    const html = render('connected', { faceMode: 'show', selfVideoOn: true });
    expect(html).not.toContain('preview-video');
    expect(html).toContain('room-video-frame');
  });
});

describe('a row draws a face or the letters, never both', () => {
  it('draws a video for a row whose camera is on', () => {
    const html = render('connected', { rows: [row({ videoKey: `${REMOTE_IDENTITY}:TR_1`, initials: 'A1' })] });
    expect(html).toContain('<video');
    expect(html).toContain('participant-video');
    expect(html).not.toContain('>A1<');
  });

  it('draws the letters for a row whose camera is off', () => {
    const html = render('connected', { rows: [row({ videoKey: null, initials: 'A1' })] });
    expect(html).toContain('>A1<');
    expect(html).not.toContain('participant-video');
  });

  it('hides the picture from a screen reader, which reads the name on the next line', () => {
    const html = render('connected', { rows: [row({ videoKey: `${REMOTE_IDENTITY}:TR_1` })] });
    expect(html).toMatch(/class="participant-video" aria-hidden="true"/);
  });

  it('mutes every tile, so nobody is heard twice', () => {
    // The room's sound comes from the hidden audio host the shell owns. An unmuted
    // tile would be a second copy of the same voice, half a second apart.
    const html = render('connected', { rows: [row({ videoKey: `${REMOTE_IDENTITY}:TR_1` })] });
    expect(html).toContain('muted=""');
  });
});

describe('the camera’s bad news is its own sentence', () => {
  it.each([
    'room.errorCameraDenied',
    'room.errorCameraMissing',
    'room.errorCameraEnded',
    'room.errorVideoPipeline',
    'room.errorVideoRefused',
  ] as const)('renders %s as an alert, without leaving the room', (key) => {
    const html = render('connected', { rows: [row()], videoNoticeKey: key });
    expect(html).toContain(VI_TRANSLATE(key));
    expect(html).toContain('role="alert"');
    // Still in the room: the list and the way out are both still there.
    expect(html).toContain(`id="${ROOM_PARTICIPANTS_ID}"`);
    expect(html).toContain(VI_TRANSLATE('room.leave'));
  });

  it('is separate from the microphone’s, because one can be lost without the other', () => {
    const html = render('connected', {
      rows: [row()],
      micNoticeKey: 'room.errorMicEnded',
      videoNoticeKey: 'room.errorCameraEnded',
    });
    expect(html).toContain(VI_TRANSLATE('room.errorMicEnded'));
    expect(html).toContain(VI_TRANSLATE('room.errorCameraEnded'));
  });

  it('says nothing about a camera when nothing happened to it', () => {
    const html = render('connected', { rows: [row()] });
    expect(html).not.toContain(VI_TRANSLATE('room.errorCameraEnded'));
    expect(html).not.toContain(VI_TRANSLATE('room.errorVideoRefused'));
  });
});
