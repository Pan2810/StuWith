import { readFileSync, readdirSync } from 'node:fs';
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

  it('still does not create date_of_birth inline — it arrives in its own migration', () => {
    // COMMENT statements are excluded: one of them says, in prose, that the column
    // arrives in 1.4. What must not exist is a DDL statement creating it HERE.
    //
    // This is no longer "the column does not exist" — Story 1.4 added it, in
    // `1788480100000_user-date-of-birth.js`, and the suite below reads that file.
    // What is still true and still worth pinning is that this migration is not
    // where it comes from: editing an already-applied migration is a change that
    // runs on a fresh database and silently does not run on any existing one.
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

/**
 * Story 1.4's column, read the same way and over the whole DIRECTORY: run each
 * migration against a fake `pgm` and look at the SQL it emits, rather than grepping
 * a named file for a word.
 *
 * The properties below are the ones that would each fail SILENTLY. A `NOT NULL`
 * breaks every first sign-in, but only against a database that already has rows
 * with no date of birth. A `DEFAULT` turns a catalogue-only change into a table
 * rewrite, which is fine on a laptop and an outage on a real database. A GRANT to
 * the wrong role hands the write to the process AD-8 says must never have it. Each
 * of them holds for the third migration to touch this column as much as for the
 * first, which is why nothing here names a file.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/** Every migration in the directory, run against a fake `pgm`, newest last. */
function statementsOf(file: string): string[] {
  const collected: string[] = [];
  const pgm: FakePgm = { sql: (statement) => void collected.push(statement) };
  const full = path.join(MIGRATIONS_DIR, file);
  delete require.cache[require.resolve(full)];
  const migration = require(full) as { up: (pgm: FakePgm) => void };
  migration.up(pgm);
  return collected;
}

/**
 * The migrations that WRITE `date_of_birth` DDL, discovered rather than named.
 *
 * This constant used to be a filename — `'1788480100000_user-date-of-birth.js'` —
 * which is a list of examples of length one, the shape this diff criticises
 * elsewhere and the shape `AGENTS.md` records as having cost four review rounds on
 * the trusted-proxy list. A SECOND migration touching the column (a type change, a
 * constraint, a back-fill) would have been outside every rule below with nothing
 * saying so.
 *
 * `COMMENT ON` statements are excluded from the selection: the Story 1.2 migration
 * mentions the column in prose, and prose is not DDL. What selects a migration here
 * is emitting a statement that actually acts on `date_of_birth`.
 */
const isDdl = (statement: string): boolean => !statement.includes('COMMENT ON');

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.js'))
  .sort();

/**
 * The text gate in front of the run, and why it is not a list of examples.
 *
 * `1755734500000_process-roles.js` reads `DB_ROLE_API_PASSWORD` from the
 * environment and throws without it, by design (AD-14: no default for any secret).
 * Running every migration in the directory to see what it emits therefore fails on
 * a file that has nothing to do with this column.
 *
 * So a file is only EXECUTED if its source mentions the column at all. That is a
 * property of the whole directory rather than a name anybody typed, it cannot miss
 * a migration that touches `date_of_birth` (such a migration must contain the
 * string), and the DDL selection below still decides which of the candidates the
 * rules apply to.
 */
const dateOfBirthMigrations: ReadonlyArray<readonly [string, readonly string[]]> = MIGRATION_FILES
  .filter((file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').includes('date_of_birth'))
  .map((file) => [file, statementsOf(file)] as const)
  .filter(([, statements]) =>
    statements.some((statement) => isDdl(statement) && statement.includes('date_of_birth')),
  );

describe('every migration that adds date_of_birth to the schema (Story 1.4)', () => {
  it('finds one at all, so an empty sweep cannot pass', () => {
    // Without this, deleting the migration — or renaming the column in it — would
    // turn every rule below into a rule over nothing, silently.
    expect(dateOfBirthMigrations.length).toBeGreaterThanOrEqual(1);
    // And the directory itself was read, so a sweep narrowed to nothing by a broken
    // filter is distinguishable from a directory that really holds one migration.
    expect(MIGRATION_FILES.length).toBeGreaterThanOrEqual(4);
  });

  const ddl = (statements: readonly string[]): string => statements.filter(isDdl).join('\n');

  it.each(dateOfBirthMigrations)('%s acts on the existing users table', (_file, statements) => {
    expect(ddl(statements)).toContain('ALTER TABLE users');
    expect(ddl(statements)).toContain('date_of_birth');
  });

  it('declares the column as a DAY somewhere, across all of them', () => {
    // A UNION rule, because "which type is it" is a question about the schema the
    // migrations add up to, not about each file. A later migration that only changes
    // nullability declares no type at all and must not be asked to.
    expect(ddl(dateOfBirthMigrations.flatMap(([, statements]) => statements))).toMatch(
      /date_of_birth\s+date\b/,
    );
  });

  it.each(dateOfBirthMigrations)('%s never makes it an instant', (_file, statements) => {
    // `timestamptz` would force every reader to choose a time zone before it could
    // say which day somebody was born on — the "two readings of one value" class
    // the UTC rule exists to close. This one IS per migration: a later `ALTER
    // COLUMN ... TYPE timestamptz` breaks the property whatever the first one said.
    expect(ddl(statements)).not.toMatch(/date_of_birth[^;]*timestamptz/);
  });

  it.each(dateOfBirthMigrations)(
    '%s leaves the column NULLABLE, because NULL is the "not declared yet" state',
    (_file, statements) => {
      // Story 1.2 inserts a users row at first login, before anybody has been asked.
      // NOT NULL here fails every one of those inserts.
      expect(ddl(statements)).not.toMatch(/date_of_birth[^;]*NOT NULL/i);
    },
  );

  it.each(dateOfBirthMigrations)(
    '%s adds no DEFAULT, so the change stays catalogue-only on a populated table',
    (_file, statements) => {
      expect(ddl(statements)).not.toMatch(/date_of_birth[^;]*DEFAULT/i);
    },
  );

  it.each(dateOfBirthMigrations)(
    '%s never hides a type conflict behind IF NOT EXISTS',
    (_file, statements) => {
      // A `date_of_birth` of some other type already in the table would make the
      // statement a no-op that still records the migration as applied, and every
      // argument about `date` and `to_char` would quietly stop being true. Migrations
      // are forward-only with their own ledger, so the clause buys nothing else.
      expect(ddl(statements)).not.toMatch(/ADD COLUMN\s+IF NOT EXISTS/i);
    },
  );

  it.each(dateOfBirthMigrations)(
    '%s adds no second column claiming to say the same thing',
    (_file, statements) => {
      // One source of truth. A `profile_completed` flag beside the date is a second
      // field describing one fact, with nothing keeping the two in step.
      expect(ddl(statements)).not.toContain('profile_completed');
      expect(ddl(statements)).not.toContain('is_over_18');
    },
  );

  it.each(dateOfBirthMigrations)(
    '%s grants nothing new — privileges are per table and stuwith_api already writes users',
    (_file, statements) => {
      for (const statement of statements) {
        expect(statement.trimStart().startsWith('GRANT')).toBe(false);
      }
    },
  );

  it.each(dateOfBirthMigrations)(
    '%s contains no DELETE anywhere, including in a comment',
    (_file, statements) => {
      // AD-12's posture: no role holds DELETE on anything in this repository, and
      // the word appearing in a migration is the first step towards one that does.
      for (const statement of statements) {
        expect(statement).not.toContain('DELETE');
      }
    },
  );

  it('says in the schema itself that the column must not leave apps/api', () => {
    // The one place a DBA reading `\d+ users` will see it. A rule that lives only
    // in a TypeScript docblock is invisible to whoever is holding a psql prompt.
    //
    // Over the union of the selected migrations rather than per file: the comment
    // has to exist once, not once per migration that ever touches the column.
    const comment = dateOfBirthMigrations
      .flatMap(([, statements]) => statements)
      .find((statement) => statement.includes('COMMENT ON COLUMN users.date_of_birth'));
    expect(comment).toBeDefined();
    expect(comment).toContain('PII');
    expect(comment).toContain('NULL');
  });
});
