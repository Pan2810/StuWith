import { describe, expect, it } from 'vitest';
import {
  LOG_ALLOWED_ERROR_FIELDS,
  LOG_ALLOWED_FIELDS,
  LOG_ERROR_CAUSE_DEPTH_LIMIT,
  LOG_ERROR_MESSAGE_MAX_LENGTH,
  LOG_ERROR_STACK_FRAME_LIMIT,
  LOG_ERROR_STACK_MAX_LENGTH,
  LOG_MAX_ARRAY_LENGTH,
  LOG_MAX_DEPTH,
  LOG_SERIALIZED_FIELDS,
} from './log-fields';
import { filterLoggedFields, loggedScalar, serializeLoggedError } from './log-filter';

/**
 * The allow-list as a pure function, with no logger in front of it.
 *
 * The two claims are separate and both are needed. THIS file proves the policy is
 * right; `apps/api/src/logging.test.ts` and `apps/realtime-gateway/src/logging.test.ts`
 * prove each process actually hands it to pino. Someone can write a perfect filter
 * and leak everything by deleting `formatters` from an app's options, and someone
 * can wire it perfectly and leak everything because the filter copies too much.
 *
 * Being pure is what makes it affordable to cover every shape in the spec's matrix
 * rather than three of them: no server, no port, no stream.
 */

/** A never-loggable value, spelled distinctively so a substring match cannot lie. */
const LEAK = 'pii-leak-marker-4f2';

describe('the sweep has something to sweep, so an empty pass is impossible', () => {
  /**
   * The same guard `logging.test.ts` put in front of its deny-list walk and
   * `config-cast-ban.test.ts` puts in front of its file walk. Every "the field is
   * absent" assertion below passes perfectly against a filter that returns `{}`
   * for everything, and against an allow-list that is accidentally empty.
   */
  it('has fields declared at all', () => {
    expect(LOG_ALLOWED_FIELDS.length).toBeGreaterThan(0);
    expect(LOG_SERIALIZED_FIELDS.length).toBe(3);
    expect(LOG_ALLOWED_ERROR_FIELDS.length).toBeGreaterThan(0);
  });

  it('lets a declared field through, so the filter is not simply deleting everything', () => {
    expect(filterLoggedFields({ request_id: 'r-1' })).toEqual({ request_id: 'r-1' });
  });
});

describe('a field nobody declared is not written', () => {
  it('drops a bare undeclared field and keeps the declared one beside it', () => {
    expect(filterLoggedFields({ request_id: 'r-1', email: LEAK })).toEqual({ request_id: 'r-1' });
  });

  /**
   * AC4, as an executable claim rather than an argument.
   *
   * `national_id` is a field nobody has ever thought about. Nothing in this
   * repository mentions it, no list forbids it, and it is absent — because the
   * mechanism's default is absence. This is the one example that a deny-list
   * cannot pass no matter how carefully it is maintained.
   */
  it('drops a field invented today, with no edit to any list', () => {
    const filtered = filterLoggedFields({ national_id: LEAK, request_id: 'r-1' });

    expect(filtered).toEqual({ request_id: 'r-1' });
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
  });

  /**
   * The pairing bug, gone structurally.
   *
   * The deny-list leaked twice because every field exists in two vocabularies and
   * a list naming one spelling protects one of them. Both spellings are absent
   * here for the same reason and it is not "because both were listed" — neither is
   * listed anywhere. There is nothing to keep in step.
   */
  it.each([
    ['date_of_birth'],
    ['dateOfBirth'],
    ['access_token'],
    ['accessToken'],
    ['provider_id'],
    ['providerId'],
    ['id_token'],
    ['idToken'],
  ])('drops %s because it was never declared, not because it was forbidden', (field) => {
    const filtered = filterLoggedFields({ [field]: LEAK });

    expect(filtered).toEqual({});
    expect(LOG_ALLOWED_FIELDS).not.toContain(field);
  });

  it('keeps the record itself — a PII filter must not become an outage', () => {
    // Dropping the whole line when an undeclared field turns up would silence the
    // log the first time somebody wrote `logger.info({ user })`, which is a worse
    // failure than the one being prevented. The object survives; only the field
    // does not.
    expect(filterLoggedFields({ email: LEAK })).toEqual({});
  });
});

