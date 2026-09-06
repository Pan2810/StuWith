import { describe, expect, it } from 'vitest';
import {
  DARK_SCHEME_QUERY,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  appliedTheme,
  appliedThemeNote,
  resolveThemeChoice,
  themeAttributeFor,
  themeBootScript,
} from './theme';

/**
 * The middle of the seam, which is the piece nothing else can reach.
 *
 * Two halves decide the palette: the pure functions the switch calls, and the
 * string that runs in `<head>` before React exists. They must agree for every
 * input, and until this file existed only one of them could be executed — the
 * other was a template literal that a typo would break silently, on the first
 * paint of every page, for every visitor.
 *
 * The string is therefore RUN here, against a fake `localStorage` and a fake
 * `document`, and its answer is compared with the function's for the same input.
 * `new Function` rather than a direct `eval` for one reason: the script names
 * `document` and `localStorage` as free identifiers, and binding them as PARAMETERS
 * is explicit about which globals it is allowed to see. A direct `eval` would leak
 * whatever else happens to be in scope here into a script this test is meant to
 * isolate.
 *
 * That "two halves, compared" shape is the lesson from the 204/200 defect this
 * repository already paid for: two green ends and an unexecuted middle.
 */

interface BootResult {
  /** The value of `data-theme` afterwards, or `null` if the attribute is absent. */
  readonly attribute: string | null;
  /** Whether the script asked for removal rather than never setting anything. */
  readonly removed: boolean;
}

/**
 * Run the real script text with the two globals it is allowed to touch.
 *
 * `getItem` can be told to throw, because that is a state a real browser produces
 * (private mode, site data blocked) and the failure it causes — an exception inside
 * `<head>` — is a blank page rather than a wrong colour.
 */
function runBootScript(stored: string | null | (() => never)): BootResult {
  let attribute: string | null = null;
  let removed = false;

  const documentStub = {
    documentElement: {
      setAttribute(name: string, value: string): void {
        if (name === THEME_ATTRIBUTE) attribute = value;
      },
      removeAttribute(name: string): void {
        if (name === THEME_ATTRIBUTE) {
          attribute = null;
          removed = true;
        }
      },
    },
  };

  const localStorageStub = {
    getItem(key: string): string | null {
      expect(key, 'the script must read the key the app writes').toBe(THEME_STORAGE_KEY);
      if (typeof stored === 'function') {
        stored();
      }
      return stored as string | null;
    },
  };

  // eslint is not available in this repo (AGENTS.md §6); `new Function` here is the
  // subject of the test rather than an oversight.
  const run = new Function('document', 'localStorage', themeBootScript()) as (
    documentArgument: unknown,
    localStorageArgument: unknown,
  ) => void;
  run(documentStub, localStorageStub);

  return { attribute, removed };
}

describe('resolveThemeChoice — every way a stored value can be wrong', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    [null, 'system'],
    ['', 'system'],
    ['system', 'system'],
    // Matrix row: a corrupt stored value falls back to `system`, and nothing throws.
    ['purple', 'system'],
    ['LIGHT', 'system'],
    ['{"theme":"dark"}', 'system'],
  ])('%o becomes %s', (stored, expected) => {
    expect(resolveThemeChoice(stored)).toBe(expected);
  });
});

describe('themeAttributeFor — `system` is the ABSENCE of the attribute', () => {
  it('returns null for system, so the attribute is removed rather than written', () => {
    /**
     * The matrix row, and the reason for it is about REPRESENTATION rather than
     * about the cascade.
     *
     * An earlier version of this comment claimed `data-theme="system"` would match
     * no rule and silently render light on a dark machine. That is false —
     * `:root:not([data-theme="light"])` matches it perfectly well — and the comment
     * even noticed the contradiction in a parenthesis before stating the conclusion
     * anyway. `theme.ts` now carries the real reasons: one canonical form for one
     * state, `resolveThemeChoice` already treating any other string as corrupt, and
     * the genuine failure in the other direction — a script that only ever calls
     * `setAttribute` leaves a stale `dark` behind for somebody who has gone back to
     * following their machine.
     */
    expect(themeAttributeFor('system')).toBeNull();
  });

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
  ] as const)('%s is written out verbatim', (choice, expected) => {
    expect(themeAttributeFor(choice)).toBe(expected);
  });

  it('never returns an empty string, which would be an attribute that exists', () => {
    for (const choice of THEME_CHOICES) {
      expect(themeAttributeFor(choice)).not.toBe('');
    }
  });
});

