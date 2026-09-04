import { describe, expect, it } from 'vitest';
import { auditEventSchema, toAuditWireTimestamp } from './audit';
import {
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_ME_PATH,
  AUTH_REFRESH_PATH,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_PATHNAME,
  MAX_SIGN_IN_RETRY_AFTER_SECONDS,
  MAX_SIGN_IN_RETURN_PATH_LENGTH,
  RATE_LIMITED_MESSAGE,
  MIN_SIGN_IN_RETRY_AFTER_SECONDS,
  SIGN_IN_OUTCOMES,
  SIGN_IN_RETURN_PATH_QUERY_PARAM,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  isSignInOutcome,
  parseSignInRetryAfterSeconds,
  signInOutcomeSchema,
} from './auth';
import {
  DETAIL_VALUE_MAX_LENGTH,
  RESERVED_DETAIL_KEYS,
  errorEnvelopeSchema,
  makeError,
} from './error';
import { healthResponseSchema } from './health';
import { toOpenApiDocument } from './openapi';

describe('error envelope', () => {
  it('accepts the one shape the whole system is allowed to emit', () => {
    expect(errorEnvelopeSchema.parse(makeError('rate_limited', 'Thử lại sau ít giây.'))).toEqual({
      error: { code: 'rate_limited', message: 'Thử lại sau ít giây.' },
    });
  });

  it('rejects an unknown code, so a provider error cannot be forwarded verbatim', () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: 'oauth_provider_500', message: 'boom' } }),
    ).toThrow();
  });
});

describe('error details — the constraints that actually hold', () => {
  const withDetails = (details: unknown) => ({
    error: { code: 'internal_error', message: 'x', details },
  });

  it('rejects a stack trace passed as a PLAIN STRING, not just as a nested object', () => {
    // The original version of this test only nested an object under `stack`, so it
    // passed because `details` refuses objects — not because it refuses stack
    // traces. A plain string is the shape a real leak takes.
    const result = errorEnvelopeSchema.safeParse(
      withDetails({ stack: 'Error: boom\n    at handler (/srv/app/dist/main.js:41:7)' }),
    );
    expect(result.success).toBe(false);
  });

  it.each(RESERVED_DETAIL_KEYS)('rejects the reserved diagnostic key %s', (key) => {
    expect(errorEnvelopeSchema.safeParse(withDetails({ [key]: 'anything' })).success).toBe(false);
  });

  it('rejects a multi-line value under ANY key — no stack trace fits on one line', () => {
    expect(
      errorEnvelopeSchema.safeParse(withDetails({ note: 'line one\n    at line two' })).success,
    ).toBe(false);
  });

  it('rejects a value longer than the cap', () => {
    expect(
      errorEnvelopeSchema.safeParse(withDetails({ note: 'z'.repeat(DETAIL_VALUE_MAX_LENGTH + 1) }))
        .success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse(withDetails({ note: 'z'.repeat(DETAIL_VALUE_MAX_LENGTH) }))
        .success,
    ).toBe(true);
  });

  it('rejects a nested object', () => {
    expect(errorEnvelopeSchema.safeParse(withDetails({ meta: { deep: true } })).success).toBe(false);
  });

  it('still allows the short scalars a client genuinely needs', () => {
    expect(
      errorEnvelopeSchema.parse(withDetails({ retry_after_seconds: 30, field: 'date_of_birth' })),
    ).toBeTruthy();
  });
});

describe('health response', () => {
  it('accepts both services and nothing else', () => {
    for (const service of ['api', 'realtime-gateway'] as const) {
      expect(healthResponseSchema.parse({ status: 'ok', service, version: '0.1.0' })).toEqual({
        status: 'ok',
        service,
        version: '0.1.0',
      });
    }
    expect(() =>
      healthResponseSchema.parse({ status: 'ok', service: 'web', version: '0.1.0' }),
    ).toThrow();
  });
});

