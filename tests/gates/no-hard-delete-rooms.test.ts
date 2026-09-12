import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * AC5 — **there is no hard-delete path for a room, anywhere.**
 *
 * Epic 2's context states it as an invariant rather than as a preference: "Không
 * tồn tại đường xoá cứng một phòng. Phòng có trạng thái tường minh gồm `closing`;
 * giao thức đóng phòng đầy đủ thuộc epic sau, epic này chỉ có nghĩa vụ không mở cửa
 * hậu." A room is closed by moving its status, and the protocol that does so belongs
 * to a later story — so what THIS story owes is that no back door exists for that
 * story to find and use instead.
 *
 * ## Why a text scan, and why it is the right shape here
 *
 * The database already refuses most of this: no role holds `DELETE` or `TRUNCATE`
 * on `rooms`, and `rooms-migration.test.ts` proves it with real statements under
 * real roles. That is the enforcement. What a privilege cannot cover is the two
 * ways the rule dies WITHOUT a failing statement:
 *
 *  - a migration runs as the OWNER, not as an application role, so
 *    `DELETE FROM rooms` or `DROP TABLE rooms` in one succeeds;
 *  - `ON DELETE CASCADE` on `rooms.owner_user_id` is a hard-delete path that never
 *    writes the word DELETE in any application file at all — it lives in the schema
 *    and fires from a statement about a different table.
 *
 * And a `@Delete` route would be a path somebody adds first and grants for second,
 * which is how "the grant is missing" turns from a control into a TODO.
 *
 * So the rule is over the TEXT, the way `audit-append-only.test.ts` is, and every
 * pattern is anchored to `rooms` as an OPERAND — never to the word DELETE near the
 * word rooms, because the migration that establishes the rule contains
 * `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE rooms`, and a rule that is red
 * on the line making it true is a rule somebody weakens until it is green.
 *
 * ## The self-checks call the PRODUCTION function (the Story 2.0 lesson)
 *
 * `tests/gates/i18n-catalogue.test.ts` records what the alternative cost: its
 * self-checks rebuilt the matching logic inline, so deleting the whole scanning loop
 * out of the real function left 37 of 37 examples green and a planted violation
 * unreported. The gate worked and nothing guarded the gate. Every example below
 * writes a real file into a scanned directory and judges it with
 * {@link roomDeletionOffences} — the same function the sweep runs.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const SCAN_ROOTS = ['apps', 'packages', 'tests', 'infra', 'scripts', '.github'];
/**
 * `.sh` and `.psql` were missing, and `scripts/` and `infra/` are scanned roots.
 *
 * A `psql -c "DELETE FROM rooms"` in a shell script is a hard-delete path that
 * ships, runs as whatever role the operator holds — which for a maintenance script
 * is usually the OWNER, the one posture no GRANT can refuse — and was invisible to
 * every rule in this file because the walker never opened the file. The anti-vacuity
 * example below checks that each ROOT yields files; nothing checked that each root's
 * own file types are in this list.
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
  '.sh',
  '.bash',
  '.psql',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.next-e2e', 'coverage', '.git']);

/**
 * `rooms`, with the spellings Postgres treats as the same table.
 *
 * A schema qualifier and double quotes are allowed for the reason the audit gate
 * allows them: `public.rooms` and `"rooms"` are the same table, and a rule that only
 * sees the bare form is a rule with a one-character bypass.
 */
const ROOMS_OPERAND = String.raw`(?:ONLY\s+)?(?:[A-Za-z_][\w$]*\s*\.\s*)?"?rooms"?\b`;

/**
 * Any one table name, used ONLY to step over the tables that precede `rooms`.
 *
 * `TRUNCATE` takes a LIST, and a rule that could see `rooms` only immediately after
 * the keyword was satisfied by `TRUNCATE TABLE users, rooms` — one comma and one
 * unrelated table, and the table is emptied with this gate green. The prefix is
 * matched as repeated OPERANDS rather than as `[^;]*` so the span cannot wander out
 * of the table list and swallow whatever follows it.
 */
