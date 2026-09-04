import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import {
  RATE_LIMITED_MESSAGE,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  makeError,
} from '@stuwith/contracts';
import type { FastifyReply } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { RateLimitedException } from './rate-limited.exception';
import { RATE_LIMITED_OUTCOME } from './request-identity';

/**
 * Turns one refusal into the shape the caller can actually use.
 *
 * The split follows Story 1.3 part 1's decision exactly. `/start` and `/callback`
 * are reached by a browser following a navigation, so an envelope there is a page
 * of braces where a person expected to be back in the app; they get a redirect
 * carrying one word from the closed `SignInOutcome` vocabulary plus the seconds.
 * `/refresh` and `/me` are called by code that can read an envelope, so they get
 * `429`, the `rate_limited` code and `Retry-After`.
 */
@Catch(RateLimitedException)
export class RateLimitedFilter implements ExceptionFilter<RateLimitedException> {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  catch(exception: RateLimitedException, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception.channel === 'browser') {
      const location = new URL(`${this.config.WEB_BASE_URL}/dang-nhap`);
      location.searchParams.set(SIGN_IN_OUTCOME_QUERY_PARAM, RATE_LIMITED_OUTCOME);
      location.searchParams.set(
        SIGN_IN_RETRY_AFTER_QUERY_PARAM,
        String(exception.retryAfterSeconds),
      );

      // 303 for the same reason `failedSignIn` uses it: Apple delivers its
      // callback as a cross-site form POST, and 302 in answer to a POST formally
      // means "repeat this request over there". 303 says the downgrade to GET
      // explicitly, and the destination is a page to look at.
      void reply
        .status(303)
        // Sent on the redirect too. It costs nothing and it is the only
        // machine-readable form of the wait for anything that is not a browser.
        .header('retry-after', String(exception.retryAfterSeconds))
        .header('location', location.toString())
        .send();
      return;
    }

    void reply
      .status(429)
      .header('retry-after', String(exception.retryAfterSeconds))
      .send(
        makeError('rate_limited', RATE_LIMITED_MESSAGE, {
          // `detailValueSchema` accepts a number, so the countdown travels as one
          // rather than as a string a client would have to parse.
          retry_after_seconds: exception.retryAfterSeconds,
        }),
      );
  }
}
