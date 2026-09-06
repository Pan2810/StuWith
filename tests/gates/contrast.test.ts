import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_MD_RELATIVE_PATH,
  GLOBALS_CSS_RELATIVE_PATH,
  TOKENS_CSS_RELATIVE_PATH,
  contrastRatio,
  designTokens,
  flattenRules,
  parseCss,
  readRepoFile,
  themeBlocks,
} from '../support/design-tokens';

/**
 * The contrast ratios `DESIGN.md` publishes are recomputed from `tokens.css`.
 *
 * ## Why the numbers are measured rather than trusted
 *
 * A contrast table in a design document is a set of claims about colours that live
 * somewhere else. Nothing stops one of those colours being nudged — a shade of
 * purple that reads better on a designer's monitor — while the table keeps the old
 * number beside it. The document then says the product meets AA and the product
 * does not, and every reviewer who checks the document agrees with it.
 *
 * So this file computes each ratio from the hex values in `tokens.css`, which is
 * what a browser actually paints, and compares:
 *
 * 1. against the WCAG thresholds — 4.5:1 for text (2.1 §1.4.3), 3:1 for the
 *    boundary of a user-interface component (§1.4.11); and
 * 2. against the number `DESIGN.md` published, so the document cannot quietly
 *    become wrong about its own palette.
 *
 * The pairs are READ OUT of the document's table rather than listed here. A list
 * here would be a third copy: adding a ninth load-bearing pair to `DESIGN.md`
 * would leave it unchecked, and that is the "patch the example rather than the
 * class" shape this repository has paid for before.
 *
 * ## If this goes red
 *
 * Change the colour, or change the pairing. Do NOT lower a threshold and do not
 * delete a row: the thresholds are WCAG's, and `EXPERIENCE.md § Accessibility
 * Floor` calls AA a floor rather than a target.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const DESIGN_MD = readRepoFile(REPO_ROOT, DESIGN_MD_RELATIVE_PATH);
const TOKENS = designTokens(DESIGN_MD);
const BLOCKS = themeBlocks(readRepoFile(REPO_ROOT, TOKENS_CSS_RELATIVE_PATH));

/** WCAG 2.1 §1.4.3 — normal body text. The story refuses to lower it. */
const TEXT_MINIMUM = 4.5;
/** WCAG 2.1 §1.4.11 — the boundary of a user-interface component. */
const COMPONENT_MINIMUM = 3;

/**
 * The palettes as a browser resolves them, built from `tokens.css` alone.
 *
 * Dark is light with the dark block applied on top, which is exactly what the
 * cascade does — and it is why a dark block that forgot a token would show up here
 * as a light colour on a dark background rather than as a missing key.
 */
const LIGHT = new Map([...BLOCKS.light].filter(([name]) => isColour(name)));
const DARK = new Map([...LIGHT, ...BLOCKS.mediaDark]);

function isColour(name: string): boolean {
  const bare = name.replace(/^--/, '');
  return TOKENS.lightColors.has(bare) || TOKENS.darkColors.has(bare);
}

function colourOf(palette: ReadonlyMap<string, string>, token: string, mode: string): string {
  const value = palette.get(`--${token}`);
  expect(value, `tokens.css has no --${token} in ${mode}`).toBeTruthy();
  return value ?? '';
}

/**
 * A colour token, or the colour a component key resolves to.
 *
 * The published table names `countdown-display`, which is a component rather than
 * a colour; the frontmatter says that component's `color` is `{colors.ink-primary}`
 * and {@link designTokens} follows the reference. Resolving it rather than
 * transcribing it means the day the countdown changes colour, this gate compares
 * the NEW pair — the number in the table would then be the thing that is wrong,
 * and it would say so.
 */
function resolveToken(name: string): string {
  return TOKENS.lightColors.has(name) ? name : (TOKENS.componentColors.get(name) ?? name);
}

/* ------------------------------------------------- the published table -- */

interface PublishedPair {
  readonly foreground: string;
  readonly background: string;
  /** `null` where the table prints `—`, which it does for one light-only pair. */
  readonly light: number | null;
  readonly dark: number | null;
}

/**
 * The rows of `DESIGN.md`'s contrast table, parsed.
 *
 * Shape: `| \`a\` trên \`b\` | 14.63:1 | 15.79:1 |`, with an optional parenthesised
 * gloss after the first name and an em dash where a mode has no published number.
 */
