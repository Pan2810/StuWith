import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Real PostgreSQL 18 for CI gates #3 and #4 (TD-5).
 *
 * The image is the same one infra/docker-compose.yml pins, not the generic
 * `postgres` image: gate #4 has to prove the migrations run on the database the
 * product actually ships with, pgvector and `uuidv7()` included.
 */
export const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie';

const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'testcontainers-local-only';
const DATABASE = 'stuwith_test';

/** Role passwords for the test database. Never reused anywhere else. */
export const TEST_ROLE_PASSWORDS = {
  DB_ROLE_API_PASSWORD: 'test-api-role-password',
  DB_ROLE_REALTIME_PASSWORD: 'test-realtime-role-password',
} as const;

/**
 * Escape hatch for a machine with no Docker daemon. CI never sets it — gates #3
 * and #4 are required checks, so a skipped run there would be a silent pass.
 */
export const testcontainersDisabled = process.env['STUWITH_SKIP_TESTCONTAINERS'] === '1';

export interface StartedPostgres {
  readonly container: StartedTestContainer;
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  connectionStringFor(role: string, password: string): string;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: SUPERUSER,
      POSTGRES_PASSWORD: SUPERUSER_PASSWORD,
      POSTGRES_DB: DATABASE,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(180_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionStringFor = (role: string, password: string): string =>
    `postgres://${role}:${password}@${host}:${port}/${DATABASE}`;

  return {
    container,
    host,
    port,
    connectionString: connectionStringFor(SUPERUSER, SUPERUSER_PASSWORD),
    connectionStringFor,
    stop: () => container.stop(),
  };
}

/** Runs every forward migration. `verbose: false` matters: verbose logging would
 *  print the CREATE ROLE statements, passwords included, into the CI log. */
export async function applyMigrations(connectionString: string): Promise<void> {
  for (const [name, value] of Object.entries(TEST_ROLE_PASSWORDS)) {
    process.env[name] = value;
  }
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl: connectionString,
    dir: migrationsDir(),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
    log: () => {},
  });
}

export function migrationsDir(): string {
  return path.resolve(__dirname, '..', '..', 'migrations');
}

export function readSeed(): string {
  return readFileSync(path.resolve(__dirname, '..', '..', 'seeds', 'baseline.sql'), 'utf8');
}

export async function withClient<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
