import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { SESSION_AUTHENTICATOR, SessionAuthenticator } from './session-authenticator';

/**
 * ONE {@link SessionAuthenticator} for the process, registered once and exported
 * to every module that needs it.
 *
 * It is `@Global()` for exactly one export, following the precedent
 * `RateLimitModule` set with `RateLimitHealth`. The alternative — the shape this
 * started as — was a `useValue` in `AuthModule` and a second `useValue` in
 * `MoneyModule`, both pointing at an object `AppModule` built. That works, and it
 * is wrong for a reason that only shows up later: the count of registrations grows
 * with the count of consumers, so Epic 3's money module would be a third copy of
 * the same three lines, and the day one of them is given a different instance
 * nothing fails. A guard that resolves one person while the handler serves another
 * is not a failure any test would spell out.
 *
 * The runtime is passed IN rather than constructed here, for the same reason
 * `RateLimitModule` takes its port: `AppModule` builds the adapters once so that a
 * test replacing the session store replaces it for everybody.
 */
@Global()
@Module({})
export class SessionAuthenticatorModule {
  static forRuntime(
    config: ApiEnv,
    runtime: ConstructorParameters<typeof SessionAuthenticator>[1],
  ): DynamicModule {
    return {
      module: SessionAuthenticatorModule,
      providers: [
        {
          provide: SESSION_AUTHENTICATOR,
          useValue: new SessionAuthenticator(config.SESSION_COOKIE_SECRET, runtime),
        },
      ],
      exports: [SESSION_AUTHENTICATOR],
    };
  }
}
