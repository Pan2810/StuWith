import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG } from './config.token';
import { AuthModule } from './auth/auth.module';
import type { AuthRuntime } from './auth/auth.runtime';
import { buildLoggerParams } from './logging';
import { HealthController } from './health/health.controller';

/**
 * Two seams, both test-only, both following the precedent `loadApiConfig` set in
 * `packages/config`: the thing that makes a property checkable is injected rather
 * than reached for.
 *
 * - `authRuntime` lets the flow test supply in-memory adapters and a `fetch` that
 *   answers from an in-process authorization server.
 * - `logDestination` lets the PII test read the lines a REAL pino wrote during a
 *   real login, which is the only way to assert "no email reached a log line"
 *   about the actual wiring rather than about a hand-built logger.
 *
 * Neither is reachable from the environment: production calls `forConfig(config)`
 * and gets Postgres and stdout.
 */
export interface AppModuleOptions {
  readonly authRuntime?: AuthRuntime;
  readonly logDestination?: DestinationStream;
}

@Module({})
export class AppModule {
  /**
   * The config is passed in, not read here: `main.ts` validates the environment
   * before anything else is constructed, so an incomplete environment can never
   * reach module wiring (AD-14).
   */
  static forConfig(config: ApiEnv, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot(buildLoggerParams(config, options.logDestination)),
        AuthModule.forConfig(config, options.authRuntime),
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
