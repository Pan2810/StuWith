import {
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  MONEY_IN_FORBIDDEN_MESSAGE,
  RATE_LIMITED_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  USER_ROLES,
} from '@stuwith/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './locale';
import {
  VI_TRANSLATE,
  formatMessage,
  formatParts,
  messagesFor,
  roleMessageKey,
  translatorFor,
} from './messages';

/**
 * The catalogue as a runtime object, and the translator as a function.
 *
 * `tests/gates/i18n-catalogue.test.ts` owns the STRUCTURAL rules — the two key sets
 * match, no sentence escaped into a component, the contract's five sentences are
 * imported rather than retyped. This file owns the behaviour: what a template does
 * with a value, what a plural does with a count, and what a role becomes.
 */

describe('every locale answers every key with a real sentence', () => {
  it.each(LOCALES)('%s has no blank and no leftover placeholder-only value', (locale) => {
    const dictionary = messagesFor(locale);
    const keys = Object.keys(dictionary);

    // A floor, so a catalogue that failed to load could not pass vacuously.
    expect(keys.length).toBeGreaterThanOrEqual(40);

    for (const key of keys) {
      const value = dictionary[key as keyof typeof dictionary];
      expect(value.trim().length, `${locale}/${key} is blank`).toBeGreaterThan(0);
      // A value that is nothing but a placeholder is a translation somebody started
      // and did not finish; it renders as a bare name with no sentence around it.
      expect(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '').trim().length,
        `${locale}/${key} is only a placeholder`).toBeGreaterThan(0);
    }
  });

  it('takes the five shared sentences from the contract, not from a copy', () => {
    /**
     * The rule the spec states as "một chuỗi, hai người dùng": `apps/api` puts these
     * on the wire and this catalogue puts them on a screen. Two copies of one
     * sentence is two things to edit and one to forget.
     */
    const vi = messagesFor('vi');
    expect(vi['error.rateLimited']).toBe(RATE_LIMITED_MESSAGE);
    expect(vi['error.dateOfBirthInvalid']).toBe(DATE_OF_BIRTH_INVALID_MESSAGE);
    expect(vi['error.dateOfBirthAlreadySet']).toBe(DATE_OF_BIRTH_ALREADY_SET_MESSAGE);
    expect(vi['error.unauthenticated']).toBe(UNAUTHENTICATED_MESSAGE);
    expect(vi['error.moneyInForbidden']).toBe(MONEY_IN_FORBIDDEN_MESSAGE);
  });
});

