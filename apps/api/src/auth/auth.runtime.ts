import type { ApiEnv } from '@stuwith/config';
import {
  PgAuditAdapter,
  PgIdentityAdapter,
  PgSessionAdapter,
  createPool,
} from '@stuwith/db';
import type { AuditPort, ClockPort, IdentityPort, SessionPort } from '@stuwith/domain';
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
}

/** The real clock. Lives here, not in the domain, because `Date` is ambient state. */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

export interface ProductionRuntime extends AuthRuntime {
  /** Drains the connection pool. Never called in-process today; Epic 2 will. */
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

  return {
    close: () => pool.end(),
    identity: new PgIdentityAdapter(pool),
    sessions: new PgSessionAdapter(pool),
    audit: new PgAuditAdapter(pool),
    clock: new SystemClock(),
    registry: createProviderRegistry(config, fetchImpl),
  };
}