describe('depth does not buy anything', () => {
  it('drops a whole domain object handed over in one go', () => {
    // `logger.info({ user })` with a real `User`. The deny-list version of this
    // needed a path per field per spelling; here the key `user` was never
    // declared, so nothing under it can be reached at all.
    const filtered = filterLoggedFields({
      user: { id: 'u-1', email: LEAK, dateOfBirth: '1993-07-19' },
    });

    expect(filtered).toEqual({});
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
    expect(JSON.stringify(filtered)).not.toContain('1993');
  });

  it('drops a value two levels down, which the deny-list wildcard could not reach', () => {
    // `RecordDateOfBirthResult` is `{ ok: true, user: User }`. pino's `*` matches
    // exactly one level, so the deny-list needed a hand-written `*.user.dateOfBirth`
    // for this ONE shape and had nothing for the next one.
    const filtered = filterLoggedFields({ outcome: { ok: true, user: { email: LEAK } } });

    expect(filtered).toEqual({});
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
  });

  it('filters INSIDE a declared field too, at every level', () => {
    // A declared name does not make its contents declared. The rule is the same
    // rule at every depth: a key survives only if its own name was declared.
    const filtered = filterLoggedFields({
      context: { context: 'Auth', email: LEAK, nested: { context: 'deep', email: LEAK } },
    });

    expect(filtered).toEqual({ context: { context: 'Auth' } });
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
  });

  it('filters through an array rather than trusting its elements', () => {
    const filtered = filterLoggedFields({
      context: [{ context: 'a', email: LEAK }, { email: LEAK }, 'plain'],
    });

    expect(filtered).toEqual({ context: [{ context: 'a' }, {}, 'plain'] });
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
  });

  it('refuses to walk a class instance, however innocent its key', () => {
    /**
     * Recursing into a class instance reads getters and inherited properties, and
     * the class instances that reach a logger — a request, a response, a pool, an
     * error — are exactly the ones holding a whole request's worth of data. So a
     * non-plain object under a declared key is dropped rather than explored.
     */
    class Caller {
      readonly email = LEAK;
      get context(): string {
        return 'looks harmless';
      }
    }

    const filtered = filterLoggedFields({ context: new Caller() });

    expect(filtered).toEqual({});
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
  });

  it('keeps null and drops undefined, so an absent field is absent rather than null', () => {
    expect(filterLoggedFields({ request_id: null, context: undefined })).toEqual({
      request_id: null,
    });
  });
});

describe('the three serializer-owned keys', () => {
  it('hands req, res and err through untouched at the root', () => {
    // At the moment `formatters.log` runs, `err` is still a live Error and `res` a
    // live ServerResponse; pino applies the serializers immediately afterwards, and
    // those serializers ARE the allow-list for those keys. Filtering here as well
    // would either delete them or walk a class instance.
    const error = new Error('boom');
    const filtered = filterLoggedFields({ err: error, res: { statusCode: 200 }, req: { id: 'r' } });

    expect(filtered['err']).toBe(error);
    expect(filtered['res']).toEqual({ statusCode: 200 });
    expect(filtered['req']).toEqual({ id: 'r' });
  });

  it('does NOT hand them through below the root, where no serializer runs', () => {
    // pino applies serializers to top-level keys only. A nested `err` passed
    // through would reach the output with nothing in front of it — which is the
    // hole this story exists to close, reintroduced one level down.
    const filtered = filterLoggedFields({
      context: { err: Object.assign(new Error('boom'), { token: LEAK }) },
    });

    expect(filtered).toEqual({ context: {} });
    expect(JSON.stringify(filtered)).not.toContain(LEAK);
  });
});

