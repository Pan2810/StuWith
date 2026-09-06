import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AD-12 — `audit_events` is append-only, in CODE as well as in the database.
 *
 * ## Why the GRANTs were only half of it
 *
 * `packages/db/migrations/1788480000000_users-and-identities.js` grants `INSERT`
 * and revokes `UPDATE, DELETE, TRUNCATE` from both application roles, so the
 * database refuses the statement. `AuditPort` has one method and `PgAuditAdapter`
 * has one SQL string, so there is no obvious place to write the call.
 *
 * None of that stops the call being WRITTEN. A migration runs as the migration
 * role, not as `stuwith_api`; a `psql` script, a seed file, an "undo this bad row"
 * helper or a future adapter is a plain text file that nobody's privileges apply
 * to until it runs. The failure mode this closes is the one where a correction
 * lands in a branch, passes review because it looks like housekeeping, and is
 * discovered at deploy time as a permission error — or worse, is discovered to
 * have worked because somebody granted the privilege to make it work.
 *
 * So this is a rule over the TEXT of the repository: no source file may contain a
 * statement that edits, empties or removes the table. It is deliberately blunt. A
 * blunt rule that is red for the obvious spelling is worth more than a clever one
 * that is green for a spelling nobody predicted, and the cost of a false red is one
 * exemption with a written reason — which is a conversation this table should have.
 *
 * ## How it avoids the three ways a scanner like this fails silently
 *
 * 1. **The stripper.** Comments are removed first, because this file and
 *    `audit-adapter.ts` both explain the ban by naming it. The line-comment anchor
 *    (`^[ \t]*\/\/.*$`) is copied from `config-cast-ban.test.ts`, where an
 *    UNANCHORED version was shipped and shown to eat everything after `https://`
 *    on a line — so an offending statement sharing a line with a URL disappeared.
 * 2. **The self-test.** Each pattern is exercised against lines it must catch and
 *    lines it must not, with the probes ASSEMBLED from fragments so this file does
 *    not fail on itself. Story 1.6 shipped three rules that looked like they ran
 *    and did nothing until they were mutated.
 * 3. **The sweep's own reach.** The file walk is asserted to find a plausible
 *    number of files AND to have actually read the files where the audit path
 *    lives — because a `SCAN_ROOTS` entry whose file types are not in
 *    `SCANNED_EXTENSIONS` contributes nothing while looking like coverage, which is
 *    what `infra` did in the first version of this file.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Everywhere a statement could be written down.
 *
 * `.github` and `scripts` are here even though nothing in either touches the
 * database today: a workflow step or a maintenance script is exactly the shape of
 * "a one-off correction that ran once in production", and the whole argument of
 * this gate is that privileges do not apply to text.
 *
 * The repository ROOT is scanned non-recursively as well, so a `fix-audit.sql`
 * dropped beside `package.json` is not invisible.
 */
const SCAN_ROOTS = ['apps', 'packages', 'tests', 'infra', '.github', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.tsbuild',
  '.next',
  '.next-e2e',
  'coverage',
  'test-results',
  'playwright-report',
]);

/**
 * Every file type this repository stores a statement in.
 *
 * `.yml`/`.yaml`/`.conf` are here because of the bug the first version had: `infra`
 * was listed as a scanned root while matching none of the file types `infra`
 * actually holds, so it contributed zero files and neither anti-vacuity guard
 * noticed — `packages` alone cleared the count threshold. A root that scans nothing
 * is worse than an absent root, because it reads as coverage.
 */
const SCANNED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.cjs',
  '.mjs',
  '.sql',
  '.yml',
  '.yaml',
  '.conf',
  '.sh',
];

/** The table, spelled once. */
const TABLE = 'audit_events';