describe('audit event', () => {
  const row = {
    id: '019200f0-0000-7000-8000-000000000000',
    source_service: 'api',
    action: 'auth.signed_in',
    actor_user_id: null,
    subject_id: null,
    request_id: 'req-1',
    occurred_at: '2026-08-21T00:00:00.000Z',
    metadata: {},
  };

  it('validates a row that has been through JSON', () => {
    // The point of the fix: a row serialised and re-parsed must still validate.
    // With `z.date()` this threw, which meant the "runtime validated" claim in the
    // spec was false for every row that crossed the process boundary.
    expect(auditEventSchema.parse(JSON.parse(JSON.stringify(row)))).toBeTruthy();
  });

  it('accepts the ISO string produced by toAuditWireTimestamp', () => {
    const at = new Date('2026-08-21T09:30:00.000Z');
    expect(
      auditEventSchema.parse({ ...row, occurred_at: toAuditWireTimestamp(at) }).occurred_at,
    ).toBe('2026-08-21T09:30:00.000Z');
  });

  it('rejects a bare Date instance — the wire type is a string', () => {
    expect(auditEventSchema.safeParse({ ...row, occurred_at: new Date() }).success).toBe(false);
  });

  it('rejects a timestamp with no zone, because "UTC" must be stated not assumed', () => {
    expect(auditEventSchema.safeParse({ ...row, occurred_at: '2026-08-21 00:00:00' }).success).toBe(
      false,
    );
  });

  it('requires a request id so a row is traceable across both processes', () => {
    const { request_id, ...withoutRequestId } = row;
    void request_id;
    expect(auditEventSchema.safeParse(withoutRequestId).success).toBe(false);
  });
});