const ANY_TABLE_OPERAND = String.raw`(?:ONLY\s+)?(?:[A-Za-z_][\w$]*\s*\.\s*)?"?[A-Za-z_][\w$]*"?`;

interface BannedStatement {
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * Whether the rule only applies to a file that deals with rooms at all.
   *
   * `true` for the `@Delete` rule and false for every SQL one, and the asymmetry is
   * deliberate: the SQL patterns NAME the table, so scoping them by a second mention
   * would let a file evade them by mentioning it once. `@Delete` names nothing, so
   * without the scope it would be a repo-wide ban on a decorator that some future
   * epic has every right to use somewhere else.
   */
  readonly roomsOnly?: boolean;
}

const BANNED: readonly BannedStatement[] = [
  {
    name: 'DELETE of a room',
    pattern: new RegExp(String.raw`\bDELETE\s+FROM\s+${ROOMS_OPERAND}`, 'i'),
  },
  {
    name: 'TRUNCATE of the rooms table',
    pattern: new RegExp(
      String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:${ANY_TABLE_OPERAND}\s*,\s*)*${ROOMS_OPERAND}`,
      'i',
    ),
  },
  {
    name: 'DROP of the rooms table',
    pattern: new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${ROOMS_OPERAND}`, 'i'),
  },
  {
    /**
     * The scenario this gate's own argument names — "somebody granted the privilege
     * to make it work". The `[^;]` spans are what keep it from reaching across a
     * statement boundary into the `REVOKE` that takes the same privileges away.
     */
    name: 'GRANT of a privilege that could remove a room',
    pattern: new RegExp(
      String.raw`\bGRANT\b[^;]{0,200}?\b(?:DELETE|TRUNCATE)\b[^;]{0,200}?\bON\s+(?:TABLE\s+)?${ROOMS_OPERAND}`,
      'i',
    ),
  },
  {
    /**
     * The grant that names no table and reaches `rooms` anyway.
     *
     * `GRANT DELETE ON ALL TABLES IN SCHEMA public TO stuwith_api` hands the
     * privilege over every table the schema holds, `rooms` among them, and the rule
     * above cannot see it because there is no operand to anchor on. It is the same
     * statement shape the migration that establishes AD-8 already uses in its
     * harmless direction (`GRANT SELECT ON ALL TABLES IN SCHEMA public`), which is
     * exactly why it would not look out of place to the next reader.
     *
     * Repo-wide rather than {@link BannedStatement.roomsOnly}, unlike `@Delete`: a
     * schema-wide grant of `DELETE` covers `rooms` whether or not the file
     * mentions it, so scoping it by a second mention would be a one-word bypass.
     */
    name: 'a schema-wide GRANT of a privilege that could remove a room',
    pattern: new RegExp(
      String.raw`\bGRANT\b[^;]{0,200}?\b(?:DELETE|TRUNCATE)\b[^;]{0,200}?\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\b`,
      'i',
    ),
  },
  {
    /**
     * The cascade that empties `rooms` while naming only another table.
     *
     * `TRUNCATE TABLE users CASCADE` truncates every table with a foreign key into
     * `users`, and `rooms.owner_user_id` is one. `ON DELETE RESTRICT` does NOT save
     * it: a referential action governs `DELETE`, and `TRUNCATE ... CASCADE` is a
     * separate mechanism that cascades regardless. So the statement that empties
     * every room in the product does not contain the word `rooms` anywhere, and the
     * operand-anchored rule above — correctly, on its own terms — sees nothing.
     *
     * Repo-wide, and the trade is stated rather than assumed: this bans
     * `TRUNCATE ... CASCADE` on ANY table, because a rule that tried to decide which
     * tables reference `rooms` would have to read the schema, and a rule that read
     * the schema would go quiet the day somebody adds a foreign key. Nothing in this
     * repository truncates anything outside a test file, which the sweep excludes.
     */
    name: 'a TRUNCATE ... CASCADE, which empties rooms through a foreign key',
    pattern: new RegExp(String.raw`\bTRUNCATE\b[^;]{0,200}?\bCASCADE\b`, 'i'),
  },
  {
    /**
     * Taking the whole schema out, which takes `rooms` with it.
     *
     * `DROP SCHEMA public CASCADE` is one statement, names no table, and leaves
     * nothing for any other rule here to anchor on. It belongs with the `DROP TABLE`
     * rule for the same reason that one exists: a migration runs as the OWNER, so no
     * privilege refuses it.
     */
    name: 'a DROP SCHEMA, which removes the rooms table with everything else',
    pattern: new RegExp(
      String.raw`\bDROP\s+SCHEMA\b|\bpgm\s*\.\s*dropSchema\s*\(`,
      'i',
    ),
  },
  {
    /**
     * `node-pg-migrate`'s JavaScript API, which writes none of the words above.
     *
     * Every migration in this repository today calls `pgm.sql(...)` with real SQL,
     * so every rule above can read it. `pgm.dropTable('rooms')` is the same DDL
     * expressed as a method call — the library builds `DROP TABLE` at run time — and
     * it contains neither `DROP` nor `TABLE` for a text scan to find. It needs no
     * grant either: a migration runs as the OWNER, which is the second of the two
     * holes this gate's own docblock says a privilege cannot cover.
     */
    name: 'a dropTable of rooms through the migration builder',
    pattern: new RegExp(
      String.raw`\bpgm\s*\.\s*dropTable\s*\(\s*[^)]{0,200}?\brooms\b`,
      'i',
    ),
  },
  {
    /**
     * A NestJS route that removes a room.
     *
     * Anchored on the decorator rather than on a method name: `@Delete()` is what
     * mounts the route, and `async remove()` under it is a name somebody can change.
     * The file has to be one that deals with rooms at all — see
     * {@link touchesRooms} — because `@Delete` on some future coin endpoint is not
     * this rule's business.
     */
    name: 'a @Delete route on something that deals with rooms',
    pattern: /@Delete\s*\(/,
    roomsOnly: true,
  },
];

