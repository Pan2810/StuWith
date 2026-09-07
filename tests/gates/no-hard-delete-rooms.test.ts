import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.sql', '.yml', '.yaml'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.next-e2e', 'coverage', '.git']);

/**
 * `rooms`, with the spellings Postgres treats as the same table.
 *
 * A schema qualifier and double quotes are allowed for the reason the audit gate
 * allows them: `public.rooms` and `"rooms"` are the same table, and a rule that only
 * sees the bare form is a rule with a one-character bypass.
 */
const ROOMS_OPERAND = String.raw`(?:ONLY\s+)?(?:[A-Za-z_][\w$]*\s*\.\s*)?"?rooms"?\b`;

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
    pattern: new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?${ROOMS_OPERAND}`, 'i'),
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

const roomsMigrations = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.js'))
  .filter((file) => {
    const source = stripComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    return /CREATE\s+TABLE[^;]{0,80}\brooms\b|ALTER\s+TABLE\s+rooms\b/i.test(source);
  });

describe('the rooms table is never reachable by a cascading delete', () => {
  it('finds a migration that creates or alters it, so the rule is over something', () => {
    expect(roomsMigrations.length).toBeGreaterThanOrEqual(1);
  });

  it.each(roomsMigrations)('%s declares no ON DELETE CASCADE', (file) => {
    const source = stripComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    expect(source, 'a cascade here is a hard-delete path in the schema').not.toMatch(
      /ON\s+DELETE\s+CASCADE/i,
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

  it('recognises a cascade when there really is one', () => {
    // The rule checking itself, over the same regex the examples above run.
    expect(/ON\s+DELETE\s+CASCADE/i.test('user_id uuid REFERENCES users (id) ON DELETE CASCADE')).toBe(
      true,
    );
    expect(/ON\s+DELETE\s+CASCADE/i.test('owner_user_id uuid REFERENCES users (id) ON DELETE RESTRICT')).toBe(
      false,
    );
  });
});