function publishedPairs(markdown: string): readonly PublishedPair[] {
  const pairs: PublishedPair[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|');
    if (cells.length < 4) continue;
    const names = /`([a-z0-9-]+)`[^`]*trên\s*`([a-z0-9-]+)`/.exec(cells[1] ?? '');
    if (names === null) continue;
    pairs.push({
      foreground: names[1] ?? '',
      background: names[2] ?? '',
      light: ratioCell(cells[2] ?? ''),
      dark: ratioCell(cells[3] ?? ''),
    });
  }
  return pairs;
}

function ratioCell(cell: string): number | null {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*:\s*1/.exec(cell);
  return match === null ? null : Number(match[1]);
}

const PUBLISHED = publishedPairs(DESIGN_MD);

describe('the table is read at all, so an empty sweep cannot pass', () => {
  it('finds every load-bearing pair the document publishes', () => {
    expect(PUBLISHED.length).toBe(8);
    // And it reaches the two rows that are easiest to lose: the first, and the
    // one whose foreground is a component key rather than a colour.
    expect(PUBLISHED[0]).toEqual({
      foreground: 'ink-primary',
      background: 'surface-base',
      light: 14.63,
      dark: 15.79,
    });
    expect(PUBLISHED.at(-1)).toEqual({
      foreground: 'countdown-display',
      background: 'coin-container',
      light: 14.88,
      dark: null,
    });
  });

  it('resolves the component key to the colour the frontmatter gives it', () => {
    expect(TOKENS.componentColors.get('countdown-display')).toBe('ink-primary');
    expect(resolveToken('countdown-display')).toBe('ink-primary');
  });

  it('builds both palettes out of tokens.css', () => {
    expect(LIGHT.size).toBe(TOKENS.lightColors.size);
    // Dark is light plus the one dark-only token, `surface-elevated`.
    expect(DARK.size).toBe(TOKENS.lightColors.size + 1);
    expect(LIGHT.get('--surface-base')).toBe('#F3F0FF');
    expect(DARK.get('--surface-base')).toBe('#121020');
  });
});

describe('every load-bearing pair clears WCAG AA in BOTH modes', () => {
  it.each(PUBLISHED.map((pair) => [pair.foreground, pair.background] as const))(
    '`%s` on `%s`',
    (foreground, background) => {
      const front = resolveToken(foreground);
      for (const [mode, palette] of [
        ['light', LIGHT],
        ['dark', DARK],
      ] as const) {
        const ratio = contrastRatio(
          colourOf(palette, front, mode),
          colourOf(palette, background, mode),
        );
        expect(
          ratio,
          `${front} on ${background} in ${mode} is ${ratio.toFixed(2)}:1 — change the colour, not the threshold`,
        ).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      }
    },
  );
});

describe('the numbers printed in DESIGN.md are the numbers the CSS produces', () => {
  const rows = PUBLISHED.flatMap((pair) =>
    (
      [
        ['light', pair.light],
        ['dark', pair.dark],
      ] as const
    )
      .filter(([, published]) => published !== null)
      .map(
        ([mode, published]) =>
          [pair.foreground, pair.background, mode, published as number] as const,
      ),
  );

  it('has something to compare in both modes', () => {
    // 8 pairs × 2 modes, minus the one row that publishes no dark number.
    expect(rows.length).toBe(15);
  });

  it.each(rows)('`%s` on `%s` in %s is the published ratio', (foreground, background, mode, published) => {
    const palette = mode === 'light' ? LIGHT : DARK;
    const front = resolveToken(foreground);
    const measured = contrastRatio(
      colourOf(palette, front, mode),
      colourOf(palette, background, mode),
    );

    /**
     * Two decimals, because that is the precision the document prints. A wider
     * tolerance would let a colour change that moves a ratio by a tenth pass while
     * the table kept the old number — which is the exact drift this checks for.
     */
    expect(Number(measured.toFixed(2)), `${front} on ${background} in ${mode}`).toBe(published);
  });
});

describe('border-ink clears the component threshold, which is what the direction rests on', () => {
  /**
   * `DESIGN.md § Colors` claims this in prose rather than in the table: "`border-ink`
   * đạt **16.41:1** ở light và **3.55:1** ở dark". It is load-bearing rather than
   * decorative — participant tiles and secondary buttons are told apart BY their
   * border, so the border is a user-interface component boundary under WCAG 1.4.11
   * and 3:1 is its floor. The dark value has the least headroom of anything in the
   * palette, so it is the first number a colour tweak would break.
   */
  const claim = /`border-ink`\s*đạt\s*\*\*([0-9.]+):1\*\*\s*ở light và\s*\*\*([0-9.]+):1\*\*\s*ở dark/.exec(
    DESIGN_MD,
  );

  it('finds the sentence that publishes the two numbers', () => {
    expect(claim, 'DESIGN.md no longer states the border-ink ratios').not.toBeNull();
  });

  it.each([
    ['light', 0],
    ['dark', 1],
  ] as const)('on surface-raised in %s mode', (mode, group) => {
    const palette = mode === 'light' ? LIGHT : DARK;
    const measured = contrastRatio(
      colourOf(palette, 'border-ink', mode),
      colourOf(palette, 'surface-raised', mode),
    );

    expect(measured, `border-ink in ${mode}`).toBeGreaterThanOrEqual(COMPONENT_MINIMUM);
    expect(Number(measured.toFixed(2))).toBe(Number(claim?.[group + 1]));
  });

  it('also clears it against the page background, which is where most borders sit', () => {
    // The published sentence measures against `surface-raised`; a border on the
    // page ground is the commoner case and has no published number, so it is
    // checked against the threshold alone.
    for (const [mode, palette] of [
      ['light', LIGHT],
      ['dark', DARK],
    ] as const) {
      const ratio = contrastRatio(
        colourOf(palette, 'border-ink', mode),
        colourOf(palette, 'surface-base', mode),
      );
      expect(ratio, `border-ink on surface-base in ${mode}`).toBeGreaterThanOrEqual(
        COMPONENT_MINIMUM,
      );
    }
  });
});


/* ------------------------------------------- the pairs globals.css composes -- */

/**
 * The pairs the STYLESHEET actually puts on screen, which are not the pairs the
 * document publishes.
 *
 * `DESIGN.md`'s table is a list of intentions: eight combinations the design leans
 * on. `globals.css` is a list of facts, and it composes pairs the table never
 * mentions — `ink-secondary` on `surface-base` for `.meta` inside `.page-shell`,
 * `primary` on `surface-raised` for a link inside a `.card`, `ink-secondary` on
 * `surface-sunken` for a disabled button. Checking only the published eight is
 * therefore checking the design's homework rather than the product.
 *
 * ## Why a table here rather than a resolver
 *
 * "Work out the background a rule renders against" needs the cascade, the DOM the
 * app actually builds, and every specificity interaction — a resolver would be a
 * second, worse browser, and a resolver that got one case wrong would be MORE
 * dangerous than no resolver, because it would report a number nobody could trace.
 *
 * So the pairings are written down. What makes the table honest rather than
 * decorative is {@link describe} "the table cannot fall behind the stylesheet"
 * below: every `color:` declaration in `globals.css` must appear here. Adding a
 * `color:` to a new rule without deciding what it sits on is a red run, which is
 * the failure mode a table on its own would have.
 */
interface ComposedPair {
  /** The selector, exactly as `globals.css` writes it — the key for the sweep. */
  readonly selector: string;
  readonly color: string;
  /** The surface it renders against, as reasoned in `where`. */
  readonly background: string;
  /** Why that background, in a sentence a reviewer can check against the file. */
  readonly where: string;
  /** Overridden only with a WCAG clause naming the exemption. Default 4.5. */
  readonly minimum?: number;
}

const COMPOSED: readonly ComposedPair[] = [
  {
    selector: 'body',
    color: 'ink-primary',
    background: 'surface-base',
    where: 'the page ground; `body` sets both halves itself',
  },
  {
    selector: 'a',
    color: 'primary',
    background: 'surface-base',
    where: 'a link directly in `.page-shell`, which inherits the body ground',
  },
  {
    selector: 'a',
    color: 'primary',
    background: 'surface-raised',
    where: 'a link inside `.card`, `nav.card` or the dialog — all `surface-raised`',
  },
  {
    selector: '.notice a',
    color: 'ink-primary',
    background: 'surface-sunken',
    where:
      'a link inside a `.notice`. It exists BECAUSE `primary` on `surface-sunken` is 4.21:1 — under AA — so the link drops to ink and keeps its underline',
  },
  {
    selector: '.brand',
    color: 'ink-primary',
    background: 'surface-raised',
    where: '`.page-header` sets `surface-raised`',
  },
  {
    selector: '.brand-accent',
    color: 'primary',
    background: 'surface-raised',
    where: 'the "With" half of the wordmark, inside `.page-header`',
  },
  {
    selector: '.meta',
    color: 'ink-secondary',
    background: 'surface-base',
    where: '`.meta` on `/khai-ngay-sinh` sits directly in `.page-shell`',
  },
  {
    selector: '.meta',
    color: 'ink-secondary',
    background: 'surface-raised',
    where: '`.meta` inside a `.card`, which is where most of them are',
  },
  {
    selector: '.button-primary',
    color: 'on-primary',
    background: 'primary',
    where: 'the button sets both halves itself',
  },
  {
    selector: '.button-secondary',
    color: 'ink-primary',
    background: 'surface-raised',
    where: 'the button sets both halves itself',
  },
  {
    selector: '.button-primary:disabled, .button-secondary:disabled',
    color: 'ink-secondary',
    background: 'surface-sunken',
    where:
      'the disabled state sets both halves itself. It used to be `opacity: 0.6`, which composites to about 2.59:1 — the reason this row exists as a real pair',
  },
  {
    selector: '.chip-status',
    color: 'ink-primary',
    background: 'surface-raised',
    where: 'the default chip, before a state variant',
  },
  {
    selector: '.chip-status.ok',
    color: 'ok',
    background: 'ok-container',
    where: 'the variant sets both halves itself',
  },
  {
    selector: '.chip-status.warn',
    color: 'warn',
    background: 'warn-container',
    where: 'the variant sets both halves itself',
  },
  {
    selector: '.chip-status.coin',
    color: 'coin',
    background: 'coin-container',
    where: 'the variant sets both halves itself',
  },
  {
    selector: '.notice',
    color: 'ink-primary',
    background: 'surface-sunken',
    where: 'the notice sets both halves itself',
  },
  {
    selector: '.notice-alert',
    color: 'warn',
    background: 'warn-container',
    where: 'the alert variant sets both halves itself',
  },
  {
    selector: '.field',
    color: 'ink-primary',
    background: 'surface-raised',
    where: 'the input sets both halves itself',
  },
  {
    selector: '.theme-switch button',
    color: 'ink-primary',
    background: 'surface-raised',
    where: 'the button is `transparent`; `.theme-switch` behind it is `surface-raised`',
  },
  {
    selector: '.theme-switch button[aria-pressed="true"]',
    color: 'on-primary',
    background: 'primary',
    where: 'the pressed button sets both halves itself',
  },
];

describe('every pair globals.css composes clears AA, in both palettes', () => {
  it.each(
    COMPOSED.map((pair) => [pair.selector, pair.color, pair.background, pair.where] as const),
  )('%s — `%s` on `%s` (%s)', (_selector, foreground, background) => {
    for (const mode of ['light', 'dark'] as const) {
      const palette = mode === 'light' ? LIGHT : DARK;
      const ratio = contrastRatio(
        colourOf(palette, foreground, mode),
        colourOf(palette, background, mode),
      );
      const minimum =
        COMPOSED.find((pair) => pair.color === foreground && pair.background === background)
          ?.minimum ?? TEXT_MINIMUM;
      expect(
        ratio,
        `${foreground} on ${background} in ${mode} is ${ratio.toFixed(2)}:1 — change the colour or the pairing, never the threshold`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('records the pairing that is one edit away from failing', () => {
    // `primary` on `surface-sunken` is 4.21:1. Nothing renders it today — `.notice a`
    // exists precisely so nothing can — and this example is what says so out loud,
    // so the next person to put a `primary` link on a sunken surface finds the
    // number here rather than discovering it from a user.
    const ratio = contrastRatio(
      colourOf(LIGHT, 'primary', 'light'),
      colourOf(LIGHT, 'surface-sunken', 'light'),
    );
    expect(ratio).toBeLessThan(TEXT_MINIMUM);
    expect(COMPOSED.some((pair) => pair.color === 'primary' && pair.background === 'surface-sunken')).toBe(
      false,
    );
  });
});

describe('the table cannot fall behind the stylesheet', () => {
  /**
   * The half that makes the table above a rule rather than a snapshot.
   *
   * Every `color:` declaration in `globals.css` has to appear here under the same
   * selector. So a new rule that paints text is a red run until somebody says what
   * it sits on — which is exactly the decision that gets skipped, and exactly the
   * decision that produced the 2.59:1 disabled button.
   */
  const GLOBALS_CSS = readRepoFile(REPO_ROOT, GLOBALS_CSS_RELATIVE_PATH);

  /** `color:` — never `background-color`, `border-color`, `outline-color`. */
  const painted = flattenRules(parseCss(GLOBALS_CSS))
    .filter((rule) => rule.declarations.has('color'))
    .map((rule) => ({ selector: rule.prelude, color: rule.declarations.get('color') ?? '' }));

  it('finds the painting rules at all, so an empty sweep cannot pass', () => {
    expect(painted.length).toBeGreaterThanOrEqual(12);
  });

  it.each(painted.map((rule) => [rule.selector, rule.color] as const))(
    '%s sets color %s, and the composed-pairs table says what it sits on',
    (selector, color) => {
      // `currentColor` is not a colour decision, it is a deferral to one — the dot
      // inside `.chip-status` inherits whatever the chip already resolved.
      if (color.includes('currentColor')) return;

      const rows = COMPOSED.filter((pair) => pair.selector === selector);
      expect(
        rows.length,
        `no row in COMPOSED for \`${selector}\` — add one saying which surface it renders against`,
      ).toBeGreaterThan(0);

      const token = /var\(\s*--([a-z0-9-]+)/.exec(color)?.[1] ?? color;
      expect(
        rows.map((row) => row.color),
        `COMPOSED has \`${selector}\` but not with colour \`${token}\``,
      ).toContain(token);
    },
  );

  /**
   * The reverse direction, and it took a mutation to find out the first version of
   * it was not enough.
   *
   * Checking only "the selector still exists" passed against the exact regression
   * this whole section was written for: put `opacity: 0.6` back on the disabled
   * button and delete its two colour declarations, and the rule went green. The
   * selector was still there, it simply no longer painted anything, so the
   * completeness sweep (which only looks at rules that HAVE a `color:`) never
   * visited it and the table asserted about a pairing the stylesheet had stopped
   * composing. A row nothing renders is a row that proves nothing.
   *
   * So each row has to find its colour still declared under its own selector.
   */
  const declaredColour = (selector: string): string | null => {
    const rule = flattenRules(parseCss(GLOBALS_CSS)).find((each) => each.prelude === selector);
    const value = rule?.declarations.get('color');
    if (value === undefined) return null;
    return /var\(\s*--([a-z0-9-]+)/.exec(value)?.[1] ?? value;
  };

  it.each(COMPOSED.map((pair) => [pair.selector, pair.color] as const))(
    '%s still declares colour %s in the stylesheet',
    (selector, colour) => {
      const found = declaredColour(selector);
      expect(
        found,
        `COMPOSED claims \`${selector}\` paints \`${colour}\`, but the stylesheet no longer sets a colour there`,
      ).not.toBeNull();
      // Two rows may share a selector (a link on two different surfaces), so the
      // colour has to match, not merely exist.
      expect(found).toBe(colour);
    },
  );

  it('the reader can tell a missing colour from a present one', () => {
    // Guards the helper above: a version that always returned a truthy value would
    // make every example in this block vacuous.
    expect(declaredColour('.button-primary')).toBe('on-primary');
    expect(declaredColour('.page-shell')).toBeNull();
    expect(declaredColour('.selector-that-does-not-exist')).toBeNull();
  });

  it('no measured pair is undone by opacity', () => {
    /**
     * `opacity` composites the text with whatever is behind it, so a rule that sets
     * one has a contrast ratio this file cannot compute from two tokens — and the
     * number it WOULD compute is wrong in the safe-looking direction. That is not a
     * hypothetical: the disabled button shipped as `opacity: 0.6` with a docblock
     * claiming it stayed above the threshold, and composited it is about 2.59:1.
     */
    const offenders = flattenRules(parseCss(GLOBALS_CSS))
      .filter(
        (rule) =>
          rule.declarations.has('opacity') &&
          COMPOSED.some((pair) => pair.selector === rule.prelude),
      )
      .map((rule) => rule.prelude);

    expect(offenders).toEqual([]);
  });
});
