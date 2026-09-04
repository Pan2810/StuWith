import { HttpException } from '@nestjs/common';
import { RATE_LIMITED_MESSAGE, makeError } from '@stuwith/contracts';
import type { RateLimitChannel } from '@stuwith/domain';

/**
 * "This caller is over the limit", raised by the guard and turned into a response
 * by `RateLimitedFilter`.
 *
 * It carries the CHANNEL rather than a ready-made response because the two legs
 * answer in completely different shapes — a 303 back to the login page for a
 * browser, a 429 envelope for `fetch` — and building either one inside a guard
 * would mean the guard has to know about `WEB_BASE_URL`, redirects and cookies.
 *
 * The body handed to `HttpException` is a real {@link makeError} envelope, not the
 * bare string it used to be. The filter normally replaces it, but "normally" is
 * doing work there: if the filter is ever unregistered, reordered, or shadowed by
 * another `@Catch()`, Nest's default handler serialises THIS body — and a client
 * parsing `errorEnvelopeSchema` would get `{"message":"rate_limited",...}`, which
 * does not validate. The fallback is a valid envelope so the failure mode is a
 * missing `Retry-After` header rather than an unparseable response.
 *
 * It carries no reason. Which counter tripped, which dimension it was keyed on and
 * what the threshold is are all internal: the acceptance criterion is that the
 * person is told what happened and what to do, and nothing that would help
 * somebody calibrate their way under the limit.
 */
export class RateLimitedException extends HttpException {
  constructor(
    readonly channel: RateLimitChannel,
    readonly retryAfterSeconds: number,
  ) {
    super(
      makeError('rate_limited', RATE_LIMITED_MESSAGE, {
        retry_after_seconds: retryAfterSeconds,
      }),
      429,
    );
  }
}
