import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Story 2.1's plan-capacity claim, as a control rather than a belief: **add a
 * fourth `UserPlan` and `typecheck` goes red because `PLAN_PARTICIPANT_LIMITS` is
 * missing a branch.**
 *
 * `packages/contracts/src/rooms.ts` says so in prose — "a fourth plan added to
 * `USER_PLANS` is a typecheck error here, which is the one place it has to be
 * answered" — and the whole value of that sentence is a compile error nobody can
 * observe from a passing test suite. Every other test in this repository asserts
 * that correct code behaves; this one asserts that INCORRECT code does not
 * compile, which is the only medium the claim actually lives in.
 *
 * Same argument and same mechanism as `ad-1-dependency-direction.test.ts`: write a
 * file into the package's `src`, run the real compiler over the real reference
 * graph, assert it fails, delete the file.
 *
 * ## Why it does not edit `rooms.ts` itself
 *
 * Editing a tracked source file from a test means a crashed run leaves the
 * repository modified — and this file is one whose modification is invisible in a
 * green suite. A scratch file that `.gitignore` already covers can be swept before
 * the run and deleted after it, and it exercises exactly the same relationship: a
 * `UserPlan` union with one more member than the table has keys for.
 *
 * The GREEN counterpart matters as much as the red one. Without it, a broken
 * compiler invocation — a bad path, a missing tsconfig — would fail on every input
 * including the ones it must accept, and the gate would report success at catching
 * something it never saw.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Its OWN basename, covered by its own `.gitignore` line.
 *
 * Not the `__ad1_violation__.ts` that `ad-1-dependency-direction.test.ts` writes:
 * nothing collides today because the `gates` project runs `fileParallelism: false`,
 * but that is one config line away from being untrue, and a shared name is a lie
 * about what this probe is — a leftover file would send whoever found it to the
 * wrong test.
 *
 * Same PLACEMENT argument as that file, though: it goes where its presence BREAKS
 * the build, which is what makes a leftover impossible to ignore.
 */
const PROBE_BASENAME = '__plan_capacity_probe__.ts';
const PROBE_PATH = path.join(REPO_ROOT, 'packages', 'contracts', 'src', PROBE_BASENAME);

/**
 * A ceiling on the compiler run, in the child rather than in vitest.
 *
 * `spawnSync` BLOCKS the worker thread, so vitest's own `testTimeout` cannot fire
 * while it is running — a `tsc` that hung would hang the whole gates project until
 * CI killed the job, with no output saying which example was stuck. The timeout has
 * to be the child's.
 */
const TSC_TIMEOUT_MS = 120_000;

function writeProbe(source: string): void {
  writeFileSync(PROBE_PATH, source, 'utf8');
}

/**
 * `tsc -p ... --noEmit` over the identical reference graph the real
 * `pnpm typecheck` uses, minus the emit — so it can run while other test projects
 * are importing `packages/contracts/dist` without racing them.
 *
 * `status === null` is never treated as a pass: `spawnSync` returns null when the
 * child was killed or never started, and `expect(null).not.toBe(0)` would make a
 * compiler that failed to launch look like a caught violation.
 */
function runTypecheck(): { status: number; output: string } {
  const entry = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(
    process.execPath,
    [entry, '-p', 'packages/contracts/tsconfig.json', '--noEmit', '--composite', 'false'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: TSC_TIMEOUT_MS,
    },
  );

  if (result.error) {
    throw new Error(`failed to spawn tsc: ${result.error.message}`);
  }
  if (result.status === null) {
    // Includes the timeout above: a killed child reports `status: null` and a
    // signal. Reporting that as "non-zero, so the violation was caught" is exactly
    // the silent pass this branch exists to prevent.
    throw new Error(
      `tsc did not exit normally (signal: ${String(result.signal)}). Treating this as a pass ` +
        'would make the gate meaningless.',
    );
  }
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

beforeAll(() => {
  // A previous run that crashed leaves the probe behind, and the first thing it
  // breaks is the clean-tree example — which then reads as a real regression.
  rmSync(PROBE_PATH, { force: true });
});

afterEach(() => {
  rmSync(PROBE_PATH, { force: true });
});

describe('the plan participant table is exhaustive over UserPlan, and the compiler says so', () => {
  it('compiles cleanly as it stands', () => {
    // The anti-vacuity half.
    expect(runTypecheck().status).toBe(0);
  }, 300_000);

  it('goes RED when a fourth plan exists with no participant limit for it', () => {
    // The claim, written as the smallest thing that reproduces it: a `UserPlan`
    // union with one more member than the table has keys. This is precisely what
    // `Readonly<Record<UserPlan, number>>` checks inside `rooms.ts` — widen that
    // annotation to `Record<string, number>` and add a plan, and nothing else in
    // the repository would notice.
    writeProbe(
      [
        "import { PLAN_PARTICIPANT_LIMITS, type UserPlan } from './rooms';",
        '',
        "type WithAFourthPlan = UserPlan | 'school_district';",
        '',
        'export const limits: Record<WithAFourthPlan, number> = PLAN_PARTICIPANT_LIMITS;',
        '',
      ].join('\n'),
    );

    const { status, output } = runTypecheck();

    expect(status, 'a plan with no participant limit must not compile').not.toBe(0);
    // By the RIGHT reason. A file that failed to resolve its import would also exit
    // non-zero and would prove nothing about exhaustiveness.
    expect(output).toContain(PROBE_BASENAME);
    expect(output).toContain('school_district');
  }, 300_000);

  it('stays GREEN for a table that really does cover the union', () => {
    // The other direction, so the example above is failing on the missing branch
    // rather than on anything else about the shape of `PLAN_PARTICIPANT_LIMITS`.
    writeProbe(
      [
        "import { PLAN_PARTICIPANT_LIMITS, type UserPlan } from './rooms';",
        '',
        'export const limits: Record<UserPlan, number> = PLAN_PARTICIPANT_LIMITS;',
        '',
      ].join('\n'),
    );

    expect(runTypecheck().status).toBe(0);
  }, 300_000);

  it('goes RED for a limit that is not a number, so the value type is real too', () => {
    // `Record<UserPlan, number>` constrains the VALUES as well as the keys, and a
    // table whose keys were checked while its values were `unknown` would let
    // `campus: '45'` through — a string that reaches a `max_participants` column
    // typed `integer`, and that Story 2.2 would count reservations against.
    writeProbe(
      [
        "import { PLAN_PARTICIPANT_LIMITS } from './rooms';",
        '',
        'export const wrong: Record<string, string> = PLAN_PARTICIPANT_LIMITS;',
        '',
      ].join('\n'),
    );

    expect(runTypecheck().status).not.toBe(0);
  }, 300_000);
});