/**
 * Comments stripped before scanning, with the line-comment rule ANCHORED.
 *
 * Every docblock in this change set explains what a hard delete would be and quotes
 * the statements it is about — this very file does — so a scan that read them would
 * report the explanation as the offence. The anchor matters separately: an
 * unanchored `\/\/.*$` treats the `//` in `https://x` as a comment and deletes the
 * rest of the line, so an offence sitting after a URL would disappear.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*--.*$/gm, '')
    .replace(/^[ \t]*#.*$/gm, '');
}

/**
 * Whether a file deals with rooms at all.
 *
 * Only the `@Delete` rule uses it. The SQL rules name the table themselves, so they
 * need no such filter — and giving them one would mean a file could evade the rule
 * by not mentioning the word twice.
 */
function touchesRooms(code: string): boolean {
  return /\bROOMS_PATH\b|\bRoomPort\b|\bRoomsController\b|\brooms?\b/i.test(code);
}

/**
 * Every banned statement in one file, in the order the patterns are declared.
 *
 * THE production function. Every example below calls it, including the self-checks,
 * so a rule that silently stopped matching cannot look like a codebase that never
 * offended.
 */
export function roomDeletionOffences(file: string): readonly string[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  const dealsWithRooms = touchesRooms(code);

  return BANNED.flatMap(({ name, pattern, roomsOnly }) => {
    if (roomsOnly === true && !dealsWithRooms) {
      return [];
    }
    const match = pattern.exec(code);
    return match === null ? [] : [`${name}: "${match[0].replace(/\s+/g, ' ')}"`];
  });
}

/** Product and test sources alike — see the exclusion below for the one exception. */
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

/**
 * A `.test.ts(x)` file ships to nobody, and the exclusion is load-bearing rather
 * than convenient.
 *
 * `packages/db/src/rooms-migration.test.ts` runs `DELETE FROM rooms` under
 * `stuwith_api` and expects `42501`, and `room-contract.pg.test.ts` truncates the
 * table as the container's OWNER between examples. Those two statements are the
 * PROOF that the rule holds — deleting them to satisfy this scan would delete the
 * only evidence that the database refuses a delete at all, which is the opposite of
 * what the rule is for.
 *
 * That is a real hole, and it is worth naming precisely: a hard-delete path added
 * inside a test file is invisible here. What closes it is that a test file is not a
 * path anything in production can take, and that the privilege model refuses the
 * statement anyway for both application roles.
 */
