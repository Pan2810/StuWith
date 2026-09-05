import { HttpException } from '@nestjs/common';
import { MONEY_IN_FORBIDDEN_MESSAGE, UNAUTHENTICATED_MESSAGE, makeError } from '@stuwith/contracts';

/**
 * The two refusals {@link MoneyGateGuard} can produce, as exceptions carrying a
 * REAL envelope.
 *
 * ## Why there is no filter here, unlike the rate limiter
 *
 * `RateLimitedFilter` exists because a refused login has to become a 303 back to a
 * page, with cookies cleared and a `Retry-After` header — none of which a return
 * value expresses. This gate needs neither: the answer is an envelope and a status
 * and nothing else. Nest's default handler sends an `HttpException` whose response
 * is an OBJECT verbatim, so the body below is the body the caller receives. A
 * filter would be a second place the shape is decided.
 *
 * ## Why the body is `makeError(...)` and not a bare string
 *
 * Same reason `RateLimitedException` gives: a client parsing `errorEnvelopeSchema`
 * must not be handed `{"statusCode":403,"message":"..."}`, which is what Nest
 * builds when the response is a string. Constructing the envelope here means the
 * contract holds however the exception is eventually serialised.
 *
 * ## Neither carries `details`
 *
 * There is nothing a client could do with the reason, and every diagnostic in an
 * error body is a diagnostic in somebody's screenshot.
 */

/**
 * 401 — nobody has been identified yet.
 *
 * It comes BEFORE the age question, always. A request with no session that got a
 * 403 would have been told it is not old enough, which is an assertion about a
 * person the system has not identified; and "sign in" is the honest next step for
 * a caller who has not.
 *
 * The sentence is `UNAUTHENTICATED_MESSAGE`, byte for byte what `/v1/auth/me`
 * answers, so the two 401s are indistinguishable.
 */
export class MoneyGateUnauthenticatedException extends HttpException {
  constructor() {
    super(makeError('unauthenticated', UNAUTHENTICATED_MESSAGE), 401);
  }
}

/**
 * 403 — identified, and not permitted to take money from another person.
 *
 * `forbidden` is a code that already exists in `ERROR_CODES`; a new one would be a
 * machine-readable way of saying "because of their age", which is exactly what the
 * sentence is forbidden from saying.
 *
 * Nothing here names an age, a date, or a threshold — see
 * {@link MONEY_IN_FORBIDDEN_MESSAGE}, which is held against `AGE_VOCABULARY` in
 * the contracts suite.
 */
export class MoneyGateForbiddenException extends HttpException {
  constructor() {
    super(makeError('forbidden', MONEY_IN_FORBIDDEN_MESSAGE), 403);
  }
}
