import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG } from './config.token';
import { buildLoggerParams } from './logging';
import { HealthController } from './health/health.controller';

@Module({})
export class AppModule {
  /**
   * The config is passed in, not read here: `main.ts` validates the environment
   * before anything else is constructed, so an incomplete environment can never
   * reach module wiring (AD-14).
   */
  static forConfig(config: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(buildLoggerParams(config))],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