const isTestFile = (file: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(file);

const SOURCE_FILES: readonly string[] = [
  ...SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root), [], true)),
  // The repository root itself, non-recursively — a stray `drop-rooms.sql` beside
  // `package.json` would otherwise be invisible.
  ...walk(REPO_ROOT, [], false),
].filter((file) => !isTestFile(file));

/** Repo-relative and forward-slashed, so a Windows walk and a Linux one agree. */
function relative(file: string): string {
  return path.relative(REPO_ROOT, file).replace(/\\/g, '/');
}

const OFFENCES: ReadonlyMap<string, readonly string[]> = new Map(
  SOURCE_FILES.map((file) => [relative(file), roomDeletionOffences(file)] as const),
);

describe('the sweep reads the repository, so an empty pass is impossible', () => {
  it('walks a meaningful number of files', () => {
    // Every assertion below is vacuous against a walker that found nothing — the
    // same guard `routes.test.ts` and `i18n-catalogue.test.ts` put in front of their
    // own sweeps.
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(100);
  });

  it('reaches the three files this rule is actually about', () => {
    const names = [...OFFENCES.keys()];
    expect(names).toContain('packages/db/migrations/1788480200000_rooms-and-plans.js');
    expect(names).toContain('apps/api/src/rooms/rooms.controller.ts');
    expect(names).toContain('packages/domain/src/ports/room-port.ts');
  });

  it('excludes the test files that are ALLOWED to contain the statements', () => {
    // Named, because the exclusion is what makes the rule satisfiable at all, and a
    // reader has to be able to see which files it lets through.
    const names = [...OFFENCES.keys()];
    expect(names).not.toContain('packages/db/src/rooms-migration.test.ts');
    expect(names).not.toContain('packages/db/src/room-contract.pg.test.ts');
  });
});

describe('no shipped file contains a hard-delete path for a room', () => {
  it('finds no statement that could remove, empty or drop a room', () => {
    // ONE example over the whole map rather than one per file: a few hundred green
    // `it.each` rows for a rule with no offenders is noise that hides the two
    // anti-vacuity guards above, which are the examples that can actually break.
    const offenders: string[] = [];
    for (const [file, statements] of OFFENCES) {
      for (const statement of statements) {
        offenders.push(`${file} — ${statement}`);
      }
    }

    expect(
      offenders,
      'A room is closed by moving its status (open -> closing -> closed), never ' +
        'removed. No role holds DELETE or TRUNCATE on `rooms`, `owner_user_id` is ' +
        'ON DELETE RESTRICT rather than CASCADE, and there is no endpoint that ' +
        'removes one. If you genuinely need one, that is a conversation, not a commit.',
    ).toEqual([]);
  });

  it.each(SCAN_ROOTS.filter((root) => existsSync(path.join(REPO_ROOT, root))))(
    'actually reads files under %s, rather than listing it',
    (root) => {
      // The bug `audit-append-only.test.ts` records about itself: a scanned root
      // whose file types are in none of `SCANNED_EXTENSIONS` contributes zero files
      // while the docblock claims it is covered, and neither anti-vacuity guard can
      // see it because one big root clears the count.
      const prefix = `${root.replace(/\\/g, '/')}/`;
      expect([...OFFENCES.keys()].filter((file) => file.startsWith(prefix)).length).toBeGreaterThan(
        0,
      );
    },
  );
});

/* -------------------------------------------------------------------------- *
 * The rule, checked against planted files, through the production function
 * -------------------------------------------------------------------------- */

