import { Controller, Get, Inject } from '@nestjs/common';
import { healthResponseSchema, type HealthResponse } from '@stuwith/contracts';
import { APP_CONFIG, type AppConfig } from '../config.token';

@Controller()
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Liveness only — no DB round trip. A health endpoint that needs Postgres turns a
   * slow query into a restart loop, which is the opposite of what it is for.
   * The response is parsed through the contract schema so a drift between this
   * shell and packages/contracts fails here rather than in a client (AD-13).
   */
  @Get('healthz')
  healthz(): HealthResponse {
    return healthResponseSchema.parse({
      status: 'ok',
      service: 'realtime-gateway',
      version: this.config.APP_VERSION,
    });
  }
}
