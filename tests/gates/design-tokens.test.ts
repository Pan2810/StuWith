import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_DARK_PRELUDE,
  DESIGN_MD_RELATIVE_PATH,
  GLOBALS_CSS_RELATIVE_PATH,
  MEDIA_DARK_GUARD,
  MEDIA_DARK_PRELUDE,
  TOKENS_CSS_RELATIVE_PATH,
  contrastRatio,
  designTokens,
  flattenRules,
  parseCss,
  readRepoFile,
  themeBlocks,
} from '../support/design-tokens';

/**
 * `apps/web/src/app/tokens.css` and the `DESIGN.md` frontmatter must say the same
 * thing, in both directions, key by key.
 *
 * ## What this closes, and why the obvious version of it would not
 *
 * The palette exists twice by necessity: once as the document a designer edits,
 * once as the stylesheet a browser loads. "Twice" is the whole problem — a
 * repository where a colour can be changed in one of two places and still look
 * consistent everywhere is a repository where the two answers drift, and nothing
 * says which one is now wrong.
 *
 * The rule is therefore a UNION OF TWO KEY SETS rather than a lookup: every colour
 * in the document must exist in the CSS with that value, AND every custom property
 * in the CSS must exist in the document. Half of that — checking only the first
 * direction — leaves the CSS free to grow a `--brand-purple` nobody documented,
 * which is exactly how a second palette starts.
 *
 * It compares by NAME, which is why `tokens.css` may not abbreviate. The moment a
 * variable is called `--bink`, this file needs a table mapping `border-ink` to it,
 * and that table is a third copy of the palette — one that can drift while this
 * gate stays green. `tokens.css` records the same argument at the top of the file.
 *
 * ## Why the guard on the media query is checked here rather than by eye
 *
 * The three-block shape has one subtle failure. `@media (prefers-color-scheme:
 * dark)` written WITHOUT `:not([data-theme="light"])` looks correct, passes every
 * visual check on a machine whose OS is light, and gives somebody who chose "sáng"
 * on a dark laptop the dark palette. It is a one-token edit to introduce and
 * invisible in review, so it is a rule rather than a convention.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (relative: string): string => readRepoFile(REPO_ROOT, relative);

const DESIGN_MD = read(DESIGN_MD_RELATIVE_PATH);
const TOKENS_CSS = read(TOKENS_CSS_RELATIVE_PATH);
const GLOBALS_CSS = read(GLOBALS_CSS_RELATIVE_PATH);

const TOKENS = designTokens(DESIGN_MD);
const BLOCKS = themeBlocks(TOKENS_CSS);

/** Sorted, so a failure reports a difference rather than an ordering. */
function keys(map: ReadonlyMap<string, string>): string[] {
  return [...map.keys()].sort();
}