/**
 * A real file, in a real scanned directory, judged by the real function.
 *
 * It goes into `apps/api/src/rooms/` for the reason the i18n gate plants inside the
 * app tree: `roomDeletionOffences` reports paths relative to the repository root and
 * exists to judge modules in these directories, so a fixture somewhere else would be
 * judged by the same code without exercising the walker and the reporter agreeing
 * about where things are.
 *
 * Cleanup is in a `finally` AND an `afterEach`. A leftover would be picked up by the
 * sweep on the next run and fail loudly by name, which is the right way for this to
 * break. The `gates` project runs with `fileParallelism: false`, which is what makes
 * writing into a source tree safe here at all.
 */
const PROBE_FILE = path.join(REPO_ROOT, 'apps', 'api', 'src', 'rooms', 'rooms-gate-probe.generated.ts');

function withPlantedFile<T>(source: string, judge: (file: string) => T): T {
  writeFileSync(PROBE_FILE, source, 'utf8');
  try {
    return judge(PROBE_FILE);
  } finally {
    rmSync(PROBE_FILE, { force: true });
  }
}

afterEach(() => {
  rmSync(PROBE_FILE, { force: true });
});

describe('every banned spelling is really reported, by the function the sweep runs', () => {
  const OFFENDING: ReadonlyArray<readonly [string, string]> = [
    ['a bare DELETE', `export const sql = "DELETE FROM rooms WHERE id = $1";`],
    ['a schema-qualified DELETE', `export const sql = "DELETE FROM public.rooms";`],
    ['a quoted DELETE', `export const sql = 'DELETE FROM "rooms"';`],
    ['a lowercase DELETE', `export const sql = "delete from rooms where id = $1";`],
    ['DELETE FROM ONLY', `export const sql = "DELETE FROM ONLY rooms";`],
    ['a TRUNCATE', `export const sql = "TRUNCATE rooms";`],
    ['a TRUNCATE TABLE', `export const sql = "TRUNCATE TABLE rooms";`],
    ['a DROP TABLE', `export const sql = "DROP TABLE rooms";`],
    ['a DROP TABLE IF EXISTS', `export const sql = "DROP TABLE IF EXISTS rooms";`],
    [
      'a GRANT of DELETE',
      `export const sql = "GRANT DELETE ON TABLE rooms TO stuwith_api";`,
    ],
    [
      'a GRANT of TRUNCATE among others',
      `export const sql = "GRANT SELECT, TRUNCATE ON rooms TO stuwith_api";`,
    ],
    [
      'a @Delete route in a file that deals with rooms',
      `import { Controller, Delete } from '@nestjs/common';\n` +
        `@Controller('v1/rooms')\nexport class X { @Delete(':id') remove() { return 1; } }`,
    ],
    // The four spellings review round 1 found this gate blind to. Each was green
    // against the rules as they stood, and each empties or drops the table.
    [
      'a TRUNCATE that lists another table first',
      `export const sql = "TRUNCATE TABLE users, rooms";`,
    ],
    [
      'a TRUNCATE list with a schema qualifier on the decoy',
      `export const sql = "TRUNCATE public.users, public.rooms RESTART IDENTITY";`,
    ],
    [
      'a schema-wide GRANT of DELETE',
      `export const sql = "GRANT DELETE ON ALL TABLES IN SCHEMA public TO stuwith_api";`,
    ],
    [
      'a schema-wide GRANT of TRUNCATE among others',
      `export const sql = "GRANT SELECT, TRUNCATE ON ALL TABLES IN SCHEMA public TO stuwith_realtime";`,
    ],
    ['a dropTable through the builder', `exports.up = (pgm) => { pgm.dropTable('rooms'); };`],
    [
      'a dropTable through the builder, in its object form',
      `exports.up = (pgm) => { pgm.dropTable({ schema: 'public', name: 'rooms' }, { ifExists: true }); };`,
    ],
    // Round 2: three more spellings that empty or remove the table without naming it.
    [
      'a TRUNCATE CASCADE on the table rooms points at',
      `export const sql = "TRUNCATE TABLE users CASCADE";`,
    ],
    ['a DROP SCHEMA', `export const sql = "DROP SCHEMA public CASCADE";`],
    ['a dropSchema through the builder', `exports.down = (pgm) => { pgm.dropSchema('public'); };`],
  ];

  it.each(OFFENDING)('reports %s when it is really in a file', (_label, source) => {
    const found = withPlantedFile(source, roomDeletionOffences);
    expect(found, `${source} was not reported`).not.toEqual([]);
  });

  /**
   * The other direction, and it matters more than it looks.
   *
   * A rule broad enough to flag the REVOKE that takes the privilege away, or the
   * `ON DELETE RESTRICT` that is the correct referential action, would be
   * unsatisfiable — and the first person to hit that would weaken it rather than
   * argue with it. Every value below is real text from this change set.
   */
  const LEGITIMATE: ReadonlyArray<readonly [string, string]> = [
    [
      'the REVOKE that establishes the rule',
      `export const sql = "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE rooms FROM stuwith_realtime";`,
    ],
    [
      'the GRANT that is actually issued',
      `export const sql = "GRANT INSERT, UPDATE ON TABLE rooms TO stuwith_api";`,
    ],
    [
      'the correct referential action',
      `export const sql = "owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT";`,
    ],
    [
      'a DELETE against a DIFFERENT table',
      `export const sql = "DELETE FROM room_reservations WHERE expires_at < now()";`,
    ],
    ['a @Post route on rooms', `@Controller('v1/rooms')\nexport class X { @Post() create() {} }`],
    [
      'a @Delete route on something that is not about rooms',
      `import { Controller, Delete } from '@nestjs/common';\n` +
        `@Controller('v1/drafts')\nexport class X { @Delete() remove() { return 1; } }`,
    ],
    [
      'prose about the rule, in a comment',
      `/* There is no DELETE FROM rooms anywhere, and no DROP TABLE rooms either. */\nexport const x = 1;`,
    ],
    // The other side of the three rules widened above. Each is real text from the
    // roles migration or a shape it would be reasonable to write, and a rule that
    // flagged one of them is a rule the next person weakens instead of arguing with.
    [
      'the schema-wide REVOKE that establishes the posture',
      `export const sql = "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC";`,
    ],
    [
      'the schema-wide GRANT that IS issued, which grants only SELECT',
      `export const sql = "GRANT SELECT ON ALL TABLES IN SCHEMA public TO stuwith_api";`,
    ],
    [
      'a TRUNCATE of other tables that never reaches rooms',
      `export const sql = "TRUNCATE TABLE users, sessions";`,
    ],
    [
      'a dropTable of a DIFFERENT table through the builder',
      `exports.up = (pgm) => { pgm.dropTable('room_reservations'); };`,
    ],
    [
      'a builder call on rooms that is not a drop',
      `exports.up = (pgm) => { pgm.addIndex('rooms', ['topic']); };`,
    ],
    // A TRUNCATE with no CASCADE reaches nothing through a foreign key, and a
    // CASCADE that is a referential action is the CORRECT spelling on other tables.
    [
      'a plain TRUNCATE of an unrelated table',
      `export const sql = "TRUNCATE TABLE audit_scratch";`,
    ],
    [
      'the CASCADE that user_identities is right to use',
      `export const sql = "user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE";`,
    ],
  ];

  it.each(LEGITIMATE)('leaves %s alone', (_label, source) => {
    expect(withPlantedFile(source, roomDeletionOffences)).toEqual([]);
  });

  it('the walker can see a planted file at all, not only the judge', () => {
    /**
     * The half a `withPlantedFile` alone does not prove: that the SWEEP would have
     * found the file. Judging a path handed in directly is green even against a
     * walker that stopped descending into `apps/`, which would leave the whole rule
     * running over nothing.
     */
    const found = withPlantedFile(`export const sql = "DELETE FROM rooms";`, () =>
      walk(path.join(REPO_ROOT, 'apps'), [], true).map(relative),
    );
    expect(found).toContain('apps/api/src/rooms/rooms-gate-probe.generated.ts');
  });
});

