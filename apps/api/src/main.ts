import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadApiConfig } from '@stuwith/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureHttpApp } from './http-setup';

async function bootstrap(): Promise<void> {
  // FIRST statement on purpose. AD-14 requires the process to exit non-zero,
  // naming the exact missing variable, BEFORE a port is opened.
  const config = loadApiConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forConfig(config),
    new FastifyAdapter(),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  // CORS with credentials, and the form-encoded parser Apple's callback needs.
  // Shared with the flow-test harness so neither can drift from the other.
  configureHttpApp(app, config);
  app.enableShutdownHooks();

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
}

void bootstrap().catch((error: unknown) => {
  // Never print the environment here — only the failure.
  process.stderr.write(`[api] failed to start: ${String(error)}\n`);
  process.exit(1);
});