/**
 * The statements that can unmake a row, and why each pattern is shaped as it is.
 *
 * Every one requires the table name to follow the verb as an OPERAND, because the
 * migration that establishes the rule contains the words `UPDATE`, `DELETE` and
 * `TRUNCATE` in the very `REVOKE UPDATE, DELETE, TRUNCATE ON audit_events` that
 * takes those privileges away. A pattern matching the verb anywhere near the table
 * name would be red on the line that makes the rule true — a false red that would
 * be silenced by weakening the rule, which is the worst possible outcome.
 *
 * An optional schema qualifier and optional double quotes are allowed, because
 * `public.audit_events` and `"audit_events"` are the same statement to Postgres and
 * a rule that only sees the bare form is a rule with a one-character bypass.
 *
 * The last three came out of this story's first review and none of them is a clever
 * bypass — all three are the spelling somebody would reach for first:
 *
 *  - `ON CONFLICT … DO UPDATE` is what "correct an audit row" actually looks like
 *    when it is written by somebody who knows Postgres. The verb is `INSERT`, so
 *    `\bUPDATE\s+audit_events` cannot see it;
 *  - `GRANT UPDATE|DELETE|TRUNCATE … ON audit_events` is the scenario this file's
 *    own docblock names — "somebody granted the privilege to make it work" — and it
 *    was not caught;
 *  - `DROP TABLE` and `ALTER TABLE` remove every row or change what a row means,
 *    which is past the rule rather than within it.
 */
const OPERAND = String.raw`(?:ONLY\s+)?(?:[A-Za-z_][\w$]*\s*\.\s*)?"?audit_events"?\b`;

const BANNED: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'UPDATE of an audit row', pattern: new RegExp(String.raw`\bUPDATE\s+${OPERAND}`, 'i') },
  {
    name: 'DELETE of an audit row',
    pattern: new RegExp(String.raw`\bDELETE\s+FROM\s+${OPERAND}`, 'i'),
  },
  {
    name: 'TRUNCATE of the audit table',
    pattern: new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?${OPERAND}`, 'i'),
  },
  {
    /**
     * The upsert, and it has to be anchored to THIS table.
     *
     * `INSERT … ON CONFLICT … DO UPDATE` mutates an existing row and never writes
     * the word UPDATE beside the table name, so the plain UPDATE pattern cannot see
     * it. But an unanchored version is worse than useless: `heartbeat-adapter.ts`
     * contains a perfectly correct `ON CONFLICT (service_key) DO UPDATE`, and a
     * rule that is red on a legitimate upsert somewhere else gets weakened until it
     * is green — which is how a rule dies.
     *
     * So the whole statement is matched: `INSERT INTO <this table> … ON CONFLICT …
     * DO UPDATE`, within a bounded span because a real one spans several lines.
     */
    name: 'upsert that would overwrite an audit row',
    pattern: new RegExp(
      String.raw`\bINSERT\s+INTO\s+${OPERAND}[\s\S]{0,400}?\bON\s+CONFLICT\b[\s\S]{0,200}?\bDO\s+UPDATE\b`,
      'i',
    ),
  },
  {
    name: 'GRANT of a privilege that could unmake a row',
    pattern: new RegExp(
      String.raw`\bGRANT\b[^;]{0,200}?\b(?:UPDATE|DELETE|TRUNCATE)\b[^;]{0,200}?\bON\s+(?:TABLE\s+)?${OPERAND}`,
      'i',
    ),
  },
  {
    name: 'DROP or ALTER of the audit table',
    pattern: new RegExp(String.raw`\b(?:DROP|ALTER)\s+TABLE\s+(?:IF\s+EXISTS\s+)?${OPERAND}`, 'i'),
  },
];

/**
 * Comments stripped before scanning, with the line-comment rule ANCHORED.
 *
 * Same spelling as `config-cast-ban.test.ts`, and the anchor is the whole point
 * there: an unanchored `\/\/.*$` treats the `//` in `https://x` as the start of a
 * comment and deletes the rest of the line, so an offender sitting after a URL
 * reads as an empty line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*--.*$/gm, '')
    .replace(/^[ \t]*#.*$/gm, '');
}

/**
 * The walk, done ONCE.
 *
 * `withDirent` rather than `statSync`: this gate shares a `fileParallelism: false`
 * project with gates that create and delete files inside `packages/domain/src`, so
 * a path can vanish between the listing and the stat. A `readdirSync` that names
 * the kind of each entry has no such window; a missing directory is skipped rather
 * than thrown on, so adding a root before it exists is not a broken gate.
 */
function walk(dir: string, found: string[], recurse: boolean): string[] {
  if (!existsSync(dir)) {
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) walk(full, found, true);
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

/** Computed once: four examples used to re-walk the tree and re-read every file. */
const SOURCE_FILES: readonly string[] = [
  ...SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root), [], true)),
  // The repository root itself, non-recursively — a stray `fix-audit.sql` beside
  // `package.json` would otherwise be invisible.
  ...walk(REPO_ROOT, [], false),
];