/* -------------------------------------------------------------------------- *
 * The path that writes no DELETE at all: ON DELETE CASCADE in the schema
 * -------------------------------------------------------------------------- */

/**
 * `CASCADE` on `rooms.owner_user_id` would BE a hard-delete path for rooms — one
 * that lives in the schema instead of in a controller, fires from a statement about
 * a different table, and contains no spelling any rule above could match.
 *
 * `user_identities` and `sessions` use `CASCADE` and are right to: an identity or a
 * session without its person is meaningless. A room is not like that, and the AC
 * says "an endpoint OR any code path".
 *
 * The migrations are DISCOVERED rather than named. A constant filename would be a
 * list of examples of length one — the shape `AGENTS.md` records as having cost four
 * review rounds on the trusted-proxy list — and a SECOND migration touching the
 * table (a new foreign key, a re-created constraint) would sit outside the rule with
 * nothing saying so.
 */
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'db', 'migrations');

/**
 * Whether a migration touches the rooms table, in any spelling it can be touched in.
 *
 * The discovery is what decides which files the cascade rule below runs over, so a
 * spelling missing HERE is not a rule that fails — it is a file that is never
 * examined, and a describe block that stays green by looking at nothing. Two
 * spellings were missing and both are ordinary:
 *
 *  - `ALTER TABLE public.rooms`, because the branch was written as literal
 *    `ALTER\s+TABLE\s+rooms` while {@link ROOMS_OPERAND} — which allows the schema
 *    qualifier and the quotes — already existed two hundred lines above it;
 *  - `pgm.createTable('rooms', …)`, the builder form. Every migration here writes
 *    raw SQL today, so it costs nothing to add and it is the form somebody reaching
 *    for the library's documentation writes first.
 *
 * The builder methods are ENUMERATED rather than matched as `pgm.<anything>`. The
 * loose version was written first and was wrong in the expensive direction: it
 * matched `pgm.sql(...)` and therefore pulled in the roles migration, whose
 * `COMMENT ON ROLE` prose names `rooms` while touching no table at all — and that
 * file legitimately contains `ON DELETE CASCADE` for `user_identities`, so the rule
 * went red on a migration it has no business judging. Raw SQL is already covered by
 * the two branches above it; this branch is only about the method calls they cannot
 * see.
 */
