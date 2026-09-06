import type { RefObject } from 'react';
import { useT } from './i18n/use-t';
import type { MessageKey } from './i18n/messages';
import { SignInProviderLinks } from './sign-in-links';
import type { SessionExpiryPrompt } from './session-expiry';

/**
 * What somebody sees when their session ends in the middle of what they were
 * doing.
 *
 * No state, no effect, no `window` — everything arrives as a prop, the same shape
 * `SignInPanel` has and for the same reason: the `web` Vitest project has no DOM,
 * so a component with any of those three is a component no test in this repo can
 * execute. `renderToStaticMarkup` runs this one for real. That still holds after
 * Story 1.6: the focus move it needed is an EFFECT, and the effect lives in
 * `session-expiry-provider.tsx` where there are already hooks — what arrives here
 * is the ref it will focus.
 *
 * ## It does not block the screen, and that is the feature
 *
 * There is no backdrop element, no `position: fixed`, no `<dialog>` opened with
 * `showModal()`, and `aria-modal` is explicitly `false`. The page behind it stays
 * visible and stays scrollable — somebody in the middle of a study session can
 * finish reading the sentence they were on, or copy something out of the room,
 * before deciding to sign in again. A modal that seizes the screen the moment a
 * cookie ages out is how a person loses the thing they were actually doing, which
 * is the exact harm this whole story exists to prevent.
 *
 * `aria-modal="false"` is the default value, and it is written out anyway: the
 * next person to style this (Story 1.6) would be looking for permission to make it
 * a real modal, and finding the answer in the markup is better than finding it in
 * a commit message. Story 1.6 read it and did not flip it — the answer worked.
 *
 * ## It says nothing technical
 *
 * No status code, no provider name, no mention of a token or a cookie. "Your
 * session ended, sign in again to carry on from where you were" is the whole of
 * what a person can act on; everything else would only tell somebody probing the
 * product which piece of it just refused them.
 *
 * ## Story 1.6 added exactly two behaviours, and deliberately not a third
 *
 * `deferred-work.md` recorded that this dialog "appears with nothing announcing
 * it": a keyboard user at the bottom of a page had no idea four sign-in links had
 * just been added above them, and a screen reader said nothing, because the
 * element was INSERTED rather than changed inside an existing live region.
 *
 * The fix is a focus move — `tabIndex={-1}` here, `focus()` from the provider —
 * plus Escape to close, which the provider also owns because the listener has to
 * live on `document` (see below). A screen reader reads a `role="dialog"` when
 * focus enters it, and the person can Tab straight back out because nothing traps
 * them. The deferred note also suggested a permanently-mounted live region AND a
 * focus trap; doing both would announce the dialog twice, and a focus trap is a
 * modal wearing a different word — which the argument above refuses. The docblock
 * wins.
 *
 * ## Escape is NOT handled here, and the first version of this file got that wrong
 *
 * It had an `onKeyDown` on the container, arguing that the event bubbles up to it
 * because focus starts inside the dialog. True at the instant it opens — and false a
 * moment later, which is the whole design: nothing traps focus, `dang-nhap.spec.ts`
 * asserts somebody can Tab out, and the moment they do, Escape stops working. A key
 * handler that only works before the person moves is one that only works in the test
 * that opens the dialog.
 *
 * So the listener is on `document`, for exactly as long as the prompt is non-null,
 * with cleanup — which puts it in `session-expiry-provider.tsx`, where the hooks
 * already are. This component stays effect-free so `renderToStaticMarkup` can
 * execute it, which is the same division every other decision in this app follows.
 *
 * Styling is classes and nothing else: `card-ask-confirm`'s shape (rounded.xl,
 * ink border, level-3 offset shadow) from `globals.css`, with no backdrop, no
 * `position: fixed` and no scroll lock — the three things that would make it block
 * the page.
 */

/**
 * The three things this dialog says, as catalogue KEYS.
 *
 * They were the sentences themselves. The words now live in `i18n/messages.ts`,
 * because a sentence has a language and this module has no way to know which one
 * the visitor asked for; what stays here is WHICH sentence, which is genuinely this
 * dialog's decision. `session-expiry-provider.test.tsx` and
 * `session-expiry-dialog.test.tsx` still name these constants — they now translate
 * them through `VI_TRANSLATE` rather than comparing raw text, which is the same
 * assertion with the locale made explicit.
 */
export const SESSION_EXPIRY_TITLE_KEY: MessageKey = 'sessionExpiry.title';
export const SESSION_EXPIRY_MESSAGE_KEY: MessageKey = 'sessionExpiry.message';
export const SESSION_EXPIRY_DISMISS_KEY: MessageKey = 'sessionExpiry.dismiss';

const TITLE_ID = 'phien-het-han-tieu-de';
const MESSAGE_ID = 'phien-het-han-noi-dung';

export function SessionExpiryDialog({
  prompt,
  apiBaseUrl,
  focusRef,
  onDismiss,
}: {
  /** `null` renders nothing at all — the dialog is closed. */
  readonly prompt: SessionExpiryPrompt | null;
  readonly apiBaseUrl: string;
  /**
   * Where the provider's effect sends focus when the dialog opens.
   *
   * REQUIRED, like `onDismiss` and for the same reason: a dialog that renders
   * without it is the accessibility gap `deferred-work.md` recorded — it appears,
   * and nothing tells anybody who is not looking at that part of the screen. An
   * optional ref is one a careless edit drops while everything still typechecks,
   * and the loss is invisible in every test this repository can run.
   */
  readonly focusRef: RefObject<HTMLDivElement | null>;
  /**
   * REQUIRED, not optional. A dialog that cannot be closed is a modal wearing a
   * different word, and an optional callback is one a careless edit can drop
   * while everything still typechecks.
   */
  readonly onDismiss: () => void;
}) {
  const t = useT();

  if (prompt === null) {
    return null;
  }

  return (
    <div
      ref={focusRef}
      className="session-expiry-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby={TITLE_ID}
      aria-describedby={MESSAGE_ID}
      /*
        Focusable, but not IN the tab order.

        `-1` is the whole difference: the provider can move focus here when the
        dialog opens, and Tab does not stop on the container itself afterwards —
        it goes to the first link inside, which is where somebody who wants to act
        needs to be. A `0` would add a stop nobody asked for on every Tab cycle.
      */
      tabIndex={-1}
    >
      <h2 id={TITLE_ID}>{t(SESSION_EXPIRY_TITLE_KEY)}</h2>
      <p id={MESSAGE_ID}>{t(SESSION_EXPIRY_MESSAGE_KEY)}</p>
      {/*
        The same list the login page offers, from `sign-in-links.tsx`.

        Shared for two reasons. One: two copies of a login link is how one of them
        keeps a parameter the other drops. Two: this dialog is mounted in
        `layout.tsx`, so whatever it imports is in the client tree of EVERY route —
        it used to reach into `dang-nhap/sign-in-outcome`, which pulls in the
        countdown timer and the whole sign-in panel, to render four anchors.
      */}
      <SignInProviderLinks apiBaseUrl={apiBaseUrl} returnPath={prompt.returnPath} />
      <button type="button" className="button-secondary" onClick={onDismiss}>
        {t(SESSION_EXPIRY_DISMISS_KEY)}
      </button>
    </div>
  );
}
