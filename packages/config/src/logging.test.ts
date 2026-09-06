import { describe, expect, it } from 'vitest';
import {
  LOG_ALLOWED_ERROR_FIELDS,
  LOG_ALLOWED_FIELDS,
  LOG_ERROR_FIELD_CARVE_OUTS,
  LOG_NEVER_LOGGABLE_FIELDS,
  LOG_SERIALIZED_FIELDS,
} from './log-fields';
import { filterLoggedFields, serializeLoggedError } from './log-filter';
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
 * AD-15's policy, in two layers, and they are asserted separately because they now
 * mean different things.
 *
 * The ALLOW-LIST is the control. A field is written because somebody declared it;
 * everything else is absent by default, at every depth, in either vocabulary.
 *
 * The DENY-LIST is the belt. It stayed wired for one measured reason: pino stitches
 * child bindings (`req`, and `pino-http`'s `customProps`) into a line without
 * passing them through `formatters.log`, and those bindings do go through `redact`.
 * Its own rules are further down and unchanged.
 *
 * ## The rule that is deliberately absent
 *
 * `LOG_REDACT_PATHS` needs a rule demanding both spellings of every path, because a
 * deny-list naming `date_of_birth` and not `dateOfBirth` protects the wire and
 * leaks the domain object — which is what happened, twice. The allow-list needs no
 * such rule and does not have one. `dateOfBirth` is absent because it was never
 * declared, not because a pairing rule caught somebody forgetting to forbid it.
 * There is no list to keep in step, so there is nothing to check. That absence is
 * the story's result rather than a hole in its tests, and `log-fields.ts` says so
 * at the top of the file.
 */
describe('the allow-list (AD-15) — the control', () => {
  it('declares something at all, so an empty sweep cannot pass', () => {
    // Ported from the deny-list's own guard below: every "the field is absent"
    // assertion in this repository passes perfectly against an empty list and a
    // filter that writes nothing. These are what make the rest mean something.
    expect(LOG_ALLOWED_FIELDS.length).toBeGreaterThan(0);
    expect(LOG_SERIALIZED_FIELDS.length).toBe(3);
    expect(LOG_ALLOWED_ERROR_FIELDS.length).toBeGreaterThan(0);
    // And the declared names really do survive the filter, so "nothing leaked" is
    // not simply "nothing was written".
    expect(filterLoggedFields({ request_id: 'r-1' })).toEqual({ request_id: 'r-1' });
    expect(serializeLoggedError(new Error('boom'))['name']).toBe('Error');
  });

  /**
   * The inheritor of `it('covers every field the spine names as never-loggable')`.
   *
   * The deny-list version asked whether each forbidden field was PRESENT. Its
   * mirror image is the honest rule for an allow-list: none of them may have been
   * quietly declared. `LOG_NEVER_LOGGABLE_FIELDS` is an assertion oracle and
   * nothing consults it at runtime — an allow-list only has to be non-empty to
   * work, which is exactly why it replaced a list that had to be complete.
   */
  it.each([...LOG_NEVER_LOGGABLE_FIELDS])('never declares %s as a loggable field', (field) => {
    expect(LOG_ALLOWED_FIELDS).not.toContain(field);
    expect(LOG_SERIALIZED_FIELDS).not.toContain(field);
  });

  /**
   * The same oracle over the ERROR list, which had none — and that was the leak
   * this story exists to close, found in its own review.
   *
   * Adding one word to `LOG_ALLOWED_ERROR_FIELDS` left all 1150 examples green
   * while a `pg` unique violation then wrote `Key (email)=(someone@example.com)
   * already exists` to disk. It survived because `detail` is a scalar and because
   * no redaction path happened to name it: protected by accident, which is the
   * exact property an allow-list was adopted to stop relying on.
   *
   * The carve-out is subtracted EXPLICITLY rather than by pointing the oracle away
   * from the list. See `LOG_ERROR_FIELD_CARVE_OUTS`.
   */
  it.each(
    LOG_NEVER_LOGGABLE_FIELDS.filter(
      (field) => !Object.keys(LOG_ERROR_FIELD_CARVE_OUTS).includes(field),
    ),
  )('never declares %s as a loggable ERROR field', (field) => {
    expect(LOG_ALLOWED_ERROR_FIELDS).not.toContain(field);
  });

  /**
   * The exact sets. Any addition to any of the three lists is red here until
   * somebody writes it down twice.
   *
   * `expect(...).toEqual([...])` rather than `toContain`, because a membership
   * assertion is satisfied by a list that has grown. The repository already used
   * this shape once (`LOG_SERIALIZED_FIELDS.length === 3`); the review showed the
   * error list needed it more.
   */
  it('pins the exact contents of all three lists', () => {
    expect([...LOG_ALLOWED_FIELDS]).toEqual(['request_id', 'msg', 'context', 'responseTime']);
    expect([...LOG_SERIALIZED_FIELDS]).toEqual(['req', 'res', 'err']);
    expect([...LOG_ALLOWED_ERROR_FIELDS]).toEqual(['name', 'message', 'stack', 'code']);
  });

  /**
   * The carve-out, asserted from both ends so it cannot rot into an accident.
   *
   * `message` is in the never-loggable list AND in the error list, and that is one
   * word with two meanings — chat content, which the spine forbids, and a failure
   * string read off a thrown object, which a chat payload cannot reach. A
   * carve-out that is asserted is a decision; one achieved by not looking is the
   * kind of thing this story was written to remove.
   */
  it.each(Object.keys(LOG_ERROR_FIELD_CARVE_OUTS))(
    'the %s carve-out is real on both sides and says why',
    (field) => {
      // It really is forbidden in general…
      expect(LOG_NEVER_LOGGABLE_FIELDS).toContain(field);
      // …and really is declared for errors, so a stale carve-out fails here.
      expect(LOG_ALLOWED_ERROR_FIELDS).toContain(field);
      expect(
        LOG_ERROR_FIELD_CARVE_OUTS[field as keyof typeof LOG_ERROR_FIELD_CARVE_OUTS].length,
      ).toBeGreaterThan(40);
    },
  );

  it('carves out exactly one word, so the exception list cannot grow quietly', () => {
    expect(Object.keys(LOG_ERROR_FIELD_CARVE_OUTS)).toEqual(['message']);
  });

  it('names the driver fields that made the error list need an oracle', () => {
    // `detail` is the worked example from the review: one plausible addition, an
    // email on disk, every test green. It is in the oracle now, so the same
    // addition is red twice over.
    for (const field of ['detail', 'where', 'query', 'body', 'params', 'headers']) {
      expect(LOG_NEVER_LOGGABLE_FIELDS).toContain(field);
    }
  });

  it('declares msg, so the object form of a log call keeps its sentence', () => {
    // `logger.info({ msg: 'x' })` is legal pino and puts the message INSIDE the
    // filtered object. Undeclared, it produced a message-less line and no error.
    expect(LOG_ALLOWED_FIELDS).toContain('msg');
    expect(filterLoggedFields({ msg: 'x' })).toEqual({ msg: 'x' });
  });

  it('reaches both vocabularies with that rule, so it is not checking one half', () => {
    // The deny-list's pairing rule asserted its sweep touched snake_case AND
    // camelCase. The oracle above has to do the same, or it would be a rule about
    // wire spellings only — the exact shape of the hole that leaked.
    expect(LOG_NEVER_LOGGABLE_FIELDS.some((field) => field.includes('_'))).toBe(true);
    expect(LOG_NEVER_LOGGABLE_FIELDS.some((field) => /[a-z][A-Z]/.test(field))).toBe(true);
  });

  it('declares err.code explicitly, so the decision survived the change of mechanism', () => {
    // A bare `*.code` was kept OUT of the deny-list on purpose: it would have
    // deleted the SQLSTATE, the errno and the HTTP status class. Reversing the
    // mechanism could have dropped that decision by simply not mentioning it, and a
    // diagnostic field that disappears silently is one you discover mid-incident.
    expect(LOG_ALLOWED_ERROR_FIELDS).toContain('code');
    expect(REDACTION_NOTES.bareCodeExcluded).toContain('err.code');
    expect(REDACTION_NOTES.errorCodeDeclared).toContain('LOG_ALLOWED_ERROR_FIELDS');
    expect(
      serializeLoggedError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))['code'],
    ).toBe('ECONNREFUSED');
  });

  it('keeps request_id, the only join between a log line and an audit row', () => {
    // `auth.controller.ts` argues that an audit row with no request id is not an
    // audit row, and `AuditPort` refuses one. Losing the field here would leave the
    // two halves of the trail unjoinable.
    expect(LOG_ALLOWED_FIELDS).toContain('request_id');
  });

  it('is handed to callers as the functions the apps wire in, not as a copy', () => {
    const base = loggerBaseOptions({ level: 'info', service: 'api', version: '0.1.0' });

    expect(base.allowedFields).toEqual(LOG_ALLOWED_FIELDS);
    expect(base.logFormatter).toBe(filterLoggedFields);
    expect(base.errorSerializer).toBe(serializeLoggedError);
  });
});

