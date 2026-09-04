import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '@stuwith/config';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG } from './config.token';
import { AuthModule } from './auth/auth.module';
import { createProductionRuntime, type AuthRuntime } from './auth/auth.runtime';
import { buildLoggerParams } from './logging';
import { HealthController } from './health/health.controller';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RuntimeShutdown } from './runtime-shutdown';

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
    /**
     * Built ONCE, here, and handed to both modules.
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
        AuthModule.forConfig(config, runtime),
      ],
      controllers: [HealthController],
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