const TABLE_BUILDER_METHODS = [
  'createTable',
  'dropTable',
  'renameTable',
  'addColumns',
  'addColumn',
  'dropColumns',
  'dropColumn',
  'alterColumn',
  'renameColumn',
  'addConstraint',
  'dropConstraint',
  'createIndex',
  'addIndex',
  'dropIndex',
].join('|');

const TOUCHES_ROOMS_TABLE = new RegExp(
  [
    String.raw`CREATE\s+TABLE[^;]{0,80}\brooms\b`,
    String.raw`ALTER\s+TABLE\s+${ROOMS_OPERAND}`,
    String.raw`\bpgm\s*\.\s*(?:${TABLE_BUILDER_METHODS})\s*\(\s*[^)]{0,200}?\brooms\b`,
  ].join('|'),
  'i',
);

/**
 * The discovery, as a function over a directory rather than over one constant path.
 *
 * Taking the directory as an argument is what lets the last example below run the
 * REAL discovery over a planted file without writing into `packages/db/migrations` —
 * a stray `.js` left behind there is not an untidy file, it is a migration
 * `pnpm test:migrations` would try to run.
 */
export function roomsMigrationsIn(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.js'))
    .filter((file) => TOUCHES_ROOMS_TABLE.test(stripComments(readFileSync(path.join(dir, file), 'utf8'))));
}

const roomsMigrations = roomsMigrationsIn(MIGRATIONS_DIR);

/**
 * A cascade, in both spellings the migration runner understands.
 *
 * `ON DELETE CASCADE` is the SQL. `onDelete: 'CASCADE'` is the same referential
 * action written as a `node-pg-migrate` column option — the library emits the former
 * from the latter, so a rule that reads only the SQL is green on a schema that
 * cascades. The quotes are optional and either kind is allowed, because the value
 * travels through a JavaScript object literal rather than through a SQL string.
 */
