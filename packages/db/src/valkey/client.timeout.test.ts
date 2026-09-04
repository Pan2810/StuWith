import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_CONNECT_TIMEOUT_MS, createValkeyClient, type ValkeyClient } from './client';
import { ValkeyRateLimitAdapter } from './rate-limit-adapter';

/**
 * The matrix row "Valkey trả chậm", against a server that is genuinely slow.
 *
 * ## What the previous version of this file actually tested
 *
 * Nothing. `createValkeyClient` is `lazyConnect` with `enableOfflineQueue: false`,
 * and the test never connected — so every command rejected with "Stream isn't
 * writeable and enableOfflineQueue options is false" long before `commandTimeout`
 * was consulted. Deleting `commandTimeout` from `client.ts` left all four examples
 * green, which is the exact gap this file had been added to close.
 *
 * So the client is CONNECTED first. The server below completes the TCP handshake,
 * reads whatever arrives, and never writes a byte — a Valkey that is up,
 * reachable, and stuck. The assertions bound the rejection from BOTH sides:
 * removing `commandTimeout` makes it hang (upper bound fails), and setting it to
 * something much larger makes it late (lower bound is what proves the configured
 * value is the one in force).
 */
describe('a Valkey that accepts and never answers', () => {
  let server: net.Server;
  let port: number;
  const clients: ValkeyClient[] = [];
  /** Held open deliberately; destroying them is the teardown. */
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    /**
     * A server that completes the HANDSHAKE and then stalls.
     *
     * "Answers nothing at all" is not the scenario: `iovalkey`'s ready check sends
     * `INFO` on connect, so a wholly silent server never becomes ready and
     * `connect()` rejects with "Connection is closed" before any command is issued.
     * That is a connect failure, not a command timeout, and it is why the previous
     * version of this file could not reach the code it claimed to test.
     *
     * So `INFO` is answered — the one reply that gets the client to `ready` — and
     * every command after it is read and dropped. That is a Valkey that is up,
     * reachable, and wedged.
     */
    server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (chunk) => {
        if (chunk.toString('utf8').toUpperCase().includes('INFO')) {
          const payload = 'loading:0\r\n';
          socket.write(`$${payload.length}\r\n${payload}\r\n`);
        }
        // Anything else: read and discard. No reply, ever.
      });
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

  /**
   * A CONNECTED client pointed at the stalling server.
   *
   * `connect()` resolves once the socket is open — `iovalkey` does not wait for a
   * `PING`/`INFO` round trip to consider a lazy connection established — so the
   * next command really reaches the wire and really waits.
   */
  async function stalled(commandTimeoutMs: number): Promise<ValkeyClient> {
    const client = createValkeyClient(`redis://127.0.0.1:${port}`, {
      commandTimeoutMs,
      // The connect itself succeeds instantly here; it is the COMMAND that hangs.
      connectTimeoutMs: 2_000,
    });
    clients.push(client);
    await client.connect();
    return client;
  }

  const COMMAND_TIMEOUT_MS = 400;

  it('rejects a rate-limit check at roughly the configured command timeout', async () => {
    const adapter = new ValkeyRateLimitAdapter(await stalled(COMMAND_TIMEOUT_MS));

    const startedAt = Date.now();
    await expect(adapter.hit('t:slow', 5, 60)).rejects.toBeTruthy();
    const elapsed = Date.now() - startedAt;

    // BOTH bounds. The upper one fails if `commandTimeout` is removed (the command
    // then waits for ever). The lower one fails if the rejection came from
    // somewhere else entirely — an offline queue, a connection error — which is
    // how the previous version of this file passed while testing nothing.
    expect(elapsed, 'must not answer before the timeout it was given').toBeGreaterThanOrEqual(
      COMMAND_TIMEOUT_MS - 50,
    );
    expect(elapsed, 'must not wait much past it either').toBeLessThan(COMMAND_TIMEOUT_MS + 2_000);
  }, 30_000);

  it('rejects the read and write paths too, not only the counter', async () => {
    const adapter = new ValkeyRateLimitAdapter(await stalled(COMMAND_TIMEOUT_MS));

    await expect(adapter.remainingSeconds('t:slow')).rejects.toBeTruthy();
    await expect(adapter.lock('t:slow', 60)).rejects.toBeTruthy();
    await expect(adapter.clear('t:slow')).rejects.toBeTruthy();
  }, 30_000);

  it('never answers "allowed" when the store is merely slow', async () => {
    // The failure this rules out is the one that would switch the layer off
    // silently: an adapter that gave up waiting and returned a decision.
    const adapter = new ValkeyRateLimitAdapter(await stalled(COMMAND_TIMEOUT_MS));

    const outcome = await adapter.hit('t:slow', 5, 60).then(
      (decision) => ({ kind: 'resolved' as const, decision }),
      () => ({ kind: 'rejected' as const }),
    );

    expect(outcome.kind).toBe('rejected');
  }, 30_000);

  it('honours a SHORTER timeout, so the value is read rather than defaulted', async () => {
    const adapter = new ValkeyRateLimitAdapter(await stalled(120));

    const startedAt = Date.now();
    await expect(adapter.hit('t:short', 5, 60)).rejects.toBeTruthy();

    // Comfortably below the 400ms used above: if the option were ignored, both
    // examples would take the same time.
    expect(Date.now() - startedAt).toBeLessThan(COMMAND_TIMEOUT_MS);
  }, 30_000);
});

describe('the connect timeout has its own floor', () => {
  /**
   * Asserted on what `createValkeyClient` DOES, not on the constant.
   *
   * `expect(MIN_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)` compared a
   * constant to a literal and would have passed with the floor never applied.
   */
  const connectTimeoutOf = (client: ValkeyClient): number =>
    (client as unknown as { options: { connectTimeout: number } }).options.connectTimeout;

  it('does not inherit the (tiny) command timeout', () => {
    // A command timeout is deliberately ~250ms because the layer fails open. A TCP
    // handshake to a cold or distant Valkey needs seconds; inheriting 250ms there
    // fails every connect, the retry strategy loops, and the blocking layer is
    // permanently off next to a perfectly healthy server.
    const client = createValkeyClient('redis://127.0.0.1:1', { commandTimeoutMs: 250 });
    try {
      expect(connectTimeoutOf(client)).toBe(MIN_CONNECT_TIMEOUT_MS);
      expect(connectTimeoutOf(client)).toBeGreaterThan(250);
    } finally {
      client.disconnect();
    }
  });

  it('lets a command timeout LARGER than the floor raise the connect timeout too', () => {
    const client = createValkeyClient('redis://127.0.0.1:1', { commandTimeoutMs: 9_000 });
    try {
      expect(connectTimeoutOf(client)).toBe(9_000);
    } finally {
      client.disconnect();
    }
  });

  it('takes an explicit connect timeout when one is given', () => {
    const client = createValkeyClient('redis://127.0.0.1:1', {
      commandTimeoutMs: 250,
      connectTimeoutMs: 12_000,
    });
    try {
      expect(connectTimeoutOf(client)).toBe(12_000);
    } finally {
      client.disconnect();
    }
  });
});
