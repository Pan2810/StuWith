import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MoneyGateGuard } from './money-gate.guard';

/**
 * Registers the age gate GLOBALLY, which is what makes `@MoneyIn()` the whole
 * interface — the shape the epic context asks for by name: "guard áp dụng tự động
 * qua decorator/metadata".
 *
 * A guard applied route by route is one more thing to remember on a new endpoint,
 * and Epic 3 will add several at once. The endpoint that gets forgotten is, by
 * construction, an endpoint that takes a child's money — so "remember to add it"
 * is not an acceptable mechanism. Global is safe here for exactly the reason it is
 * safe for `RateLimitModule`: {@link MoneyGateGuard} returns `true` on any route
 * with no metadata, before it fetches the request, so an unmarked route reads no
 * cookie, touches no database and changes no behaviour.
 *
 * ## No filter, unlike `RateLimitModule`
 *
 * Both refusals are an envelope and a status. Nest's default handler serialises an
 * `HttpException` whose response is an object verbatim, so
 * `money-gate.exception.ts` already produces the exact body. A filter would be a
 * second place the response shape is decided, and the point of this module is that
 * there are no second places.
 *
 * ## Static, and it takes nothing
 *
 * There is no `forRuntime(...)` here because there is nothing runtime-shaped to
 * pass: the guard's one dependency, `SESSION_AUTHENTICATOR`, is exported by the
 * `@Global()` {@link SessionAuthenticatorModule}. This module used to accept the
 * authenticator and register it a second time, which made the number of copies of
 * one object grow with the number of modules that wanted it.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: MoneyGateGuard }],
})
export class MoneyModule {}