/** Repo-relative and forward-slashed, so a Windows walk and a Linux one agree. */
function relative(file: string): string {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

/** Every banned statement in a file, in the order the patterns are declared. */
function offendingStatements(file: string): readonly string[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  return BANNED.flatMap(({ name, pattern }) => {
    const match = pattern.exec(code);
    return match === null ? [] : [`${name}: "${match[0].replace(/\s+/g, ' ')}"`];
  });
}

/** Read once, keyed by repo-relative path. */
const OFFENCES: ReadonlyMap<string, readonly string[]> = new Map(
  SOURCE_FILES.map((file) => [relative(file), offendingStatements(file)] as const),
);

/**
 * The statements that are allowed to exist, and why each one is.
 *
 * ## Exemptions are per STATEMENT, not per file
 *
 * The first version exempted two paths, and a whole-file exemption is a hole with a
 * filename on it: an exempted test that swapped its `TRUNCATE` for an unrelated
 * `UPDATE` stayed exempt, and a genuinely new `DELETE FROM audit_events` added to
 * an exempted file was invisible for ever. What is exempted here is the exact
 * statement text the sweep reports, so anything else in the same file is still red.
 *
 * ## Why these two are legitimate
 *
 * Neither can execute against a deployment. Both run in the `db` Vitest project,
 * against a Postgres 18 container that lives for the length of one test file, and
 * both are addressed to that container's OWNER — the one role in the design that is
 * neither `stuwith_api` nor `stuwith_realtime`.
 *
 * Deleting them to satisfy the rule would delete the only proof that AD-12 is
 * enforced by the database at all, which is the opposite of what the rule is for.
 */
/**
 * An exemption key, in the exact shape {@link offendingStatements} reports.
 *
 * ASSEMBLED rather than written out. A literal `"UPDATE audit_events"` here would
 * make this file its own first offender — which it duly did, on the first run —
 * and the fix must not be to exempt this path, because that would put a permanent
 * hole in the middle of the rule.
 */
const exemption = (index: number, sql: string): string =>
  `${BANNED[index]?.name ?? 'unknown'}: "${sql}"`;

const EXEMPT_STATEMENTS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    'packages/db/src/migrations.test.ts',
    new Map([
      [
        exemption(0, `${'UPDATE'} ${TABLE}`),
        'the example that PROVES the GRANTs work: it issues this statement as stuwith_api and ' +
          'asserts SQLSTATE 42501. Without it nothing checks that Postgres enforces AD-12.',
      ],
      [
        exemption(1, `${'DELETE'} FROM ${TABLE}`),
        'the second half of the same proof, also asserted to be refused with SQLSTATE 42501. ' +
          'Removing it would leave the DELETE privilege unchecked by anything.',
      ],
    ]),
  ],
  [
    'packages/db/src/audit-contract.pg.test.ts',
    new Map([
      [
        exemption(2, `${'TRUNCATE'} TABLE ${TABLE}`),
        'a reset of a throwaway container database between contract examples, issued as the ' +
          'OWNER. Doing it through an application role would exercise a privilege that must ' +
          'not exist — which is the reason the comment beside it gives.',
      ],
    ]),
  ],
]);

