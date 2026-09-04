import * as contracts from '@stuwith/contracts';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every route constant `packages/contracts` publishes names a page that EXISTS.
 *
 * ## The gap this closes
 *
 * `DATE_OF_BIRTH_PATHNAME` was pinned by three assertions in
 * `packages/contracts/src/auth.test.ts`, and all three compared it with another
 * constant: it is not `AUTH_DATE_OF_BIRTH_PATH`, it does not start with `/v1`, it
 * is not `SIGN_IN_PATHNAME`. Changing its value to `/ngay-sinh` without renaming
 * `apps/web/src/app/khai-ngay-sinh/` left every one of those true, every gate
 * green, and every link built from the constant pointing at a 404.
 *
 * The API side of the same constant family is held down twice — by a literal and
 * by real HTTP traffic through it (`auth.flow.test.ts`). The web side had neither
 * half. This is the second half: the constant is compared with the FILESYSTEM,
 * which is what Next.js actually routes on.
 *
 * ## Why it sweeps the exports instead of listing the two routes
 *
 * A third `_PATHNAME` added later would otherwise be unprotected until somebody
 * remembered to add a line here — the same "list of examples" shape that
 * `AGENTS.md` records as having cost four review rounds on the trusted-proxy
 * list. The rule is over the set: whatever `packages/contracts` exports under
 * that suffix must be routable.
 */

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * The route constants, discovered rather than listed.
 *
 * The `_PATHNAME` suffix is the convention `SIGN_IN_PATHNAME` established and
 * `DATE_OF_BIRTH_PATHNAME` followed: a `*_PATH` is a `/v1` endpoint in `apps/api`,
 * a `*_PATHNAME` is a page in `apps/web`. Only the second kind is a directory.
 */
const webPathnames: ReadonlyArray<readonly [string, string]> = Object.entries(contracts)
  .filter(
    (entry): entry is [string, string] =>
      entry[0].endsWith('_PATHNAME') && typeof entry[1] === 'string',
  )
  .map(([name, value]) => [name, value] as const);

describe('every web route constant points at a real page', () => {
  it('finds the constants at all, so an empty sweep cannot pass', () => {
    // A filter that matched nothing would make every assertion below vacuous —
    // the same guard `seam-usage.test.ts` puts in front of its file sweep.
    expect(webPathnames.length).toBeGreaterThanOrEqual(2);
    const names = webPathnames.map(([name]) => name);
    expect(names).toContain('SIGN_IN_PATHNAME');
    expect(names).toContain('DATE_OF_BIRTH_PATHNAME');
  });

  it.each(webPathnames)('%s (%s) has a route directory with a page in it', (_name, pathname) => {
    // Next.js routes on the App Router directory tree, so this is the only fact
    // that decides whether a link built from the constant reaches anything.
    expect(pathname.startsWith('/'), `${pathname} must be an absolute path`).toBe(true);

    const segments = pathname.slice(1).split('/');
    const directory = join(APP_ROOT, ...segments);

    expect(
      readdirSync(APP_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
      `no route directory matches ${pathname}`,
    ).toContain(segments[0]);

    expect(existsSync(join(directory, 'page.tsx')), `${directory} has no page.tsx`).toBe(true);
  });

  it('does not treat an API path as a page, so the two families stay apart', () => {
    // `AUTH_DATE_OF_BIRTH_PATH` is `/v1/auth/date-of-birth` and must never grow a
    // directory here; if the suffix convention ever blurs, this is what says so.
    expect(webPathnames.map(([, value]) => value).some((value) => value.startsWith('/v1'))).toBe(
      false,
    );
  });
});
