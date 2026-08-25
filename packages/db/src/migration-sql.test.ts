import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The roles migration builds SQL by string interpolation, which is unavoidable —
 * `CREATE ROLE` and `ALTER ROLE` take no bind parameters. So the SQL it produces is
 * checked directly, with no database involved.
 *
 * The defect this pins: the password literal used to be interpolated INSIDE a
 * `DO $do$ ... $do$` block. Doubling single quotes does nothing there, because the
 * dollar-quote delimiter is not a quote — a password containing `$do$` closed the
 * block early and the remainder ran as SQL, as the migration role. The fix is
 * structural (the password moved to a top-level `ALTER ROLE`), and structure is
 * exactly what a test like this can hold in place.
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  'migrations',
  '1755734500000_process-roles.js',
);

interface FakePgm {
  sql(statement: string): void;
}

function collectStatements(passwords: Record<string, string>): string[] {
  const statements: string[] = [];
  const pgm: FakePgm = { sql: (statement) => void statements.push(statement) };

  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(passwords)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const migration = require(MIGRATION) as { up: (pgm: FakePgm) => void };
    migration.up(pgm);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return statements;
}

/** Every `DO $tag$ ... $tag$` body in a statement. */
function dollarQuotedBodies(statement: string): string[] {
  const bodies: string[] = [];
  const opener = /\$[A-Za-z_][A-Za-z0-9_]*\$/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(statement)) !== null) {
    const tag = match[0];
    const start = match.index + tag.length;
    const end = statement.indexOf(tag, start);
    if (end === -1) break;
    bodies.push(statement.slice(start, end));
    opener.lastIndex = end + tag.length;
  }
  return bodies;
}

const SAFE = {
  DB_ROLE_API_PASSWORD: 'safe-api-password',
  DB_ROLE_REALTIME_PASSWORD: 'safe-realtime-password',
};

beforeEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

afterEach(() => {
  delete require.cache[require.resolve(MIGRATION)];
});

describe('roles migration — SQL construction', () => {
  it('never places a password inside a dollar-quoted body', () => {
    const statements = collectStatements(SAFE);

    for (const statement of statements) {
      for (const body of dollarQuotedBodies(statement)) {
        for (const password of Object.values(SAFE)) {
          expect(
            body,
            'a password inside a dollar-quoted body can escape it by containing the tag',
          ).not.toContain(password);
        }
      }
    }
  });

  it('sets the password in a top-level ALTER ROLE statement', () => {
    const statements = collectStatements(SAFE);
    const alter = statements.filter((s) => s.includes('ALTER ROLE') && s.includes('PASSWORD'));

    expect(alter.length).toBe(2);
    for (const statement of alter) {
      expect(statement).not.toContain('DO $');
      expect(statement.trim().startsWith('ALTER ROLE')).toBe(true);
    }
  });

  it('creates the roles without a password, so the DO block carries no secret', () => {
    const statements = collectStatements(SAFE);
    const createBlocks = statements.filter((s) => s.includes('CREATE ROLE'));

    expect(createBlocks.length).toBe(2);
    for (const statement of createBlocks) {
      expect(statement).not.toContain('PASSWORD');
    }
  });

  it('survives a password containing a dollar-quote tag', () => {
    // The exact payload that used to terminate `DO $do$` early.
    const hostile = "x$do$; ALTER ROLE stuwith_api SUPERUSER; --";
    const statements = collectStatements({
      DB_ROLE_API_PASSWORD: hostile,
      DB_ROLE_REALTIME_PASSWORD: SAFE.DB_ROLE_REALTIME_PASSWORD,
    });

    for (const statement of statements) {
      for (const body of dollarQuotedBodies(statement)) {
        expect(body).not.toContain('$do$');
        expect(body).not.toContain('SUPERUSER');
      }
    }

    // It survives as a correctly escaped literal in the top-level statement.
    const alter = statements.find(
      (s) => s.includes('ALTER ROLE stuwith_api') && s.includes('PASSWORD'),
    );
    expect(alter).toBeDefined();
    expect(alter).toContain("'x$do$; ALTER ROLE stuwith_api SUPERUSER; --'");
  });

  it('doubles a single quote rather than letting it close the literal', () => {
    const statements = collectStatements({
      DB_ROLE_API_PASSWORD: "it's-fine",
      DB_ROLE_REALTIME_PASSWORD: SAFE.DB_ROLE_REALTIME_PASSWORD,
    });
    const alter = statements.find(
      (s) => s.includes('ALTER ROLE stuwith_api') && s.includes('PASSWORD'),
    );
    expect(alter).toContain("'it''s-fine'");
  });

  it('refuses a password it cannot escape safely, instead of guessing', () => {
    // A backslash means the escaping rule depends on standard_conforming_strings,
    // and a control character makes any statement that does echo it unreadable.
    expect(() =>
      collectStatements({
        DB_ROLE_API_PASSWORD: 'back\\slash',
        DB_ROLE_REALTIME_PASSWORD: SAFE.DB_ROLE_REALTIME_PASSWORD,
      }),
    ).toThrow(/backslash/);

    expect(() =>
      collectStatements({
        DB_ROLE_API_PASSWORD: 'has\nnewline',
        DB_ROLE_REALTIME_PASSWORD: SAFE.DB_ROLE_REALTIME_PASSWORD,
      }),
    ).toThrow(/control characters/);
  });

  it('names the missing variable when a role password is absent', () => {
    expect(() =>
      collectStatements({ DB_ROLE_REALTIME_PASSWORD: SAFE.DB_ROLE_REALTIME_PASSWORD }),
    ).toThrow(/DB_ROLE_API_PASSWORD/);
  });

  it('uses an unpredictable dollar-quote tag rather than a fixed one', () => {
    const first = collectStatements(SAFE).join('\n');
    delete require.cache[require.resolve(MIGRATION)];
    const second = collectStatements(SAFE).join('\n');

    const tagsOf = (sql: string) => [...sql.matchAll(/\$stuwith_[0-9a-f]{16}\$/g)].map((m) => m[0]);
    expect(tagsOf(first).length).toBeGreaterThan(0);
    expect(new Set(tagsOf(first)).size).toBeGreaterThan(1);
    expect(tagsOf(first)).not.toEqual(tagsOf(second));
    expect(first).not.toContain('$do$');
  });
});
