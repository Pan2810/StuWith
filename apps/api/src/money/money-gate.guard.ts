import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canReceiveMoney, fixedAt } from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { SESSION_AUTHENTICATOR, SessionAuthenticator } from '../auth/session-authenticator';
import {
  MoneyGateForbiddenException,
  MoneyGateUnauthenticatedException,
} from './money-gate.exception';
import { attachMoneyInCaller } from './money-gate.request';
import { MONEY_IN_METADATA } from './money-in.decorator';

/**
 * The age gate, at the API boundary, on every route marked `@MoneyIn()`.
 *
 * ## Why here and not in the handler
 *
 * The acceptance criterion says the block must happen "kể cả khi gọi thẳng API" —
 * hiding a button in `apps/web` is Story 3.3 and is not a control at all. A guard
 * is the layer that runs whatever the caller is; an `if` at the top of a handler
 * is the line the fourth money endpoint copies without.
 *
 * ## Why it decides nothing about age itself
 *
 * `canReceiveMoney` is the whole rule and it lives in `packages/domain`, where it
 * is a projection of `isAdult`, which is a projection of `readStoredDateOfBirth`.
 * There is no threshold in this file, no date arithmetic, and no reading of
 * `user.dateOfBirth`. That is deliberate to the point of being the story: two age
 * rules on one column is the defect `date-of-birth.ts` paid four review rounds to
 * remove, and a NestJS guard is the worst possible place for the second one — the
 * realtime process cannot read it and no test can execute it without a request.
 *
 * ## Why global registration is safe
 *
 * Because the first branch is a true no-op. A route with no metadata is allowed
 * before the request object is even fetched: no cookie is parsed, no session is
 * read, no database is touched, nothing is logged. Every route that exists today —
 * the whole of `/v1/auth`, `/healthz` — takes that branch, which is what AC4 asks
 * to be proven rather than asserted.
 *
 * ## 401 before 403
 *
 * A request with no session is not "too young", it is unidentified. Answering 403
 * there would tell a passing stranger something about a person the system has
 * never met, and "sign in" is the honest next step for a caller who has not.
 *
 * ## Fail closed, everywhere, and in three different shapes
 *
 * `not-declared`, `unusable`, a broken clock, a user row that vanished — every
 * state that means "we do not know" answers `false` in the domain and 403 here. A
 * control that protects minors must never read its own ignorance as permission.
 *
 * Two more states mean "we do not know", and neither is a 403, because a 403 is a
 * statement ABOUT THE PERSON and both of these are statements about us:
 *
 * - **The session store did not answer.** Postgres down, a connection timeout, a
 *   defect in an adapter. The rejection propagates and surfaces as the 500 it is.
 *   The handler does not run, which is the property that matters; converting it to
 *   a 403 would tell somebody they are too young when the truth is that we are
 *   broken, and would hide an outage behind a refusal nobody investigates. There
 *   is deliberately NO fail-open branch here — the rate limiter has one, decided
 *   by a human on 2026-09-04, and the trade that makes it defensible (a login
 *   flood during a Valkey incident) has no counterpart when the thing being let
 *   through is money moving to a child.
 * - **The execution context is not HTTP.** See {@link canActivate}.
 *
 * ## What it does NOT do
 *
 * It never touches money going OUT. Spending coins to ask a private question, to
 * enter a Phòng học or to hide a face is untouched, and so are coins the SYSTEM
 * grants. It also revokes nothing: cutting a live session or ejecting somebody
 * from a room is Epic 4. This gate refuses at the moment permission is exercised,
 * and that is the whole of its remit.
 */
@Injectable()
export class MoneyGateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    /**
     * The SAME object `AuthService` authenticates through, built once in
     * `AppModule.forConfig`. Two ways of answering "who is calling" is a gate that
     * judges one person while the handler serves another.
     */
    @Inject(SESSION_AUTHENTICATOR) private readonly authenticator: SessionAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.isMoneyIn(context)) {
      // Before `switchToHttp()`, deliberately. The cheapest possible no-op is also
      // the most auditable one: there is no line below this that could touch a
      // cookie or a store on an unmarked route, because the request never enters
      // this method.
      return true;
    }

    /**
     * A marked handler on a transport this guard cannot inspect is REFUSED, never
     * allowed.
     *
     * `switchToHttp()` does not throw on a WebSocket or RPC context — it hands
     * back whatever the first handler argument was, so `getRequest()` there is a
     * socket, a payload, or `undefined`, and `request.headers` is then either
     * missing or attacker-shaped. Reading it would throw before any refusal was
     * decided, and a guard whose crash path is reached before its refusal path is
     * a guard that can be bypassed by choosing a transport.
     *
     * `apps/realtime-gateway` is a separate process with no gate of its own today
     * (`deferred-work.md` records that), so this branch is unreachable from
     * `apps/api` as it stands. It is written anyway because the direction is not
     * negotiable: the day somebody adds a WebSocket handler here, the wrong
     * default must not be "allowed".
     */
    if (context.getType() !== 'http') {
      throw new MoneyGateUnauthenticatedException();
    }

    const request: FastifyRequest | undefined = context.switchToHttp().getRequest();

    // The cookie header, raw and `unknown` — `parseCookies` is total over whatever
    // a caller sent, which is the property that keeps a hostile header from
    // becoming a 500 on the layer whose whole job is to refuse. `request?.` for
    // the same reason: an absent request is not a reason to let anybody through.
    const caller = await this.authenticator.authenticate(request?.headers?.cookie);
    if (caller === null) {
      throw new MoneyGateUnauthenticatedException();
    }

    /**
     * `fixedAt(caller.at)`, not a fresh clock.
     *
     * The session was judged live at `caller.at`; asking the age question off a
     * second reading would let one request straddle a midnight and answer two
     * questions about two days. On this gate, one of those two answers is "yes,
     * take their money".
     */
    if (!canReceiveMoney(caller.user, fixedAt(caller.at))) {
      throw new MoneyGateForbiddenException();
    }

    // Only after the gate has been passed. A handler can then serve the person the
    // gate actually judged, without a second session read. `request` is non-null
    // on this line: an absent one produced a `null` caller two branches up.
    attachMoneyInCaller(request as FastifyRequest, caller);
    return true;
  }

  /**
   * Whether this route declared itself inbound money.
   *
   * The HANDLER only, never the class — the same rule `RateLimitGuard` follows and
   * for a sharper reason here. `getAllAndOverride` also reads class metadata, so a
   * single decorator on an Epic 3 money controller would gate its READ routes too,
   * and "you may not look at your own Số dư" is a refusal nobody would think to
   * test for. `@MoneyIn` is typed `MethodDecorator`, so writing it on a class is a
   * compile error, and reading only the handler means reflection could not put it
   * there either.
   *
   * `=== true` rather than a truthy check: the metadata is `unknown`, and the only
   * value the decorator ever writes is `true`. Anything else is not a marked route.
   */
  private isMoneyIn(context: ExecutionContext): boolean {
    const declared: unknown = this.reflector.get(MONEY_IN_METADATA, context.getHandler());
    return declared === true;
  }
}