describe('appliedTheme — what is actually on screen', () => {
  it.each([
    ['system', false, 'light'],
    ['system', true, 'dark'],
    // A hand-picked mode wins over the machine, in both directions. The second row
    // is the matrix case that a missing `:not()` guard in the CSS breaks.
    ['light', true, 'light'],
    ['dark', false, 'dark'],
  ] as const)('%s with prefersDark=%s is %s', (choice, prefersDark, expected) => {
    expect(appliedTheme(choice, prefersDark)).toBe(expected);
  });

  it('says which palette is on screen, in words, for somebody who cannot see it', () => {
    expect(appliedThemeNote('system', true)).toContain('tối');
    expect(appliedThemeNote('system', false)).toContain('sáng');
    expect(appliedThemeNote('light', true)).toContain('sáng');
  });
});

describe('the boot script agrees with the functions, for every input', () => {
  it.each([null, '', 'light', 'dark', 'system', 'purple', 'LIGHT'])(
    'stored %o produces the same attribute both ways',
    (stored) => {
      const expected = themeAttributeFor(resolveThemeChoice(stored));
      expect(runBootScript(stored).attribute).toBe(expected);
    },
  );

  it('REMOVES the attribute for system rather than leaving it untouched', () => {
    /**
     * The genuine palette failure, and the only one in this area.
     *
     * The document may already carry `data-theme="dark"` from a previous choice —
     * a client-side navigation, a back button, a second tab — and a script that only
     * ever CALLS `setAttribute` leaves it there for somebody who has since gone back
     * to "theo hệ điều hành". Their machine is then never consulted again.
     */
    expect(runBootScript(null).removed).toBe(true);
    expect(runBootScript('dark').removed).toBe(false);
  });

  it('survives a localStorage that throws, and still picks a palette', () => {
    // Private mode, or a browser told to block site data. An unguarded read here
    // throws inside `<head>` and stops the parser: a blank page, over a colour.
    const result = runBootScript(() => {
      throw new Error('SecurityError');
    });
    expect(result.attribute).toBeNull();
    expect(result.removed).toBe(true);
  });

  it('is safe to inline: it closes no tag and needs no escaping', () => {
    // The string goes into a `<script>` in `<head>`. A `</script>` anywhere in it —
    // including inside a string literal — ends the element early and dumps the rest
    // of the code onto the page as text.
    const source = themeBootScript();
    expect(source.toLowerCase()).not.toContain('</script');
    expect(source).not.toContain('<!--');
  });

  it('is built from the same two literals the app uses, not from copies', () => {
    // If the key or the attribute were spelled again in the template, this is the
    // assertion that would still pass while the two halves disagreed — so it checks
    // the generated text CONTAINS them rather than trusting the construction.
    const source = themeBootScript();
    expect(source).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(source).toContain(JSON.stringify(THEME_ATTRIBUTE));
  });
});

describe('the switch has three labelled choices and one query', () => {
  it('labels every choice', () => {
    expect(THEME_CHOICES).toEqual(['system', 'light', 'dark']);
    for (const choice of THEME_CHOICES) {
      expect(THEME_LABELS[choice].length).toBeGreaterThan(0);
    }
  });

  it('reads the OS preference through the same query the stylesheet matches', () => {
    // A drift here is invisible: `(prefers-color-scheme:dark)` without the space is
    // also valid, but the point is that the announcement and the paint agree.
    expect(DARK_SCHEME_QUERY).toBe('(prefers-color-scheme: dark)');
  });
});
