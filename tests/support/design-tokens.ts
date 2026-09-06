import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reading `DESIGN.md` and `apps/web/src/app/tokens.css` — once, for the three
 * readers that compare them.
 *
 * `design-tokens.test.ts` proves the CSS says what the document says.
 * `contrast.test.ts` recomputes WCAG from the CSS and checks the ratios the
 * document publishes. `tests/e2e/web/he-thiet-ke.spec.ts` asks a real browser
 * whether `getComputedStyle` agrees with the same file. All three need the same two
 * parsers, and three copies of a parser is three parsers that drift: a `DESIGN.md`
 * reader that quietly stopped seeing the `colors` block would make one gate vacuous
 * while the others stayed strict, and no run would say so. So the parsers live here
 * and each reader holds its own rules.
 *
 * ## Why there is no `import.meta` and no `__dirname` in this file
 *
 * The same reason `tests/e2e/support/next-env.ts` gives, and it is not stylistic:
 * this module is imported from BOTH runners. Vitest loads it as ESM, where
 * `__dirname` does not exist; Playwright's babel emits CommonJS, where `import.meta`
 * does not. A module that reached for either would work in one place and throw in
 * the other. So it exports repo-RELATIVE paths and lets each caller resolve the
 * root the way its own runner already does.
 */

/** From the repository root. Resolved by the caller; see the docblock above. */
export const DESIGN_MD_RELATIVE_PATH = path.join(
  '_bmad-output',
  'planning-artifacts',
  'ux-designs',
  'ux-StuWith-2026-08-19',
  'DESIGN.md',
);

export const TOKENS_CSS_RELATIVE_PATH = path.join('apps', 'web', 'src', 'app', 'tokens.css');
export const GLOBALS_CSS_RELATIVE_PATH = path.join('apps', 'web', 'src', 'app', 'globals.css');

export function readRepoFile(repoRoot: string, relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/* ------------------------------------------------------------------ YAML -- */

type YamlNode = string | readonly string[] | { readonly [key: string]: YamlNode };

/**
 * Enough YAML for this one document, and deliberately not more.
 *
 * `DESIGN.md`'s frontmatter is nested maps of scalars plus one sequence
 * (`sources`). A general YAML library would be a new dependency — an "Ask First"
 * item — to read a file whose shape is fixed and checked below: {@link
 * designTokens} refuses a document missing any of the five groups it reads, so a
 * parser that silently stopped understanding the file cannot leave a gate green.
 */
function parseYaml(source: string): { readonly [key: string]: YamlNode } {
  const lines = source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'));

  let index = 0;

  function indentOf(line: string): number {
    return line.length - line.trimStart().length;
  }

  function parseBlock(indent: number): YamlNode {
    // A sequence: `- item` lines at this indentation.
    if (index < lines.length && (lines[index] ?? '').trim().startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length) {
        const line = lines[index] ?? '';
        if (indentOf(line) !== indent || !line.trim().startsWith('- ')) break;
        items.push(unquote(line.trim().slice(2)));
        index += 1;
      }
      return items;
    }

    const map: Record<string, YamlNode> = {};
    while (index < lines.length) {
      const line = lines[index] ?? '';
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      // A deeper line with no parent key above it is malformed; treat the block as
      // finished rather than guessing, so the group check below reports it.
      if (lineIndent > indent) break;

      const trimmed = line.trim();
      const separator = trimmed.indexOf(':');
      if (separator === -1) break;

      const key = unquote(trimmed.slice(0, separator).trim());
      const rest = trimmed.slice(separator + 1).trim();
      index += 1;

      if (rest.length > 0) {
        map[key] = unquote(rest);
        continue;
      }
      map[key] = parseBlock(indent + 2);
    }
    return map;
  }

  const parsed = parseBlock(0);
  return typeof parsed === 'string' || Array.isArray(parsed)
    ? {}
    : (parsed as { readonly [key: string]: YamlNode });
}

/** `'#F3F0FF'` and `"…sans-serif"` both lose exactly their own outer quotes. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** The frontmatter of a Markdown file, between the first two `---` fences. */
function frontmatterOf(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (match === null) {
    throw new Error('DESIGN.md has no frontmatter fence — the token source is unreadable');
  }
  return match[1] ?? '';
}

/* ---------------------------------------------------------------- tokens -- */

