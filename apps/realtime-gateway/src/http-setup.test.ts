import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RealtimeGatewayEnv } from '@stuwith/config';
import { REQUEST_ID_HEADER, REQUEST_ID_MAX_LENGTH } from '@stuwith/config';
import { Logger } from 'nestjs-pino';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { configureHttpApp, fastifyAdapterOptions } from './http-setup';

/**
 * The gateway, actually running.
 *
 * ## Why this file exists at all
 *
 * Every other example in this directory reads the options `buildLoggerParams`
 * returns. That is the right test for a policy and the wrong one for a PROCESS:
 * `main.ts` is the one file here no test constructed, so a decision made only
 * there was a decision nothing could execute. Story 1.7 puts the request-id
 * decision on the Fastify adapter and the echo on a Fastify hook — both of them
 * `main.ts` wiring — so both are now driven over a socket instead.
 *
 * It is cheap. The process has five source files, one route (`/healthz`), no
 * database, no auth and no WebSocket, so booting it costs a port and a few
 * milliseconds.
 *
 * ## What it proves that `logging.test.ts` cannot
 *
 * `resolveRequestId` had never run on a real request in EITHER process between
 * Story 1.1 and Story 1.7: `genReqId` lived in the pino options, and `pino-http`
 * writes `req.id = req.id || genReqId(...)` after Fastify has already assigned an
 * id. Both processes therefore stamped Fastify's `req-1`, `req-2` counter — which
 * they mint independently, so a gateway request and an api request collide on the
 * same id and a search for one returns the other. That is the specific thing this
 * file exists to keep fixed, in the process where it is least likely to be noticed.
 */
const config: RealtimeGatewayEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  APP_VERSION: '0.1.0-test',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'x'.repeat(32),
  GATEWAY_PORT: 3002,
  REALTIME_DATABASE_URL: 'postgres://test@127.0.0.1:5432/test',
};

/** An ephemeral port, so two suites in this project never fight over one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

describe('the realtime gateway, running', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  const logLines: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;

    /**
     * The SAME wiring `main.ts` applies, in the same order.
     *
     * Building the adapter without `fastifyAdapterOptions()` here would test a
     * server nobody deploys — which is exactly how a `genReqId` that never ran
     * survived six stories.
     */
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule.forConfig(config, {
        logDestination: new Writable({
          write(chunk, _encoding, callback) {
            logLines.push(String(chunk));
            callback();
          },
        }),
      }),
      new FastifyAdapter(fastifyAdapterOptions()),
      { logger: false, bufferLogs: true },
    );
    app.useLogger(app.get(Logger));
    configureHttpApp(app);
    await app.listen({ port, host: '127.0.0.1' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function get(headers: Record<string, string> = {}): Promise<{
    echoed: string | null;
    logged: string;
  }> {
    const before = logLines.length;
    const response = await fetch(`${baseUrl}/healthz`, { headers });
    await response.text();
    for (let waited = 0; waited < 200 && logLines.length === before; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { echoed: response.headers.get(REQUEST_ID_HEADER), logged: logLines.slice(before).join('') };
  }

  it('serves its one route, so every assertion below is about a live process', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'realtime-gateway' });
  }, 60_000);

  it('honours a well-formed inbound request id, in the process that receives the hop', async () => {
    // This is the half of "traceable across both processes" the gateway owns: an
    // id minted by `apps/api` and forwarded here has to survive. Until Story 1.7 it
    // did not — this process replaced it with its own `req-N` counter.
    const incoming = '018f9c2e-6a1b-7c3d-9e4f-a1b2c3d4e5f6';
    const { echoed, logged } = await get({ [REQUEST_ID_HEADER]: incoming });

    expect(echoed).toBe(incoming);
    expect(JSON.parse(logged.trim()) as Record<string, unknown>).toMatchObject({
      request_id: incoming,
      service: 'realtime-gateway',
    });
  }, 60_000);

  it('mints and echoes one when the caller sends none', async () => {
    const { echoed, logged } = await get();

    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    // Not Fastify's `req-N` counter, which BOTH processes mint independently and
    // therefore collide on.
    expect(echoed).not.toMatch(/^req-\d+$/);
    expect(logged).toContain(String(echoed));
  }, 60_000);

  it.each([
    ['a space', 'has space here'],
    ['JSON, which would restructure the record', '{"level":50,"msg":"injected"}'],
    ['a value over the length cap', 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1)],
    ['an empty value', ''],
  ])('replaces %s and echoes only the sanitised id', async (_label, hostile) => {
    const { echoed, logged } = await get({ [REQUEST_ID_HEADER]: hostile });

    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    if (hostile.length > 0) {
      // Echoing the raw value would make this a reflection point; logging it is the
      // forging half.
      expect(echoed).not.toContain(hostile);
      expect(logged).not.toContain(hostile);
    }
    // One well-formed line, which a brace or a newline in the id would have broken.
    const lines = logged.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow();
  }, 60_000);

  it('writes a line worth keeping: the path, the status and the latency', async () => {
    // The allow-list's own named failure mode is being too strict. `/healthz` is
    // the only route this process has, so if these three vanish the gateway's log
    // says nothing at all.
    const { logged } = await get();
    const record = JSON.parse(logged.trim()) as Record<string, unknown>;

    expect((record['req'] as Record<string, unknown>)['url']).toBe('/healthz');
    expect((record['res'] as Record<string, unknown>)['statusCode']).toBe(200);
    expect(typeof record['responseTime']).toBe('number');
  }, 60_000);
});
