import { Module, type DynamicModule, type Type } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG } from './config.token';
import { AuthModule } from './auth/auth.module';
import { createProductionRuntime, type AuthRuntime } from './auth/auth.runtime';
import { buildLoggerParams } from './logging';
import { HealthController } from './health/health.controller';
import { MoneyModule } from './money/money.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RuntimeShutdown } from './runtime-shutdown';
import { SessionAuthenticatorModule } from './auth/session-authenticator.module';

/**
 * Three seams, all test-only, all following the precedent `loadApiConfig` set in
 * `packages/config`: the thing that makes a property checkable is injected rather
 * than reached for.
 *
 * - `authRuntime` lets the flow test supply in-memory adapters and a `fetch` that
 *   answers from an in-process authorization server.
 * - `logDestination` lets the PII test read the lines a REAL pino wrote during a
 *   real login, which is the only way to assert "no email reached a log line"
 *   about the actual wiring rather than about a hand-built logger.
 * - `fixtureControllers` lets the money-gate flow test mount a marked endpoint on
 *   the real application, which is the only way to show that marking a NEW route
 *   is the whole of what protecting it takes.
 *
 * None of them is reachable from the environment, and that claim is worth stating
 * PRECISELY, because a reader asked to check it by eye will open `main.ts` and see
 * `forConfig(config, { authRuntime: runtime })` — an options object, not a bare
 * call. What is true is the part that matters: `main.ts` passes `authRuntime` and
 * NOTHING else, so the log destination is stdout and the controller list is
 * `HealthController` alone. `authRuntime` is the one seam production does use, and
 * it uses it to hold the adapters' lifetime outside the module factory so the
 * failure path can close them — see the docblock in `main.ts`.
 */
export interface AppModuleOptions {
  readonly authRuntime?: AuthRuntime;
  readonly logDestination?: DestinationStream;
  /**
   * Extra controllers, test-only, and the third seam of the same family.
   *
   * `money-gate.flow.test.ts` has to prove that a NEW endpoint is protected by
   * doing nothing but marking itself `@MoneyIn()` — AC3, which cannot be shown by
   * any existing route, because no route in this product takes money in yet
   * (Epic 3 owns them all). The fixture controller therefore has to be mounted on
   * the real application, behind the real global guard, over real HTTP.
   *
   * Nothing production calls this: `main.ts` calls `forConfig(config)` and gets
   * `HealthController` and nothing else.
   */
  readonly fixtureControllers?: readonly Type<unknown>[];
}

@Module({})
export class AppModule {
  /**
   * The config is passed in, not read here: `main.ts` validates the environment
   * before anything else is constructed, so an incomplete environment can never
   * reach module wiring (AD-14).
   */
  static forConfig(config: ApiEnv, options: AppModuleOptions = {}): DynamicModule {
    /**
     * Built ONCE, here, and handed to every module that needs an adapter.
     *
     * It used to be constructed inside `AuthModule.forConfig`, which was fine
     * while auth was the only consumer. The rate-limit guard needs the same
     * Valkey client `AuthService` records failures through, and a second call to
     * `createProductionRuntime` would give it a second connection — and, in a
     * test, a second store that the assertions are not looking at.
     */
    const runtime = options.authRuntime ?? createProductionRuntime(config);

    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot(buildLoggerParams(config, options.logDestination)),
        RateLimitModule.forRuntime(config, runtime.rateLimit),
        // One `SessionAuthenticator` for the process, exported globally, so the
        // guard that runs before a handler and the service that runs inside it
        // cannot answer "who is calling" two different ways.
        SessionAuthenticatorModule.forRuntime(config, runtime),
        MoneyModule,
        AuthModule.forConfig(config, runtime),
      ],
      controllers: [HealthController, ...(options.fixtureControllers ?? [])],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        // `main.ts` calls `enableShutdownHooks()`; this is what it was calling for.
        // A Valkey client with a reconnect strategy keeps the event loop alive, so
        // without this the process looks like it is ignoring SIGTERM.
        { provide: RuntimeShutdown, useValue: new RuntimeShutdown(runtime) },
      ],
    };
  }
}