describe('the sweep reads something at all, so an empty pass is impossible', () => {
  it('finds the document’s five token groups', () => {
    // Every rule below is vacuous against a parser that stopped understanding the
    // frontmatter, so the counts are pinned first — the same guard `routes.test.ts`
    // and `seam-usage.test.ts` put in front of their own sweeps.
    expect(TOKENS.lightColors.size).toBeGreaterThanOrEqual(20);
    expect(TOKENS.darkColors.size).toBeGreaterThanOrEqual(20);
    expect(TOKENS.scales.size).toBeGreaterThanOrEqual(40);

    // And it reaches the exact tokens the rest of the story leans on.
    expect(TOKENS.lightColors.get('surface-base')).toBe('#F3F0FF');
    expect(TOKENS.darkColors.get('surface-base')).toBe('#121020');
    expect(TOKENS.scales.get('--rounded-full')).toBe('9999px');
    expect(TOKENS.scales.get('--motion-easing-standard')).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('finds the stylesheet’s three theme blocks', () => {
    expect(BLOCKS.light.size).toBeGreaterThanOrEqual(60);
    expect(BLOCKS.mediaDark.size).toBeGreaterThanOrEqual(20);
    expect(BLOCKS.attributeDark.size).toBeGreaterThanOrEqual(20);
  });
});

describe('light: `:root` is exactly the document’s light palette plus the shared scales', () => {
  const expected = new Map<string, string>([
    ...[...TOKENS.lightColors].map(([name, value]) => [`--${name}`, value] as const),
    ...TOKENS.scales,
  ]);

  it('declares every documented token, under the same name', () => {
    expect(keys(BLOCKS.light)).toEqual(keys(expected));
  });

  it.each([...expected])('%s is %s', (name, value) => {
    expect(BLOCKS.light.get(name)).toBe(value);
  });
});

describe('dark: both dark blocks are exactly the document’s dark palette', () => {
  const expected = new Map<string, string>(
    [...TOKENS.darkColors].map(([name, value]) => [`--${name}`, value] as const),
  );

  it('the media block declares every documented dark token and nothing else', () => {
    expect(keys(BLOCKS.mediaDark)).toEqual(keys(expected));
  });

  it('the attribute block declares every documented dark token and nothing else', () => {
    expect(keys(BLOCKS.attributeDark)).toEqual(keys(expected));
  });

  it.each([...expected])('%s is %s in both dark blocks', (name, value) => {
    expect(BLOCKS.mediaDark.get(name), `${name} in ${MEDIA_DARK_PRELUDE}`).toBe(value);
    expect(BLOCKS.attributeDark.get(name), `${name} in ${ATTRIBUTE_DARK_PRELUDE}`).toBe(value);
  });

  it('the two dark blocks are identical, so choosing dark by hand and by OS agree', () => {
    // The two cannot be merged into one selector list — a media query is not
    // reachable from a DOM attribute — so the only thing keeping them in step is
    // this comparison.
    expect([...BLOCKS.mediaDark].sort()).toEqual([...BLOCKS.attributeDark].sort());
  });
});

describe('the dark override reuses the light NAME, never a second variable', () => {
  it.each([TOKENS_CSS_RELATIVE_PATH, GLOBALS_CSS_RELATIVE_PATH])('%s declares no `--…-dark` variable', (file) => {
    /**
     * `--border-ink-dark` would compile, look tidy, and break the whole model: a
     * component would then have to know which mode it is in to pick a variable,
     * and every component that forgot would be permanently light. The `-dark`
     * suffix belongs to `DESIGN.md`, where both modes share one flat document.
     */
    const offenders = flattenRules(parseCss(read(file)))
      .flatMap((rule) => [...rule.declarations.keys()])
      .filter((name) => /^--.*-dark$/.test(name));

    expect(offenders).toEqual([]);
  });

  it('every dark colour overrides a light one, except the documented dark-only token', () => {
    // `surface-elevated` is dark-only in `DESIGN.md`. Inventing a light value for
    // it here would be editing the design document from a stylesheet.
    const darkOnly = [...TOKENS.darkColors.keys()].filter(
      (name) => !TOKENS.lightColors.has(name),
    );
    expect(darkOnly).toEqual(['surface-elevated']);
  });
});

describe('no palette is reachable only through a media query', () => {
  it.each([TOKENS_CSS_RELATIVE_PATH, GLOBALS_CSS_RELATIVE_PATH])(
    '%s guards every `prefers-color-scheme: dark` block with `:not([data-theme="light"])`',
    (file) => {
      const rules = parseCss(read(file));
      const mediaBlocks = flattenRules(rules).filter((rule) =>
        rule.prelude.includes('prefers-color-scheme: dark'),
      );

      // At least one, or the rule below is checking nothing.
      expect(mediaBlocks.length, `${file} has no dark media query at all`).toBeGreaterThan(0);

      for (const block of mediaBlocks) {
        // The block itself declares nothing: everything inside it is a guarded
        // selector. A declaration written directly under `@media` would apply to
        // nothing, but a `:root { … }` without the guard applies to everybody.
        expect([...block.declarations.keys()]).toEqual([]);
        for (const child of block.children) {
          expect(child.prelude, `unguarded selector inside ${MEDIA_DARK_PRELUDE}`).toContain(
            ':not([data-theme="light"])',
          );
        }
      }
    },
  );

  it('every variable the media block sets is also set outside a media query', () => {
    /**
     * The half of the rule the guard does not cover. A token that exists ONLY
     * inside `@media` has no value at all for somebody who chose dark by hand on a
     * light OS — the attribute block would simply not mention it, and the property
     * would resolve to nothing.
     */
    for (const name of BLOCKS.mediaDark.keys()) {
      const outside = BLOCKS.attributeDark.has(name) || BLOCKS.light.has(name);
      expect(outside, `${name} exists only inside ${MEDIA_DARK_PRELUDE}`).toBe(true);
    }
  });

  it('spells the guard exactly as the story fixes it', () => {
    // Belt to the structural braces above: a guard written
    // `:root:not([data-theme='light'])` (single quotes) is still correct CSS, but
    // the shape this repo standardises on is one spelling, matching the reference
    // demo, so a reader comparing the two files sees no difference to explain.
    expect(TOKENS_CSS).toContain(MEDIA_DARK_PRELUDE);
    expect(TOKENS_CSS).toContain(MEDIA_DARK_GUARD);
    expect(TOKENS_CSS).toContain(ATTRIBUTE_DARK_PRELUDE);
  });
});

describe('tokens.css is a token file and nothing else', () => {
  const rules = flattenRules(parseCss(TOKENS_CSS));

  it('declares only custom properties', () => {
    // A `background:` here would be a presentation decision hiding inside the
    // layer that exists so the scan has one unambiguous thing to read.
    const offenders = rules.flatMap((rule) =>
      [...rule.declarations.keys()]
        .filter((name) => !name.startsWith('--'))
        .map((name) => `${rule.prelude} { ${name} }`),
    );
    expect(offenders).toEqual([]);
  });

  it('carries only the three theme selectors', () => {
    expect(rules.map((rule) => rule.prelude).sort()).toEqual(
      [MEDIA_DARK_PRELUDE, MEDIA_DARK_GUARD, ATTRIBUTE_DARK_PRELUDE, ':root'].sort(),
    );
  });
});

describe('globals.css spends only tokens that exist', () => {
  const declaredHere = new Set(
    flattenRules(parseCss(GLOBALS_CSS)).flatMap((rule) => [...rule.declarations.keys()]),
  );

  const referenced = [
    ...new Set([...GLOBALS_CSS.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1] ?? '')),
  ].sort();

  it('references a meaningful number of them, so an empty sweep cannot pass', () => {
    expect(referenced.length).toBeGreaterThanOrEqual(15);
  });

  it.each(referenced)('%s is defined by tokens.css or by globals.css itself', (name) => {
    /**
     * A misspelled `var(--boder-ink)` resolves to nothing and paints a transparent
     * border: the page still renders, the gate above still passes (the name is not
     * in `DESIGN.md`, but nothing was checking references), and the component
     * silently loses the boundary that carries its 3:1 contrast.
     */
    const defined = BLOCKS.light.has(name) || BLOCKS.mediaDark.has(name) || declaredHere.has(name);
    expect(defined, `${name} is referenced but never defined`).toBe(true);
  });

  it('names the three component keys `DESIGN.md` and `EXPERIENCE.md` share', () => {
    // Kebab-case English keys, joined by key and not by label — the convention
    // `DESIGN.md § Quy ước đọc token` fixes for both spines.
    for (const component of ['button-primary', 'button-secondary', 'chip-status']) {
      expect(GLOBALS_CSS).toContain(`.${component}`);
    }
  });
});

describe('the focus ring is never switched off', () => {
  /**
   * `EXPERIENCE.md:218`, word for word: "Vòng focus 2px `{colors.primary}`, cách
   * viền 2px. Không bao giờ tắt outline."
   *
   * `demo-san-pham.html:184` breaks it — `.field:focus{…outline:none}` — and that
   * line is a real accessibility defect rather than a house style: its specificity
   * beats the global `:focus-visible` rule, so a keyboard user typing into a field
   * has no visible focus at all. It was not ported, and this is what says so if
   * anybody ports it later while "matching the demo".
   */
  const files = [TOKENS_CSS_RELATIVE_PATH, GLOBALS_CSS_RELATIVE_PATH];

  /**
   * Every spelling that switches the ring off, not just the famous one.
   *
   * The first version of this rule matched `outline: none` and `outline: 0`, and
   * `outline-style: none`, `outline-width: 0` and `outline: 0px` all sail past it
   * while doing exactly the same thing to a keyboard user. A rule that knows one
   * spelling of a defect is a rule somebody satisfies by using another spelling —
   * usually without meaning to, because these are all things an autoformatter or a
   * "reset" snippet writes.
   */
  const RING_OFF = [
    /outline\s*:\s*none/i,
    /outline-style\s*:\s*none/i,
    /outline\s*:\s*0(?![.0-9a-z%])/i,
    /outline\s*:\s*0(px|em|rem|pt)\b/i,
    /outline-width\s*:\s*0(?![.0-9a-z%])/i,
    /outline-width\s*:\s*0(px|em|rem|pt)\b/i,
  ];

  it.each(files)('%s never switches the focus ring off, in any spelling', (file) => {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = RING_OFF.filter((pattern) => pattern.test(source)).map(String);
    expect(offenders).toEqual([]);
  });

  it('the ban recognises every spelling it claims to', () => {
    // The rule checking itself. A widened pattern that quietly stopped matching is
    // indistinguishable from a stylesheet that never offended.
    for (const offence of [
      'a:focus{outline: none}',
      'a:focus{outline:none}',
      'a:focus{outline-style: none}',
      'a:focus{outline: 0}',
      'a:focus{outline: 0px}',
      'a:focus{outline-width: 0}',
      'a:focus{outline-width: 0px}',
      'a:focus{OUTLINE: NONE}',
    ]) {
      expect(
        RING_OFF.some((pattern) => pattern.test(offence)),
        `${offence} is not recognised as switching the ring off`,
      ).toBe(true);
    }
  });

  it('the ban does not fire on a ring that is actually drawn', () => {
    // The other direction, which matters more than it looks: a pattern broad enough
    // to match `outline: 2px solid …` would make the rule unsatisfiable, and the
    // first person to hit that would delete it rather than debug it.
    for (const legitimate of [
      'outline: 2px solid var(--primary)',
      'outline-offset: 2px',
      'outline-width: 2px',
      'outline: 0.5rem solid red',
    ]) {
      expect(
        RING_OFF.some((pattern) => pattern.test(legitimate)),
        `${legitimate} was wrongly reported as switching the ring off`,
      ).toBe(false);
    }
  });

  it('sets the ring at the width and offset EXPERIENCE.md fixes', () => {
    expect(GLOBALS_CSS).toContain(':focus-visible');
    expect(GLOBALS_CSS).toContain('outline: 2px solid var(--primary)');
    expect(GLOBALS_CSS).toContain('outline-offset: 2px');
  });
});

describe('globals.css writes no colour of its own', () => {
  /**
   * The claim `globals.css` makes about itself, turned into a rule.
   *
   * Its docblock says "ở đây không có một mã hex nào — mọi màu là `var(--…)`". That
   * was TRUE and unenforced, which is the worst of the three possible states: a
   * reader believes it, and the first `background: #fff` written in a hurry makes it
   * false with nothing going red. A literal colour here is a second copy of a value
   * `DESIGN.md` owns, and the two-way comparison above cannot see it — it only reads
   * `tokens.css`.
   */
  const DECLARATIONS = flattenRules(parseCss(GLOBALS_CSS)).flatMap((rule) =>
    [...rule.declarations].map(([name, value]) => [rule.prelude, name, value] as const),
  );

  /**
   * Named CSS colours, or at least the ones somebody reaches for by accident.
   *
   * Deliberately not the full 148-name list: `currentColor` and `transparent` are
   * legitimate and used here, and a list long enough to be exhaustive would start
   * matching substrings of ordinary values. What has to be caught is the shape
   * `color: white`, and the eight below are what that shape actually looks like.
   */
  const NAMED = ['white', 'black', 'red', 'green', 'blue', 'grey', 'gray', 'orange'];

  const LITERAL = [
    /#[0-9a-f]{3,8}\b/i,
    /\brgba?\s*\(/i,
    /\bhsla?\s*\(/i,
    new RegExp(`(^|[^-a-z])(${NAMED.join('|')})([^-a-z]|$)`, 'i'),
  ];

  it('reads a meaningful number of declarations, so an empty sweep cannot pass', () => {
    expect(DECLARATIONS.length).toBeGreaterThanOrEqual(60);
  });

  it('spells no colour literally — every one is a var() into tokens.css', () => {
    const offenders = DECLARATIONS.filter(([, , value]) =>
      LITERAL.some((pattern) => pattern.test(value)),
    ).map(([prelude, name, value]) => `${prelude} { ${name}: ${value} }`);

    expect(offenders).toEqual([]);
  });

  it('recognises the literals it claims to, and leaves legitimate values alone', () => {
    for (const offence of ['#fff', '#F3F0FF', 'rgb(1,2,3)', 'rgba(1,2,3,.5)', 'hsl(1,2%,3%)', '2px solid white']) {
      expect(LITERAL.some((p) => p.test(offence)), `${offence} not caught`).toBe(true);
    }
    for (const legitimate of [
      'var(--surface-base)',
      'currentColor',
      'transparent',
      '2px solid var(--border-ink)',
      'inset(50%)',
      // `--border-decor` contains no banned word, and neither does a font stack.
      "'Be Vietnam Pro', Roboto, 'Segoe UI', system-ui, sans-serif",
    ]) {
      expect(LITERAL.some((p) => p.test(legitimate)), `${legitimate} wrongly caught`).toBe(false);
    }
  });
});

describe('border-decor is never the only boundary of something you can click', () => {
  /**
   * `DESIGN.md:274` and `:386`, in as many words: `border-decor` is "chỉ dùng cho
   * vạch phân cách trang trí, không bao giờ là ranh giới duy nhất của một thành phần
   * bấm được". The measurement behind that sentence is in `contrast.test.ts`:
   * `border-decor` on `surface-raised` is 1.41:1 light and 1.33:1 dark, against a
   * WCAG 1.4.11 floor of 3:1 for the boundary of a user-interface component.
   *
   * `.field` broke it. `DESIGN.md:362` prescribes a dashed `border-decor` for every
   * empty input, which contradicts the other two sentences, and the date input on
   * `/khai-ngay-sinh` has no other boundary at all. The resolution kept the dashed
   * STYLE and moved the COLOUR to `border-ink`; `deferred-work.md` records that a
   * human still has to say which sentence is canonical.
   *
   * The rule is an ALLOW-LIST rather than a shape heuristic. "A selector that also
   * sets `min-height: 48px`" would have missed `.field` the moment somebody moved
   * the height to a shared rule, and a list of what may use the token is a list
   * somebody has to edit deliberately.
   */
  const ALLOWED_TO_USE_BORDER_DECOR: readonly string[] = [];

  const users = flattenRules(parseCss(GLOBALS_CSS))
    .flatMap((rule) =>
      [...rule.declarations]
        .filter(
          ([name, value]) =>
            (name === 'border' || name.startsWith('border-')) && value.includes('--border-decor'),
        )
        .map(() => rule.prelude),
    )
    .filter((prelude, index, all) => all.indexOf(prelude) === index);

  it('only the selectors on the allow-list draw a border with it', () => {
    expect(users.filter((prelude) => !ALLOWED_TO_USE_BORDER_DECOR.includes(prelude))).toEqual([]);
  });

  it('the date input in particular does not', () => {
    // Named, because it is the one that broke the rule and the one a restyle is
    // most likely to break again — a dashed decorative border is what an input
    // "should" look like right up until you measure it.
    expect(users).not.toContain('.field');
    expect(GLOBALS_CSS).toContain('border: 2px dashed var(--border-ink)');
  });

  it('the sweep can see a border-decor border at all', () => {
    // Otherwise the two rules above pass against a reader that finds nothing.
    const probe = flattenRules(parseCss('.x{border: 2px dashed var(--border-decor)}'));
    expect(probe[0]?.declarations.get('border')).toContain('--border-decor');
  });
});

describe('globals.css mirrors the three-block theme shape it says it mirrors', () => {
  /**
   * The offset-shadow levels live here rather than in `tokens.css`, because
   * `DESIGN.md` has no `shadow` group — they are composition, expressed under
   * `components` as references. But they DO change by mode ("ở chế độ tối, bóng lệch
   * giảm một mức"), so they are written three times in the same shape as the token
   * file, and this file's docblock says so.
   *
   * Which means `globals.css` has the same duplication `tokens.css` has, and until
   * now nothing kept its two dark blocks in step: the identity check below ran on
   * `tokens.css` only. Two hand-maintained copies with no comparison is the exact
   * shape this whole story exists to refuse.
   */
  const blocks = themeBlocks(GLOBALS_CSS);

  /**
   * Custom properties only, and the exception is named rather than tolerated.
   *
   * `:root[data-theme="dark"]` also carries `color-scheme: dark`, and its media-query
   * twin correctly does NOT: with no attribute on the element, `html { color-scheme:
   * light dark }` already lets the browser follow the machine, so repeating it inside
   * the media query would say nothing. That is a real asymmetry rather than a drift,
   * so the identity check is over the variables and the second example below pins
   * exactly which non-variable declarations are allowed to be asymmetric.
   */
  const variablesOf = (block: ReadonlyMap<string, string>): Array<readonly [string, string]> =>
    [...block].filter(([name]) => name.startsWith('--')).sort();

  it('declares the same variables in both dark blocks, with the same values', () => {
    expect(variablesOf(blocks.mediaDark)).toEqual(variablesOf(blocks.attributeDark));
  });

  it('has something to compare, so the identity check is not over two empty sets', () => {
    expect(variablesOf(blocks.mediaDark).map(([name]) => name)).toEqual([
      '--shadow-1',
      '--shadow-2',
      '--shadow-3',
    ]);
  });

  it('allows exactly one non-variable declaration to differ, and names it', () => {
    // Without this the rule above would let any NEW ordinary property be added to
    // one dark block and forgotten in the other — the same drift, one keyword out
    // of scope.
    const ordinary = (block: ReadonlyMap<string, string>): string[] =>
      [...block.keys()].filter((name) => !name.startsWith('--')).sort();

    expect(ordinary(blocks.attributeDark)).toEqual(['color-scheme']);
    expect(ordinary(blocks.mediaDark)).toEqual([]);
  });

  it('gives every mode-dependent variable a light value outside any media query', () => {
    for (const [name] of variablesOf(blocks.mediaDark)) {
      expect(blocks.light.has(name), `${name} has no light value`).toBe(true);
    }
  });
});

describe('the parsers themselves, because a broken reader is a silent pass', () => {
  it('reads a nested at-rule rather than stopping at the first closing brace', () => {
    const rules = flattenRules(
      parseCss('@media (prefers-color-scheme: dark){:root:not([x]){--a:1}}:root{--b:2}'),
    );
    expect(rules.map((rule) => rule.prelude)).toEqual([
      '@media (prefers-color-scheme: dark)',
      ':root:not([x])',
      ':root',
    ]);
    expect(rules[1]?.declarations.get('--a')).toBe('1');
    expect(rules[2]?.declarations.get('--b')).toBe('2');
  });

  it('drops CSS comments rather than reading a variable out of one', () => {
    const rules = parseCss(':root{/* --ghost: #000; */ --real: #fff}');
    expect([...(rules[0]?.declarations.keys() ?? [])]).toEqual(['--real']);
  });

  it('refuses a frontmatter group that parses EMPTY, rather than passing vacuously', () => {
    /**
     * The direction that fails silently, and the reason it needs its own example.
     *
     * This reader keys entirely off two-space indentation, so a reflow of
     * `DESIGN.md` — or a `colors:` block that grew a nested level — makes a group
     * come back as `{}`. Every comparison in this file is "every key in the document
     * is in the CSS, and every key in the CSS is in the document", and the first half
     * of that is vacuously true over an empty set. The gate would go green against a
     * stylesheet nobody had checked, which is the worst outcome available.
     */
    const emptyColours = [
      '---',
      'colors:',
      'typography:',
      '  body:',
      '    fontSize: 15px',
      '---',
      '',
    ].join(String.fromCharCode(10));
    expect(() => designTokens(emptyColours)).toThrow(/parsed as EMPTY/);
  });

  it('refuses frontmatter it cannot find at all', () => {
    expect(() => designTokens('# just a heading')).toThrow(/no frontmatter fence/);
  });

  it('unquotes a YAML scalar without eating quotes that belong to the value', () => {
    // `typography.base.fontFamily` is double-quoted AND contains single quotes;
    // a stripper that removed every quote would produce an invalid font stack.
    expect(TOKENS.scales.get('--typography-base-font-family')).toBe(
      "'Be Vietnam Pro', Roboto, 'Segoe UI', system-ui, sans-serif",
    );
  });

  it('computes a contrast ratio that matches the extremes by definition', () => {
    // The reader `contrast.test.ts` leans on, checked against the two values WCAG
    // fixes rather than against another implementation of the same formula.
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});
