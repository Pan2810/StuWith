import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * The contract's SOURCE, by relative path, not `@stuwith/contracts`.
 *
 * `tests/gates` is not a workspace package, so the bare specifier does not resolve
 * here — and reading `packages/contracts/dist` would reproduce the Story 1.7 trap
 * where a run that skipped `build:packages` silently judged the PREVIOUS code and
 * reported green. Reading the source means this gate always judges the tree.
 */
import {
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  MONEY_IN_FORBIDDEN_MESSAGE,
  RATE_LIMITED_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
} from '../../packages/contracts/src/auth';
import { CREATE_ROOM_INVALID_MESSAGE } from '../../packages/contracts/src/rooms';

/**
 * Two rules over `apps/web/src/app`, and both are about a class rather than an
 * example.
 *
 * **Rule 1 — no sentence lives in a component.** Every string a person reads is a
 * key into `i18n/messages.ts`, so a natural-language literal anywhere else is a
 * string that escaped the catalogue: it has no English twin, it will never get one,
 * and nothing but a reader's eye would ever notice. The eight screens of Epic 2 are
 * what makes this worth a gate rather than a review note — the cost of finding
 * these by hand multiplies by nine.
 *
 * **Rule 2 — the two catalogues carry the same keys.** The Vietnamese side is
 * `MessageKey`'s definition, so a key missing from English is already a `tsc` error
 * that names the key. The reverse is NOT: `EN_MESSAGES` reaches `Record<MessageKey,
 * string>` as an imported constant rather than as a fresh object literal, so excess
 * property checking does not apply and an English-only key compiles fine. That key
 * is dead weight nothing can ever render, and this is the half of the pair that
 * sees it.
 *
 * ## Why a text scan, and why it is safe to be absolute about it
 *
 * There is no ESLint in this repository and cannot be one until TypeScript 7.1
 * (`AGENTS.md` §6: `@typescript-eslint/parser` throws at import time under TS 7.0),
 * so a rule with the shape of a lint rule is written as a test. The scan is
 * absolute about VIETNAMESE characters because it can be: after this story there is
 * exactly one file in `apps/web` allowed to contain them, and a Vietnamese
 * character in a component is unambiguous evidence rather than a heuristic. The
 * looser sentence-shaped rule beside it is what catches the same mistake made in
 * English, which is the direction a scan for diacritics is blind to.
 *
 * ## What is deliberately NOT caught, and why that is a decision
 *
 * The spec's "Never" list names things that look like strings and are DATA: query
 * parameters (`ket-qua`, `giay`, `quay-ve`), the wire enum `SIGN_IN_OUTCOMES`,
 * cookie and storage keys, DOM ids (`ngay-sinh`, `phien-het-han-tieu-de`), the
 * provider names in `PROVIDER_LABELS`, and `'StuWith'`. None of them carries a
 * diacritic and none is a sentence, so both rules pass them without an exemption
 * list to maintain. That is the point of choosing these two shapes: the boundary
 * falls where the spec draws it, by construction.
 *
 * ## Mutation-checked before being trusted, both halves
 *
 * `AGENTS.md` requires it and the examples at the bottom of each block do it
 * in-process: the ban is run against strings that must trip it and strings that must
 * not, and the key comparison is run against two hand-built catalogues that differ
 * in each direction. A rule that silently stopped matching is indistinguishable from
 * a codebase that never offended.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const APP_ROOT = path.join(REPO_ROOT, 'apps', 'web', 'src', 'app');
const I18N_DIR = path.join(APP_ROOT, 'i18n');
const VI_CATALOGUE = path.join(I18N_DIR, 'messages.ts');
const EN_CATALOGUE = path.join(I18N_DIR, 'messages.en.ts');

/** The two catalogues, which are the only files allowed to hold sentences. */
const CATALOGUES = new Set([VI_CATALOGUE, EN_CATALOGUE]);

/**
 * Block comments and whole-line `//` comments, removed before anything is judged.
 *
 * Every docblock in this codebase is written in a mixture of English and Vietnamese
 * and quotes the very sentences these rules are about, so a scan that read them
 * would report the explanation as the offence. Same anchored spelling as
 * `routes.test.ts:352`, `seam-usage.test.ts:121` and `config-cast-ban.test.ts:47`,
 * and the anchor is load-bearing: an UNANCHORED line-comment rule eats everything
 * after `https://` on a line, so an offending literal sitting after a URL would
 * disappear from the scan.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Product modules only. A `.test.ts(x)` file ships to nobody. */
function productFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...productFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
      continue;
    }
    found.push(full);
  }
  return found;
}

const SCANNED = productFiles(APP_ROOT).filter((file) => !CATALOGUES.has(file));

const relative = (file: string): string =>
  path.relative(REPO_ROOT, file).split(path.sep).join('/');

/* -------------------------------------------------------------------------- *
 * Rule 1a — Vietnamese characters
 * -------------------------------------------------------------------------- */

/**
 * Every letter Vietnamese has and English does not.
 *
 * A RANGE rather than a list of the 134 precomposed forms: `À-ỹ` covers
 * Latin-1 Supplement, Latin Extended-A and the whole of Latin Extended Additional,
 * which is where every Vietnamese tone mark lives. It also covers French, German and
 * Spanish accents, which is the correct behaviour rather than a side effect — a
 * sentence in any of those is just as much a string that escaped the catalogue.
 *
 * The `̀-ͯ` half catches the DECOMPOSED spelling. `ế` can be written as
 * one code point or as `e` plus two combining marks, the two look identical in every
 * editor, and an editor or a paste from a Mac can produce either. A rule that knew
 * only the precomposed form would be satisfied by a sentence that renders the same.
 */
const VIETNAMESE_LETTER = /[\u00C0-\u1EF9\u0300-\u036F]/;

/* -------------------------------------------------------------------------- *
 * Rule 1b — sentence shapes, for the same mistake made in English
 * -------------------------------------------------------------------------- */

/**
 * A string literal or a JSX text node, as the two places a sentence can hide.
 *
 * Template literals are included because `` `Thử lại sau ${n} giây.` `` is exactly
 * how the countdown used to be written, and it is the spelling somebody reaches for
 * the moment a sentence needs a value in it.
 *
 * Every pattern is SINGLE-LINE, and that is not cosmetic. The first version let a
 * quote or a backtick match across newlines, so an unmatched backtick — which is
 * what a `${...}` interpolation looks like to a naive pattern — swallowed forty
 * lines of ordinary code and reported them as one enormous sentence. A rule whose
 * failures are unreadable is a rule somebody deletes rather than fixes.
 */
