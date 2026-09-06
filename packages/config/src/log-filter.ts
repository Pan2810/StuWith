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

/**
 * AD-15, the mechanism: the allow-list of `log-fields.ts`, applied.
 *
 * Two pure functions, and they are pure on purpose — the whole of the policy can
 * be exercised without building a logger, which is what makes the matrix in
 * `log-filter.test.ts` fast enough to cover every shape rather than three of them.
 * The wiring (that both processes actually hand these to pino) is a separate claim
 * and is tested separately, in each app's own `logging.test.ts`.
 *
 * ## Why `formatters.log` and not `serializers`
 *
 * `serializers` are keyed BY FIELD NAME: pino calls `serializers.foo` when a log
 * object has a key `foo`. A field nobody declared has no serializer to call, so it
 * goes straight to the output — which is precisely the case this story exists to
 * close. `formatters.log(object)` receives the whole merged object on every line,
 * so it is the only place in pino where "only these keys may continue" can be
 * stated at all. Choosing `serializers` would have produced a story that looks
 * right and fails its acceptance criterion.
 *
 * ## Everything here runs ON THE REQUEST PATH, so nothing here may be unbounded
 *
 * These functions execute inside `formatters.log`, before pino's own cycle-safe
 * stringifier. That ordering matters more than it looks: pino tolerates a circular
 * object, and a naive filter placed in front of it REINTRODUCES the hazard it was
 * added to remove — `a.context = a` threw `RangeError` out of the middle of a
 * request until the cycle guard below existed. Depth, array length, message
 * length, stack length and `cause` depth are all bounded for the same reason: a
 * caller must not be able to make one log line cost the process an unbounded
 * amount of work.
 */

type PlainObject = Record<string, unknown>;

const ALLOWED = new Set<string>(LOG_ALLOWED_FIELDS);
const SERIALIZED = new Set<string>(LOG_SERIALIZED_FIELDS);

/**
 * A plain object, and nothing that merely looks like one.
 *
 * `Object.create(null)` is included because pino builds objects that way itself.
 * A class instance is NOT: recursing into one reads getters and inherited
 * properties, and the objects in this repository that are class instances —
 * `IncomingMessage`, `ServerResponse`, an `Error`, a `Pool` — are exactly the ones
 * that carry a whole request's worth of data behind an innocent-looking key.
 */
function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A value under an already-allowed key, filtered by the same rule at every depth.
 *
 * `undefined` means "drop the key". Scalars pass; arrays are filtered element by
 * element; a plain object keeps only declared keys; anything else — a `Date`, a
 * `Buffer`, a class instance, a function, a symbol, a bigint — is dropped, because
 * there is no way to write it out without either inventing a representation or
 * walking an object nobody declared.
 *
 * `seen` is the cycle guard and `depth` the bound. Both are carried rather than
 * held in module state so the function stays pure and reentrant: pino can call
 * `formatters.log` from anywhere, including from inside another log call's error
 * handling.
 */
function filterValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') {
    // Functions, symbols and bigints. A bigint would additionally throw inside
    // `JSON.stringify`, which is a log write failing rather than degrading.
    return undefined;
  }
  if (depth >= LOG_MAX_DEPTH) {
    // Not an error and not a truncation marker: a marker would be a value nobody
    // declared, written into a log line by the thing whose job is to stop that.
    return undefined;
  }
  if (seen.has(value)) {
    // The cycle. pino's own stringifier writes `"[Circular]"` here; this filter
    // runs BEFORE it and would recurse forever, so the branch is dropped instead.
    return undefined;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      /**
       * Elements are kept IN PLACE, empty husks included.
       *
       * `[{ context: 'a' }, { email: '...' }]` becomes `[{ context: 'a' }, {}]` and
       * not `[{ context: 'a' }]`. Dropping a filtered-to-empty element renumbers
       * everything after it, so `errors[3]` in a log line would name a different
       * element from `errors[3]` anywhere else — a quiet way to make a log lie
       * about what it is describing. An empty object is honestly "something was
       * here and none of it was loggable".
       */
      return value
        .slice(0, LOG_MAX_ARRAY_LENGTH)
        .map((entry) => filterValue(entry, depth + 1, seen))
        .filter((entry) => entry !== undefined);
    }
    if (isPlainObject(value)) {
      const kept: PlainObject = {};
      for (const key of Object.keys(value)) {
        if (!ALLOWED.has(key)) {
          continue;
        }
        const filtered = filterValue(value[key], depth + 1, seen);
        if (filtered !== undefined) {
          kept[key] = filtered;
        }
      }
      return kept;
    }
    return undefined;
  } finally {
    // Removed on the way out so a value legitimately appearing twice in a TREE is
    // kept twice; only a value appearing inside itself is a cycle.
    seen.delete(value);
  }
}

/**
 * `formatters.log`: the merged object pino is about to write, reduced to the
 * declared fields.
 *
 * The line itself is still written. That matters and is a matrix row of its own:
 * a filter that dropped the record when it found an undeclared field would turn a
 * PII control into an availability incident the first time somebody logged a user
 * object, and the message is usually the part worth keeping anyway.
 *
 * The three serializer-owned keys are passed through UNTOUCHED at the root, on
 * purpose. At the moment this function runs, `err` is still a live `Error` and
 * `res` a live `ServerResponse`; pino applies `serializers` immediately
 * afterwards, and those serializers are themselves allow-lists. Filtering here as
 * well would mean either recursing into a class instance (see `isPlainObject`) or
 * deleting the three keys that make a log line worth keeping.
 */
