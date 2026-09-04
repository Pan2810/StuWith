import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import {
  AUTH_COOKIE_PATH,
  RATE_LIMITED_MESSAGE,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_PATHNAME,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  makeError,
} from '@stuwith/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clearCookie, oauthStateCookies, parseCookies } from '../auth/cookies';
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
    const request = host.switchToHttp().getRequest<FastifyRequest>();

    if (exception.channel === 'browser') {
      /**
       * The attempt cookies this refused request would have cleared itself.
       *
       * A guard runs BEFORE the handler, so a refused `/callback` never reaches
       * `failedSignIn` — the one place that clears the per-attempt state cookie.
       * Each blocked attempt therefore left its cookie behind until `Max-Age` ran
       * out, and since `/start` mints one per attempt, a burst against a locked
       * address grew the `Cookie` header on every later request from that browser
       * until the server refused the header itself.
       *
       * Only the callback leg, deliberately. A refused `/start` has minted
       * nothing, and clearing there would kill an attempt that is in flight in
       * another tab.
       */
      const doomed =
        exception.action === 'auth_callback'
          ? oauthStateCookies(parseCookies(request.headers?.cookie)).map(([name]) =>
              clearCookie(name, AUTH_COOKIE_PATH),
            )
          : [];
      if (doomed.length > 0) {
        reply.header('set-cookie', doomed);
      }

      /**
       * `new URL(path, base)`, and the path from `packages/contracts` — the same
       * two rules `AuthService` follows, because this is the SAME page.
       *
       * It used to be `new URL(`${WEB_BASE_URL}/dang-nhap`)`: a second spelling of
       * the route and a second way of joining it to the base. `WEB_BASE_URL` is
       * now refused unless it is a bare origin, so the two forms cannot disagree
       * any more — but they were free to, and for one release they did.
       */
      const location = new URL(SIGN_IN_PATHNAME, this.config.WEB_BASE_URL);
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
