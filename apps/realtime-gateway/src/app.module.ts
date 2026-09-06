import { Module, type DynamicModule } from '@nestjs/common';
import type { RealtimeGatewayEnv } from '@stuwith/config';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG } from './config.token';
import { buildLoggerParams } from './logging';
import { HealthController } from './health/health.controller';

/**
 * One seam, test-only, and the same one `apps/api` has had since Story 1.2.
 *
 * `logDestination` lets a test read the lines a REAL pino wrote during a real
 * request, which is the only way to assert anything about the actual wiring rather
 * than about a logger the test built for itself. `main.ts` passes nothing, so the
 * destination in production is stdout.
 *
 * It exists here because the gateway is the process whose wiring nothing executed:
 * every other example in this directory inspects the options object
 * `buildLoggerParams` returns, and an options object cannot show that `main.ts`
 * assembled them correctly.
 */
export interface AppModuleOptions {
  readonly logDestination?: DestinationStream;
}

@Module({})
export class AppModule {
  /**
   * The config is passed in, not read here: `main.ts` validates the environment
   * before anything else is constructed, so an incomplete environment can never
   * reach module wiring (AD-14).
   */
  static forConfig(config: RealtimeGatewayEnv, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(buildLoggerParams(config, options.logDestination))],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
