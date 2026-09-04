import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { ApiEnv } from '@stuwith/config';
import type { RateLimitPort } from '@stuwith/domain';
import { APP_CONFIG } from '../config.token';
import { RateLimitHealth } from './rate-limit-health';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_PORT } from './rate-limit.tokens';
import { RateLimitedFilter } from './rate-limited.filter';

/**
 * Registers the guard and the filter GLOBALLY, which is what makes the decorator
 * the whole interface — and is `@Global()` for exactly one export,
 * {@link RateLimitHealth}.
 *
 * The guard and `AuthService` both talk to the counter store on the same request,
 * and both have to fail open when it does not answer. If each kept its own idea of
 * "are we degraded", one outage would produce two independent log storms and two
 * disagreeing recovery lines. One shared instance means one line in, one line out,
 * and one honest count of how many checks were skipped.
 *
 * A guard applied route by route is one more thing to remember on a new endpoint,
 * and the epic context is explicit that the age gate — the same shape — has to be
 * automatic. Global here is safe because the guard is a no-op on any route with no
 * `@RateLimited(...)` metadata: it looks the action up, finds nothing, and returns
 * `true` without touching Valkey.
 *
 * The port is passed IN rather than constructed here so that the whole process
 * shares one Valkey connection with `AuthService`, which needs the same store to
 * record failures and to clear them after a success. Two clients would be two
 * connection pools and, worse, two places for a test to replace only one of them.
 */
@Global()
@Module({})
export class RateLimitModule {
  static forRuntime(config: ApiEnv, rateLimit: RateLimitPort): DynamicModule {
    return {
      module: RateLimitModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RATE_LIMIT_PORT, useValue: rateLimit },
        RateLimitHealth,
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_FILTER, useClass: RateLimitedFilter },
      ],
      exports: [RateLimitHealth],
    };
  }
}
