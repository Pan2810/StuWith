import { describe, expect, it } from 'vitest';
import {
  LOG_REDACT_PATHS,
  REDACTION_NOTES,
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  isAcceptableRequestId,
  loggerBaseOptions,
  resolveRequestId,
  sanitizeLoggedUrl,
} from './logging';

/**
 * AD-15 has no other test in the repo, which meant the redaction list was a
 * comment with a shape. Deleting `req.headers.cookie` from it, or flipping
 * `remove: true` to `false` in either app, left every gate green.
 *
 * This file pins the FLOOR, not the finished control: the spine mandates a
 * whitelist serializer and that is Story 1.7's job. What is asserted here is only
 * what today's deny-list actually promises.
 */
describe('LOG_REDACT_PATHS (AD-15)', () => {
  const required = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["set-cookie"]',
    'res.headers["set-cookie"]',
    '*.email',
    '*.date_of_birth',
    // The camelCase half of the same field. `packages/domain`'s `User` carries
    // `dateOfBirth`, so the snake_case path alone covered the request body and
    // missed the object anything in `apps/api` would actually log.
    '*.dateOfBirth',
    '*.access_token',
    '*.refresh_token',
    '*.provider_id',
  ];

  it.each(required)('redacts %s', (path) => {
    expect(LOG_REDACT_PATHS).toContain(path);
  });

  /**
   * The pairing, as a rule over the SET rather than over a list of examples.
   *
   * The previous version of this test iterated a hand-written array of four field
   * names. That is a list of examples, and it was green while `*.oauth_state`,
   * `*.authorization_code`, `req.body.access_token`, `req.body.id_token`,
   * `req.body.provider_id`, `req.body.code_verifier` and `req.body.refresh_token`
   * all had no camelCase half — the exact class of hole the array was written to
   * close. The comment in `logging.ts` claimed the stronger property; only now is
   * that claim true.
   *
   * The rule walks `LOG_REDACT_PATHS` itself, so a field added later in ONE
   * spelling fails here without anybody remembering to extend a list.
   */
  describe('every path is declared in both spellings of its last segment', () => {
    /** `req.headers["set-cookie"]` and friends: a quoted segment is not a field name. */
    const fieldPaths = LOG_REDACT_PATHS.filter((path) => !path.includes('['));

    const split = (path: string): { prefix: string; field: string } => {
      const cut = path.lastIndexOf('.');
      return { prefix: path.slice(0, cut), field: path.slice(cut + 1) };
    };
    const toCamel = (snake: string): string =>
      snake.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase());
    const toSnake = (camel: string): string =>
      camel.replace(/[A-Z]/g, (upper) => `_${upper.toLowerCase()}`);

    it('finds paths to check at all, so an empty sweep cannot pass', () => {
      // Same guard as `dep-check`'s module count: a filter that matched nothing
      // would make every assertion below vacuous.
      expect(fieldPaths.length).toBeGreaterThanOrEqual(20);
      // And the sweep must actually reach both vocabularies it is about.
      expect(fieldPaths.some((path) => split(path).field.includes('_'))).toBe(true);
      expect(fieldPaths.some((path) => /[a-z][A-Z]/.test(split(path).field))).toBe(true);
    });

    it.each(fieldPaths.filter((path) => split(path).field.includes('_')))(
      '%s has a camelCase sibling',
      (path) => {
        const { prefix, field } = split(path);
        expect(LOG_REDACT_PATHS).toContain(`${prefix}.${toCamel(field)}`);
      },
    );

    it.each(fieldPaths.filter((path) => /[a-z][A-Z]/.test(split(path).field)))(
      '%s has a snake_case sibling',
      (path) => {
        const { prefix, field } = split(path);
        expect(LOG_REDACT_PATHS).toContain(`${prefix}.${toSnake(field)}`);
      },
    );
  });

  it('covers every field the spine names as never-loggable', () => {
    // "Email, provider-id, date of birth, access token and chat content never
    // reach a log line at any level." Each needs at least one covering path.
    const joined = LOG_REDACT_PATHS.join('\n');
    for (const field of ['email', 'date_of_birth', 'access_token', 'provider_id', 'message']) {
      expect(joined, `no redaction path mentions ${field}`).toContain(field);
    }
  });

  it('is handed to callers intact', () => {
    const base = loggerBaseOptions({ level: 'info', service: 'api', version: '0.1.0' });
    expect(base.redactPaths).toEqual(LOG_REDACT_PATHS);
    expect(base.requestIdHeader).toBe(REQUEST_ID_HEADER);
    expect(base.base).toEqual({ service: 'api', version: '0.1.0' });
  });
});

