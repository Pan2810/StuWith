import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadApiConfig } from '@stuwith/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { createProductionRuntime } from './auth/auth.runtime';
import { configureHttpApp, fastifyAdapterOptions } from './http-setup';

async function bootstrap(): Promise<void> {
  // FIRST statement on purpose. AD-14 requires the process to exit non-zero,
  // naming the exact missing variable, BEFORE a port is opened.
  const config = loadApiConfig();

  /**
   * Built HERE, before `NestFactory.create`, and not inside the module factory.
   *
   * It used to be constructed while `AppModule.forConfig(config)` was being
   * evaluated as an ARGUMENT to `NestFactory.create` — so it opened a `pg` pool
   * and started a retrying Valkey client before the container existed. If anything
   * later in bootstrap threw, the `catch` below called `process.exit(1)` and
   * `RuntimeShutdown` was never constructed, let alone run: a process on its way
   * out with a client still trying to reconnect.
   *
   * Holding the reference here means the failure path can close it.
   */
  const runtime = createProductionRuntime(config);

  try {
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forConfig(config, { authRuntime: runtime }),
      // `trustProxy` from the environment, never a literal. See
      // `fastifyAdapterOptions` for why the wrong value here is invisible.
      new FastifyAdapter(fastifyAdapterOptions(config)),
      { bufferLogs: true },
    );
    app.useLogger(app.get(Logger));
    // CORS with credentials, and the form-encoded parser Apple's callback needs.
    // Shared with the flow-test harness so neither can drift from the other.
    configureHttpApp(app, config);
    // `RuntimeShutdown` is the hook this enables; without it a Valkey client with
    // a reconnect strategy keeps the event loop alive past SIGTERM.
    app.enableShutdownHooks();

    await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  } catch (error) {
    // Nest never got far enough to own the runtime, so nothing else will close it.
    await runtime.close().catch(() => {});
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  // Never print the environment here — only the failure.
  process.stderr.write(`[api] failed to start: ${String(error)}\n`);
  process.exit(1);
});
