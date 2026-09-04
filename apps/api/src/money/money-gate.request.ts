import type { FastifyRequest } from 'fastify';
import type { AuthenticatedCaller } from '../auth/session-authenticator';

/**
 * Where the guard leaves the caller it already resolved, so no handler reads the
 * session a second time.
 *
 * A guard runs before the handler — that is the reason it exists — but the handler
 * still needs to know WHO it is serving. Left to itself it would parse the cookie,
 * hash it, read the session and load the user all over again: two database round
 * trips per request, and two answers that a revocation landing between them can
 * make disagree. The gate would then have judged one person while the handler
 * charged another.
 *
 * A SYMBOL rather than a string property, and that is not decoration. The request
 * object is shared with Fastify, with `nestjs-pino`, and with every plugin either
 * of them loads; a string key is a name that can collide, and — worse — a name a
 * serialiser can enumerate. `User` carries `dateOfBirth`, which the epic's release
 * gate says must never reach a log line, and a symbol-keyed property is invisible
 * to `JSON.stringify` and to pino's serialisers alike.
 */
const MONEY_IN_CALLER = Symbol('stuwith:money-in-caller');

/**
 * `FastifyRequest`, named in the type rather than `object`, and that is the one
 * place a compiler can hold the distinction the whole PII analysis turns on.
 *
 * There are two request objects in this process: the raw Node `IncomingMessage`
 * that `pino-http` serialises, and the Fastify request that wraps it, which is
 * what a Nest `ExecutionContext` hands back and what these functions write to.
 * Confusing them is what makes "a serialiser could reach this" sound true when it
 * is not, and what would make it silently become true if the guard were ever
 * changed to attach to `request.raw`.
 */
type GatedRequest = FastifyRequest & {
  [MONEY_IN_CALLER]?: AuthenticatedCaller;
};

/** Called by the guard, once, after the gate has been passed. */
export function attachMoneyInCaller(request: FastifyRequest, caller: AuthenticatedCaller): void {
  (request as GatedRequest)[MONEY_IN_CALLER] = caller;
}

/**
 * The caller a `@MoneyIn()` handler is serving, and the instant their session was
 * resolved at.
 *
 * It THROWS when there is nothing there, rather than returning `undefined` or
 * reaching for the session itself. Both alternatives fail open: an `undefined` a
 * handler forgets to check becomes a money movement with no owner, and a fallback
 * that re-authenticates would let a route that forgot `@MoneyIn()` work perfectly
 * — ungated — which is the one bug this whole module exists to make impossible.
 * Loud and immediate is the only safe direction here.
 */
export function moneyInCallerOf(request: FastifyRequest): AuthenticatedCaller {
  const caller = (request as GatedRequest)[MONEY_IN_CALLER];
  if (caller === undefined) {
    throw new Error(
      'no gated caller on this request — the handler is missing @MoneyIn(), or ' +
        'something read the caller before MoneyGateGuard ran',
    );
  }
  return caller;
}
