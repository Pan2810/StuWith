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
 * Escape hatch for a developer machine with no Docker daemon.
 *
 * CI must never take it: gates #3 and #4 are REQUIRED checks, so a skipped run
 * there is a silent pass — a green tick on a suite that executed nothing. The
 * workflow guards against the variable too, but that guard lives in a YAML file
 * anyone can edit; this one travels with the tests, so the flag cannot be honoured
 * inside CI however it arrives.
 */
function resolveTestcontainersDisabled(): boolean {
  const requested = process.env['STUWITH_SKIP_TESTCONTAINERS'] === '1';
  if (!requested) {
    return false;
  }
  if (process.env['CI']) {
    throw new Error(
      'STUWITH_SKIP_TESTCONTAINERS is set while CI is set. Refusing to skip: gates 3 and 4 ' +
        'are required checks, and a skipped required check reports success without testing ' +
        'anything. Unset it, or run these suites against a real Docker daemon.',
    );
  }
  return true;
}

export const testcontainersDisabled = resolveTestcontainersDisabled();

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

/**
 * Runs every forward migration.
 *
 * `verbose: false` matters: verbose logging would print the CREATE ROLE
 * statements, passwords included, into the CI log.
 *
 * The role passwords have to travel through `process.env` because that is the
 * interface the migration reads (AD-14) — but they are put back exactly as they
 * were found. Leaving them set meant every later test in the same worker
 * inherited them, and a developer running the suite locally had their real
 * DB_ROLE_* values silently replaced with test ones for the rest of the process.
 */
export async function applyMigrations(connectionString: string): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(TEST_ROLE_PASSWORDS)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    const { runner } = await import('node-pg-migrate');
    await runner({
      databaseUrl: connectionString,
      dir: migrationsDir(),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
      log: () => {},
    });
  } finally {
    for (const [name, value] of previous) {
      // `delete` rather than `= undefined`: assigning undefined to process.env
      // stores the literal string "undefined", which is worse than the leak.
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
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