describe('inbound request id is not trusted verbatim', () => {
  const generate = () => 'generated-id';

  it('reuses an id that already looks like an id', () => {
    expect(resolveRequestId('018f9c2e-6a1b-7c3d-9e4f-a1b2c3d4e5f6', generate)).toBe(
      '018f9c2e-6a1b-7c3d-9e4f-a1b2c3d4e5f6',
    );
  });

  it('replaces one containing a newline — the log-forging case', () => {
    // A newline in a value that is stamped on every log line lets the caller
    // append whole fabricated records to the log.
    expect(resolveRequestId('abc\n{"level":50,"msg":"fake"}', generate)).toBe('generated-id');
    expect(resolveRequestId('abc\r\nX', generate)).toBe('generated-id');
  });

  it('replaces one containing control or escape characters', () => {
    expect(resolveRequestId('abc\u001b[31m', generate)).toBe('generated-id');
    expect(resolveRequestId('abc\u0000', generate)).toBe('generated-id');
    expect(resolveRequestId('abc\u007f', generate)).toBe('generated-id');
  });

  it('replaces one longer than the cap — an unbounded log-growth lever', () => {
    expect(resolveRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH), generate)).toBe(
      'a'.repeat(REQUEST_ID_MAX_LENGTH),
    );
    expect(resolveRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH + 1), generate)).toBe('generated-id');
  });

  it('replaces an empty, absent, or repeated header', () => {
    expect(resolveRequestId('', generate)).toBe('generated-id');
    expect(resolveRequestId(undefined, generate)).toBe('generated-id');
    // A repeated header arrives as an array; there is no correct one to pick.
    expect(resolveRequestId(['a', 'b'], generate)).toBe('generated-id');
  });

  it('rejects whitespace and quoting that would break a log line apart', () => {
    for (const bad of ['has space', 'quote"inside', "quote'inside", 'brace{}']) {
      expect(isAcceptableRequestId(bad), `${bad} must not be accepted`).toBe(false);
    }
  });
});

describe('the OAuth handshake never reaches a log line (Story 1.2)', () => {
  const required = [
    'req.query.code',
    'req.query.state',
    '*.code_verifier',
    '*.id_token',
    '*.client_secret',
    '*.session_token',
    '*.provider_user_id',
    '*.state',
  ];

  it.each(required)('redacts %s', (path) => {
    expect(LOG_REDACT_PATHS).toContain(path);
  });

  it('covers every handshake value the spec names as never-loggable', () => {
    const joined = LOG_REDACT_PATHS.join('\n');
    for (const field of ['code', 'state', 'code_verifier', 'id_token', 'refresh_token']) {
      expect(joined, `no redaction path mentions ${field}`).toContain(field);
    }
  });

  it('deliberately does NOT blanket-redact `code`, and says why', () => {
    // A bare `*.code` would match `err.code` — SQLSTATE, errno, status class — and
    // delete the field every incident starts from. The OAuth `code` is covered by
    // the specific paths above plus sanitizeLoggedUrl. This assertion exists so the
    // omission stays a decision instead of decaying into an oversight.
    expect(LOG_REDACT_PATHS).not.toContain('*.code');
    expect(REDACTION_NOTES.bareCodeExcluded).toContain('err.code');
  });
});

describe('sanitizeLoggedUrl — the leak a redact path cannot reach', () => {
  it('drops the query string of an OAuth callback entirely', () => {
    const raw =
      '/v1/auth/google/callback?code=4/0AeanS0b-SECRET&state=abc123&scope=openid%20email';
    const sanitised = sanitizeLoggedUrl(raw);

    expect(sanitised).toBe('/v1/auth/google/callback?<redacted>');
    for (const leak of ['4/0AeanS0b-SECRET', 'abc123', 'code=', 'state=']) {
      expect(sanitised).not.toContain(leak);
    }
  });

  it('leaves a plain path untouched, so ordinary logs stay readable', () => {
    expect(sanitizeLoggedUrl('/v1/auth/me')).toBe('/v1/auth/me');
    expect(sanitizeLoggedUrl('/healthz')).toBe('/healthz');
  });

  it('marks that a query WAS present, so a missing parameter is still diagnosable', () => {
    // `/x` and `/x?<redacted>` are different facts. Collapsing them hides the case
    // where the bug is that a parameter never arrived.
    expect(sanitizeLoggedUrl('/x?')).toBe('/x?<redacted>');
    expect(sanitizeLoggedUrl('/x')).toBe('/x');
  });

  it('drops a fragment too, and survives a non-string', () => {
    expect(sanitizeLoggedUrl('/v1/auth/callback#id_token=leak')).toBe('/v1/auth/callback?<redacted>');
    expect(sanitizeLoggedUrl(undefined)).toBe('');
    expect(sanitizeLoggedUrl(42)).toBe('');
  });
});
