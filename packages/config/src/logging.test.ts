import { describe, expect, it } from 'vitest';
import {
  LOG_REDACT_PATHS,
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  isAcceptableRequestId,
  loggerBaseOptions,
  resolveRequestId,
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
    '*.access_token',
    '*.refresh_token',
    '*.provider_id',
  ];

  it.each(required)('redacts %s', (path) => {
    expect(LOG_REDACT_PATHS).toContain(path);
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
