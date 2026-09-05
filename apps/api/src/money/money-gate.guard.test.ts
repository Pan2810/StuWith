import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AGE_VOCABULARY, UNAUTHENTICATED_MESSAGE } from '@stuwith/contracts';
import { InMemorySessionAdapter } from '@stuwith/db';
import { FixedClock, type IdentityPort, type User } from '@stuwith/domain';
import { describe, expect, it } from 'vitest';
import { SessionAuthenticator } from '../auth/session-authenticator';
import { hashSessionToken } from '../auth/tokens';
import { MoneyGateGuard } from './money-gate.guard';
import { moneyInCallerOf } from './money-gate.request';
import { MONEY_IN_METADATA } from './money-in.decorator';

/**
 * Every branch of the money gate, without an HTTP server.
 *
 * `money-gate.flow.test.ts` drives the same code through real requests and is the
 * stronger evidence for the product-facing rows of the matrix. What it cannot
 * reach cheaply is the branch SHAPE: that an unmarked route is a no-op which never
 * fetches the request at all, that class-level metadata cannot gate anything, and
 * that every "we do not know" state lands on 403 rather than on a pass. Those are
 * asserted here.
 *
 * ## The instant this file calls "today"
 *
 * **`2026-09-05`**, the same day `packages/domain/src/policies/money.test.ts`
 * stands on — and one day LATER than `createAuthHarness`, which the flow test and
 * `logging.test.ts` run on. So `2008-09-05` is the exact-eighteenth-birthday adult
 * here and the too-young example over there. Reading one file's boundary dates
 * into another is the mistake; each file names its own day for that reason.
 *
 * The session store and the hashing are REAL — `InMemorySessionAdapter` is the
 * same object the contract suite runs against, and the cookie is hashed with the
 * same function `AuthService` uses. Only the identity lookup is a stub, and only
 * because the `unusable` row (`1899-12-31`) is a value no adapter will let a test
 * write through the front door; it is a row that got there by hand-editing or by a
 * clock correction, which is precisely why the state has a name.
 */

const SECRET = 'money-gate-guard-secret'.padEnd(48, 'x');
const NOW = new Date('2026-09-05T12:00:00.000Z');
const SESSION_TOKEN = 'a-session-token-for-the-guard-test';
const COOKIE = `stuwith_session=${SESSION_TOKEN}`;

/**
 * `findUserById` and nothing else.
 *
 * The other two methods throw rather than returning something plausible: the gate
 * has no business creating an identity or writing a date of birth, and a stub that
 * answered them quietly would hide the day it starts.
 */
class StubIdentity implements IdentityPort {
  readonly lookups: string[] = [];

  constructor(
    private readonly user: User | null,
    /** A store that cannot answer, as opposed to one that answers "nobody". */
    private readonly fault?: Error,
  ) {}

  async findOrCreateByIdentity(): Promise<never> {
    throw new Error('the money gate must never create an identity');
  }

  async findUserById(userId: string): Promise<User | null> {
    this.lookups.push(userId);
    if (this.fault !== undefined) {
      throw this.fault;
    }
    return this.user;
  }

  async recordDateOfBirth(): Promise<never> {
    throw new Error('the money gate must never write a date of birth');
  }
}

/**
 * A session store that accepts a write and then cannot answer a read.
 *
 * Subclassed rather than hand-rolled so it is a real `SessionPort` — the contract
 * suite's own adapter with one method replaced, which is the shape a Postgres
 * outage actually takes: the row exists, the connection does not.
 */
class ExplodingSessions extends InMemorySessionAdapter {
  constructor(private readonly fault: Error) {
    super();
  }

  override async readByAccessTokenHash(): Promise<never> {
    throw this.fault;
  }
}

interface World {
  readonly guard: MoneyGateGuard;
  readonly identity: StubIdentity;
}

