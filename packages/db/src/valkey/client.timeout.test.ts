import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_CONNECT_TIMEOUT_MS, createValkeyClient, type ValkeyClient } from './client';
import { ValkeyRateLimitAdapter } from './rate-limit-adapter';

/**
 * The matrix row "Valkey trả chậm", against a server that is genuinely slow.
 *
 * Nothing else in the suite tests it, and the gap was invisible: the flow test's
 * fake port throws by itself, the contract suite talks to a healthy container, and
 * `createFaultingPort` points at a REFUSED port — which fails instantly and
 * therefore proves nothing about a timeout. Delete `commandTimeout` from
 * `client.ts` and every one of those still passes, while production hangs every
 * `/v1/auth/*` request for as long as a wedged Valkey holds the socket open.
 *
 * So this file stands up a TCP server that accepts the connection, completes
 * nothing, and never writes a byte — the shape of a Valkey that is up, reachable,
 * and stuck. Needs no Docker.
 */
describe('a Valkey that accepts and never answers', () => {
  let server: net.Server;
  let port: number;
  const clients: ValkeyClient[] = [];
  /** Held open deliberately; destroying them is the teardown. */
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    server = net.createServer((socket) => {
      sockets.push(socket);
      // Read and discard. No reply, ever — not even a protocol error.
      socket.on('data', () => {});
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('could not bind the stalling server');
    }
    port = address.port;
  });

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const stalled = (commandTimeoutMs: number): ValkeyClient => {
    const client = createValkeyClient(`redis://127.0.0.1:${port}`, {
      commandTimeoutMs,
      // The connect itself succeeds instantly here; it is the COMMAND that hangs.
      connectTimeoutMs: 2_000,
    });
    clients.push(client);
    return client;
  };

  it('rejects a rate-limit check within the configured command timeout', async () => {
    const adapter = new ValkeyRateLimitAdapter(stalled(300));

    const startedAt = Date.now();
    await expect(adapter.hit('t:slow', 5, 60)).rejects.toBeTruthy();
    const elapsed = Date.now() - startedAt;

    // The number that matters is the upper bound: a request must not sit behind a
    // wedged store. Generous, because a CI runner under load is not a stopwatch —
    // but far below the "forever" that removing `commandTimeout` produces.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);

  it('rejects the read and write paths too, not only the counter', async () => {
    const adapter = new ValkeyRateLimitAdapter(stalled(300));

    await expect(adapter.remainingSeconds('t:slow')).rejects.toBeTruthy();
    await expect(adapter.lock('t:slow', 60)).rejects.toBeTruthy();
    await expect(adapter.clear('t:slow')).rejects.toBeTruthy();
  }, 30_000);

  it('never answers "allowed" when the store is merely slow', async () => {
    // The failure this rules out is the one that would switch the layer off
    // silently: an adapter that gave up waiting and returned a decision.
    const adapter = new ValkeyRateLimitAdapter(stalled(300));

    const outcome = await adapter.hit('t:slow', 5, 60).then(
      (decision) => ({ kind: 'resolved' as const, decision }),
      () => ({ kind: 'rejected' as const }),
    );

    expect(outcome.kind).toBe('rejected');
  }, 30_000);
});

describe('the connect timeout has its own floor', () => {
  it('does not inherit the (tiny) command timeout', () => {
    // A command timeout is deliberately ~250ms because the layer fails open. A
    // TCP handshake to a cold or distant Valkey needs seconds; inheriting 250ms
    // there fails every connect, the retry strategy loops, and the blocking layer
    // is permanently off next to a perfectly healthy server.
    expect(MIN_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
