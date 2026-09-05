import type { FastifyRequest } from 'fastify';
import type { AuthenticatedCaller } from '../auth/session-authenticator';
import { describe, expect, it } from 'vitest';
import { attachMoneyInCaller, moneyInCallerOf } from './money-gate.request';

/**
 * The symbol key, executed.
 *
 * ## Why this file had to exist
 *
 * It was measured: swapping the `Symbol` in `money-gate.request.ts` for an
 * ordinary string key left `logging.test.ts`, `money-gate.guard.test.ts` and
 * `money-gate.flow.test.ts` ALL green. Every reader in the repository goes through
 * {@link moneyInCallerOf}, which follows whatever the constant says, so no
 * behavioural test can see the difference — and the PII suite could not see it
 * either, because pino's `req` serialiser is looking at the raw Node request
 * rather than at the Fastify one this writes to.
 *
 * So the only barrier standing between "the caller is attached" and "the caller is
 * enumerable" was a comment. That is one refactor away from gone, and
 * `deferred-work.md` records that Story 1.7 may well remove the OTHER barrier
 * (which object gets serialised) on purpose.
 *
 * What is asserted here is the property itself — invisible to enumeration,
 * invisible to `JSON.stringify`, and still readable by the one function that is
 * meant to read it. It survives the pino wiring changing underneath it, which is
 * exactly what the behavioural suites cannot promise.
 */

const CALLER: AuthenticatedCaller = {
  user: {
    id: 'user-on-the-request',
    displayName: 'Một người dùng',
    email: 'someone@example.test',
    avatarUrl: null,
    role: 'user',
    // The value the whole exercise is about. A `User` on the request object means
    // a date of birth on the request object.
    dateOfBirth: '1988-11-07',
    createdAt: new Date('2026-09-05T12:00:00.000Z'),
    updatedAt: new Date('2026-09-05T12:00:00.000Z'),
  },
  at: new Date('2026-09-05T12:00:00.000Z'),
};

/**
 * A plain object standing in for the Fastify request.
 *
 * The functions are typed to `FastifyRequest` so the compiler holds the
 * raw-Node-versus-Fastify distinction in product code (that confusion is what the
 * whole leak analysis turns on). A test asserting a property of the STORAGE does
 * not need a real one, and a bare object makes the enumeration assertions mean
 * what they say: anything visible below was put there by `attachMoneyInCaller`.
 */
const bareRequest = (): FastifyRequest => ({}) as unknown as FastifyRequest;

describe('the attached caller is invisible to anything that enumerates', () => {
  it('adds no enumerable key', () => {
    const request = bareRequest();
    attachMoneyInCaller(request, CALLER);

    expect(Object.keys(request)).toEqual([]);
  });

  it('serialises to an empty object', () => {
    // The single most likely accident: something logs, clones or returns the
    // request. With a string key this is where the date of birth would appear.
    const request = bareRequest();
    attachMoneyInCaller(request, CALLER);

    expect(JSON.stringify(request)).toBe('{}');
  });

  it.each([
    ['Object.entries', (request: FastifyRequest) => Object.entries(request)],
    ['a spread into a new object', (request: FastifyRequest) => Object.keys({ ...request })],
    ['JSON round-tripping', (request: FastifyRequest) => Object.keys(JSON.parse(JSON.stringify(request)))],
  ])('is not reachable through %s', (_label, walk) => {
    const request = bareRequest();
    attachMoneyInCaller(request, CALLER);

    expect(walk(request)).toEqual([]);
  });

  it('does not put the date of birth into any string form of the request', () => {
    // The assertion in the terms the release gate is written in, rather than in
    // terms of key names: whatever spelling somebody reaches for, the value is not
    // in it.
    const request = bareRequest();
    attachMoneyInCaller(request, CALLER);

    for (const rendering of [JSON.stringify(request), String(request), `${Object.keys(request)}`]) {
      expect(rendering).not.toContain('1988-11-07');
      expect(rendering).not.toContain(CALLER.user.email ?? 'no-email');
    }
  });
});

describe('and still readable by the one function meant to read it', () => {
  it('hands back exactly what the guard attached', () => {
    // The negative assertions above are satisfied perfectly by a function that
    // stores nothing at all. This is what stops them being vacuous.
    const request = bareRequest();
    attachMoneyInCaller(request, CALLER);

    const read = moneyInCallerOf(request);
    expect(read).toBe(CALLER);
    expect(read.user.id).toBe('user-on-the-request');
    expect(read.at.getTime()).toBe(CALLER.at.getTime());
  });

  it('throws on a request nothing was attached to, rather than returning undefined', () => {
    // Both alternatives fail open: an `undefined` a handler forgets to check is a
    // money movement with no owner, and a fallback that re-authenticated would let
    // a route that forgot `@MoneyIn()` work perfectly — ungated.
    expect(() => moneyInCallerOf(bareRequest())).toThrow(/@MoneyIn/);
  });

  it('keeps two requests apart', () => {
    // The storage is per-request, not module state — a shared slot would serve one
    // person's money movement to another's request.
    const first = bareRequest();
    const second = bareRequest();
    attachMoneyInCaller(first, CALLER);

    expect(moneyInCallerOf(first)).toBe(CALLER);
    expect(() => moneyInCallerOf(second)).toThrow();
  });
});
