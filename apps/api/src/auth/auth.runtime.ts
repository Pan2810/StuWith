import type { ApiEnv } from '@stuwith/config';
import {
  PgAuditAdapter,
  PgIdentityAdapter,
  PgSessionAdapter,
  ValkeyRateLimitAdapter,
  createPool,
  createValkeyClient,
} from '@stuwith/db';
import type {
  AuditPort,
  ClockPort,
  IdentityPort,
  RateLimitPort,
  SessionPort,
} from '@stuwith/domain';
import { createProviderRegistry, type ProviderRegistry } from './providers/registry';

/**
 * Everything the auth module needs that is not the config: the three ports, a
 * clock, and the provider adapters.
 *
 * It is one injectable object rather than five providers so that a test can
 * replace the whole set in one line, and — more importantly — so that the
 * production wiring is a single function somebody can read top to bottom and see
 * exactly which adapter is talking to which store.
 */
export const AUTH_RUNTIME = Symbol('AUTH_RUNTIME');

export interface AuthRuntime {
  readonly identity: IdentityPort;
  readonly sessions: SessionPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly registry: ProviderRegistry;
  /**
   * Shared with `RateLimitModule`'s guard, deliberately.
   *
   * The guard counts an attempt; this service records the failure that follows it
   * and clears the counter after a success. Those are three views of ONE store, so
   * two clients would be two connection pools — and, worse, two places for a test
   * to replace only one of them and prove nothing.
   */
  readonly rateLimit: RateLimitPort;
  /**
   * Optional so a test can supply in-memory adapters that own no sockets.
   * Production always has one, and `RuntimeShutdown` calls it on SIGTERM.
   */
  close?(): Promise<void>;
}

/** The real clock. Lives here, not in the domain, because `Date` is ambient state. */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

export interface ProductionRuntime extends AuthRuntime {
  /** Drains the pool and drops the Valkey connection. Wired to `onApplicationShutdown`. */
  close(): Promise<void>;
}

/**
 * The production wiring: one `pg` pool as `stuwith_api` (AD-8), the three Postgres
 * adapters, and whichever providers the environment enabled.
 *
 * Constructing the pool does not open a connection, so this is safe to call during
 * module construction — `/healthz` still answers with the database down, which is
 * the property that keeps a slow query from becoming a restart loop.
 */
export function createProductionRuntime(
  config: ApiEnv,
  fetchImpl: typeof fetch = fetch,
): ProductionRuntime {
  const pool = createPool(config.API_DATABASE_URL);
  // A pg Pool emits 'error' for background connection failures, and an unhandled
  // 'error' event takes the whole process down — turning a transient database
  // blip into an outage of the login endpoint AND the health check.
  pool.on('error', () => {});

  /**
   * `createValkeyClient` is `lazyConnect`, so this opens no socket. That matters
   * here specifically: this function runs while the Nest modules are being wired,
   * and a connect that threw would take the process down before `/healthz` exists
   * — turning "Valkey is down" into "the API is down", which is the exact opposite
   * of the fail-open decision this whole feature rests on.
   */
  const valkey = createValkeyClient(config.VALKEY_URL, {
    commandTimeoutMs: config.VALKEY_COMMAND_TIMEOUT_MS,
  });

  /**
   * Warm the connection in the background, and ignore whether it worked.
   *
   * Without this the FIRST request after every start or reconnect is answered by
   * "Stream isn't writeable and enableOfflineQueue options is false" — the socket
   * is still opening — so it fails open, goes uncounted and writes an alarming
   * `error` line about the layer being off. That was measured, not guessed: with a
   * healthy Valkey and a limit of 2, the first four requests came back
   * 401/401/401/429 instead of 401/401/429/429, and one spurious error line.
   *
   * `void` + `catch` and not `await`: the whole point of `lazyConnect` is that a
   * Valkey that is down must not stop the process from listening. This kicks the
   * connection off and lets `retryStrategy` keep trying; nothing here waits for it.
   */
  void valkey.connect().catch(() => {});

  return {
    /**
     * Both closes run, whatever the other one does.
     *
     * Sequencing them as `valkey.disconnect(); await pool.end();` meant a throw
     * from the first skipped the second and leaked every database connection. And
     * with a reconnect strategy now running, a Valkey client nobody disconnected
     * keeps the event loop alive after SIGTERM — the process appears to ignore
     * the signal and is eventually killed.
     */
    close: async () => {
      const failures: unknown[] = [];
      try {
        valkey.disconnect();
      } catch (error) {
        failures.push(error);
      }
      try {
        await pool.end();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'the api runtime did not shut down cleanly');
      }
    },
    identity: new PgIdentityAdapter(pool),
    sessions: new PgSessionAdapter(pool),
    audit: new PgAuditAdapter(pool),
    rateLimit: new ValkeyRateLimitAdapter(valkey),
    clock: new SystemClock(),
    registry: createProviderRegistry(config, fetchImpl),
  };
}
