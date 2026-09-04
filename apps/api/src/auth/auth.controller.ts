import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { REQUEST_ID_HEADER, resolveRequestId } from '@stuwith/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
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
  constructor(private readonly auth: AuthService) {}

  @Get(':provider/start')
  async start(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    send(reply, await this.auth.start(provider, requestIdOf(request, reply)));
  }

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
    );
    send(reply, outcome);
  }

  @Post('refresh')
  async refresh(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    send(reply, await this.auth.refresh(request.headers.cookie, requestIdOf(request, reply)));
  }

  @Post('logout')
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    send(reply, await this.auth.logout(request.headers.cookie));
  }

  @Get('me')
  async me(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    send(reply, await this.auth.me(request.headers.cookie));
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
