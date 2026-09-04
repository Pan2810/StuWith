import path from 'node:path';
import { AUDIT_ACTIONS, AUTH_PROVIDERS, GLOBAL_USER_ROLES, SERVICE_NAMES } from '@stuwith/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The migration cannot import `@stuwith/contracts`: it runs as plain JavaScript,
 * through `node-pg-migrate`, before anything is built. So the two lists are kept
 * in step by this test instead of by an import.
 *
 * Without it the drift is silent and one-directional: adding a fifth provider to
 * the contracts enum makes every type check pass and every login through that
 * provider fail at INSERT time with a CHECK violation — in production, because no
 * test would have exercised it.
 *
 * The assertions run the migration against a fake `pgm` and read the SQL it
 * actually emits, rather than grepping the file for a constant. What matters is
 * what reaches the database.
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  'migrations',
  '1788480000000_users-and-identities.js',
);

interface FakePgm {
  sql(statement: string): void;
}

function statements(): string[] {
  const collected: string[] = [];
  const pgm: FakePgm = { sql: (statement) => void collected.push(statement) };
  const migration = require(MIGRATION) as { up: (pgm: FakePgm) => void };
  migration.up(pgm);
  return collected;
}

function statementContaining(needle: string): string {
  const found = statements().find((statement) => statement.includes(needle));
  if (found === undefined) {
    throw new Error(`no migration statement contains ${needle}`);
  }
  return found;
}

/** The quoted values inside `... IN ('a', 'b')`, for the named constraint. */
function checkValues(statement: string, constraint: string): string[] {
  const index = statement.indexOf(constraint);
  expect(index, `constraint ${constraint} is missing`).toBeGreaterThan(-1);
  const tail = statement.slice(index);
  const match = /IN \(([^)]*)\)/.exec(tail);
  if (match === null) {
    throw new Error(`constraint ${constraint} has no IN (...) list`);
  }
  return [...(match[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}

beforeEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

afterEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

describe('the schema and packages/contracts agree', () => {
  it('accepts exactly the four providers the contract declares', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS user_identities');
    expect(checkValues(statement, 'user_identities_provider_check').sort()).toEqual(
      [...AUTH_PROVIDERS].sort(),
    );
  });

  it('accepts exactly the global roles — and NOT `host`', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS users');
    const roles = checkValues(statement, 'users_role_check');

    expect(roles.sort()).toEqual([...GLOBAL_USER_ROLES].sort());
    // `host` is a per-room permission (Epic 2). A global `host` role would mean
    // "host of every room" the first time anyone wrote a guard against it.
    expect(roles).not.toContain('host');
  });

  it('accepts exactly the audit actions and services the contract declares', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS audit_events');
    expect(checkValues(statement, 'audit_events_action_check').sort()).toEqual(
      [...AUDIT_ACTIONS].sort(),
    );
    expect(checkValues(statement, 'audit_events_source_service_check').sort()).toEqual(
      [...SERVICE_NAMES].sort(),
    );
  });
});

describe('the migration cannot lose the properties the story depends on', () => {
  it('makes (provider, provider_user_id) UNIQUE — the anti-duplicate rule', () => {
    expect(statementContaining('CREATE TABLE IF NOT EXISTS user_identities')).toContain(
      'UNIQUE (provider, provider_user_id)',
    );
  });

  it('does NOT make email unique — two providers, one address, two people', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS users');
    expect(statement).not.toMatch(/UNIQUE \(\s*email\s*\)/i);
  });

  it('does not add date_of_birth — that column belongs to Story 1.4', () => {
    // COMMENT statements are excluded: one of them says, in prose, that the column
    // arrives in 1.4. What must not exist is a DDL statement creating it.
    const ddl = statements().filter((statement) => !statement.includes('COMMENT ON'));
    expect(ddl.join('\n')).not.toContain('date_of_birth');
  });

  it('stores only hashes of session tokens', () => {
    const statement = statementContaining('CREATE TABLE IF NOT EXISTS sessions');
    expect(statement).toContain('access_token_hash');
    expect(statement).toContain('refresh_token_hash');
    // A column literally named for the token itself would mean the plaintext is
    // being kept, and a dump would then be replayable as a cookie.
    expect(statement).not.toMatch(/\baccess_token\s+text/);
    expect(statement).not.toMatch(/\brefresh_token\s+text/);
  });

  it('grants writes on the identity tables to stuwith_api only (AD-8)', () => {
    const grants = statements().filter((s) => s.trimStart().startsWith('GRANT'));
    for (const table of ['users', 'user_identities', 'sessions']) {
      const grant = grants.find((s) => s.includes(`ON TABLE ${table} `));
      expect(grant, `no GRANT for ${table}`).toBeDefined();
      expect(grant).toContain('stuwith_api');
      expect(grant, `${table} must not be writable by the realtime process`).not.toContain(
        'stuwith_realtime',
      );
    }
  });

  it('grants INSERT and nothing else on audit_events (AD-12)', () => {
    const grant = statements()
      .filter((statement) => statement.trimStart().startsWith('GRANT'))
      .find((statement) => statement.includes('ON TABLE audit_events'));
    expect(grant).toBe('GRANT INSERT ON TABLE audit_events TO stuwith_api, stuwith_realtime');
  });

  it('never grants DELETE to anybody, on any table', () => {
    for (const statement of statements().filter((s) => s.trimStart().startsWith('GRANT'))) {
      expect(statement, 'DELETE is never granted in this repo').not.toContain('DELETE');
    }
  });
});