describe('OpenAPI emission (AD-13)', () => {
  const doc = toOpenApiDocument() as {
    openapi: string;
    components: { schemas: Record<string, unknown> };
    paths: Record<string, unknown>;
  };

  it('emits a document', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths['/healthz']).toBeTruthy();
  });

  // Membership, deliberately not an exact-set assertion. The previous version
  // asserted the component list was exactly ['ErrorEnvelope','HealthResponse'],
  // which turned the missing audit schema from a bug into a documented fixture —
  // adding the schema would have failed the test that was supposed to protect it.
  it.each(['ErrorEnvelope', 'HealthResponse', 'AuditEvent', 'SignInOutcome'])(
    'publishes %s',
    (name) => {
      expect(Object.keys(doc.components.schemas)).toContain(name);
    },
  );

  it('documents both callback methods, because both share one outcome path', () => {
    const callback = doc.paths['/v1/auth/{provider}/callback'] as Record<string, unknown>;
    // Apple REQUIRES `response_mode=form_post` once the scope asks for `name` or
    // `email`, so the POST is the normal case for one of the four providers. A
    // document with only `get:` tells an integrator it is unsupported.
    expect(Object.keys(callback).sort()).toEqual(['get', 'post']);
  });

  /**
   * The return path parameter is documented on EXACTLY one leg, and the document
   * is the only place an integrator can learn that.
   *
   * Deleting the whole `parameters` block from `/start` used to leave every gate
   * green: nothing read the emitted document for this endpoint, so the one thing
   * `openapi.ts` exists to publish was unpinned. The `/callback` half is the more
   * important of the two — a client that passed `quay-ve` there would find it
   * silently ignored, and "silently ignored" is what the whole signed-state design
   * depends on staying true.
   */
  describe('the return path parameter', () => {
    const parametersOf = (path: string, method: 'get' | 'post') => {
      const operation = (doc.paths[path] as Record<string, unknown>)[method] as {
        parameters?: ReadonlyArray<{ name: string; in: string; schema?: { maxLength?: number } }>;
      };
      return operation.parameters ?? [];
    };

    it('is offered on /start, as a query parameter, under the contract name', () => {
      const parameter = parametersOf('/v1/auth/{provider}/start', 'get').find(
        (candidate) => candidate.name === SIGN_IN_RETURN_PATH_QUERY_PARAM,
      );

      expect(parameter).toBeDefined();
      expect(parameter?.in).toBe('query');
      // The ceiling travels with it: a client that truncates at its own guess is a
      // client whose long paths vanish without explanation.
      expect(parameter?.schema?.maxLength).toBe(MAX_SIGN_IN_RETURN_PATH_LENGTH);
    });

    it.each([
      ['get' as const],
      ['post' as const],
    ])('is NOT offered on the %s callback, on either method', (method) => {
      const named = parametersOf('/v1/auth/{provider}/callback', method).map(
        (parameter) => parameter.name,
      );

      expect(named).not.toContain(SIGN_IN_RETURN_PATH_QUERY_PARAM);
    });
  });

  /**
   * The Story 1.4 endpoint, read out of the document that is emitted.
   *
   * Nothing looked at `doc.paths[AUTH_DATE_OF_BIRTH_PATH]` at all, so deleting the
   * registration line, or documenting a `422` the service never answers, left
   * every gate green. That failure has happened here once already — the comment
   * above the return-path block records it about `/start`'s `parameters` — which
   * is why the same shape is applied rather than a note about being careful.
   */
  describe('the date-of-birth endpoint as published', () => {
    const operation = () =>
      (doc.paths[AUTH_DATE_OF_BIRTH_PATH] as Record<string, unknown>).post as {
        responses: Record<string, unknown>;
        requestBody?: { required?: boolean; content: Record<string, { schema: unknown }> };
        description?: string;
      };

    it('is registered, and only as a POST', () => {
      // There is deliberately no PATCH or PUT: the value is written once and
      // changing it goes through support, so a route that could update one must
      // not exist for an integrator to find — or to build a settings screen on.
      expect(Object.keys(doc.paths[AUTH_DATE_OF_BIRTH_PATH] as object)).toEqual(['post']);
    });

    it('documents exactly the statuses the service answers with', () => {
      // Not a superset and not a subset: an undocumented `429` leaves a client with
      // no reason to read `Retry-After`, and a documented `422` sends one looking
      // for a branch that does not exist.
      expect(Object.keys(operation().responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '409',
        '429',
      ]);
    });

    it('requires a body carrying the contract field name and its format', () => {
      const schema = operation().requestBody?.content['application/json']?.schema as {
        required: string[];
        properties: Record<string, { pattern?: string }>;
      };

      expect(operation().requestBody?.required).toBe(true);
      expect(schema.required).toEqual([DATE_OF_BIRTH_FIELD]);
      expect(schema.properties[DATE_OF_BIRTH_FIELD]?.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    });

    it('publishes the web route behind this endpoint, as its docblock promises', () => {
      // `DATE_OF_BIRTH_PATHNAME`'s docblock says `apps/api` "publishes it in the
      // OpenAPI description of the endpoint behind it". That was a description of
      // behaviour that did not exist: nothing in `openapi.ts` referred to the
      // constant. This is the assertion that keeps the sentence true.
      expect(operation().description).toContain(DATE_OF_BIRTH_PATHNAME);
    });
  });

  /**
   * `429` was absent from the WHOLE document while every route but `logout`
   * carried `@RateLimited(...)`.
   *
   * A client reading a document with no `429` in it has no reason to look at
   * `Retry-After` and every reason to retry at once — which is the loop the limit
   * exists to break. The browser legs are the deliberate exception: their refusal
   * is a `303` back to the login page, so a `429` there would describe an answer
   * they never give.
   */
  describe('a rate-limited answer is documented wherever it can happen', () => {
    // The CONSTANTS, not copies of their values. Two of these were still written
    // out here while `AUTH_REFRESH_PATH` already existed and `AUTH_ME_PATH` was the
    // last `/v1/auth` route with no constant at all — so a rename would have left
    // this suite asserting the documentation of a path the document no longer has,
    // which is a green `it.each` over nothing rather than a failure.
    it.each([[AUTH_REFRESH_PATH], [AUTH_ME_PATH], [AUTH_DATE_OF_BIRTH_PATH]])(
      '%s documents 429',
      (path) => {
        const operations = doc.paths[path] as Record<string, { responses: Record<string, unknown> }>;
        // A path that is not in the document at all would make the loop below run
        // zero times and pass. This is what says the route is documented before the
        // assertion about HOW it is documented.
        expect(Object.keys(operations ?? {}).length).toBeGreaterThan(0);
        for (const operation of Object.values(operations)) {
          expect(Object.keys(operation.responses)).toContain('429');
        }
      },
    );

    /**
     * A prose sentence is for a person; a `headers` block is for a code generator.
     *
     * The description said `Retry-After` exists and nothing machine-readable did, so
     * a generated client saw a `429` with no header on it — which leaves it in
     * exactly the position the whole 429 documentation exists to fix.
     */
    it.each([[AUTH_REFRESH_PATH], [AUTH_ME_PATH], [AUTH_DATE_OF_BIRTH_PATH]])(
      '%s declares Retry-After as a header, not only in prose',
      (path) => {
        const operations = doc.paths[path] as Record<
          string,
          { responses: Record<string, { headers?: Record<string, unknown> }> }
        >;
        for (const operation of Object.values(operations)) {
          const headers = operation.responses['429']?.headers;
          expect(Object.keys(headers ?? {})).toContain('Retry-After');
        }
      },
    );

    it('documents the browser legs redirecting instead, never answering 429', () => {
      const start = (doc.paths['/v1/auth/{provider}/start'] as Record<string, {
        responses: Record<string, unknown>;
      }>).get;

      expect(Object.keys(start.responses)).toContain('303');
      expect(Object.keys(start.responses)).not.toContain('429');
    });

    /**
     * BOTH callback legs, which the previous version of this suite never read.
     *
     * `/callback` carries `@RateLimited('auth_callback')` on the same browser channel
     * as `/start`, so its refusal is the same `303` — and the document said nothing
     * about that on either the `get` or the `post`. An integrator reading only the
     * callback had no way to learn the limit applies there at all, and the gap was
     * invisible because the only assertion in this block read `/start`.
     */
    it.each([['get'], ['post']])(
      'documents the callback %s as redirecting when it is refused, on both methods',
      (method) => {
        const leg = (doc.paths['/v1/auth/{provider}/callback'] as Record<string, {
          responses: Record<string, { description?: string }>;
        }>)[method];

        expect(Object.keys(leg.responses)).toContain('303');
        expect(Object.keys(leg.responses)).not.toContain('429');
        // And the 303 says the rate limit is one of the ways it happens, or the
        // status alone reads as "the login failed" and nothing more.
        expect(leg.responses['303']?.description?.toLowerCase()).toContain('rate-limited');
      },
    );

    it('leaves logout alone, because logout is not limited', () => {
      // Limiting sign-out keeps somebody inside a session they are trying to leave.
      // There is no `RateLimitAction` for it, so there is nothing to document.
      const logout = (doc.paths['/v1/auth/logout'] as Record<string, {
        responses: Record<string, unknown>;
      }>).post;

      expect(Object.keys(logout.responses)).toEqual(['204']);
    });
  });

  it('emits the audit timestamp as a JSON string, not an unrepresentable Date', () => {
    const audit = doc.components.schemas['AuditEvent'] as {
      properties: { occurred_at: { type: string; format?: string } };
    };
    expect(audit.properties.occurred_at.type).toBe('string');
    expect(audit.properties.occurred_at.format).toBe('date-time');
  });
});

