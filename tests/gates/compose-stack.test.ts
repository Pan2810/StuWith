import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Story 1.1, I/O matrix row 5 — `docker compose up` brings up exactly four
 * services and no object store.
 *
 * This reads the compose file rather than booting it. Booting proves the same
 * thing but only on a machine with a warm Docker daemon and ~2GB of images;
 * a gate that is skipped on CI is not a gate. The shape of the stack is a
 * *declaration*, so it can be checked as one — and AD-29 ("no object store in
 * the MVP stack") is a rule about what may be declared, not about what happens
 * to be running.
 *
 * Deliberately no YAML dependency: the spec puts new dependencies behind
 * "Ask First", and this file's structure is ours to keep simple.
 */

const composePath = fileURLToPath(new URL('../../infra/docker-compose.yml', import.meta.url));
const compose = readFileSync(composePath, 'utf8');

/**
 * The two things AD-29 is actually a rule about: which services exist, and which
 * images they run.
 *
 * Scanning the whole declaration block for a substring was the earlier approach,
 * and it is the wrong shape of check. `s3` turns up inside plenty of innocent
 * strings — an endpoint hostname, an env var name, a comment explaining why there
 * is no bucket — so the gate would eventually go red for a reason that has nothing
 * to do with an object store. At that point someone deletes the token from the
 * list to get their build through, and the rule quietly stops covering the real
 * case. A check that can fail for the wrong reason does not survive contact with a
 * deadline.
 */
function serviceImages(source: string): string[] {
  return [...source.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => (m[1] ?? '').toLowerCase());
}

/**
 * Collect the two-space-indented keys of one top-level block, stopping at the
 * next top-level key. Scoping matters: `volumes:` also has two-space children
 * (`postgres-data`, `valkey-data`), and counting those as services would make
 * this test pass for the wrong reason.
 */
function blockKeys(source: string, blockName: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${blockName}:`);
  if (start === -1) throw new Error(`compose file has no top-level \`${blockName}:\` block`);

  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level block
    const match = /^ {2}([A-Za-z][\w-]*):/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

describe('AD-29 / story 1.1 — the local stack is exactly four services', () => {
  const services = blockKeys(compose, 'services');

  it('declares the four services the acceptance criteria name, and nothing else', () => {
    expect([...services].sort()).toEqual(['coturn', 'livekit', 'postgres', 'valkey']);
  });

  it('does not read `volumes:` entries as services', () => {
    // Guards the parser above, not the compose file: if `blockKeys` ever stopped
    // scoping, the assertion below would start passing by accident.
    expect(services).not.toContain('postgres-data');
    expect(blockKeys(compose, 'volumes')).toContain('postgres-data');
  });

  it.each([
    ['postgres', 'pgvector/pgvector:0.8.6-pg18-trixie'],
    ['valkey', 'valkey/valkey:9.0.4-alpine'],
    ['livekit', 'livekit/livekit-server:v1.13.5'],
    ['coturn', 'coturn/coturn:4.17.2-alpine'],
  ])('pins %s to an exact image tag', (_service, image) => {
    expect(compose).toContain(`image: ${image}`);
  });

  it('pins every image — no `latest`, no floating tag', () => {
    const images = [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    expect(images.length).toBe(4);
    for (const image of images) {
      expect(image, `${image} must carry an explicit tag`).toMatch(/:.+$/);
      expect(image, `${image} must not float on :latest`).not.toMatch(/:latest$/);
    }
  });

  const FORBIDDEN = ['minio', 's3', 'ceph', 'garage', 'seaweedfs', 'localstack'];

  it.each(FORBIDDEN)('declares no %s service — AD-29, "just for dev" included', (forbidden) => {
    // The MVP writes no binaries. An object store in the dev stack is how that
    // rule gets quietly relaxed: something starts writing to it locally, and the
    // constraint is only discovered at deploy.
    for (const service of services) {
      expect(
        service.toLowerCase(),
        `service "${service}" looks like an object store`,
      ).not.toContain(forbidden);
    }
    for (const image of serviceImages(compose)) {
      expect(image, `image "${image}" looks like an object store`).not.toContain(forbidden);
    }
  });

  it('declares no Caddy — TLS terminates at the VPS edge, not on a dev machine', () => {
    for (const service of services) {
      expect(service.toLowerCase()).not.toContain('caddy');
    }
    for (const image of serviceImages(compose)) {
      expect(image).not.toContain('caddy');
    }
  });

  it('would still notice a forbidden service if one were added', () => {
    // Proves the two checks above look in the right place. The compose file names
    // MinIO and Caddy in comments precisely to say they are absent, so a check
    // that cannot tell a comment from a declaration is checking nothing — and one
    // that cannot see a real declaration is worth even less.
    const eol = compose.includes('\r\n') ? '\r\n' : '\n';
    const tampered = compose.replace(
      /^services:\r?\n/m,
      ['services:', '  minio:', '    image: minio/minio:RELEASE.2026-01-01', ''].join(eol),
    );
    expect(blockKeys(tampered, 'services')).toContain('minio');
    expect(serviceImages(tampered).some((image) => image.includes('minio'))).toBe(true);
  });

  it('gives every service a healthcheck, so `up --wait` means something', () => {
    const healthchecks = [...compose.matchAll(/^\s{4}healthcheck:/gm)];
    expect(healthchecks.length).toBe(services.length);
  });
});
