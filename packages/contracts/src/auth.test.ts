import { describe, expect, it } from 'vitest';
import {
  MAX_SIGN_IN_RETURN_PATH_LENGTH,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  SIGN_IN_RETURN_PATH_QUERY_PARAM,
  parseInternalReturnPath,
} from './auth';

/**
 * The return-path validator, tested by CLASS rather than by example.
 *
 * This repository has a scar about exactly that. The trusted-proxy list went
 * through four review rounds and every one of them patched the specific token it
 * had been shown while the family behind it stayed open — nine probe addresses
 * that turned out to be a sample, a one-bit floor that let two `/1`s cover the
 * whole internet. `AGENTS.md` records it at length. A validator standing in front
 * of an open redirect in the login flow is the same kind of control, so the tests
 * below are organised around the WAYS a string can stop being an internal path,
 * and each way is swept over several spellings including ones no report has named.
 */

describe('parseInternalReturnPath — what an internal path is', () => {
  it.each([
    ['the root', '/'],
    ['a single segment', '/dang-nhap'],
    ['a nested path', '/phong-hoc/abc-123'],
    ['a path with a query', '/phong-hoc/abc?tab=chat'],
    ['a query with several parameters', '/a?x=1&y=2'],
    ['unreserved punctuation', '/a-b_c.d~e/f'],
    ['a dot inside a segment rather than as one', '/report.v2/latest'],
    ['a doubled slash that is not at the start', '/a//b'],
    ['a `..` inside the QUERY, where it cannot normalise anything', '/a?next=../b'],
    ['a `//` inside the QUERY, where it cannot change the origin', '/a?next=//evil.com'],
  ])('accepts %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBe(raw);
  });

  it('returns the string unchanged, never a rewritten one', () => {
    // A validator that normalises is a validator with two answers: the one it
    // checked and the one it returned. Returning the input verbatim means the
    // thing that was judged is the thing that gets signed.
    const raw = '/phong-hoc/abc?tab=chat&x=1';
    expect(parseInternalReturnPath(raw)).toBe(raw);
  });
});

describe('parseInternalReturnPath — the class of things carrying an origin', () => {
  it.each([
    ['an absolute https URL', 'https://evil.com/x'],
    ['an absolute http URL', 'http://evil.com/x'],
    ['a scheme with no slashes', 'https:evil.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>x</script>'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with a path', '//evil.com/x'],
    ['three slashes', '///evil.com'],
    ['backslash after the slash', '/\\evil.com'],
    ['two backslashes', '\\\\evil.com'],
    ['a backslash anywhere at all', '/a\\b'],
    ['userinfo punctuation', '/@evil.com'],
    ['a colon anywhere at all', '/a:b'],
    ['an absolute URL hidden behind a leading slash and a colon', '/https://evil.com'],
    ['no leading slash at all', 'dang-nhap'],
    ['a relative path', './dang-nhap'],
    ['a parent-relative path', '../dang-nhap'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of encoded spellings', () => {
  /**
   * There is no decoding step in the validator, on purpose, so this whole family
   * is refused by ONE rule (`%` is not an allowed character) rather than by a
   * decoder that has to agree with whatever decodes the value later. Two readings
   * of one string that can disagree is the round-three failure of the proxy list,
   * and it is not repeated here.
   */
  it.each([
    ['encoded protocol-relative', '/%2F%2Fevil.com'],
    ['lowercase encoded protocol-relative', '/%2f%2fevil.com'],
    ['encoded backslash', '/%5Cevil.com'],
    ['double-encoded slash', '/%252F%252Fevil.com'],
    ['encoded parent segment', '/%2E%2E/x'],
    ['an encoded newline, which would split a Location header', '/a%0D%0ASet-Cookie:%20x=y'],
    ['an encoded NUL', '/a%00b'],
    ['an ordinary, harmless escape — refused too, and that is the trade', '/tim-kiem?q=%C3%A1'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of normalisation surprises', () => {
  it.each([
    ['a bare parent segment', '/../x'],
    ['a parent segment in the middle', '/a/../../etc'],
    ['a trailing parent segment', '/a/..'],
    ['a bare current segment', '/./x'],
    ['a current segment in the middle', '/a/./b'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of bytes that are not path characters', () => {
  it.each([
    ['a carriage return and newline', '/a\r\nSet-Cookie: x=y'],
    ['a bare newline', '/a\nb'],
    ['a tab', '/a\tb'],
    // Written as an ESCAPE and never as a literal byte: a raw NUL makes git
    // classify the whole file as binary, which is how the central fixture of
    // the login stories once became a file nobody could review or grep.
    ['a NUL', '/a\u0000b'],
    ['a space', '/a b'],
    ['a leading space, so trimming is not silently assumed', ' /a'],
    ['a trailing space', '/a '],
    ['angle brackets', '/a<script>'],
    ['a quote', "/a'b"],
    ['a fragment, which the server never sees anyway', '/a#b'],
    ['a percent on its own', '/a%b'],
  ])('drops %s', (_label, raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — the class of things that are not strings', () => {
  it('drops the empty string', () => {
    expect(parseInternalReturnPath('')).toBeNull();
  });

  it.each([null, undefined, 0, 1, {}, [], ['/a'], true, false])('drops %s', (raw) => {
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('parseInternalReturnPath — length', () => {
  it('accepts a path exactly at the ceiling', () => {
    const raw = `/${'a'.repeat(MAX_SIGN_IN_RETURN_PATH_LENGTH - 1)}`;
    expect(raw.length).toBe(MAX_SIGN_IN_RETURN_PATH_LENGTH);
    expect(parseInternalReturnPath(raw)).toBe(raw);
  });

  it('drops a path one character over it', () => {
    // The bound exists because this value rides in a cookie on every /v1/auth
    // request until the handshake ends, and a browser sending a large enough
    // Cookie header is answered with a 431 instead of a login page.
    const raw = `/${'a'.repeat(MAX_SIGN_IN_RETURN_PATH_LENGTH)}`;
    expect(parseInternalReturnPath(raw)).toBeNull();
  });
});

describe('the three sign-in query parameters are distinct', () => {
  /**
   * They travel on the same URL family and two of them already ride back
   * together. A copy-paste that gave two of them the same name would make one
   * silently unreadable, and nothing else in the system would notice.
   */
  it('has three different names', () => {
    const names = [
      SIGN_IN_OUTCOME_QUERY_PARAM,
      SIGN_IN_RETRY_AFTER_QUERY_PARAM,
      SIGN_IN_RETURN_PATH_QUERY_PARAM,
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it('names the return path in Vietnamese, like the two beside it', () => {
    expect(SIGN_IN_RETURN_PATH_QUERY_PARAM).toBe('quay-ve');
  });
});