describe('the err serializer — the route that was actually open', () => {
  it('drops a custom property and keeps the declared ones', () => {
    const error = Object.assign(new Error('boom'), { token: LEAK, user: { email: LEAK } });

    const serialised = serializeLoggedError(error);

    expect(serialised['token']).toBeUndefined();
    expect(serialised['user']).toBeUndefined();
    expect(JSON.stringify(serialised)).not.toContain(LEAK);
    expect(serialised['name']).toBe('Error');
    expect(serialised['message']).toBe('boom');
    expect(typeof serialised['stack']).toBe('string');
  });

  it('keeps err.code, the field every incident starts from', () => {
    // `REDACTION_NOTES.bareCodeExcluded` recorded why a bare `*.code` was left out
    // of the deny-list. Turning the mechanism round could have deleted the field
    // silently, so it is declared explicitly and asserted here.
    expect(serializeLoggedError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))['code']).toBe(
      'ECONNREFUSED',
    );
    // A numeric SQLSTATE-ish or errno code is just as much a code.
    expect(serializeLoggedError(Object.assign(new Error('x'), { code: 23505 }))['code']).toBe(23505);
  });

  it('drops a code that is an object, so a payload cannot ride in on a scalar name', () => {
    const serialised = serializeLoggedError(
      Object.assign(new Error('x'), { code: { sqlstate: '23505', email: LEAK } }),
    );

    expect(serialised['code']).toBeUndefined();
    expect(JSON.stringify(serialised)).not.toContain(LEAK);
  });

  it('caps the stack, because a stack is the cheapest thing to make enormous', () => {
    const frames = Array.from({ length: 40 }, (_, index) => `    at frame${index} (a.ts:${index}:1)`);
    const error = new Error('deep');
    error.stack = ['Error: deep', ...frames].join('\n');

    const stack = String(serializeLoggedError(error)['stack']);

    expect(stack.split('\n').filter((line) => line.trimStart().startsWith('at '))).toHaveLength(
      LOG_ERROR_STACK_FRAME_LIMIT,
    );
    // The header survives the cap: it is where `name: message` lives, and where
    // `diagnosableWithoutTheData` puts the bare name it substitutes for a driver's
    // message.
    expect(stack.startsWith('Error: deep')).toBe(true);
  });

  it('leaves a message-free stack alone, so diagnosableWithoutTheData still works', () => {
    // `rate-limit-health.ts` builds a stack of `name` + frames precisely so a
    // driver's message — which carries the rate-limit key — never reaches a log
    // line. That shape must survive this serializer unchanged in substance.
    const error = new Error('rate limiting is not working');
    error.stack = ['ValkeyError', '    at hit (rate-limit.ts:1:1)'].join('\n');

    expect(serializeLoggedError(error)['stack']).toBe(
      'ValkeyError\n    at hit (rate-limit.ts:1:1)',
    );
  });

  it('says something useful about a thrown non-object without writing its value', () => {
    // `throw 'super-secret'` has no message to separate from anything, and the
    // value itself is exactly what might be a token.
    expect(serializeLoggedError(LEAK)).toEqual({ name: 'non-error thrown: string' });
    expect(serializeLoggedError(null)).toEqual({ name: 'non-error thrown: object' });
    expect(JSON.stringify(serializeLoggedError(LEAK))).not.toContain(LEAK);
  });

  it('never enumerates, so a subclass adding fields adds nothing to the log', () => {
    // The rule is "read these four names", not "copy everything except". A rule of
    // the second kind is the deny-list this story removed.
    class TokenError extends Error {
      override readonly name = 'TokenError';
      readonly accessToken = LEAK;
      readonly refreshToken = LEAK;
    }

    const serialised = serializeLoggedError(new TokenError('nope'));

    expect(Object.keys(serialised).sort()).toEqual(['message', 'name', 'stack']);
    expect(JSON.stringify(serialised)).not.toContain(LEAK);
  });
});