export interface DesignTokens {
  /** Light colours, keyed exactly as `DESIGN.md` writes them (`border-ink`). */
  readonly lightColors: ReadonlyMap<string, string>;
  /** Dark colours, with the `-dark` suffix REMOVED — the CSS name they override. */
  readonly darkColors: ReadonlyMap<string, string>;
  /**
   * `typography`, `rounded`, `spacing` and `motion`, flattened to the CSS custom
   * property name each one must appear under. These have no `-dark` variant by
   * the document's own rule, so they belong to `:root` and to nowhere else.
   */
  readonly scales: ReadonlyMap<string, string>;
  /**
   * `components.<key>.color`, resolved to the colour token it names.
   *
   * One entry today — `countdown-display` is `'{colors.ink-primary}'` — and it is
   * read rather than transcribed because the published contrast table names the
   * COMPONENT (`countdown-display` (ink) trên `coin-container`) while the palette
   * is keyed by colour. Writing that correspondence into a test by hand would be a
   * mapping table nobody updates when the component changes its colour.
   */
  readonly componentColors: ReadonlyMap<string, string>;
}

/** `fontSize` → `font-size`; a key that is already kebab-case is unchanged. */
function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Whitespace collapsed, so a line break in one file is not a difference. */
function normaliseValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Prose, not a value.
 *
 * `note` carries the sentences that explain a token (`tabular-nums bắt buộc …`).
 * Translating one into a custom property would put a paragraph in a stylesheet.
 */
const PROSE_KEYS = new Set(['note']);

/**
 * A frontmatter group, refused if it is missing OR empty.
 *
 * The empty case is the one that fails silently, and it is not hypothetical: this
 * parser keys entirely off two-space indentation, so a reflow of `DESIGN.md` that
 * changed the indent would leave `colors` parsing as `{}`. Every comparison
 * downstream is "every key in the document exists in the CSS, and every key in the
 * CSS exists in the document" — and the first half of that is vacuously true over
 * an empty set. The gate would go green on a stylesheet nobody had checked.
 *
 * The size floors in the gate catch the same thing one layer up; this throws at the
 * point where the failure is legible, naming the group that came back empty.
 */
function asMap(node: YamlNode | undefined, group: string): { readonly [key: string]: YamlNode } {
  if (node === undefined || typeof node === 'string' || Array.isArray(node)) {
    throw new Error(`DESIGN.md frontmatter has no \`${group}\` map — the token source is unreadable`);
  }
  const map = node as { readonly [key: string]: YamlNode };
  if (Object.keys(map).length === 0) {
    throw new Error(
      `DESIGN.md frontmatter group \`${group}\` parsed as EMPTY — the reader is broken, ` +
        'and every key comparison built on it would pass vacuously',
    );
  }
  return map;
}

export function designTokens(designMarkdown: string): DesignTokens {
  const frontmatter = parseYaml(frontmatterOf(designMarkdown));

  const lightColors = new Map<string, string>();
  const darkColors = new Map<string, string>();
  for (const [key, value] of Object.entries(asMap(frontmatter['colors'], 'colors'))) {
    if (typeof value !== 'string') continue;
    if (key.endsWith('-dark')) {
      darkColors.set(key.slice(0, -'-dark'.length), normaliseValue(value));
    } else {
      lightColors.set(key, normaliseValue(value));
    }
  }

  const scales = new Map<string, string>();

  for (const [step, properties] of Object.entries(asMap(frontmatter['typography'], 'typography'))) {
    for (const [property, value] of Object.entries(asMap(properties, `typography.${step}`))) {
      if (typeof value !== 'string' || PROSE_KEYS.has(property)) continue;
      scales.set(`--typography-${step}-${kebab(property)}`, normaliseValue(value));
    }
  }

  for (const group of ['rounded', 'spacing', 'motion'] as const) {
    for (const [key, value] of Object.entries(asMap(frontmatter[group], group))) {
      if (typeof value !== 'string' || PROSE_KEYS.has(key)) continue;
      scales.set(`--${group}-${key}`, normaliseValue(value));
    }
  }

  const componentColors = new Map<string, string>();
  for (const [component, properties] of Object.entries(
    asMap(frontmatter['components'], 'components'),
  )) {
    if (typeof properties === 'string' || Array.isArray(properties)) continue;
    const colour = (properties as { readonly [key: string]: YamlNode })['color'];
    if (typeof colour !== 'string') continue;
    const reference = /^\{colors\.([A-Za-z0-9-]+)\}$/.exec(colour.trim());
    if (reference !== null) {
      componentColors.set(component, reference[1] ?? '');
    }
  }

  return { lightColors, darkColors, scales, componentColors };
}