describe('AD-12 — nothing in this repository can unmake an audit row', () => {
  it('finds no statement that could edit, empty or remove the audit table', () => {
    const offenders: string[] = [];

    for (const [file, statements] of OFFENCES) {
      const exempt = EXEMPT_STATEMENTS.get(file) ?? new Map<string, string>();
      for (const statement of statements) {
        if (!exempt.has(statement)) {
          offenders.push(`${file} — ${statement}`);
        }
      }
    }

    expect(
      offenders,
      `${TABLE} is append-only (AD-12): no role holds UPDATE, DELETE or TRUNCATE on it, and ` +
        'AuditPort has no method for any of them. A correction to this table is a new row, ' +
        'not an edit — if you genuinely need one, that is a conversation, not a commit.',
    ).toEqual([]);
  });

  it('scans a meaningful number of files, so an empty pass is not a broken walk', () => {
    // The same guard `config-cast-ban.test.ts` and `design-tokens.test.ts` put in
    // front of their sweeps: a walk that silently matched nothing would make the
    // rule above vacuous and would look exactly like a clean repository.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it.each(SCAN_ROOTS.filter((root) => existsSync(path.join(REPO_ROOT, root))))(
    'actually reads files under %s, rather than listing it',
    (root) => {
    /**
     * The bug the first version of this file had, as a rule.
     *
     * `infra` was a scanned root whose file types were in none of
     * `SCANNED_EXTENSIONS`, so it contributed zero files while `AGENTS.md` claimed
     * it was covered. Neither anti-vacuity guard could see it, because `packages`
     * alone cleared the count. A root that reads nothing is worse than an absent
     * one.
     */
      const prefix = `${root.replace(/\\/g, '/')}/`;
      expect(
        [...OFFENCES.keys()].filter((file) => file.startsWith(prefix)).length,
      ).toBeGreaterThan(0);
    },
  );

  it('lists at least one root that does not exist yet, and survives it', () => {
    // `scripts/` is declared before it exists, on purpose: a maintenance script is
    // exactly the shape of "a one-off correction that ran once in production", and
    // the root should already be covered on the day somebody creates the directory
    // rather than on the day somebody remembers this file. The walk skips a missing
    // directory rather than throwing, and the rule above only asks about roots that
    // are really there.
    expect(SCAN_ROOTS).toContain('scripts');
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('reads the files where the audit path actually lives', () => {
    // Naming them, so a `SCAN_ROOTS` or `SKIP_DIRS` edit that quietly excluded
    // `packages/db` fails here rather than turning the rule above into an assertion
    // about an empty set.
    expect([...OFFENCES.keys()]).toContain('packages/db/src/pg/audit-adapter.ts');
    expect([...OFFENCES.keys()]).toContain(
      'packages/db/migrations/1788480000000_users-and-identities.js',
    );
    // And those files really are the ones that mention the table, so the sweep is
    // reading content rather than a directory listing.
    expect(
      readFileSync(path.join(REPO_ROOT, 'packages/db/src/pg/audit-adapter.ts'), 'utf8'),
    ).toContain(TABLE);
  });

  it('exempts exactly two files and three statements, so the list cannot grow unnoticed', () => {
    // An exemption list is the hole in the middle of a rule. Pinning its size means
    // a fourth entry is a decision somebody has to defend in a diff rather than a
    // line added while making a build go green.
    expect([...EXEMPT_STATEMENTS.keys()].sort()).toEqual([
      'packages/db/src/audit-contract.pg.test.ts',
      'packages/db/src/migrations.test.ts',
    ]);
    expect([...EXEMPT_STATEMENTS.values()].reduce((total, map) => total + map.size, 0)).toBe(3);
  });

  it.each(
    [...EXEMPT_STATEMENTS].flatMap(([file, statements]) =>
      [...statements].map(([statement, reason]) => [file, statement, reason] as const),
    ),
  )('%s still contains the exact statement its exemption names', (file, statement, reason) => {
    /**
     * The staleness guard, now at statement granularity.
     *
     * The whole-file version only checked that SOME banned statement was still
     * present, so an exempted file that swapped one verb for another kept its
     * exemption for a reason that no longer existed. This asserts the exact text.
     */
    expect(OFFENCES.get(file), `${file} is exempted but was not scanned`).toBeDefined();
    expect(OFFENCES.get(file)).toContain(statement);
    // And the reason is written down rather than implied by the entry existing.
    expect(reason.length).toBeGreaterThan(60);
  });

  it('is still red for a NEW statement inside an exempted file', () => {
    // The hole the per-file version left open, closed as a rule rather than as a
    // promise: only the named statements are forgiven, so anything else in those
    // two files is reported like anywhere else.
    const exempt = EXEMPT_STATEMENTS.get('packages/db/src/migrations.test.ts');
    // That file is forgiven an UPDATE and a DELETE. A TRUNCATE appearing in it
    // tomorrow is not forgiven by either entry.
    expect(exempt?.has(exemption(2, `${'TRUNCATE'} TABLE ${TABLE}`))).toBe(false);
  });

  /**
   * The rule checking itself.
   *
   * Assembled from fragments rather than written out, because this file is inside
   * the scanned tree and a literal probe would make the rule fail on itself. The
   * alternative — exempting this path — would put a permanent hole in the middle of
   * the rule. The rule stays global; the probes hide from it.
   */
  const UPDATE_PROBE = `${'UPDATE'} ${TABLE} SET metadata = '{}'`;
  const DELETE_PROBE = `${'DELETE'} FROM ${TABLE} WHERE id = $1`;
  const TRUNCATE_PROBE = `${'TRUNCATE'} TABLE ${TABLE}`;
  const UPSERT_PROBE =
    `INSERT INTO ${TABLE} (id, action) VALUES ($1, $2) ` +
    `${'ON'} CONFLICT (id) ${'DO'} ${'UPDATE'} SET action = EXCLUDED.action`;
  const GRANT_PROBE = `${'GRANT'} ${'UPDATE'}, INSERT ON TABLE ${TABLE} TO stuwith_api`;
  const DROP_PROBE = `${'DROP'} TABLE IF EXISTS ${TABLE}`;

  it.each([
    ['an UPDATE', UPDATE_PROBE],
    ['a DELETE', DELETE_PROBE],
    ['a TRUNCATE', TRUNCATE_PROBE],
    ['an upsert that overwrites a row', UPSERT_PROBE],
    ['a GRANT of UPDATE', GRANT_PROBE],
    ['a GRANT of DELETE', `${'GRANT'} ${'DELETE'} ON ${TABLE} TO r`],
    ['a GRANT of TRUNCATE', `${'GRANT'} ${'TRUNCATE'} ON TABLE ${TABLE} TO r`],
    ['a DROP TABLE', DROP_PROBE],
    ['an ALTER TABLE', `${'ALTER'} TABLE ${TABLE} DROP COLUMN request_id`],
    ['a schema-qualified UPDATE', `${'UPDATE'} public.${TABLE} SET x = 1`],
    ['a quoted DELETE', `${'DELETE'} FROM "${TABLE}" WHERE 1 = 1`],
    ['an UPDATE ONLY', `${'UPDATE'} ONLY ${TABLE} SET x = 1`],
    ['a lower-case delete', `${'delete'} from ${TABLE}`],
    ['an UPDATE split across lines', `${'UPDATE'}\n  ${TABLE}\n  SET x = 1`],
  ])('is red for %s', (_label, probe) => {
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(probe)))).toBe(true);
  });

  it('still sees a statement that shares a line with a URL', () => {
    // The unanchored line-comment stripper this repository has already been bitten
    // by: `//` inside `https://` swallowed the rest of the line, and the offender
    // vanished.
    const line = `const q = 'https://docs.example/audit'; const bad = \`${DELETE_PROBE}\`;`;
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(line)))).toBe(true);
  });

  it.each([
    ['the REVOKE that establishes the rule', `REVOKE UPDATE, DELETE, TRUNCATE ON ${TABLE} FROM r`],
    ['the GRANT that is allowed', `${'GRANT'} INSERT ON ${TABLE} TO stuwith_api`],
    ['a SELECT grant', `${'GRANT'} SELECT ON ${TABLE} TO stuwith_realtime`],
    ['an INSERT, which is the one allowed verb', `INSERT INTO ${TABLE} (action) VALUES ($1)`],
    ['a SELECT for reading the trail', `SELECT * FROM ${TABLE} WHERE request_id = $1`],
    ['a DELETE against a different table', `${'DELETE'} FROM sessions WHERE id = $1`],
    ['an UPDATE against a different table', `${'UPDATE'} users SET date_of_birth = $1`],
    ['an upsert against a different table', `INSERT INTO users VALUES ($1) ON CONFLICT DO NOTHING`],
    ['a table whose name merely starts the same', `${'DELETE'} FROM audit_events_archive`],
    ['a CREATE TABLE, which is how the table gets there', `CREATE TABLE ${TABLE} (id uuid)`],
  ])('is green for %s', (_label, line) => {
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(line)))).toBe(false);
  });

  it('does not flag the banned spellings when they appear inside a comment', () => {
    const docblock = `/**\n * Never write \`${DELETE_PROBE}\` here.\n */\nconst a = 1;`;
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(docblock)))).toBe(false);

    const lineComment = `// ${UPDATE_PROBE}\nconst a = 1;`;
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(lineComment)))).toBe(false);

    const sqlComment = `-- ${TRUNCATE_PROBE}\nSELECT 1;`;
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(sqlComment)))).toBe(false);

    // `#` for the shell and conf files the widened extension list now reaches.
    const hashComment = `# ${DROP_PROBE}\necho ok\n`;
    expect(BANNED.some(({ pattern }) => pattern.test(stripComments(hashComment)))).toBe(false);
  });
});
