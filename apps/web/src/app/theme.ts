/**
 * Light and dark as two equal modes, and the seam that keeps the inline boot
 * script honest.
 *
 * `EXPERIENCE.md:25`: "Light và dark là **hai chế độ ngang hàng**, không phải một
 * chế độ với biến thể. Mặc định theo hệ điều hành, người dùng đổi được." Three
 * states, then — `system`, `light`, `dark` — and the first one is not a value the
 * DOM carries. It is the ABSENCE of `data-theme`.
 *
 * ## Why "system" removes the attribute instead of setting `data-theme="system"`
 *
 * NOT because the palette would break. An earlier version of this docblock said so,
 * and it was wrong: `:root:not([data-theme="light"])` matches an element carrying
 * `data-theme="system"` perfectly well, so a dark machine would still get the dark
 * palette. Stating a mechanism that does not exist is worse than stating none —
 * the next person tests the claim, finds it false, and stops trusting the file.
 *
 * The real reasons are about REPRESENTATION, and they are enough:
 *
 * - One canonical form for one state. "Follow the machine" is the absence of a
 *   choice, and writing it out as a value creates a second way to spell the same
 *   thing — so `removeAttribute` and `setAttribute(…, 'system')` would both have to
 *   be handled everywhere, for ever.
 * - {@link resolveThemeChoice} reads any string that is not `light` or `dark` as
 *   corrupt and falls back to `system`. `"system"` in storage is therefore already
 *   travelling the corrupt-value path; putting it in the DOM as well would make the
 *   DOM disagree with the model about whether anything was ever chosen.
 * - A leftover attribute is a real bug in the other direction. Somebody who picked
 *   dark and then went back to "theo hệ điều hành" must end up with NO attribute; a
 *   script that only ever calls `setAttribute` leaves `data-theme="dark"` in place
 *   and the machine is never consulted again. That one is a genuine palette
 *   failure, and it is the case `demo-san-pham.html:1117` ships — it stamps
 *   `data-theme` unconditionally on load. A defect in the reference, not a shape to
 *   copy.
 *
 * ## Why the boot script is a STRING, and how a string gets tested
 *
 * It has to run before the first paint, inside `<head>`, or the page renders one
 * frame in the wrong palette and React reports a hydration mismatch on `<html>`.
 * Nothing that runs there can be imported, so it is source code in a string —
 * exactly the kind of thing that ships broken because nothing executes it.
 *
 * {@link themeBootScript} therefore builds that string out of the same constants
 * and the same rules as the functions below, and `theme.test.ts` runs BOTH: it
 * calls the pure functions, then evaluates the actual script text with a fake
 * `localStorage` and a fake `document`, and compares the two answers for every
 * input. That comparison is the only reason to trust a string in a `<head>`.
 */

/** The three states, and the order the switch offers them in. */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/**
 * Where the choice is remembered.
 *
 * Namespaced, because `localStorage` is per ORIGIN and a bare `theme` is the key
 * every other script on a shared origin also reaches for.
 */
export const THEME_STORAGE_KEY = 'stuwith-theme';

/** The attribute `tokens.css` matches on. One spelling, used by both halves. */
export const THEME_ATTRIBUTE = 'data-theme';

/** Vietnamese labels, one table, so the button and its announcement agree. */
export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'Theo hệ điều hành',
  light: 'Sáng',
  dark: 'Tối',
};

export const THEME_SWITCH_LEGEND = 'Giao diện';

/**
 * What a stored value means, including every way it can be wrong.
 *
 * `localStorage` holds strings a person can edit, another tab can write and an
 * older version of this app may have left behind, so `null`, `''`, `'purple'` and
 * `'system'` all have to mean the same safe thing. Falling back to `system` rather
 * than to `light` matters: the safe answer is "do what the machine asks", not "pick
 * one for them".
 */
export function resolveThemeChoice(stored: string | null): ThemeChoice {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * The value `data-theme` should carry, or `null` meaning "remove the attribute".
 *
 * `null` is not an omission and not an empty string — `data-theme=""` would be an
 * attribute that exists, and `:root:not([data-theme="light"])` matches it, which is
 * right by luck rather than by design. Removal is the state.
 */
export function themeAttributeFor(choice: ThemeChoice): string | null {
  return choice === 'system' ? null : choice;
}

/**
 * Which palette is actually on screen — the answer `system` cannot give alone.
 *
 * Used by the switch to say, for a screen-reader user, what "theo hệ điều hành"
 * currently resolves to. Without it the three buttons announce a preference and
 * never announce a result, and somebody who cannot see the page has no way to
 * learn which of the two modes they are in.
 */
export function appliedTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  if (choice === 'system') {
    return prefersDark ? 'dark' : 'light';
  }
  return choice;
}

/** The sentence that says which palette is on screen right now. */
export function appliedThemeNote(choice: ThemeChoice, prefersDark: boolean): string {
  return `Đang dùng giao diện ${appliedTheme(choice, prefersDark) === 'dark' ? 'tối' : 'sáng'}.`;
}

/** The media query the OS preference is read through, in both halves of the seam. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * The source of the blocking script that runs in `<head>` before the first paint.
 *
 * Two things it must survive, and both have bitten real products:
 *
 * - **`localStorage` that throws.** Reading it is not safe: Safari in private mode
 *   and any browser configured to block site data raise on access rather than
 *   returning `null`. An unguarded read there throws inside `<head>`, which stops
 *   the parser, which means a blank page — the worst possible failure for a
 *   nicety like a colour scheme. Hence the `try`, and hence a matrix row for it.
 * - **A stored value nobody recognises.** Same rule as {@link resolveThemeChoice},
 *   because it IS that rule; the script is generated from the same two literals.
 *
 * It is deliberately ES5-shaped (`var`, `function`) and free of optional chaining:
 * this string is not transpiled by anything, so it is read by whatever browser
 * loads the page, including the old laptop `DESIGN.md § Typography` keeps naming.
 */
export function themeBootScript(): string {
  return (
    '(function(){' +
    'var s=null;' +
    `try{s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});}catch(e){s=null;}` +
    "var t=s==='light'||s==='dark'?s:'system';" +
    'var r=document.documentElement;' +
    `if(t==='system'){r.removeAttribute(${JSON.stringify(THEME_ATTRIBUTE)});}` +
    `else{r.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);}` +
    '})();'
  );
}