/**
 * The closed enum is not a convenience — it is the control that stops a value
 * from a URL reaching the screen. `apps/web` matches against this list and then
 * renders a string of its OWN; if the list ever accepted arbitrary input, the
 * login page would be reflecting attacker-controlled text. So it gets tests of its
 * own rather than only being used.
 */
describe('sign-in outcome codes', () => {
  it('is exactly the three codes the login page knows how to render', () => {
    expect([...SIGN_IN_OUTCOMES]).toEqual(['that-bai', 'da-huy', 'bi-khoa']);
  });

  it('names the query parameter in one place, so both processes agree', () => {
    expect(SIGN_IN_OUTCOME_QUERY_PARAM).toBe('ket-qua');
  });

  it.each([...SIGN_IN_OUTCOMES])('accepts %s', (code) => {
    expect(signInOutcomeSchema.parse(code)).toBe(code);
    expect(isSignInOutcome(code)).toBe(true);
  });

  /**
   * Every one of these is a value somebody can put in a link and send to another
   * person. None of them may become a message on the page.
   */
  it.each([
    ['a made-up code', 'khong-co-that'],
    ['a script tag', '<script>alert(1)</script>'],
    ['an encoded script tag', '%3Cscript%3Ealert(1)%3C/script%3E'],
    ['an empty string', ''],
    ['a near miss', 'that-bai '],
    ['different casing', 'That-Bai'],
  ])('rejects %s', (_label, value) => {
    expect(isSignInOutcome(value)).toBe(false);
    expect(signInOutcomeSchema.safeParse(value).success).toBe(false);
  });

  it.each([null, undefined, 42, {}, ['that-bai']])('rejects the non-string %s', (value) => {
    expect(isSignInOutcome(value)).toBe(false);
  });

  /**
   * The internal audit vocabulary of `apps/api` (`SIGN_IN_FAILURE_REASONS`) must
   * not be sayable here. If one of these ever became a valid public code, the
   * many-to-few collapse in `auth.service.ts` would have been quietly undone and
   * the URL would start naming which part of the system is broken.
   *
   * ## This list is hand-copied, and that is a known compromise
   *
   * `audit.ts` made `SIGN_IN_FAILURE_REASONS` a runtime array precisely so tests
   * would stop copying it — but AD-13 forbids `packages/contracts` from importing
   * `apps/api` (`ad13-contracts-stay-standalone` fails the build for it), and
   * inverting the dependency by moving the internal vocabulary into the contract
   * package would publish it, which is the exact thing this test protects.
   *
   * So: a reason added to `apps/api` will NOT appear here on its own. The
   * deferred AC3 rate-limit work is the next thing that will add some — something
   * like `rate_limited` or `login_locked` — and they will be missing from this
   * block on the day they land.
   *
   * That is affordable because this is the secondary check. The assertion with
   * teeth walks the real array and runs against real HTTP responses:
   * `apps/api/src/auth/auth.flow.test.ts`, in `expectOutcomeRedirect`, where
   * every failure and cancellation call site asserts that no value of
   * `SIGN_IN_FAILURE_REASONS` reaches the redirect URL. What is pinned HERE is
   * the narrower, permanent claim: the public enum is closed, and these
   * particular internal words are outside it.
   */
  it.each([
    'provider_start_failed',
    'provider_authorize_failed',
    'user_cancelled',
    'state_missing',
    'state_mismatch',
    'state_expired',
    'code_missing',
    'provider_exchange_failed',
    'identity_rejected',
    'refresh_cookie_missing',
    'refresh_token_unknown',
    'refresh_token_expired',
    'session_revoked',
    'session_reuse_detected',
  ])('refuses the internal reason %s', (reason) => {
    expect(isSignInOutcome(reason)).toBe(false);
  });
});