/**
 * Everything in this block runs inside `formatters.log`, on the request path,
 * before pino's own cycle-safe stringifier.
 *
 * That ordering is the hazard. pino tolerates a circular object; a filter placed
 * in front of it does not, unless it is written to — so the naive version of this
 * file reintroduced, one layer earlier, the exact failure pino had already solved.
 * A `RangeError` out of the middle of a log call is a 500 on a request that was
 * otherwise fine.
 */
describe('nothing a caller can build makes the filter unbounded', () => {
  it('survives a value that contains itself', () => {
    const cyclic: Record<string, unknown> = { context: 'root' };
    cyclic['context'] = cyclic;

    expect(() => filterLoggedFields({ context: cyclic })).not.toThrow();
    // The object is still written; only the branch that loops back is dropped. A
    // marker string would be a value nobody declared, written into a log line by
    // the thing whose whole job is to stop that.
    expect(filterLoggedFields({ context: cyclic })).toEqual({ context: {} });
  });

  it('keeps the declared siblings of a cyclic branch', () => {
    // The cycle must cost the loop and nothing else: a filter that gave up on the
    // whole object would turn one bad reference into a blank log line.
    const cyclic: Record<string, unknown> = { context: 'kept', msg: 'also kept' };
    cyclic['self'] = cyclic;
    const wrapper: Record<string, unknown> = { context: cyclic };
    cyclic['inner'] = wrapper;

    expect(filterLoggedFields(wrapper)).toEqual({ context: { context: 'kept', msg: 'also kept' } });
  });

  it('survives a cycle through an array', () => {
    const list: unknown[] = ['plain'];
    list.push(list);

    expect(() => filterLoggedFields({ context: list })).not.toThrow();
  });

  it('keeps a value that appears twice in a TREE, which is not a cycle', () => {
    // Dropping on first sight rather than on the path would silently delete the
    // second occurrence of a shared object — a filter that lies about the shape.
    const shared = { context: 'shared' };

    expect(filterLoggedFields({ context: [shared, shared] })).toEqual({
      context: [{ context: 'shared' }, { context: 'shared' }],
    });
  });

  it('stops at the depth cap rather than walking forever', () => {
    let deep: Record<string, unknown> = { context: 'bottom' };
    for (let level = 0; level < LOG_MAX_DEPTH + 5; level += 1) {
      deep = { context: deep };
    }

    const filtered = filterLoggedFields({ context: deep });

    // Walk what survived and confirm it is bounded.
    let levels = 0;
    let cursor: unknown = filtered['context'];
    while (cursor !== undefined && typeof cursor === 'object' && cursor !== null) {
      levels += 1;
      cursor = (cursor as Record<string, unknown>)['context'];
    }
    expect(levels).toBeLessThanOrEqual(LOG_MAX_DEPTH);
  });

  it('caps how many array elements are kept', () => {
    const long = Array.from({ length: LOG_MAX_ARRAY_LENGTH + 50 }, (_, index) => `item-${index}`);

    expect((filterLoggedFields({ context: long })['context'] as unknown[]).length).toBe(
      LOG_MAX_ARRAY_LENGTH,
    );
  });
});

