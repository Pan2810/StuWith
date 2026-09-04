import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { APP_CONFIG } from '../config.token';
import { AuthController } from './auth.controller';
import { AUTH_RUNTIME, type AuthRuntime } from './auth.runtime';
import { AuthService } from './auth.service';

@Module({})
export class AuthModule {
  /**
   * Like `AppModule.forConfig`, the config is passed in rather than read here:
   * `main.ts` validates the environment before anything is constructed, so an
   * incomplete environment can never reach module wiring (AD-14).
   *
   * `runtime` is injectable so the flow test can supply in-memory adapters and a
   * fetch that answers from an in-process authorization server. That is the ONLY
   * reason it is a parameter — production always uses `createProductionRuntime`,
   * and there is no environment variable that switches it.
   *
   * It is REQUIRED rather than optional: `AppModule.forConfig` builds it, because
   * the rate-limit guard has to be handed the same `RateLimitPort` this service
   * writes failures through. A default constructed in here would silently give
   * the two halves of one feature two different stores.
   */
  static forConfig(config: ApiEnv, runtime: AuthRuntime): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: APP_CONFIG, useValue: config },
        { provide: AUTH_RUNTIME, useValue: runtime },
      ],
    };
  }
}