/**
 * The countdown that rides beside `bi-khoa`.
 *
 * It is declared here, once, because BOTH processes read it: `apps/api` decides
 * the value is worth putting in a redirect, `apps/web` decides it is worth
 * rendering. Two parsers would eventually disagree about what `?giay=1e3` means,
 * and the half that was more generous would be the one on the screen.
 */
describe('the sign-in retry countdown', () => {
  it('names the query parameter in one place, so both processes agree', () => {
    expect(SIGN_IN_RETRY_AFTER_QUERY_PARAM).toBe('giay');
  });

  it.each(['1', '30', '900', '86400'])('accepts %s', (raw) => {
    expect(parseSignInRetryAfterSeconds(raw)).toBe(Number(raw));
  });

  it.each([
    ['not a number', 'abc'],
    ['negative', '-5'],
    ['zero, which invites an instant retry', '0'],
    ['absurdly large', '99999999'],
    ['empty', ''],
    ['fractional', '1.5'],
    ['padded', ' 12 '],
    ['hexadecimal', '0x10'],
    ['exponential', '1e3'],
    ['a script payload', '<script>'],
    ['a plus sign', '+30'],
  ])('rejects %s', (_label, raw) => {
    // `Number()` accepts most of these, which is exactly why the check is a
    // regex plus a range rather than a cast: each one is somebody probing, not a
    // countdown this product wrote.
    expect(parseSignInRetryAfterSeconds(raw)).toBeNull();
  });

  it.each([null, undefined, {}, [], true])('rejects the non-string %s', (raw) => {
    expect(parseSignInRetryAfterSeconds(raw)).toBeNull();
  });

  it('holds the band the page is willing to show', () => {
    // The floor stops a finished countdown being rendered; the ceiling stops
    // "thử lại sau 1157 ngày" appearing for somebody who is not locked out.
    expect(parseSignInRetryAfterSeconds(MIN_SIGN_IN_RETRY_AFTER_SECONDS)).toBe(
      MIN_SIGN_IN_RETRY_AFTER_SECONDS,
    );
    expect(parseSignInRetryAfterSeconds(MAX_SIGN_IN_RETRY_AFTER_SECONDS)).toBe(
      MAX_SIGN_IN_RETRY_AFTER_SECONDS,
    );
    expect(parseSignInRetryAfterSeconds(MIN_SIGN_IN_RETRY_AFTER_SECONDS - 1)).toBeNull();
    expect(parseSignInRetryAfterSeconds(MAX_SIGN_IN_RETRY_AFTER_SECONDS + 1)).toBeNull();
  });
});