describe('the value kinds nothing declared a representation for', () => {
  /**
   * The documented "anything else is dropped" branch, which had no example. Each of
   * these would otherwise be written by `JSON.stringify` in a shape nobody chose —
   * a `Date` as an ISO string, a `Buffer` as `{type:'Buffer',data:[…]}` — and a
   * `bigint` throws outright, which is a log write failing rather than degrading.
   */
  it.each([
    ['a Date', new Date('2026-09-06T00:00:00.000Z')],
    ['a Buffer', Buffer.from('secret-bytes')],
    ['a bigint', 10n],
    ['a function', (): string => LEAK],
    ['a symbol', Symbol('secret')],
    ['a Map', new Map([['email', LEAK]])],
    ['a Set', new Set([LEAK])],
  ])('drops %s under a declared key', (_label, value) => {
    const filtered = filterLoggedFields({ context: value });

    expect(filtered).toEqual({});
    expect(() => JSON.stringify(filtered)).not.toThrow();
  });

  it('loggedScalar answers the same question for the req/res serializers', () => {
    // The serializers in both apps were allow-lists over field NAMES and not over
    // field VALUES, so `logger.info({ req: { id: someObject } })` copied an
    // undeclared object straight out through a key that had been filtered.
    expect(loggedScalar('r-1')).toBe('r-1');
    expect(loggedScalar(200)).toBe(200);
    expect(loggedScalar(true)).toBe(true);
    expect(loggedScalar({ email: LEAK })).toBeUndefined();
    expect(loggedScalar(null)).toBeUndefined();
    expect(loggedScalar(undefined)).toBeUndefined();
  });
});

describe('the err serializer degrades instead of taking the log line down', () => {
  it('survives a property that throws when read', () => {
    // A proxy, a lazily-parsed driver error, a half-constructed class. pino calls
    // this while WRITING, so an exception here loses the line entirely — on the
    // failure path, which is where the line matters most.
    const hostile = new Error('outer');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('nope');
      },
      enumerable: true,
    });

    const serialised = serializeLoggedError(hostile);

    expect(serialised['code']).toBeUndefined();
    expect(serialised['message']).toBe('outer');
  });

  it('survives every declared field throwing at once', () => {
    const hostile: Record<string, unknown> = {};
    for (const field of LOG_ALLOWED_ERROR_FIELDS) {
      Object.defineProperty(hostile, field, {
        get() {
          throw new Error('nope');
        },
        enumerable: true,
      });
    }

    expect(() => serializeLoggedError(hostile)).not.toThrow();
  });

  it('caps a message long enough to be a log-growth lever', () => {
    const enormous = 'x'.repeat(LOG_ERROR_MESSAGE_MAX_LENGTH * 3);

    expect(String(serializeLoggedError(new Error(enormous))['message'])).toHaveLength(
      LOG_ERROR_MESSAGE_MAX_LENGTH,
    );
  });

  it('caps a stack that is not really a stack', () => {
    // Nothing guarantees the property holds frames; `err.stack = <10 MB>` is one
    // assignment away, and the frame cap alone would not see it.
    const error = new Error('x');
    error.stack = 'y'.repeat(LOG_ERROR_STACK_MAX_LENGTH * 2);

    expect(String(serializeLoggedError(error)['stack']).length).toBeLessThanOrEqual(
      LOG_ERROR_STACK_MAX_LENGTH,
    );
  });

  it('follows a cause chain through the SAME allow-list', () => {
    // A rethrow puts the real origin in `cause`; dropping it keeps the wrapper and
    // throws away the failure. Keeping it unfiltered would be a whole second error
    // object with no allow-list in front of it.
    const origin = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
      token: LEAK,
    });
    const wrapper = new Error('could not sign in', { cause: origin });

    const serialised = serializeLoggedError(wrapper);
    const cause = serialised['cause'] as Record<string, unknown>;

    expect(serialised['message']).toBe('could not sign in');
    expect(cause['message']).toBe('connection refused');
    expect(cause['code']).toBe('ECONNREFUSED');
    expect(cause['token']).toBeUndefined();
    expect(JSON.stringify(serialised)).not.toContain(LEAK);
  });

  it('stops following a cause chain that points back at itself', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.defineProperty(first, 'cause', { value: second, enumerable: true });

    expect(() => serializeLoggedError(second)).not.toThrow();

    let depth = 0;
    let cursor: unknown = serializeLoggedError(second);
    while (cursor !== undefined && cursor !== null) {
      cursor = (cursor as Record<string, unknown>)['cause'];
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(LOG_ERROR_CAUSE_DEPTH_LIMIT + 2);
  });
});