async function world(
  options: {
    readonly dateOfBirth?: string | null;
    readonly expired?: boolean;
    readonly userIsGone?: boolean;
    readonly now?: Date;
    /** The identity store cannot answer at all. */
    readonly identityFault?: Error;
    /** The session store cannot answer at all. */
    readonly sessionFault?: Error;
  } = {},
): Promise<World> {
  const now = options.now ?? NOW;
  const user: User = {
    id: 'user-under-test',
    displayName: 'Một người dùng',
    email: null,
    avatarUrl: null,
    role: 'user',
    dateOfBirth: options.dateOfBirth ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const identity = new StubIdentity(
    options.userIsGone === true ? null : user,
    options.identityFault,
  );

  const sessions =
    options.sessionFault === undefined
      ? new InMemorySessionAdapter()
      : new ExplodingSessions(options.sessionFault);
  const issuedAt = new Date(now.getTime() - 60_000);
  await sessions.open({
    userId: user.id,
    accessTokenHash: hashSessionToken(SECRET, SESSION_TOKEN),
    refreshTokenHash: hashSessionToken(SECRET, 'a-refresh-token-for-the-guard-test'),
    issuedAt,
    expiresAt:
      options.expired === true ? new Date(now.getTime() - 1_000) : new Date(now.getTime() + 3_600_000),
    refreshExpiresAt: new Date(now.getTime() + 86_400_000),
  });

  const authenticator = new SessionAuthenticator(SECRET, {
    identity,
    sessions,
    clock: new FixedClock(now),
  });
  return { guard: new MoneyGateGuard(new Reflector(), authenticator), identity };
}

interface FakeContext {
  readonly context: ExecutionContext;
  readonly request: { headers: Record<string, string> };
  /** How many times the guard reached for the request at all. */
  requestFetches(): number;
}

function contextFor(
  options: {
    readonly marked?: boolean;
    readonly markedOnClass?: boolean;
    readonly metadata?: unknown;
    readonly cookie?: string;
    /** Anything but `'http'` stands in for a transport this guard cannot inspect. */
    readonly type?: string;
    /** Drop the request entirely, the shape a non-HTTP context hands back. */
    readonly withoutRequest?: boolean;
  } = {},
): FakeContext {
  const request = { headers: options.cookie === undefined ? {} : { cookie: options.cookie } };

  const handler = (): undefined => undefined;
  const declared = options.metadata ?? (options.marked === true ? true : undefined);
  if (declared !== undefined) {
    Reflect.defineMetadata(MONEY_IN_METADATA, declared, handler);
  }

  class Anonymous {}
  if (options.markedOnClass === true) {
    // Not reachable through `@MoneyIn()` — it is typed `MethodDecorator`, so this
    // is a compile error in product code. Reflection can still do it, which is
    // exactly why the guard reads the handler and nothing else.
    Reflect.defineMetadata(MONEY_IN_METADATA, true, Anonymous);
  }

  let fetches = 0;
  const context = {
    // Nest's real contexts answer this; a fake that omitted it would make the
    // guard's transport check pass for the wrong reason on every example.
    getType: () => options.type ?? 'http',
    switchToHttp: () => {
      fetches += 1;
      return { getRequest: () => (options.withoutRequest === true ? undefined : request) };
    },
    getHandler: () => handler,
    getClass: () => Anonymous,
  } as unknown as ExecutionContext;

  return { context, request, requestFetches: () => fetches };
}

/** Runs the guard expecting a refusal, and hands back the exception to inspect. */
async function refusalOf(guard: MoneyGateGuard, context: ExecutionContext): Promise<HttpException> {
  try {
    await guard.canActivate(context);
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('the guard allowed a request the matrix says it must refuse');
}

describe('Matrix: a route that is NOT marked', () => {
  it('is allowed without fetching the request, reading a cookie or touching the store', async () => {
    // AC4 asks for this to be PROVEN rather than claimed, because it is the whole
    // reason a globally registered guard is safe. If the guard reached for the
    // request first, every route in the product — `/healthz` included — would pay
    // a session read on every call.
    const { guard, identity } = await world({ dateOfBirth: '2015-01-01' });
    const fake = contextFor({ cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);

    expect(fake.requestFetches()).toBe(0);
    expect(identity.lookups).toEqual([]);
  });

  it('ignores metadata on the CLASS, so one decorator cannot gate a whole controller', async () => {
    // Gating an Epic 3 money controller wholesale would refuse its READ routes
    // too — "you may not look at your own Số dư" — which is not what the rule says
    // and is not a refusal anybody would think to test for.
    const { guard, identity } = await world({ dateOfBirth: '2015-01-01' });
    const fake = contextFor({ markedOnClass: true, cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);
    expect(identity.lookups).toEqual([]);
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['false', false],
    ['null', null],
  ])('ignores metadata that is not exactly `true`: %s', async (_label, metadata) => {
    // The decorator writes `true` and only `true`. A truthy check would let a
    // mis-set value gate a route in a way nothing else in the codebase writes.
    const { guard } = await world({ dateOfBirth: '2015-01-01' });
    const fake = contextFor({ metadata, cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);
    expect(fake.requestFetches()).toBe(0);
  });
});

describe('Matrix: a marked route, and who gets through it', () => {
  it('lets an adult through and leaves the resolved caller on the request', async () => {
    const { guard, identity } = await world({ dateOfBirth: '1999-04-02' });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);

    // The point of attaching it: the handler serves the person the gate judged,
    // and the session is read ONCE for the whole request.
    const caller = moneyInCallerOf(fake.request);
    expect(caller.user.id).toBe('user-under-test');
    expect(caller.at.getTime()).toBe(NOW.getTime());
    expect(identity.lookups).toEqual(['user-under-test']);
  });

  it('lets somebody through on the DAY of their eighteenth birthday', async () => {
    // 2008-09-05 is eighteen exactly today. `<=`, not `<`.
    const { guard } = await world({ dateOfBirth: '2008-09-05' });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);
  });
});

describe('Matrix: everything that fails CLOSED lands on 403', () => {
  it.each([
    ['the eighteenth birthday has not arrived', '2008-09-06'],
    ['no date of birth has been declared', null],
    ['the stored value is unusable — a year below the floor', '1899-12-31'],
    ['the stored value is unusable — a day in the future', '2026-09-06'],
  ])('refuses when %s', async (_label, dateOfBirth) => {
    const { guard } = await world({ dateOfBirth });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    const refusal = await refusalOf(guard, fake.context);
    expect(refusal.getStatus()).toBe(403);
    expect(refusal.getResponse()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('leaves NO caller on the request when it refuses', async () => {
    // A handler that somehow ran anyway must not find a caller sitting there.
    const { guard } = await world({ dateOfBirth: '2008-09-06' });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    await refusalOf(guard, fake.context);
    expect(() => moneyInCallerOf(fake.request)).toThrow();
  });

  it('says nothing about an age, a date or a threshold', async () => {
    // The date of birth must not leave `apps/api` — and the threshold must not
    // either, because telling somebody which side of it they fell on is free
    // calibration for anybody who would rather be on the other side.
    const { guard } = await world({ dateOfBirth: '2008-09-06' });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    const body = (await refusalOf(guard, fake.context)).getResponse() as {
      error: { message: string; details?: unknown };
    };
    for (const word of AGE_VOCABULARY) {
      expect(body.error.message.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(body.error.message).not.toContain('2008');
    expect(body.error.details).toBeUndefined();
  });
});

describe('Matrix: 401 comes before 403, always', () => {
  it.each([
    ['there is no cookie at all', undefined],
    ['the cookie holds an unknown token', 'stuwith_session=not-a-real-token'],
    ['the cookie header is junk', 'this is not a cookie header'],
  ])('answers 401 when %s', async (_label, cookie) => {
    // Answering 403 here would tell a passing stranger they are not old enough —
    // an assertion about a person the system has never identified.
    const { guard, identity } = await world({ dateOfBirth: '2008-09-06' });
    const fake = contextFor({ marked: true, ...(cookie === undefined ? {} : { cookie }) });

    const refusal = await refusalOf(guard, fake.context);
    expect(refusal.getStatus()).toBe(401);
    expect(refusal.getResponse()).toMatchObject({
      error: { code: 'unauthenticated', message: UNAUTHENTICATED_MESSAGE },
    });
    // No session, no user lookup: the store is not consulted about somebody who
    // presented nothing.
    expect(identity.lookups).toEqual([]);
  });

  it('answers 401 for a session that has expired', async () => {
    const { guard } = await world({ dateOfBirth: '1999-04-02', expired: true });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    expect((await refusalOf(guard, fake.context)).getStatus()).toBe(401);
  });

  it('answers 401 when the session points at a profile that is gone', async () => {
    // Collapsed into the same 401 on purpose: distinguishing the three reasons
    // tells somebody probing which of the three they achieved.
    const { guard } = await world({ dateOfBirth: '1999-04-02', userIsGone: true });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    expect((await refusalOf(guard, fake.context)).getStatus()).toBe(401);
  });
});

describe('one request, one instant', () => {
  it('judges the age against the instant the SESSION was resolved at', async () => {
    /**
     * A request that read the clock twice could straddle a midnight and answer two
     * questions about two days — and on this gate one of those two answers is "yes,
     * take their money".
     *
     * The clock here is fixed, so the property is shown the other way round: the
     * instant handed to the handler is the instant the age was judged with, and the
     * boundary case proves the two are the same reading rather than two that happen
     * to agree.
     */
    const eve = new Date('2026-09-04T23:59:59.999Z');
    const { guard } = await world({ dateOfBirth: '2008-09-05', now: eve });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    // Not yet eighteen at 23:59:59.999 UTC on the 4th.
    expect((await refusalOf(guard, fake.context)).getStatus()).toBe(403);

    const midnight = new Date('2026-09-05T00:00:00.000Z');
    const later = await world({ dateOfBirth: '2008-09-05', now: midnight });
    const nextFake = contextFor({ marked: true, cookie: COOKIE });
    await expect(later.guard.canActivate(nextFake.context)).resolves.toBe(true);
    expect(moneyInCallerOf(nextFake.request).at.getTime()).toBe(midnight.getTime());
  });
});

describe('Matrix: a store that cannot answer is NOT a person who is too young', () => {
  /**
   * The third shape of "we do not know", and the one the guard's docblock used to
   * omit entirely.
   *
   * `not-declared` and `unusable` are facts about a row, and 403 is the right
   * answer to both. A Postgres outage is a fact about US. Answering 403 there
   * would tell somebody they are not old enough when the truth is that we are
   * broken — a false statement about a person, and an outage hidden behind a
   * refusal nobody would think to investigate.
   *
   * There is deliberately no fail-OPEN branch either. `RateLimitGuard` has one, a
   * human took that decision on 2026-09-04, and what makes it defensible is the
   * size of the trade: an unchecked login flood for the length of a Valkey
   * incident. The same trade here is money moving to a child, so the rejection
   * simply propagates and the request becomes the 500 it is.
   */
  it.each([
    ['the session store', 'sessionFault'],
    ['the identity store', 'identityFault'],
  ])('refuses rather than allowing when %s does not answer', async (_label, key) => {
    const fault = new Error('the store did not answer');
    const { guard } = await world({ dateOfBirth: '1999-04-02', [key]: fault });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    // The exact error, not merely "some rejection": a guard that swallowed this
    // and threw its own 403 would also reject, and would be the defect above.
    await expect(guard.canActivate(fake.context)).rejects.toBe(fault);
  });

  it('does not attach a caller when the store failed', async () => {
    const { guard } = await world({
      dateOfBirth: '1999-04-02',
      sessionFault: new Error('the store did not answer'),
    });
    const fake = contextFor({ marked: true, cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).rejects.toThrow();
    expect(() => moneyInCallerOf(fake.request)).toThrow();
  });

  it('leaves an UNMARKED route alone even while the store is down', async () => {
    // The no-op branch never reaches a store, so an outage must not turn every
    // route in the product into a 500.
    const { guard } = await world({
      dateOfBirth: '1999-04-02',
      sessionFault: new Error('the store did not answer'),
    });
    const fake = contextFor({ cookie: COOKIE });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);
  });
});

describe('Matrix: a transport this guard cannot inspect', () => {
  /**
   * `switchToHttp()` does not throw on a WebSocket or RPC context — it hands back
   * whatever the first handler argument was. So a marked handler on another
   * transport gets a socket or a payload where a request should be, and the guard
   * would crash on `.headers` BEFORE deciding anything. A guard whose crash path
   * is reached before its refusal path can be bypassed by choosing a transport.
   *
   * `apps/api` is HTTP-only today, so this is defensive. The direction is not.
   */
  it.each([['ws'], ['rpc'], ['graphql']])('refuses a marked handler on a %s context', async (type) => {
    const { guard, identity } = await world({ dateOfBirth: '1999-04-02' });
    const fake = contextFor({ marked: true, cookie: COOKIE, type });

    const refusal = await refusalOf(guard, fake.context);
    expect(refusal.getStatus()).toBe(401);
    // It refused without asking anybody: there was nothing here it could identify.
    expect(identity.lookups).toEqual([]);
    expect(fake.requestFetches()).toBe(0);
  });

  it('still leaves an UNMARKED handler alone on such a context', async () => {
    // The no-op branch is decided by metadata alone, before the transport is even
    // looked at, so a future non-HTTP handler is not refused just for existing.
    const { guard } = await world({ dateOfBirth: '1999-04-02' });
    const fake = contextFor({ cookie: COOKIE, type: 'ws' });

    await expect(guard.canActivate(fake.context)).resolves.toBe(true);
  });

  it('refuses when the context claims HTTP but hands back no request at all', async () => {
    // Belt and braces for the same class: `getRequest()` returning `undefined`
    // must be a refusal, not a `TypeError` and certainly not a pass.
    const { guard } = await world({ dateOfBirth: '1999-04-02' });
    const fake = contextFor({ marked: true, cookie: COOKIE, withoutRequest: true });

    expect((await refusalOf(guard, fake.context)).getStatus()).toBe(401);
  });
});

describe('an empty session cookie costs nothing', () => {
  it('is treated as no cookie, without an HMAC or a store read', async () => {
    /**
     * `stuwith_session=` is what a browser presents on the request straight after
     * a clearing `Set-Cookie`, so it is the ordinary shape of a signed-out visitor
     * rather than a hostile one. Before this branch existed every such visitor to
     * a gated route spent one HMAC and one round trip to the session store to be
     * told the obvious.
     */
    const { guard, identity } = await world({ dateOfBirth: '1999-04-02' });
    const fake = contextFor({ marked: true, cookie: 'stuwith_session=' });

    expect((await refusalOf(guard, fake.context)).getStatus()).toBe(401);
    expect(identity.lookups).toEqual([]);
  });
});
