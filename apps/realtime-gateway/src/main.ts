import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadRealtimeGatewayConfig } from '@stuwith/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureHttpApp, fastifyAdapterOptions } from './http-setup';

async function bootstrap(): Promise<void> {
  // FIRST statement on purpose. AD-14 requires the process to exit non-zero,
  // naming the exact missing variable, BEFORE a port is opened.
  const config = loadRealtimeGatewayConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forConfig(config),
    // The SAME adapter options a test constructs. `genReqId` is in there, and an
    // adapter built without it mints Fastify's sequential counter instead of
    // honouring an inbound `x-request-id` — see `http-setup.ts`.
    new FastifyAdapter(fastifyAdapterOptions()),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  configureHttpApp(app);
  app.enableShutdownHooks();

  await app.listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' });
}

void bootstrap().catch((error: unknown) => {
  // Never print the environment here — only the failure.
  process.stderr.write(`[realtime-gateway] failed to start: ${String(error)}\n`);
  process.exit(1);
});
