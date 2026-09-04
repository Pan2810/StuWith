import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One copy of `@fastify/proxy-addr`, proved rather than assumed.
 *
 * Three docblocks and AGENTS.md say "Fastify and we cannot disagree about who is
 * trusted", and they say it is a property of the WIRING: `packages/config`
 * compiles `TRUSTED_PROXY_ADDRESSES` with this library, `apps/api` resolves the
 * client address with the predicate that comes back, and Fastify decides
 * `request.ip` with its own copy. That claim only holds while all three resolve
 * the same code.
 *
 * Nothing enforced it. Two workspace packages declared `5.1.0` and Fastify
 * resolved whatever its own dependency range allowed — identical today, by
 * coincidence rather than by construction. A Fastify bump carrying a different
 * version would have given the process two different readings of the proxy list,
 * with no error, no warning and a green CI run: the two halves of "who may set
 * `X-Forwarded-For`" would simply disagree, which is the failure this whole
 * mechanism exists to make impossible.
 *
 * `pnpm-workspace.yaml` now has an `overrides` entry. This is the test that says
 * the entry is doing its job — delete it, and the assertion is what tells you.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The version `@fastify/proxy-addr` resolves to for code living in `dir`. */
function versionSeenFrom(dir: string): string {
  const from = createRequire(join(repoRoot, dir, 'package.json'));
  const manifest = from.resolve('@fastify/proxy-addr/package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version as string;
}

/** The version Fastify itself gets — the one that actually decides `request.ip`. */
function versionFastifySees(): string {
  const fromApi = createRequire(join(repoRoot, 'apps/api', 'package.json'));
  const fromFastify = createRequire(fromApi.resolve('fastify'));
  const manifest = fromFastify.resolve('@fastify/proxy-addr/package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version as string;
}

describe('the proxy list is compiled by exactly one implementation', () => {
  it('resolves the same version from packages/config, apps/api and Fastify', () => {
    const config = versionSeenFrom('packages/config');
    const api = versionSeenFrom('apps/api');
    const fastify = versionFastifySees();

    expect(api, 'apps/api must see the copy packages/config compiled with').toBe(config);
    expect(fastify, 'Fastify must decide request.ip with that same copy').toBe(config);
  });

  it('is a single exact version, not a range that could drift', () => {
    // A caret or a tilde in either declaration reopens the same hole one install
    // later, so the declarations are checked as written rather than as resolved.
    for (const dir of ['packages/config', 'apps/api']) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      const declared = manifest.dependencies?.['@fastify/proxy-addr'];

      expect(declared, `${dir} must declare @fastify/proxy-addr`).toBeDefined();
      expect(declared, `${dir} must pin it exactly`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
