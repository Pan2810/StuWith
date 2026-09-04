import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  REQUEST_ID_HEADER,
  compileTrustedProxies,
  resolveRequestId,
  type TrustedProxyTrust,
} from '@stuwith/config';
import { SIGN_IN_RETURN_PATH_QUERY_PARAM } from '@stuwith/contracts';
import type { RateLimitSubject } from '@stuwith/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { RateLimited } from '../rate-limit/rate-limit.decorator';
import { rateLimitSubjectOf } from '../rate-limit/request-identity';
import { AuthService, type AuthOutcome } from './auth.service';

/**
 * The Fastify-facing half. It contains no decisions: it reads the request, hands
 * the pieces to `AuthService`, and writes whatever outcome comes back.
 *
 * `@Res()` is used deliberately, which turns off Nest's automatic response
 * handling. This flow needs 302s with several `Set-Cookie` headers and a 204 with
 * no body, none of which a return value expresses.
 */
@Controller('v1/auth')
export class AuthController {
  /** Compiled once; the environment was already validated before a port was opened. */
  private readonly trust: TrustedProxyTrust;

  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const compiled = compileTrustedProxies(config.TRUSTED_PROXY_ADDRESSES);
    if (!compiled.ok) {
      throw new Error(`TRUSTED_PROXY_ADDRESSES ${compiled.problem}`);
    }
    this.trust = compiled.trust;
  }

  /**
   * The one leg that reads a proposed return path, and it does not judge it.
   *
   * The raw query value is handed down as `unknown` on purpose. `AuthService` owns
   * the verdict — through the shared `parseInternalReturnPath` in
   * `packages/contracts` — because a controller that pre-filtered would be a
   * second place where "is this destination safe" is decided, and two such places
   * are two places that can drift apart. This file contains no decisions; that is
   * the arrangement, and this parameter does not get to be the exception.
   *
   * A provider that is not enabled still answers `404`, and the ORDER is worth
   * stating accurately because an earlier version of this comment got it wrong.
   * The query is read here first, unconditionally; the 404 decision is made
   * further in, by `adapterFor` inside `AuthService.start`. What matters is not
   * that the reply is decided first but that it is decided the SAME WAY whatever
   * the query said — reading a parameter has no side effect, nothing about it is
   * logged, and the body a disabled provider returns is byte-identical to the one
   * an unknown provider returns whether or not `quay-ve` was present. Otherwise
   * the endpoint starts enumerating the deployment's configuration.
   * `auth.flow.test.ts` sends `/start?quay-ve=` at a disabled provider to hold
   * that.
   */
  @RateLimited('auth_start')
  @Get(':provider/start')
  async start(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const query = (request.query ?? {}) as Record<string, unknown>;
    send(
      reply,
      await this.auth.start(
        provider,
        requestIdOf(request, reply),
        query[SIGN_IN_RETURN_PATH_QUERY_PARAM],
      ),
    );
  }

  @RateLimited('auth_callback')
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const outcome = await this.auth.callback(
      provider,
      (request.query ?? {}) as Record<string, unknown>,
      request.headers.cookie,
      requestIdOf(request, reply),
      this.subjectOf(request),
    );
    send(reply, outcome);
  }

  /**
   * Apple's callback, and only Apple's.
   *
   * `response_mode=form_post` is mandatory once the scope asks for `name` or
   * `email`, and Apple then POSTs a form-encoded body to this URL instead of
   * redirecting with query parameters. Same handler, different transport: the
   * parameters are read from the body rather than the query string.
   *
   * The `SameSite=Lax` state cookie DOES ride along with it, because Apple's POST
   * is a top-level form submission — the case `Lax` explicitly allows and `Strict`
   * would not.
   */
  @RateLimited('auth_callback')
  @Post(':provider/callback')
  async callbackFormPost(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const outcome = await this.auth.callback(
      provider,
      body,
      request.headers.cookie,
      requestIdOf(request, reply),
      this.subjectOf(request),
    );
    send(reply, outcome);
  }

  @RateLimited('auth_refresh')
  @Post('refresh')
  async refresh(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    send(
      reply,
      await this.auth.refresh(
        request.headers.cookie,
        requestIdOf(request, reply),
        this.subjectOf(request),
      ),
    );
  }

  /**
   * The ONE route in this controller with no `@RateLimited(...)`, and the omission
   * is the feature.
   *
   * Every other endpoint being limited is an inconvenience. Logging out being
   * limited keeps somebody inside a session they are actively trying to leave —
   * on a shared machine that is a security failure, not a nuisance. There is also
   * nothing to gain from hammering it: it revokes a chain the caller already
   * holds.
   *
   * This is not an exemption somebody could delete and get a limit back:
   * `RateLimitAction` in `packages/domain` has no name for logging out, so there
   * is nothing that could be written in the parentheses.
   */
  @Post('logout')
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    send(reply, await this.auth.logout(request.headers.cookie));
  }

  @RateLimited('auth_me')
  @Get('me')
  async me(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    send(reply, await this.auth.me(request.headers.cookie));
  }

  /**
   * Story 1.4 — the first-login declaration.
   *
   * The body goes down as `unknown`, like the return-path proposal on `/start`
   * and for the same reason: `AuthService` owns the verdict, through the shared
   * `parseDateOfBirth` in `packages/contracts`. A controller that pre-checked the
   * shape would be a second place where "is this a date of birth" is decided, and
   * this file contains no decisions.
   *
   * `POST`, and there is no `PATCH` or `PUT` beside it. That is not an omission
   * to be filled in later: the value is written once and changing it goes through
   * support, so a route that could update one must not exist for somebody to
   * find.
   */
  @RateLimited('auth_date_of_birth')
  @Post('date-of-birth')
  async recordDateOfBirth(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    send(reply, await this.auth.recordDateOfBirth(request.headers.cookie, request.body));
  }

  /**
   * The same address and credential the guard counted this request against.
   *
   * Computed through the same two functions, deliberately: a failed sign-in has to
   * land on the brute-force keys the guard will later read, and two call sites
   * inferring "who is this" separately is how those two stop being the same keys.
   *
   * TOTAL, like the guard's copy. Both functions read attacker-supplied values —
   * a header and a cookie header — and the guard wraps its pair in a `try` with a
   * comment saying a throw there would be "a 500 on a layer whose entire posture is
   * to fail open". This one sat outside any `try` and did exactly that on
   * `/callback` and `/refresh`: a hostile cookie would have turned a login into a
   * 500 rather than the 303 Story 1.3 part 1 established. `clientIpOf` and
   * `userHandleOf` are now total in themselves, and this is the belt to that
   * braces — the brute-force bookkeeping is never worth failing a request over.
   *
   * It is now literally the same FUNCTION the guard calls, not the same pair of
   * calls written out twice, and the difference mattered: this copy wrapped both
   * in ONE `try`, so a throw out of the cookie half discarded an address the
   * guard had resolved perfectly well on the same request — the two halves of the
   * brute-force bookkeeping then keyed on different values, which is the exact
   * disagreement the shared answer exists to prevent. `rateLimitSubjectOf` gives
   * each half its own `try`.
   */
  private subjectOf(request: FastifyRequest): RateLimitSubject {
    return rateLimitSubjectOf(request, this.trust, this.config.SESSION_COOKIE_SECRET);
  }
}

