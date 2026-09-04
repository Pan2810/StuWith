import { SetMetadata } from '@nestjs/common';

/**
 * The only way a route becomes "money coming IN".
 *
 * The epic context asks for exactly this shape: "guard áp dụng **tự động** qua
 * decorator/metadata — endpoint mới chỉ cần đánh dấu là hành vi có tiền đi vào,
 * không chép lại điều kiện tuổi". The alternative — an `if` at the top of each
 * handler — drifts the moment Epic 3 adds its fourth money endpoint by copying the
 * third without its condition. Nothing would say so, and the endpoint that forgot
 * would be the one taking a child's money.
 *
 * A route with no decorator is not gated, and that default is the reason global
 * registration is safe: {@link MoneyGateGuard} returns `true` before it reads a
 * cookie or touches a database. Every route that exists today takes that branch.
 */
export const MONEY_IN_METADATA = 'stuwith:money-in';

/**
 * `MethodDecorator`, never `ClassDecorator`, copied deliberately from
 * `@RateLimited` — including the type, which is the enforcement rather than a
 * convention.
 *
 * A class-level marker would gate every route in the controller, and in Epic 3 a
 * money controller will hold READ routes beside its write ones ("what is my
 * balance", "what is my price"). Gating those on age would tell a seventeen-year
 * old they may not look at their own wallet, which is not what the rule says and
 * not a refusal anybody would think to test for. Narrowing the type makes writing
 * it on a class a compile error, and the guard reads only handler metadata, so it
 * cannot arrive by reflection either.
 *
 * It carries NO argument. There is nothing an endpoint could usefully vary: the
 * threshold is a business constant in `packages/domain`, and a parameter here
 * would be the first step towards a per-endpoint age rule — which is the thing
 * this whole story exists to make impossible.
 *
 * ## READ THIS BEFORE MARKING AN EPIC 3 ENDPOINT
 *
 * The mark gates the CALLER, and the guard asks `canReceiveMoney(caller)`. So it
 * is correct on exactly one shape of endpoint: **the caller is the RECIPIENT**.
 *
 * That covers all three behaviours the epic names — turning on "nhận hỏi riêng",
 * setting a Đơn giá, receiving coins — because in each of them the person making
 * the request is the person the money would arrive at. It is NOT a general "this
 * route involves money" marker, and putting it on an endpoint where a SENDER posts
 * a payment gets the rule exactly backwards, in both directions at once:
 *
 * - it would refuse a seventeen-year-old PAYER, and the epic is explicit that
 *   somebody under 18 may still spend coins;
 * - it would let an adult payer send money to a recipient who is a minor, which is
 *   the transfer the rule exists to stop — the gate would pass, having asked about
 *   the wrong person entirely.
 *
 * Neither failure looks like a failure. The endpoint is marked, the guard runs,
 * the tests are green. An endpoint where the sender and the recipient are
 * different people needs a gate that names the recipient, and `deferred-work.md`
 * records that as a decision Epic 3 owns rather than something to improvise.
 */
export const MoneyIn = (): MethodDecorator => SetMetadata(MONEY_IN_METADATA, true);