/**
 * The BELT, asserted as carefully as before precisely because it is no longer the
 * control.
 *
 * A belt nobody checks is a belt that quietly stops fastening, and this one still
 * covers ground the allow-list cannot: pino's `asChindings` replaces a child's
 * bindings formatter with an identity function, so `req` and `pino-http`'s
 * `customProps` never pass through `formatters.log` — but they do pass through
 * `redact`. Removing it entirely is a human decision, recorded in
 * `deferred-work.md` rather than taken here.
 */
describe('LOG_REDACT_PATHS (AD-15) — the belt behind the allow-list', () => {
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

    /**
     * A path split into "everything before the last dot" and "the field name".
     *
     * The `cut === -1` guard is not decoration. Every one of the fifty paths in the
     * list happens to contain a dot today, so a top-level path — `email`, say, added
     * by somebody redacting a root field — is currently unreachable. It would not
     * stay unreachable, and the unguarded version answers `{prefix: 'emai', field:
     * 'l'}` for it: `slice(0, -1)` drops the last character and `slice(0)` returns
     * the whole string. That is a FALSE RED — a sibling assertion about a field
     * called `l` — which is the worst kind, because the failure names nothing that
     * is actually wrong.
     */
    const split = (path: string): { prefix: string; field: string } => {
      const cut = path.lastIndexOf('.');
      return cut === -1
        ? { prefix: '', field: path }
        : { prefix: path.slice(0, cut), field: path.slice(cut + 1) };
    };
    /** `a.b` for a nested path, and a bare `b` for a top-level one. */
    const rejoin = (prefix: string, field: string): string =>
      prefix.length === 0 ? field : `${prefix}.${field}`;
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

    it('splits a path with no dot in it without inventing a field name', () => {
      // The trap this guard removes, exercised directly because no path in the list
      // reaches it yet. Unguarded, `split('email')` answers `{prefix: 'emai', field:
      // 'l'}` and the sibling rule below then demands a path called `emai.l` — a red
      // that names nothing real, on the day somebody adds a top-level redaction.
      expect(split('email')).toEqual({ prefix: '', field: 'email' });
      expect(rejoin('', 'email')).toBe('email');
      expect(split('req.body.email')).toEqual({ prefix: 'req.body', field: 'email' });
      expect(rejoin('req.body', 'email')).toBe('req.body.email');
    });

    it.each(fieldPaths.filter((path) => split(path).field.includes('_')))(
      '%s has a camelCase sibling',
      (path) => {
        const { prefix, field } = split(path);
        expect(LOG_REDACT_PATHS).toContain(rejoin(prefix, toCamel(field)));
      },
    );

    it.each(fieldPaths.filter((path) => /[a-z][A-Z]/.test(split(path).field)))(
      '%s has a snake_case sibling',
      (path) => {
        const { prefix, field } = split(path);
        expect(LOG_REDACT_PATHS).toContain(rejoin(prefix, toSnake(field)));
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