export function filterLoggedFields(object: PlainObject): PlainObject {
  const kept: PlainObject = {};
  const seen = new WeakSet<object>();
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value === undefined) {
      continue;
    }
    if (SERIALIZED.has(key)) {
      kept[key] = value;
      continue;
    }
    if (!ALLOWED.has(key)) {
      continue;
    }
    const filtered = filterValue(value, 0, seen);
    if (filtered !== undefined) {
      kept[key] = filtered;
    }
  }
  return kept;
}

/**
 * A value that may be written as-is, or `undefined`.
 *
 * Exported for the two apps' `req`/`res` serializers. Those are allow-lists over
 * FIELD NAMES and were not allow-lists over field VALUES, so
 * `logger.info({ req: { id: { email } } })` reached the output through a
 * serializer that copied `req.id` verbatim — the same "an undeclared thing sails
 * through" shape this story closed one key over.
 */
export function loggedScalar(value: unknown): string | number | boolean | undefined {
  const kind = typeof value;
  return kind === 'string' || kind === 'number' || kind === 'boolean'
    ? (value as string | number | boolean)
    : undefined;
}

/**
 * Read one property without letting it take the log line down with it.
 *
 * A getter that throws is not hypothetical for the objects that reach a logger: a
 * proxy, a lazily-parsed driver error, a partially-constructed class. `pino` calls
 * this serializer while writing, so an exception here means the log write FAILS
 * rather than degrades — the one outcome worse than a missing field, because it is
 * the failure path where you most need the line.
 */
function readQuietly(source: PlainObject, field: string): unknown {
  try {
    return source[field];
  } catch {
    return undefined;
  }
}

/**
 * `serializers.err`: the field this story found actually leaking.
 *
 * pino's default error serializer copies every enumerable own property of the
 * thrown object. Nothing in this repository writes `logger.info({ someObject })`
 * — all six hand-written log calls pass a string — so an allow-list over
 * hand-written payloads would have protected nothing at all. What DOES flow
 * through the logger is whatever `pino-http` writes by itself, and of those `req`
 * and `res` were already narrowed while `err` was not. An `Error` carrying
 * `error.token`, `error.user` or a whole provider response reached the output
 * verbatim.
 *
 * Reads only the declared names, and never enumerates: a rule written as "copy
 * everything except X" is the deny-list this story is removing.
 */
export function serializeLoggedError(value: unknown, depth = 0): PlainObject {
  const serialised: PlainObject = {};
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    // A thrown non-object — `throw 'oops'`, `throw 42`. Its type is all that can be
    // said about it without writing the value itself, and the value is exactly
    // what might be a token.
    serialised['name'] = `non-error thrown: ${typeof value}`;
    return serialised;
  }

  const source = value as PlainObject;
  for (const field of LOG_ALLOWED_ERROR_FIELDS) {
    const raw = readQuietly(source, field);
    const candidate =
      field === 'stack'
        ? cappedStack(raw)
        : field === 'message'
          ? capped(raw, LOG_ERROR_MESSAGE_MAX_LENGTH)
          : raw;
    const scalar = loggedScalar(candidate);
    if (scalar !== undefined) {
      serialised[field] = scalar;
    }
  }

  /**
   * The `cause` chain, through this same allow-list.
   *
   * A rethrow puts the real origin here and nothing else, so dropping it keeps the
   * wrapper and throws away the failure. Following it forever is how one log line
   * becomes unbounded, and a `cause` can point back at its own wrapper, so the
   * depth cap is the guard rather than a cycle set — three links is deeper than any
   * rethrow in this repository.
   */
  if (depth < LOG_ERROR_CAUSE_DEPTH_LIMIT) {
    const cause = readQuietly(source, 'cause');
    if (cause !== undefined) {
      serialised['cause'] = serializeLoggedError(cause, depth + 1);
    }
  }

  return serialised;
}

/** Free text, bounded. See `LOG_ERROR_MESSAGE_MAX_LENGTH` for why. */
function capped(text: unknown, limit: number): unknown {
  return typeof text === 'string' && text.length > limit ? text.slice(0, limit) : text;
}

/**
 * The stack, truncated to {@link LOG_ERROR_STACK_FRAME_LIMIT} frames and then to
 * {@link LOG_ERROR_STACK_MAX_LENGTH} characters.
 *
 * Everything before the first `at ` line is kept as the header — that is where
 * `name: message` lives, and where `diagnosableWithoutTheData` puts the bare name
 * it substitutes for a driver's message. Only the frames are counted, so a stack
 * that has been rewritten to carry no message stays intact. The character cap is
 * the backstop for a "stack" that is not a stack at all: nothing guarantees the
 * property holds frames, and `err.stack = <10 MB>` is one assignment away.
 */
function cappedStack(stack: unknown): unknown {
  if (typeof stack !== 'string') {
    return stack;
  }
  const kept: string[] = [];
  let frames = 0;
  for (const line of stack.split('\n')) {
    if (line.trimStart().startsWith('at ')) {
      if (frames >= LOG_ERROR_STACK_FRAME_LIMIT) {
        break;
      }
      frames += 1;
    }
    kept.push(line);
  }
  return capped(kept.join('\n'), LOG_ERROR_STACK_MAX_LENGTH);
}
