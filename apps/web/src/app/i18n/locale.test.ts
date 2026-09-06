import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, isLocale, resolveLocale } from './locale';

/**
 * The story's I/O matrix, row by row, over the one function that decides a locale.
 *
 * These are unit tests and they are deliberately NOT the evidence that the feature
 * works. The spec says so in as many words: a unit test on `resolveLocale` does not
 * run the browser that sends the header, the server that writes `<html lang>`, or
 * the client that renders the sentence — and "three green suites over an unexecuted
 * middle" is the failure class this repository has already paid for once.
 * `tests/e2e/web/ngon-ngu.spec.ts` is the probe. What these examples ARE good for is
 * the header-parsing detail a browser test cannot enumerate: fifteen spellings of
 * `Accept-Language`, each with a reason.
 */

describe('the two locales, and the default among them', () => {
  it('has exactly the two the product ships, with Vietnamese first', () => {
    expect(LOCALES).toEqual(['vi', 'en']);
    expect(DEFAULT_LOCALE).toBe('vi');
  });

  it('recognises only those two as locales', () => {
    for (const locale of LOCALES) {
      expect(isLocale(locale)).toBe(true);
    }
    for (const other of ['', 'fr', 'VI', 'vi-VN', 'en_US', '../../etc', 'vi;en']) {
      expect(isLocale(other), `${other} must not read as a locale`).toBe(false);
    }
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('with no cookie, the browser decides', () => {
  it('falls back to Vietnamese when the browser asked for nothing', () => {
    // Matrix row 1. A missing header is the ordinary case for a `curl`, a crawler
    // and a browser with the preference cleared.
    expect(resolveLocale(null, null)).toBe('vi');
    expect(resolveLocale(null, '')).toBe('vi');
  });

  it('answers in English when the browser asked for English', () => {
    // Matrix row 2, in the exact spelling Chromium sends.
    expect(resolveLocale(null, 'en-US,en;q=0.9')).toBe('en');
  });

  it('matches on the PRIMARY subtag, so every English is English', () => {
    for (const header of ['en', 'en-GB', 'EN-AU', 'en-US,en;q=0.9,fr;q=0.8']) {
      expect(resolveLocale(null, header), header).toBe('en');
    }
    for (const header of ['vi', 'vi-VN', 'vi-VN,vi;q=0.9,en-US;q=0.8']) {
      expect(resolveLocale(null, header), header).toBe('vi');
    }
  });

  it('falls back to Vietnamese for a language nobody here speaks', () => {
    // Matrix row 4: no 404, no error, and above all no raw message key on a screen.
    for (const header of ['fr-FR', 'ja,ko;q=0.9', '*', 'x-klingon']) {
      expect(resolveLocale(null, header), header).toBe('vi');
    }
  });

  it('honours q-values rather than the order the tags were written in', () => {
    // A browser configured with English first but Vietnamese preferred is a real
    // configuration, and reading position instead of weight gets it backwards.
    expect(resolveLocale(null, 'en;q=0.4,vi;q=0.9')).toBe('vi');
    expect(resolveLocale(null, 'vi;q=0.2,en;q=0.8')).toBe('en');
  });

  it('keeps the browser’s own order when two languages carry the same weight', () => {
    // `sort` is stable, so equal weights mean "as written" — which is what the
    // browser meant by writing them in that order.
    expect(resolveLocale(null, 'en,vi')).toBe('en');
    expect(resolveLocale(null, 'vi,en')).toBe('vi');
    expect(resolveLocale(null, 'en;q=0.5,vi;q=0.5')).toBe('en');
  });

  it('treats q=0 as "not acceptable" and skips it', () => {
    // RFC 9110 gives `q=0` that exact meaning. Reading it as just another number
    // would answer in the one language the visitor explicitly refused.
    expect(resolveLocale(null, 'en;q=0,vi;q=0.1')).toBe('vi');
    expect(resolveLocale(null, 'en;q=0')).toBe('vi');
  });

  it('reads a malformed q as absent rather than as zero', () => {
    /**
     * `q=banana` is a broken client, not a refusal. Inventing a refusal from a
     * parse failure would silently drop a language nobody objected to.
     *
     * `q=` is the row this case was MISSING, and it is the only malformed spelling
     * that behaved backwards: `Number('')` is `0`, not `NaN`, so an empty value
     * passed every range check and came out as an explicit refusal of English.
     * Measured before the fix: `resolveLocale(null, 'en;q=')` answered `vi`. The
     * other three below were correct all along, which is precisely why their being
     * here proved nothing about this one.
     */
    expect(resolveLocale(null, 'en;q=')).toBe('en');
    expect(resolveLocale(null, 'en;q= ')).toBe('en');
    expect(resolveLocale(null, 'en;q=\t')).toBe('en');
    expect(resolveLocale(null, 'en;q=banana')).toBe('en');
    expect(resolveLocale(null, 'en;q=5')).toBe('en');
    expect(resolveLocale(null, 'en;q=-1')).toBe('en');
  });

  it('still honours a REAL q=0 beside the empty one, so the fix did not widen too far', () => {
    // The other direction: `q=0` must keep meaning "not acceptable". A fix that
    // treated every unparseable q as absent by ignoring the value entirely would
    // have made this pass for the wrong reason.
    expect(resolveLocale(null, 'en;q=0,vi;q=0.1')).toBe('vi');
    expect(resolveLocale(null, 'en;q=0.0,vi;q=0.1')).toBe('vi');
  });

  it('survives whitespace, casing and empty entries', () => {
    expect(resolveLocale(null, '  EN-US ; q=0.9 ')).toBe('en');
    expect(resolveLocale(null, ',,en,,')).toBe('en');
    expect(resolveLocale(null, ';;;')).toBe('vi');
  });

  it('cannot be made to do unbounded work by a header a stranger writes', () => {
    /**
     * The header arrives from the network with no length limit of its own, so both
     * bounds are here. Neither changes an honest answer — a real browser sends a
     * handful of short tags — and the case below proves the truncation does not
     * accidentally make a legitimate header unreadable when English is first.
     */
    const flood = `${'zz,'.repeat(5_000)}en`;
    expect(resolveLocale(null, flood)).toBe('vi');
    expect(resolveLocale(null, `en,${'zz,'.repeat(5_000)}`)).toBe('en');
  });

  it('truncates at a COMMA, so a half-read entry is never counted', () => {
    /**
     * The bound cuts ENTRIES, never the middle of one, and the case below is the
     * one where that is observable rather than merely tidy.
     *
     * A naive `slice(0, MAX)` ends wherever byte 512 lands. Land inside a TAG and
     * the fragment still parses: `en-US;q=0.9` cut to `en-` has primary subtag `en`
     * and no `q`, so it reads as "English, weight 1" — a preference assembled out of
     * half a token. Under the comma-cut the entry is simply not there, which is the
     * only truncation that cannot invent an answer.
     *
     * The other spelling P13 names — landing inside `;q=0.9` and leaving `;q=0`,
     * i.e. RFC 9110's "not acceptable" — is fixed by the same line but is NOT
     * observable through `resolveLocale`: a skipped range and an absent range
     * produce the same result here, because `q=0` drops its own entry rather than
     * vetoing the language everywhere. Said out loud so nobody adds an assertion
     * that would pass either way and reads as protection.
     */
    /**
     * The entries are LONG on purpose. The other bound — at most 20 ranges — is
     * reached first for ordinary short tags, so a header built from `zz;q=0.1,`
     * never exercises the length cut at all and a test using one passes whichever
     * truncation is in place. Twelve forty-character entries put byte 512 inside
     * the thirteenth, with the entry count still under its own ceiling.
     */
    const padEntry = `zz-${'b'.repeat(30)};q=0.1,`;
    const padding = padEntry.repeat(12);
    const header = `${padding}en-US-${'c'.repeat(28)};q=0.9`;

    expect(padEntry.length).toBe(40);
    expect(padding.length).toBe(480);
    // What a character-count cut would have handed the parser: a tag with no `q`,
    // whose primary subtag is `en` — an unqualified request for English, assembled
    // out of half a token.
    expect(header.slice(0, 512).endsWith(`en-US-${'c'.repeat(26)}`)).toBe(true);

    // English is past the window, so it is not read at all — rather than read as a
    // fragment that happens to look like a request for English.
    expect(resolveLocale(null, header)).toBe('vi');

    // And the entries that DID fit are still read, in full.
    expect(resolveLocale(null, `en;q=0.9,${'zz;q=0.1,'.repeat(200)}`)).toBe('en');
  });
});

describe('a cookie beats the header', () => {
  it('answers in the locale the person chose, whatever the browser asks for', () => {
    // Matrix row 3, and the acceptance criterion "a choice survives a return visit".
    expect(resolveLocale('vi', 'en-US,en;q=0.9')).toBe('vi');
    expect(resolveLocale('en', 'vi-VN,vi;q=0.9')).toBe('en');
  });

  it('DROPS a cookie value that is not one of ours, rather than repairing it', () => {
    /**
     * Matrix row 5, and the reason it is a security rule and not tidiness: this
     * answer is written into `<html lang>`, so a value that travelled through
     * would put text a stranger chose into an attribute of the document element.
     * The type guard makes that unexpressible — only the two literals can come out.
     */
    for (const junk of ['../../etc', '', ' vi', 'VI', 'en-US', 'vi"><script>', 'fr']) {
      expect(resolveLocale(junk, null), junk).toBe('vi');
    }
  });

  it('lets the header decide when the cookie is junk, rather than forcing the default', () => {
    // A corrupt cookie must not cost somebody the language their browser asked for.
    expect(resolveLocale('fr', 'en-US,en;q=0.9')).toBe('en');
  });
});