/**
 * What the rate-limited sentence may contain, decided ONCE, beside the constant.
 *
 * Three files used to keep their own blacklists — `rate-limit.flow.test.ts`,
 * `rate-limited.filter.test.ts` and the web notice test — all checking this same
 * frozen string, and all diverging. A word added to one left the other two blind,
 * which is the failure mode a shared constant exists to prevent. Those three now
 * assert equality with `RATE_LIMITED_MESSAGE`; the rules about the string itself
 * live here.
 */
describe('the rate-limited sentence leaks nothing a prober could calibrate on', () => {
  const sentence = RATE_LIMITED_MESSAGE.toLowerCase();

  it.each([
    ['the dimension, in English', 'ip'],
    ['the dimension, in Vietnamese', 'địa chỉ'],
    ['the account', 'tài khoản'],
    ['the mechanism', 'brute'],
    ['the store', 'valkey'],
    ['the layer', 'rate limit'],
    ['a key prefix', 'rl:'],
    ['a rate', 'lần/'],
  ])('does not name %s', (_label, leak) => {
    expect(sentence).not.toContain(leak);
  });

  it('contains no number at all', () => {
    // A threshold in the message says exactly how slowly to go. The only number a
    // person is given is how long to wait, and it travels separately — as
    // `Retry-After` and as `?giay=`.
    expect(sentence).not.toMatch(/\d/);
  });

  it('says what happened and what to do next', () => {
    // The other half of the acceptance criterion: not leaking is not enough if the
    // person is left with nothing actionable.
    expect(RATE_LIMITED_MESSAGE.length).toBeGreaterThan(20);
    expect(sentence).toContain('thử lại');
  });
});