const TEXT_SOURCES = [
  /'([^'\\\n]*)'/g,
  /"([^"\\\n]*)"/g,
  /`([^`\n]*)`/g,
  // JSX text: between `>` and `<`, on one line, with no braces in it.
  />([^<>{}\n]+)</g,
];

/**
 * The literal parts of a template, with every `${...}` slot removed.
 *
 * `` `Retry in ${n} seconds.` `` is a sentence with a hole in it, and the hole must
 * not stop the words either side of it being read as the sentence they are.
 */
function withoutInterpolations(text: string): string {
  return text.replace(/\$\{[^}]*\}/g, ' ');
}

/**
 * Three or more words in a row, or two words ending a sentence.
 *
 * Calibrated against what this codebase actually contains rather than against an
 * idea of English. `'notice notice-alert'`, `'(prefers-color-scheme: dark)'`,
 * `'content-type'` and `'application/json'` are all two tokens at most once the
 * hyphens are counted as word characters, so none of them trips it; "Sign in again
 * to carry on" trips the first alternative and "Check your session." the second.
 *
 * It is a heuristic and it is the looser of the two rules on purpose: the precise
 * one above already catches everything written in the product's own language, and
 * this exists so the same mistake made in English is not free.
 */
const SENTENCE_SHAPE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}|[A-Za-z]{2,}\s+[A-Za-z]{2,}[.!?]/;

/** Whether a piece of text reads as prose in either language. */
function readsAsProse(text: string): boolean {
  const bare = withoutInterpolations(text);
  return VIETNAMESE_LETTER.test(bare) || SENTENCE_SHAPE.test(bare);
}

/**
 * Everything in one file that either rule objects to.
 *
 * The two halves are asked differently, on purpose. Vietnamese is looked for over
 * the WHOLE file: after this story there is no legitimate reason for a Vietnamese
 * character to appear anywhere in `apps/web` outside the catalogue — not in a
 * literal, not in an identifier, not in a JSX attribute — and a whole-file scan
 * cannot be evaded by a spelling the literal patterns fail to recognise. The
 * sentence-shaped rule DOES need the literals, because ordinary TypeScript is
 * written in English and `export function createSessionRefresher(deps` is three
 * words in a row.
 */
function offencesIn(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const found: string[] = [];

  for (const [index, line] of source.split('\n').entries()) {
    if (VIETNAMESE_LETTER.test(line)) {
      found.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
    }
  }

  for (const pattern of TEXT_SOURCES) {
    for (const match of source.matchAll(pattern)) {
      const text = match[1] ?? '';
      if (text.trim().length === 0) {
        continue;
      }
      if (SENTENCE_SHAPE.test(withoutInterpolations(text))) {
        found.push(`${relative(file)}: ${text.trim()}`);
      }
    }
  }
  return [...new Set(found)];
}

/**
 * A real file, in the real tree, judged by the real function.
 *
 * ## Why the self-checks could not stay as they were
 *
 * They rebuilt the matching logic inline — `TEXT_SOURCES[0]`, then a hand-written
 * `.some(...)` — so they proved the REGEXES recognise a sentence and nothing about
 * whether the gate still runs them. Demonstrated: deleting the whole
 * `for (const pattern of TEXT_SOURCES)` loop out of {@link offencesIn} left 37 of 37
 * examples green, and planting `const LEAK = 'Welcome to the study room.'` in
 * `page.tsx` left them green too. The gate worked and nothing guarded the gate —
 * which is exactly what stands between the eight remaining screens of Epic 2 and
 * untranslated text.
 *
 * So every self-check below writes a file and calls the production function on it.
 *
 * ## Why the file goes into the app tree
 *
 * `offencesIn` reports paths relative to the repository root and exists to judge app
 * modules; a fixture somewhere else would be judged by the same code but would not
 * exercise the walker and the reporter agreeing about where things are. It is the
 * shape `tests/gates/ad-1-dependency-direction.test.ts` already uses — that one
 * writes and deletes a file inside `packages/domain/src`, which is why the `gates`
 * project runs with `fileParallelism: false`.
 *
 * Cleanup is in a `finally` AND an `afterEach`. A leftover would be picked up by the
 * sweep on the next run and fail loudly by name, which is the right way for this to
 * break.
 */
const PROBE_FILE = path.join(APP_ROOT, 'i18n-gate-probe.generated.tsx');

function withPlantedFile<T>(source: string, judge: (file: string) => T): T {
  writeFileSync(PROBE_FILE, source, 'utf8');
  try {
    return judge(PROBE_FILE);
  } finally {
    rmSync(PROBE_FILE, { force: true });
  }
}

afterEach(() => {
  rmSync(PROBE_FILE, { force: true });
});

describe('rule 1 — no sentence lives outside the catalogue', () => {
  it('scans the app at all, so an empty sweep cannot pass', () => {
    // Every assertion below is vacuous against a walker that found nothing — the
    // same guard `routes.test.ts` and `design-tokens.test.ts` put in front of their
    // own sweeps.
    expect(SCANNED.length).toBeGreaterThanOrEqual(10);
    const names = SCANNED.map(relative);
    expect(names).toContain('apps/web/src/app/layout.tsx');
    expect(names).toContain('apps/web/src/app/dang-nhap/sign-in-outcome.tsx');
    // And the catalogues are excluded rather than absent.
    expect(names).not.toContain('apps/web/src/app/i18n/messages.ts');
    expect(names).not.toContain('apps/web/src/app/i18n/messages.en.ts');
  });

  it.each(SCANNED.map(relative))('%s holds no natural-language literal', (name) => {
    const file = path.join(REPO_ROOT, ...name.split('/'));
    expect(
      offencesIn(file),
      'these read as sentences rather than as data. Move each one into ' +
        'apps/web/src/app/i18n/messages.ts (and messages.en.ts) and render it ' +
        'through useT().',
    ).toEqual([]);
  });

  /**
   * Every offence is planted in a real file and judged by {@link offencesIn}.
   *
   * The list is split by WHICH HALF of the rule should catch it, because the two
   * halves are independently deletable and the demonstration that prompted this
   * rewrite deleted exactly one of them.
   */
  const VIETNAMESE_OFFENCES: ReadonlyArray<readonly [string, string]> = [
    ['a single-quoted sentence', "export const label = 'H\u1ea3i, h\u00e3y th\u1eed l\u1ea1i sau \u00edt ph\u00fat.';"],
    ['a double-quoted sentence', 'export const label = "\u0110\u0103ng nh\u1eadp l\u1ea1i \u0111\u1ec3 ti\u1ebfp t\u1ee5c";'],
    ['JSX text', 'export const x = <p>Ch\u01b0a l\u01b0u \u0111\u01b0\u1ee3c.</p>;'],
    /**
     * DECOMPOSED, written as escapes so no editor and no `git` filter can quietly
     * normalise it back. `e` + U+0302 + U+0301 renders identically to `\u1ebf`, and a
     * rule that knew only the precomposed form would be satisfied by a sentence that
     * looks exactly the same on screen.
     */
    ['a decomposed diacritic', "export const label = 'K\u0065\u0302\u0301t th\u00fac';"],
    ['a JSX attribute, which no literal pattern reads', 'export const x = <p aria-label="Giao di\u1ec7n" />;'],
    ['an identifier, which no literal pattern reads either', 'export const nh\u00e3n = 1;'],
  ];

  const ENGLISH_OFFENCES: ReadonlyArray<readonly [string, string]> = [
    ['a single-quoted sentence', "export const label = 'Sign in again to carry on';"],
    ['a double-quoted sentence', 'export const label = "Check your session.";'],
    ['JSX text', 'export const x = <p>That was not saved.</p>;'],
    ['a template with a hole in it', 'export const label = `Retry in ${n} seconds.`;'],
    // Vietnamese written without its marks: no diacritic to find, so only the
    // sentence-shaped half can see it.
    ['Vietnamese with the marks stripped', "export const label = 'Ban da thu qua nhieu lan.';"],
  ];

  it.each([...VIETNAMESE_OFFENCES, ...ENGLISH_OFFENCES])(
    'reports %s when it is really in a file',
    (_label, source) => {
      const found = withPlantedFile(source, offencesIn);
      expect(found, `${source} was not reported`).not.toEqual([]);
      // And it names the file, so the failure is one somebody can act on.
      expect(found.join('\n')).toContain('i18n-gate-probe');
    },
  );

  it.each(ENGLISH_OFFENCES)(
    'catches %s through the SENTENCE half specifically, not the diacritic half',
    (_label, source) => {
      /**
       * The half the demonstration deleted. These sources carry no Vietnamese
       * character at all, so the whole-file diacritic scan cannot see them: if
       * `offencesIn` stops running `TEXT_SOURCES`, these are the examples that go
       * red, and that is the entire point of keeping the two lists apart.
       */
      expect(VIETNAMESE_LETTER.test(source), 'this example must not contain a diacritic').toBe(
        false,
      );
      expect(withPlantedFile(source, offencesIn)).not.toEqual([]);
    },
  );

  it('reports an offence that sits after a URL on the same line', () => {
    // The anchoring in `stripComments`. An unanchored line-comment rule eats
    // everything after `https://`, so an offence on such a line disappears — the
    // measured failure `config-cast-ban.test.ts` records for itself.
    const source =
      "export const doc = 'https://example.test'; export const l = 'Ch\u01b0a l\u01b0u \u0111\u01b0\u1ee3c.';";
    expect(withPlantedFile(source, offencesIn)).not.toEqual([]);
  });

  it('reports NOTHING for prose that lives in comments, where prose belongs', () => {
    /**
     * The other direction of the same mechanism, and it has to be a rule: every
     * docblock in this codebase mixes English and Vietnamese and quotes the very
     * sentences these rules are about. A scan that read them would report the
     * explanation as the offence, and the first person to hit that would delete the
     * gate rather than argue with it.
     */
    const source = [
      '/**',
      ' * \u0110\u00e2y l\u00e0 v\u0103n xu\u00f4i ti\u1ebfng Vi\u1ec7t trong docblock.',
      ' * And this is an English sentence explaining the same thing.',
      ' */',
      '// M\u1ed9t d\u00f2ng b\u00ecnh lu\u1eadn n\u1eefa, c\u0169ng ph\u1ea3i \u0111\u01b0\u1ee3c b\u1ecf qua.',
      'export const value = 1;',
    ].join('\n');

    expect(withPlantedFile(source, offencesIn)).toEqual([]);
  });

  it('leaves DATA alone — the spec’s "Never rút" list, item by item', () => {
    /**
     * The other direction, and it matters more than it looks: a rule broad enough to
     * flag `'ket-qua'` would be unsatisfiable, and the first person to hit that
     * would delete it rather than argue with it. Every value below is a real one
     * from this codebase, and each is data that happens to be spelled with letters.
     */
    const legitimate = [
      'ket-qua',
      'giay',
      'quay-ve',
      'that-bai',
      'da-huy',
      'bi-khoa',
      'stuwith-theme',
      'stuwith-locale',
      'data-theme',
      'ngay-sinh',
      'ngay-sinh-hint',
      'phien-het-han-tieu-de',
      'Google',
      'Facebook',
      'Microsoft',
      'StuWith',
      'use client',
      'application/json',
      'content-type',
      'notice notice-alert',
      'button-primary',
      'page-shell',
      '(prefers-color-scheme: dark)',
      'aria-live',
      'polite',
      '/dang-nhap',
      '/khai-ngay-sinh',
      'date_of_birth',
      'org_admin',
      'YYYY-MM-DD',
      '1900-01-01',
    ];

    for (const value of legitimate) {
      expect(readsAsProse(value), `${value} was wrongly reported as a sentence`).toBe(false);
    }

    /**
     * And the same list as a real MODULE, judged by the real function.
     *
     * The loop above asks the predicate; this asks the gate. They can disagree —
     * `offencesIn` also runs a whole-file diacritic scan and a JSX-text pattern that
     * `readsAsProse` never sees — and a rule that is satisfiable only in the
     * abstract is one somebody deletes the first time it fires on `'ket-qua'`.
     */
    const asModule = legitimate
      .map((value, index) => `export const v${index} = ${JSON.stringify(value)};`)
      .join('\n');

    expect(withPlantedFile(asModule, offencesIn)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * Rule 2 — the two catalogues carry the same keys
 * -------------------------------------------------------------------------- */

/**
 * The keys of a catalogue, read out of its TEXT.
 *
 * Text rather than an import, for the same reason the contract above is read from
 * source: `apps/web` is not resolvable from `tests/gates`, and a gate that imported
 * a built artefact would judge whatever was last compiled. Both files write one
 * `'key': value` per entry, which is a shape a regex can read exactly.
 */
function catalogueKeys(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  return [...source.matchAll(/^\s{2}'([A-Za-z][A-Za-z0-9.]*)':/gm)].map((match) => match[1] ?? '');
}

/** Keys `expected` has that `actual` does not. The rule and its self-check share it. */
function missingFrom(expected: readonly string[], actual: readonly string[]): string[] {
  const have = new Set(actual);
  return expected.filter((key) => !have.has(key));
}

const VI_KEYS = catalogueKeys(VI_CATALOGUE);
const EN_KEYS = catalogueKeys(EN_CATALOGUE);

describe('rule 2 — the catalogues are the same shape', () => {
  it('reads a meaningful number of keys from both, so an empty comparison cannot pass', () => {
    // Two empty sets are equal, which is the way this rule fails silently.
    expect(VI_KEYS.length).toBeGreaterThanOrEqual(40);
    expect(EN_KEYS.length).toBeGreaterThanOrEqual(40);
    for (const known of ['countdown.done', 'signIn.heading', 'error.rateLimited']) {
      expect(VI_KEYS, `the reader lost ${known}`).toContain(known);
      expect(EN_KEYS, `the reader lost ${known}`).toContain(known);
    }
  });

  it('declares each key exactly once per catalogue', () => {
    // A duplicate key is legal JavaScript and silently keeps the LAST value, so the
    // sentence a reviewer read is not the one that ships.
    for (const [name, keys] of [['vi', VI_KEYS], ['en', EN_KEYS]] as const) {
      const seen = new Set<string>();
      const duplicated = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
      expect(duplicated, `${name} declares these twice`).toEqual([]);
    }
  });

  it('has no key in one catalogue that the other lacks', () => {
    // The direction `tsc` already covers, asserted anyway: if this ever fires, the
    // type-level guard has been weakened and that is worth knowing separately.
    expect(missingFrom(VI_KEYS, EN_KEYS), 'missing from messages.en.ts').toEqual([]);
    // The direction `tsc` CANNOT cover — an imported constant gets no excess
    // property check, so an English-only key compiles and renders to nobody.
    expect(missingFrom(EN_KEYS, VI_KEYS), 'missing from messages.ts').toEqual([]);
  });

  it('the READER and the comparison both see a difference, in each direction', () => {
    /**
     * The rule checking itself, through the production functions rather than through
     * two hand-typed arrays and a filter written on the spot.
     *
     * Two catalogue-shaped files are written and read with {@link catalogueKeys},
     * then compared with {@link missingFrom} — the same two functions the rule runs.
     * A reader that silently stopped matching (a reformatted file, a nested object,
     * a change of quote style) returns `[]`, and two empty sets agree perfectly;
     * that is the failure this example exists to make impossible.
     */
    const catalogue = (keys: readonly string[]): string =>
      ['export const X = {', ...keys.map((key) => `  '${key}': 'value',`), '};'].join('\n');

    const left = withPlantedFile(catalogue(['a.one', 'a.two']), catalogueKeys);
    const right = withPlantedFile(catalogue(['a.one']), catalogueKeys);

    // The reader read something, and read exactly what was written.
    expect(left).toEqual(['a.one', 'a.two']);
    expect(right).toEqual(['a.one']);

    // And the comparison reports each direction independently.
    expect(missingFrom(left, right)).toEqual(['a.two']);
    expect(missingFrom(right, left)).toEqual([]);
  });

  it('is looking at catalogues that really have keys in them', () => {
    // Was `catalogueKeys.length`, which is a FUNCTION's arity — always 1, always
    // greater than 0, and just as true of a reader that had stopped reading.
    expect(VI_KEYS.length).toBeGreaterThanOrEqual(40);
    expect(VI_KEYS.length).toBe(EN_KEYS.length);
  });
});

/* -------------------------------------------------------------------------- *
 * Rule 4 — the English catalogue is in English
 * -------------------------------------------------------------------------- */

describe('rule 4 — no Vietnamese survives in the English catalogue', () => {
  /**
   * The failure NOTHING else in this file could see, and it is a one-keystroke one.
   *
   * Both catalogues are excluded from rule 1 — they are the one place sentences
   * belong — and rule 2 compares KEYS, which a copy-paste does not disturb. So
   * duplicating a Vietnamese row into `messages.en.ts` and forgetting to translate
   * it passes every structural check here and every non-empty check in
   * `messages.test.tsx`, and ships an English page with a Vietnamese sentence in it.
   *
   * This is the TEXT half of the rule; `messages.test.tsx` holds the VALUE half
   * (every English value differs from its Vietnamese twin, and the placeholder sets
   * match). Two mechanisms, because they fail differently: a value comparison cannot
   * see a Vietnamese string that is not also a Vietnamese VALUE — a helper constant,
   * a fallback, a comment-shaped literal — and a text scan cannot see a value that
   * was copied without being translated but happens to be pure ASCII.
   *
   * Comments are stripped first, and that is not a loophole: the docblocks in that
   * file explain the `org_admin` defect and quote Vietnamese to do it. Prose about
   * the rule is not a violation of it — the same decision every other scan in this
   * repository makes.
   */
  it('has no Vietnamese letter outside its comments', () => {
    const code = stripComments(readFileSync(EN_CATALOGUE, 'utf8'));
    const offenders = code
      .split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => VIETNAMESE_LETTER.test(line))
      .map(([number, line]) => `messages.en.ts:${number}: ${line.trim()}`);

    expect(offenders, 'these lines of the English catalogue are not English').toEqual([]);
  });

  it('reads the catalogue at all, so the rule above is not scanning an empty string', () => {
    // The way this fails silently: a rename, a moved file, a `readFileSync` that
    // throws and is swallowed. An empty string contains no Vietnamese either.
    const code = stripComments(readFileSync(EN_CATALOGUE, 'utf8'));
    expect(code).toContain('EN_MESSAGES');
    expect(code.length).toBeGreaterThan(1_000);
  });

  it('would report a Vietnamese value planted in a catalogue-shaped file', () => {
    // The mutation, on disk, through the same two functions the rule runs.
    const planted = [
      'export const EN_MESSAGES = {',
      "  'signIn.signOut': '\u0110\u0103ng xu\u1ea5t',",
      '};',
    ].join('\n');

    const reported = withPlantedFile(planted, (file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .some((line) => VIETNAMESE_LETTER.test(line)),
    );
    expect(reported).toBe(true);
  });

  it('would NOT report the same sentence sitting in a docblock', () => {
    // The other direction, and the reason the strip is there: the English
    // catalogue's own comments quote Vietnamese to explain what they are about.
    const planted = [
      '/** \u0110\u0103ng xu\u1ea5t is what this row used to say. */',
      "export const EN_MESSAGES = { 'signIn.signOut': 'Sign out' };",
    ].join('\n');

    const reported = withPlantedFile(planted, (file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .some((line) => VIETNAMESE_LETTER.test(line)),
    );
    expect(reported).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * Rule 3 — the contract's sentences have exactly one home
 * -------------------------------------------------------------------------- */

/**
 * Whether a file writes a sentence out, ignoring anything inside a comment.
 *
 * Named and shared so the rule and its self-check run the SAME code. It was an
 * inline `.filter(...)` with the self-check re-implementing it beside — which is how
 * a rule and its proof drift apart while both look green.
 */
function retypesSentence(file: string, sentence: string): boolean {
  return stripComments(readFileSync(file, 'utf8')).includes(sentence);
}

describe('rule 3 — the shared sentences are imported, never copied', () => {
  /**
   * Six now, and the list GROWS with the contract rather than staying at the five
   * Story 2.0 found. `CREATE_ROOM_INVALID_MESSAGE` crosses the boundary exactly as
   * the others do — `apps/api` puts it in a `validation_failed` envelope and the
   * create-room form shows it beside the field without waiting for a round trip —
   * so it earns the same protection: named by the catalogue, retyped nowhere.
   */
  const SHARED = [
    ['RATE_LIMITED_MESSAGE', RATE_LIMITED_MESSAGE],
    ['DATE_OF_BIRTH_INVALID_MESSAGE', DATE_OF_BIRTH_INVALID_MESSAGE],
    ['DATE_OF_BIRTH_ALREADY_SET_MESSAGE', DATE_OF_BIRTH_ALREADY_SET_MESSAGE],
    ['UNAUTHENTICATED_MESSAGE', UNAUTHENTICATED_MESSAGE],
    ['MONEY_IN_FORBIDDEN_MESSAGE', MONEY_IN_FORBIDDEN_MESSAGE],
    ['CREATE_ROOM_INVALID_MESSAGE', CREATE_ROOM_INVALID_MESSAGE],
  ] as const;

  const VI_SOURCE = readFileSync(VI_CATALOGUE, 'utf8');

  it.each(SHARED)('%s is named by the catalogue', (name) => {
    // `apps/api` puts these on the wire and the catalogue puts them on a screen.
    // One string, two consumers, and no second copy for an edit to miss.
    expect(VI_SOURCE).toContain(name);
  });

  it.each(SHARED)('%s is not RETYPED anywhere in apps/web', (name, sentence) => {
    /**
     * The half that matters, and the one an import alone does not give: a file can
     * import the constant AND write the sentence out somewhere else, and the two
     * then drift with nothing to say which is now wrong.
     */
    const offenders = [...SCANNED, VI_CATALOGUE, EN_CATALOGUE]
      .filter((file) => retypesSentence(file, sentence))
      .map(relative);

    expect(offenders, `${name} is written out as a literal here`).toEqual([]);
  });

  it('would notice a copy in a REAL file, through the same predicate', () => {
    // The mutation, on disk: the exact sentence pasted into a module is caught by
    // `retypesSentence`, which is the function the rule above runs — not by a
    // re-implementation of it written here.
    const planted = `export const message = ${JSON.stringify(RATE_LIMITED_MESSAGE)};`;
    expect(withPlantedFile(planted, (file) => retypesSentence(file, RATE_LIMITED_MESSAGE))).toBe(
      true,
    );
  });

  it('does NOT count the sentence when it is only quoted in a comment', () => {
    /**
     * The other direction, and it is what lets these sentences be discussed in prose
     * at all. Without comment-stripping, `messages.ts`'s own docblock explaining that
     * the value is imported would itself be reported as a copy of it.
     */
    const quoted = `/** ${RATE_LIMITED_MESSAGE} */\nexport const value = 1;`;
    expect(withPlantedFile(quoted, (file) => retypesSentence(file, RATE_LIMITED_MESSAGE))).toBe(
      false,
    );
  });
});
