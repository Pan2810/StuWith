import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { APP_CONFIG } from '../config.token';
import { AuthController } from './auth.controller';
import { AUTH_RUNTIME, createProductionRuntime, type AuthRuntime } from './auth.runtime';
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
   */
  static forConfig(config: ApiEnv, runtime?: AuthRuntime): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: APP_CONFIG, useValue: config },
        { provide: AUTH_RUNTIME, useValue: runtime ?? createProductionRuntime(config) },
      ],
    };
  }
}