/**
 * The id that is already on every log line for this request.
 *
 * The logger's `genReqId` stamps it on the raw response as `x-request-id` before
 * anything else runs, so reading it back here is what makes an audit row and its
 * log lines join up. The fallbacks exist because an audit row without a request id
 * is not an audit row — `AuditPort` rejects one — and a login must not fail
 * because the logging middleware was not wired.
 */
function requestIdOf(request: FastifyRequest, reply: FastifyReply): string {
  const stamped = reply.raw.getHeader(REQUEST_ID_HEADER);
  if (typeof stamped === 'string' && stamped.length > 0) {
    return stamped;
  }
  const onRaw = (request.raw as unknown as { id?: unknown }).id;
  if (typeof onRaw === 'string' && onRaw.length > 0) {
    return onRaw;
  }
  // Last resort: derive one the same way the logger would have.
  return resolveRequestId(request.headers[REQUEST_ID_HEADER], randomUUID);
}

function send(reply: FastifyReply, outcome: AuthOutcome): void {
  if (outcome.cookies.length > 0) {
    // Fastify accumulates `set-cookie` into an array; handing it the array in one
    // call is the form that is documented to work in every version, whereas
    // repeated single-value calls have historically depended on that special case.
    reply.header('set-cookie', [...outcome.cookies]);
  }

  switch (outcome.kind) {
    case 'redirect':
      // 302 by default, because the leg that dominates this flow — `/start`
      // sending the browser to the provider — is a GET, and 302 is what every
      // OAuth client library and provider expects there.
      //
      // The callback leg is not always a GET, which is why the status is the
      // service's to choose. Apple delivers its callback as a cross-site form
      // POST, and answering a POST with 302 formally means "repeat this request
      // at the new URL"; browsers downgrade it to GET by convention, not by
      // specification. `failedSignIn` therefore returns 303, where the downgrade
      // is what the status actually says.
      void reply
        .status(outcome.status ?? 302)
        .header('location', outcome.location)
        .send();
      return;
    case 'json':
      void reply.status(outcome.status).send(outcome.body);
      return;
    case 'empty':
      void reply.status(outcome.status).send();
      return;
  }
}