describe('the two catalogues are two languages, not one copied twice', () => {
  /**
   * Keys whose two locales are ALLOWED to be identical, declared rather than
   * tolerated.
   *
   * It is empty, and that is the assertion: nothing in this product spells the same
   * in both languages today. A key added here is a decision somebody had to write
   * down — the shape `design-tokens.test.ts` uses for `ALLOWED_TO_USE_BORDER_DECOR`,
   * and the reason is the same: a rule with a silent escape hatch is not a rule.
   */
  const ALLOWED_TO_MATCH: readonly string[] = [];

  it('has no key whose English value is still the Vietnamese one', () => {
    /**
     * The failure nothing else could see. Both catalogues are excluded from the
     * gate's literal scan (they are the one place sentences belong), the key sets
     * match either way, and `messages.test.tsx` only checked that values are
     * non-empty — so one copy-paste leaving `'signIn.signOut': 'Đăng xuất'` in the
     * English catalogue would ship green.
     */
    const vi = messagesFor('vi');
    const en = messagesFor('en');

    const untranslated = Object.keys(vi)
      .filter((key) => !ALLOWED_TO_MATCH.includes(key))
      .filter((key) => {
        const k = key as keyof typeof vi;
        return vi[k] === en[k];
      });

    expect(untranslated, 'these English values are still the Vietnamese ones').toEqual([]);
  });

  it('has no Vietnamese letter anywhere in the English catalogue', () => {
    /**
     * The same defect caught by its other signature, and the one that survives a
     * PARTIAL copy-paste: "Retry in {seconds} giây." has an English half, so it is
     * not equal to the Vietnamese value and the rule above would let it through.
     *
     * The range is the whole of Latin-1 Supplement, Latin Extended-A and Latin
     * Extended Additional, plus the combining marks — so the decomposed spelling of
     * a tone mark is caught as well as the precomposed one.
     */
    const en = messagesFor('en');
    const offenders = Object.entries(en).filter(([, value]) =>
      /[\u00C0-\u1EF9\u0300-\u036F]/.test(value),
    );

    expect(offenders, 'these English values carry Vietnamese letters').toEqual([]);
  });

  it('gives every key the SAME set of placeholders in both locales', () => {
    /**
     * A placeholder renamed, dropped or added on one side only is invisible until
     * somebody reads that locale: drop `{version}` from English and the version
     * disappears from the sentence; rename it and `{version}` is printed literally,
     * which is what `formatMessage` deliberately does with a slot it cannot fill.
     * Neither shows up in a key comparison or a non-empty check.
     */
    const vi = messagesFor('vi');
    const en = messagesFor('en');
    const slots = (value: string): string[] =>
      [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? '').sort();

    const mismatched = Object.keys(vi)
      .map((key) => key as keyof typeof vi)
      .filter((key) => slots(vi[key]).join(',') !== slots(en[key]).join(','))
      .map((key) => `${key}: vi=[${slots(vi[key])}] en=[${slots(en[key])}]`);

    expect(mismatched, 'these keys interpolate different things per locale').toEqual([]);
  });

  it('finds the placeholders it claims to, so the comparison is not over two empty sets', () => {
    // Five interpolation templates were counted in the spec. A reader that stopped
    // matching would report every key as agreeing, perfectly, about nothing.
    const vi = messagesFor('vi');
    const withSlots = Object.values(vi).filter((value) => /\{[A-Za-z]/.test(value));
    expect(withSlots.length).toBeGreaterThanOrEqual(5);
  });
});

describe('interpolation', () => {
  it('substitutes a named value', () => {
    expect(formatMessage('Hợp đồng API: {version}.', { version: '1.0.0' })).toBe(
      'Hợp đồng API: 1.0.0.',
    );
  });

  it('substitutes numbers as well as strings', () => {
    expect(formatMessage('{seconds}', { seconds: 30 })).toBe('30');
  });

  it('LEAVES an unfilled placeholder on screen rather than blanking it', () => {
    /**
     * The deliberate choice, and the reason is that the other behaviour hides.
     * Blanking produces "Thử lại sau  giây." — clumsy enough that nobody reports it
     * and nothing fails. `{seconds}` in the middle of a sentence is unmistakably a
     * bug, which is what an unnoticeable failure should be turned into.
     */
    expect(formatMessage('Thử lại sau {seconds} giây.', {})).toBe('Thử lại sau {seconds} giây.');
    expect(formatMessage('Thử lại sau {seconds} giây.')).toBe('Thử lại sau {seconds} giây.');
  });

  it('leaves braces that are not placeholders exactly where they are', () => {
    // A looser pattern would eat a stray brace out of a sentence and nobody would
    // be able to say where the character went.
    expect(formatMessage('a { b } c', { b: 'X' })).toBe('a { b } c');
  });
});

describe('the two substitutions agree about an EMPTY slot', () => {
  /**
   * `formatMessage` and `formatParts` state one rule — an unfilled placeholder stays
   * on the screen — and used to implement two. `formatParts` tested `name in values`,
   * so `{ name: undefined }` counted as filled and was substituted with a value React
   * renders as nothing: the placeholder vanished and the sentence closed up around
   * the hole, which reads as clumsy rather than as broken and therefore never gets
   * reported.
   */
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an absent key', {}],
    ['an explicit undefined', { name: undefined }],
    ['an explicit null', { name: null }],
  ];

  it.each(cases)('formatMessage keeps the placeholder for %s', (_label, values) => {
    expect(formatMessage('Xin chào {name}!', values as never)).toBe('Xin chào {name}!');
  });

  it.each(cases)('formatParts keeps the placeholder for %s', (_label, values) => {
    const html = renderToStaticMarkup(<>{formatParts('Xin chào {name}!', values as never)}</>);
    expect(html).toBe('Xin chào {name}!');
  });

  it('still substitutes a value that is merely FALSY', () => {
    // The other direction: `0` and `''` are values somebody supplied, not absences.
    // A fix written as `if (!value) continue` would have swallowed both.
    expect(formatMessage('{seconds}s', { seconds: 0 })).toBe('0s');
    expect(renderToStaticMarkup(<>{formatParts('[{a}]', { a: '' })}</>)).toBe('[]');
    expect(renderToStaticMarkup(<>{formatParts('[{a}]', { a: 0 })}</>)).toBe('[0]');
  });
});

