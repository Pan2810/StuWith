import { AUTH_PROVIDERS } from '@stuwith/contracts';
import { PROVIDER_LABELS } from './dang-nhap/sign-in-outcome';
import { signInStartHref, type SessionExpiryPrompt } from './session-expiry';

/**
 * What somebody sees when their session ends in the middle of what they were
 * doing.
 *
 * No state, no effect, no `window` — everything arrives as a prop, the same shape
 * `SignInPanel` has and for the same reason: the `web` Vitest project has no DOM,
 * so a component with any of those three is a component no test in this repo can
 * execute. `renderToStaticMarkup` runs this one for real.
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
 * next person to style this (Story 1.6) will be looking for permission to make it
 * a real modal, and finding the answer in the markup is better than finding it in
 * a commit message.
 *
 * ## It says nothing technical
 *
 * No status code, no provider name, no mention of a token or a cookie. "Your
 * session ended, sign in again to carry on from where you were" is the whole of
 * what a person can act on; everything else would only tell somebody probing the
 * product which piece of it just refused them.
 *
 * Styling, tokens, light/dark and a focus ring are Story 1.6's. This is the bare
 * skeleton on purpose — provisional styling here would only have to be deleted.
 */

export const SESSION_EXPIRY_TITLE = 'Phiên đăng nhập đã kết thúc';
export const SESSION_EXPIRY_MESSAGE =
  'Đăng nhập lại để tiếp tục từ chỗ bạn đang đứng. Trang này vẫn ở đây trong lúc đó.';
export const SESSION_EXPIRY_DISMISS_LABEL = 'Để sau';

const TITLE_ID = 'phien-het-han-tieu-de';
const MESSAGE_ID = 'phien-het-han-noi-dung';

export function SessionExpiryDialog({
  prompt,
  apiBaseUrl,
  onDismiss,
}: {
  /** `null` renders nothing at all — the dialog is closed. */
  readonly prompt: SessionExpiryPrompt | null;
  readonly apiBaseUrl: string;
  /**
   * REQUIRED, not optional. A dialog that cannot be closed is a modal wearing a
   * different word, and an optional callback is one a careless edit can drop
   * while everything still typechecks.
   */
  readonly onDismiss: () => void;
}) {
  if (prompt === null) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={TITLE_ID}
      aria-describedby={MESSAGE_ID}
    >
      <h2 id={TITLE_ID}>{SESSION_EXPIRY_TITLE}</h2>
      <p id={MESSAGE_ID}>{SESSION_EXPIRY_MESSAGE}</p>
      <ul>
        {AUTH_PROVIDERS.map((provider) => (
          <li key={provider}>
            {/*
              The return path rides on the href, which is the only leg allowed to
              carry it: `apps/api` judges the proposal once at `/start` and signs
              the verdict into the OAuth state. Nothing on the way back reads a
              path from a URL.
            */}
            <a href={signInStartHref(apiBaseUrl, provider, prompt.returnPath)}>
              Tiếp tục với {PROVIDER_LABELS[provider]}
            </a>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onDismiss}>
        {SESSION_EXPIRY_DISMISS_LABEL}
      </button>
    </div>
  );
}
