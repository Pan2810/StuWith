import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { moneyInCallerOf } from '../money-gate.request';
import { MoneyIn } from '../money-in.decorator';

/**
 * The "endpoint mẫu" of AC3, and it exists only so a test can watch a NEW money
 * endpoint be protected by nothing but the mark on it.
 *
 * ## Read this file for what is NOT in it
 *
 * There is no age here. No threshold, no `canReceiveMoney`, no `isAdult`, no date
 * of birth, no `if`. One decorator, and the route is gated — which is the entire
 * acceptance criterion, and `money-gate.flow.test.ts` asserts that absence
 * mechanically by reading this file rather than trusting the sentence above.
 *
 * ## Why it is a real file under `src/` and not a class inside the test
 *
 * Two reasons, and the second is the one that matters. It is typechecked (only
 * `src/**\/*.test.ts` is excluded from `apps/api/tsconfig.json`), so the shape a
 * future Epic 3 controller is meant to copy is a shape the compiler has agreed to.
 * And it is transformed the same way every other decorated class in this app is,
 * rather than by whatever a file outside the project's `include` happens to get.
 *
 * ## It is never mounted in production
 *
 * Three things have to be true at once, and each is checked rather than asserted:
 *
 *  1. `AppModule.forConfig` mounts extra controllers only through
 *     `options.fixtureControllers`, and `main.ts` never passes that key — it
 *     passes `authRuntime` and nothing else. Read `main.ts` and you will see an
 *     options object, so "production calls `forConfig(config)`" would have been the
 *     wrong sentence to check this by.
 *  2. Nothing outside a test or a `__testing__` directory imports this class.
 *  3. `apps/api/tsconfig.build.json` excludes `src/**\/__testing__/**`, so it is
 *     typechecked by the repo-wide `tsc -b` and absent from `dist`.
 *
 * `tests/gates/money-fixture-containment.test.ts` holds (1) and (2); (3) is
 * observable as `dist/money/__testing__` not existing after a build.
 */

/** The routes, spelled once, so the test cannot assert against its own copy. */
export const MONEY_FIXTURE_BASE = 'v1/__fixture__/money';
export const MONEY_FIXTURE_IN_PATH = `/${MONEY_FIXTURE_BASE}/nhan-coin`;
export const MONEY_FIXTURE_OPEN_PATH = `/${MONEY_FIXTURE_BASE}/so-du`;
export const MONEY_FIXTURE_THROWS_PATH = `/${MONEY_FIXTURE_BASE}/hong`;

/** The sentence the throwing route fails with, so a test can find its log line. */
export const MONEY_FIXTURE_FAILURE = 'money fixture handler failed on purpose';

@Controller(MONEY_FIXTURE_BASE)
export class MoneyFixtureController {
  /**
   * Every call that actually REACHED a handler, in order.
   *
   * "The handler did not run" is a claim about this array, not about a status
   * code: a 403 with the handler already run would look identical from outside,
   * and on a real money endpoint that is the difference between a refusal and a
   * refund.
   */
  static readonly reached: string[] = [];

  static reset(): void {
    MoneyFixtureController.reached.length = 0;
  }

  /** Inbound money. The mark is the whole of the protection. */
  @MoneyIn()
  @HttpCode(200)
  @Post('nhan-coin')
  receive(@Req() request: FastifyRequest): { readonly userId: string; readonly at: string } {
    MoneyFixtureController.reached.push('receive');
    // The caller the GATE resolved, not a second reading of the session.
    const caller = moneyInCallerOf(request);
    return { userId: caller.user.id, at: caller.at.toISOString() };
  }

  /**
   * A gated handler that FAILS after the gate let it through.
   *
   * It exists for `logging.test.ts`, and it is the most dangerous shape this
   * module has: the guard has already put the resolved caller on the request, and
   * an unhandled throw is the one path where a framework serialises request
   * context into a log line it writes on its own. Every other example asserts
   * "nothing leaked" about a request the application handled successfully; this
   * one asserts it about a request the application did not handle at all.
   */
  @MoneyIn()
  @Post('hong')
  fails(): never {
    MoneyFixtureController.reached.push('fails');
    throw new Error(MONEY_FIXTURE_FAILURE);
  }

  /**
   * The same controller, unmarked — a stand-in for every route that exists today
   * and for the READ half of a future money controller. Nobody is gated here.
   */
  @Get('so-du')
  balance(): { readonly ok: true } {
    MoneyFixtureController.reached.push('balance');
    return { ok: true };
  }
}
