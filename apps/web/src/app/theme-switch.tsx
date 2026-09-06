'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DARK_SCHEME_QUERY,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  THEME_SWITCH_LEGEND,
  appliedThemeNote,
  resolveThemeChoice,
  themeAttributeFor,
  type ThemeChoice,
} from './theme';

/**
 * Three equal choices: follow the machine, force light, force dark.
 *
 * ## Why this file carries `'use client'` and `layout.tsx` does not
 *
 * `layout.tsx` is a Server Component, and it stays one. The boundary in this app
 * sits at the components that need a browser — `SessionExpiryProvider` records the
 * same rule for itself — because a `'use client'` on the layout drags every page
 * under it into the client bundle. This component owns the boundary for the theme
 * switch and nothing else does.
 *
 * ## Every decision here is in `theme.ts`, and that is not tidiness
 *
 * The `web` Vitest project has `environment: 'node'` and no DOM (AGENTS.md §6), so
 * an effect in this file is an effect nothing in the repository can execute. What
 * is left here is `useState`, one write to `localStorage`, one attribute change and
 * one listener — the parts that only a browser can run, and which `he-thiet-ke.spec.ts`
 * runs in a real one. Everything that DECIDES is a pure function next door, and
 * `theme.test.ts` executes it alongside the inline boot script that has to agree
 * with it.
 *
 * ## Why there is a listener at all, when CSS already follows the OS
 *
 * The palette does not need it: with no `data-theme` attribute the media query in
 * `tokens.css` re-evaluates by itself when the OS flips, with no reload. The
 * listener exists for the sentence below the buttons — the one that says which
 * palette is on screen — because "theo hệ điều hành" announces a preference and
 * not a result, and somebody who cannot see the page has no other way to learn
 * which of the two modes they are in.
 */
export function ThemeSwitch() {
  /**
   * `system` on the server AND on the first client render.
   *
   * It is not a guess at the person's choice — the inline boot script has already
   * applied that to `<html>` before this component exists. It is the only value
   * that renders identically on both sides, which is what keeps hydration quiet;
   * the effect below then corrects the BUTTONS to match what the document is
   * already wearing.
   */
  const [choice, setChoice] = useState<ThemeChoice>('system');
  /**
   * `null` until the browser has been asked, and the note below renders nothing
   * while it is.
   *
   * Starting at `false` was a real defect rather than an untidiness. On a dark
   * machine the boot script has ALREADY painted dark before this component exists,
   * so the first render would put "Đang dùng giao diện sáng." into a live region —
   * announcing the opposite of what is on screen, then correcting itself a tick
   * later. A live region is exactly where a briefly-wrong value does damage,
   * because the wrong value is the one that gets spoken.
   */
  const [prefersDark, setPrefersDark] = useState<boolean | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Private mode, or site data blocked. `resolveThemeChoice` reads `null` as
      // `system`, which is the same answer the boot script reached.
      stored = null;
    }
    setChoice(resolveThemeChoice(stored));
  }, []);

  useEffect(() => {
    const query = window.matchMedia(DARK_SCHEME_QUERY);
    setPrefersDark(query.matches);
    /**
     * The listener is what keeps the SENTENCE true when the machine changes its
     * mind mid-session. The palette needs no help — with no `data-theme` attribute
     * the media query in `tokens.css` re-evaluates by itself — which is precisely
     * why deleting this line used to leave every test green: the only case watching
     * an OS flip asserted `--surface-base`, and CSS was doing that on its own.
     * `he-thiet-ke.spec.ts` now asserts the announcement across the same flip.
     */
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const select = useCallback((next: ThemeChoice) => {
    setChoice(next);

    const attribute = themeAttributeFor(next);
    /**
     * REMOVE for `system`, never `setAttribute(…, 'system')`.
     *
     * The demo this design comes from stamps the attribute unconditionally
     * (`demo-san-pham.html:1117`), which destroys "theo hệ điều hành" the moment
     * it runs. `themeAttributeFor` returning `null` is what makes the difference
     * expressible, and `theme.test.ts` pins it.
     */
    if (attribute === null) {
      document.documentElement.removeAttribute(THEME_ATTRIBUTE);
    } else {
      document.documentElement.setAttribute(THEME_ATTRIBUTE, attribute);
    }

    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The choice still applies to this page; it just will not survive a reload.
      // Losing a colour preference is not worth an exception on the way to a
      // click handler.
    }
  }, []);

  return (
    <div className="theme-switch" role="group" aria-label={THEME_SWITCH_LEGEND}>
      {THEME_CHOICES.map((option) => (
        <button
          key={option}
          type="button"
          /*
            `aria-pressed`, not `aria-checked`: these are three toggle buttons in a
            group rather than a radio group, so nothing here claims arrow-key
            navigation it does not implement.
          */
          aria-pressed={choice === option}
          onClick={() => select(option)}
        >
          {THEME_LABELS[option]}
        </button>
      ))}
      {/*
        The RESULT, announced once, beside the buttons rather than inside one.

        Two reasons it is not a suffix on the pressed button's label. It would make
        that button's accessible name contain the words "sáng" and "tối", which are
        the other two buttons' names — ambiguous for anybody, and for a test looking
        one up by name. And a live region announces the CHANGE, which is the useful
        moment: press "Theo hệ điều hành" on a dark machine and a screen reader says
        which palette that turned out to mean, rather than leaving "theo hệ điều
        hành" as a preference with no stated outcome.

        `aria-live="polite"` and deliberately NOT `role="status"`, which is the
        same thing with a name. This element is in the layout, so it is on EVERY
        screen — and `role="status"` would have made `page.getByRole('status')`
        ambiguous on three screens that already use exactly that selector to find
        their own message. It was measured: adding the role turned an existing,
        unrelated browser case red. A live region announces either way.
      */}
      {prefersDark === null ? null : (
        <p className="sr" aria-live="polite">
          {appliedThemeNote(choice, prefersDark)}
        </p>
      )}
    </div>
  );
}