const CASCADE_SPELLINGS = /ON\s+DELETE\s+CASCADE|onDelete\s*:\s*['"`]?\s*CASCADE/i;

describe('the rooms table is never reachable by a cascading delete', () => {
  it('finds a migration that creates or alters it, so the rule is over something', () => {
    expect(roomsMigrations.length).toBeGreaterThanOrEqual(1);
  });

  it('names the migration this story added, so the discovery is not matching by luck', () => {
    // The count above is satisfied by any one migration. This is what says the
    // discovery reaches the file the rule is actually about — a widened pattern that
    // silently stopped matching it would otherwise leave the block green.
    expect(roomsMigrations).toContain('1788480200000_rooms-and-plans.js');
  });

  it.each(roomsMigrations)('%s declares no cascade, in either spelling', (file) => {
    const source = stripComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    expect(source, 'a cascade here is a hard-delete path in the schema').not.toMatch(
      CASCADE_SPELLINGS,
    );
  });

  it('and it declares the RESTRICT that replaces it, so the absence is not an omission', () => {
    // Without this, a migration that dropped the foreign key entirely would satisfy
    // the rule above perfectly — and a room whose owner no longer exists is the same
    // dangling state a cascade was there to avoid, reached from the other side.
    const sources = roomsMigrations
      .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
      .join('\n');
    expect(sources).toMatch(/REFERENCES\s+users\s*\(\s*id\s*\)\s*ON\s+DELETE\s+RESTRICT/i);
  });

  it.each([
    ['the SQL spelling', 'user_id uuid REFERENCES users (id) ON DELETE CASCADE', true],
    ["the builder's option", `{ references: 'users', onDelete: 'CASCADE' }`, true],
    ["the builder's option, unquoted", '{ onDelete: CASCADE }', true],
    ['the correct referential action', 'owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT', false],
    ["the builder's RESTRICT", `{ references: 'users', onDelete: 'RESTRICT' }`, false],
  ] as const)('recognises %s', (_label, source, expected) => {
    // The rule checking itself, over the same regex the examples above run. The
    // RESTRICT rows are what keep it from being a rule that simply says yes.
    expect(CASCADE_SPELLINGS.test(source)).toBe(expected);
  });

  it.each([
    [
      'the builder form',
      `exports.up = (pgm) => { pgm.createTable('rooms', { owner_user_id: { references: 'users', onDelete: 'CASCADE' } }); };\n`,
    ],
    [
      'a schema-qualified ALTER',
      `exports.up = (pgm) => { pgm.sql(\`ALTER TABLE public.rooms ADD CONSTRAINT fk FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE\`); };\n`,
    ],
  ])('discovers a migration written as %s, and judges it', (_label, source) => {
    /**
     * The half the rows above cannot show: that the DISCOVERY and the rule meet on
     * the same file. Both spellings here were INVISIBLE to the discovery before
     * review round 1 — `it.each(roomsMigrations)` simply never saw the file, so the
     * block reported success while examining nothing.
     *
     * A temporary directory, not `packages/db/migrations`: a stray `.js` left behind
     * there is a migration `pnpm test:migrations` would try to run.
     */
    const dir = mkdtempSync(path.join(tmpdir(), 'rooms-gate-'));
    try {
      const name = '9999999999999_planted.js';
      writeFileSync(path.join(dir, name), source, 'utf8');

      expect(roomsMigrationsIn(dir)).toContain(name);
      expect(CASCADE_SPELLINGS.test(stripComments(readFileSync(path.join(dir, name), 'utf8')))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a migration that touches no rooms table undiscovered', () => {
    // The other direction: a discovery that said yes to everything would make the
    // example above pass and the rule meaningless.
    const dir = mkdtempSync(path.join(tmpdir(), 'rooms-gate-'));
    try {
      writeFileSync(
        path.join(dir, '9999999999998_other.js'),
        `exports.up = (pgm) => { pgm.createTable('room_reservations', {}); };\n`,
        'utf8',
      );
      expect(roomsMigrationsIn(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