describe('interpolation that carries markup', () => {
  it('keeps the sentence whole and puts the node in its slot', () => {
    /**
     * The shape that lets a display name keep its `<strong>` and an English name
     * keep its `lang` inside a Vietnamese sentence — the alternative is splitting a
     * sentence around the markup in JSX, which fixes Vietnamese word order for
     * every locale that will ever exist.
     */
    const html = renderToStaticMarkup(
      <>{formatParts('Đang đăng nhập: {name} (vai trò: {role})', {
        name: <strong>An Nguyen</strong>,
        role: 'Thành viên',
      })}</>,
    );

    expect(html).toBe('Đang đăng nhập: <strong>An Nguyen</strong> (vai trò: Thành viên)');
  });

  it('works when a placeholder starts or ends the sentence', () => {
    const html = renderToStaticMarkup(
      <>{formatParts('{a} middle {b}', { a: <i>A</i>, b: <i>B</i> })}</>,
    );
    expect(html).toBe('<i>A</i> middle <i>B</i>');
  });
});

describe('the one plural in the product', () => {
  it('says "second" for one and "seconds" for anything else, in English', () => {
    // Matrix row 6. `Retry in 1 seconds.` is exactly what a catalogue with no
    // plural support ships, and it is the reason `Intl.PluralRules` is here.
    const t = translatorFor('en');
    expect(t.plural('countdown.retryIn', 1, { seconds: 1 })).toBe('Retry in 1 second.');
    expect(t.plural('countdown.retryIn', 2, { seconds: 2 })).toBe('Retry in 2 seconds.');
    expect(t.plural('countdown.retryIn', 0, { seconds: 0 })).toBe('Retry in 0 seconds.');
  });

  it('says the same sentence for every count in Vietnamese, which has one category', () => {
    for (const seconds of [1, 2, 30, 900]) {
      expect(VI_TRANSLATE.plural('countdown.retryIn', seconds, { seconds })).toBe(
        `Thử lại sau ${seconds} giây.`,
      );
    }
  });

  it('carries its locale, so a caller never has to guess it', () => {
    expect(VI_TRANSLATE.locale).toBe('vi');
    expect(translatorFor('en').locale).toBe('en');
  });
});

describe('a role becomes a word, never a wire identifier', () => {
  it.each(USER_ROLES)('%s has a label in every locale', (role) => {
    /**
     * The defect this closes: `SignedInPanel` rendered `{user.role}` raw, so an
     * organisation administrator read "(vai trò: org_admin)" on their own account
     * page. `USER_ROLES` is the vocabulary two processes agree on; it is not a
     * label in any language.
     */
    for (const locale of LOCALES) {
      const label = translatorFor(locale)(roleMessageKey(role));
      expect(label.length, `${locale}/${role}`).toBeGreaterThan(0);
      // Never the wire value itself, and never anything with an underscore in it —
      // `org_admin` on a screen is the exact shape this table exists to remove.
      // (An English label may legitimately contain the wire WORD: `host` is both a
      // role name and an English noun, which is why the check is inequality rather
      // than absence.)
      expect(label, `${locale}/${role} shows the wire value`).not.toBe(role);
      expect(label, `${locale}/${role} looks like an identifier`).not.toContain('_');
    }
  });

  it('gives a role it has never heard of a true, general word', () => {
    // Matrix row 7's error column. `parseCurrentUser` should make this impossible;
    // the fallback costs one `??` and prevents a raw identifier on a screen.
    expect(roleMessageKey('space_pirate')).toBe('role.unknown');
    expect(VI_TRANSLATE(roleMessageKey('space_pirate'))).toBe('Thành viên');
  });
});
