import { Pool, type PoolConfig } from 'pg';

/**
 * The single place `pg` is constructed. AD-1 keeps this out of packages/domain and
 * AD-8 keeps the two processes on two different roles, so the connection string is
 * always supplied by the caller (from packages/config) and never guessed here.
 */
export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    // Keep the pool small: one VPS, two processes, and a coin scheduler that must
    // not be starved by a burst of HTTP traffic.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...overrides,
  });
}