/* ------------------------------------------------------------------- CSS -- */

export interface CssRule {
  /** The selector or at-rule text before `{`, whitespace collapsed. */
  readonly prelude: string;
  readonly declarations: ReadonlyMap<string, string>;
  readonly children: readonly CssRule[];
}

/**
 * A brace-matching reader, not a regex.
 *
 * The three theme blocks are nested one level deep (`@media { :root { … } }`), and
 * a regex over `:root\s*\{([^}]*)\}` cannot see that — it stops at the first `}`,
 * which is the INNER one, and hands back a body that belongs to a different
 * selector. The gates below decide what is and is not allowed; this only reads.
 */
export function parseCss(source: string): readonly CssRule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let index = 0;

  /**
   * Each level hands back BOTH its child rules and its own declarations, which is
   * why this returns an object rather than an array: `@media { :root { … } }` has
   * children and no declarations, `:root { … }` has declarations and no children,
   * and a reader that could only carry one of the two would silently drop the
   * other on whichever block mixed them.
   */
  return parseBlock().rules;

  function parseBlock(): { rules: CssRule[]; declarations: Map<string, string> } {
    const rules: CssRule[] = [];
    const declarations = new Map<string, string>();
    let buffer = '';

    while (index < withoutComments.length) {
      const character = withoutComments[index] ?? '';
      index += 1;

      if (character === '}') {
        break;
      }
      if (character === '{') {
        const prelude = normaliseValue(buffer);
        buffer = '';
        const body = parseBlock();
        rules.push({ prelude, declarations: body.declarations, children: body.rules });
        continue;
      }
      if (character === ';') {
        addDeclaration(declarations, buffer);
        buffer = '';
        continue;
      }
      buffer += character;
    }

    addDeclaration(declarations, buffer);
    return { rules, declarations };
  }
}

function addDeclaration(into: Map<string, string>, raw: string): void {
  const text = raw.trim();
  if (text.length === 0) return;
  const separator = text.indexOf(':');
  if (separator === -1) return;
  into.set(normaliseValue(text.slice(0, separator)), normaliseValue(text.slice(separator + 1)));
}

/** Every rule in the tree, parents before children. */
export function flattenRules(rules: readonly CssRule[]): readonly CssRule[] {
  return rules.flatMap((rule) => [rule, ...flattenRules(rule.children)]);
}

/**
 * The three theme blocks of `tokens.css`, found by the exact shape the story
 * mandates rather than by position in the file.
 */
export interface ThemeBlocks {
  readonly light: ReadonlyMap<string, string>;
  readonly mediaDark: ReadonlyMap<string, string>;
  readonly attributeDark: ReadonlyMap<string, string>;
}

export const MEDIA_DARK_PRELUDE = '@media (prefers-color-scheme: dark)';
export const MEDIA_DARK_GUARD = ':root:not([data-theme="light"])';
export const ATTRIBUTE_DARK_PRELUDE = ':root[data-theme="dark"]';

/**
 * The declarations of every rule with this prelude, merged in source order.
 *
 * Merged rather than "the first one found", because `globals.css` legitimately
 * writes `:root[data-theme="dark"]` twice — once for `color-scheme`, once for the
 * offset-shadow overrides — and a reader that took only the first would compare
 * half a block and call the halves identical.
 */
function declarationsFor(rules: readonly CssRule[], prelude: string): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (rule.prelude !== prelude) continue;
    for (const [name, value] of rule.declarations) {
      merged.set(name, value);
    }
  }
  return merged;
}

export function themeBlocks(cssSource: string): ThemeBlocks {
  const all = flattenRules(parseCss(cssSource));

  return {
    light: declarationsFor(all, ':root'),
    mediaDark: declarationsFor(all, MEDIA_DARK_GUARD),
    attributeDark: declarationsFor(all, ATTRIBUTE_DARK_PRELUDE),
  };
}

/* -------------------------------------------------------------- contrast -- */

/** sRGB relative luminance, WCAG 2.1 §relative-luminance. */
function relativeLuminance(hex: string): number {
  const digits = hex.trim().replace('#', '');
  const expanded =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => `${digit}${digit}`)
          .join('')
      : digits;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** WCAG 2.1 contrast ratio, always ≥ 1, order of the arguments irrelevant. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
