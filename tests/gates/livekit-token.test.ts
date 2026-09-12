import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Story 2.2, probe of boundary 1: us ↔ LiveKit.
 *
 * `apps/api` signs a token and hands it to a client; a `livekit-server` the
 * client connects to decides whether it opens a room. Every unit test on `jose`
 * proves only that we signed SOMETHING. This one starts the real server
 * (`livekit/livekit-server:v1.13.5`, the image `infra/docker-compose.yml` pins),
 * mints a token with the SAME `mintRoomToken` the built `apps/api` ships, and
 * sends the WebSocket upgrade a browser would send to `/rtc` — raw, with
 * `node:http`, reading nothing but the status line before the socket is dropped.
 *
 * ## What is asserted, and what was MEASURED on the way to writing it
 *
 * | Token                                  | Expected | Measured (v1.13.5)       |
 * | -------------------------------------- | -------- | ------------------------ |
 * | as minted                              | 101      | 101                      |
 * | signed with a different secret         | 401      | 401 "invalid token"      |
 * | `roomJoin: false`                      | 401      | 401 "permissions denied" |
 * | no `video.room`                        | refused  | **400 "no room name"**   |
 * | no `video` at all                      | 401      | 401                      |
 *
 * The spec's frozen text expects `401` for "no `video.room`"; the server answers
 * `400`. The example pins what the boundary DOES — refused, and specifically the
 * measured code — rather than the guess, and the spec's Change Log carries the
 * discrepancy for a human to renegotiate. What matters for AD-9 is unchanged
 * either way: a token that does not name a room does not open one.
 *
 * ## The mutations that turn this red (run, not imagined)
 *
 * - start the container with a DIFFERENT secret in `LIVEKIT_KEYS` from the one
 *   `mintRoomToken` signs with → the `101` example answers `401`;
 * - delete `room: input.roomId` from the grant in `room-token.ts`, rebuild
 *   `apps/api` → the `101` example answers `400`.
 *
 * ## Skipping, the way `packages/db/src/__testing__/postgres.ts` does it
 *
 * `STUWITH_SKIP_TESTCONTAINERS=1` skips on a machine with no daemon, and is
 * REFUSED when `CI` is set: gates are required checks, and a skipped required
 * check is a green tick on a suite that executed nothing. Same rule, same
 * message, inlined rather than imported so this gate does not pull the database
 * package's test helpers into its module graph.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const LIVEKIT_IMAGE = 'livekit/livekit-server:v1.13.5';

/**
 * The key pair the container is started with AND the pair the token is signed
 * with — the same two strings, because that is the property under test. The
 * "different secret" example derives its own from these.
 */
const API_KEY = 'gate-livekit-key';
const API_SECRET = `gate-livekit-secret-${'x'.repeat(24)}`;

const ROOM_ID = '019200f1-0000-7000-8000-00000000abcd';
const USER_ID = '019200f0-0000-7000-8000-00000000abcd';

function resolveTestcontainersDisabled(): boolean {
  const requested = process.env['STUWITH_SKIP_TESTCONTAINERS'] === '1';
  if (!requested) {
    return false;
  }
  if (process.env['CI']) {
    throw new Error(
      'STUWITH_SKIP_TESTCONTAINERS is set while CI is set. Refusing to skip: the LiveKit ' +
        'token probe is a gate, and a skipped gate reports success without testing anything. ' +
        'Unset it, or run this suite against a real Docker daemon.',
    );
  }
  return true;
}

const testcontainersDisabled = resolveTestcontainersDisabled();

/**
 * The BUILT `mintRoomToken`, not the source.
 *
 * `pnpm test:gates` builds `apps/api` first (`package.json`). Loading
 * `dist/rooms/room-token.js` is what makes this a probe of what ships rather than
 * of what a transformer produced from `src/` a moment ago — the same choice
 * `config-fail-fast.test.ts` makes by spawning `dist/main.js`.
 */
const BUILT_ROOM_TOKEN = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'rooms', 'room-token.js');

interface RoomTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly roomId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

type MintRoomToken = (input: RoomTokenInput) => Promise<string>;

/**
 * `jose` as the BUILT `apps/api` resolves it.
 *
 * `tests/gates` has no `jose` of its own — it is `apps/api`'s dependency, and
 * pnpm's isolated layout (AGENTS.md §2, the free third layer) is exactly what stops
 * a bare `import 'jose'` here from resolving. Resolving from the built module's
 * location gives this probe the same copy the process signs with, which is the
 * honest one to re-sign and decode with.
 */
interface Jose {
  decodeJwt(token: string): Record<string, unknown>;
  SignJWT: new (payload: Record<string, unknown>) => {
    setProtectedHeader(header: { alg: string }): unknown & JoseSigner;
  };
}
interface JoseSigner {
  setIssuer(issuer: string): JoseSigner;
  setSubject(subject: string): JoseSigner;
  setIssuedAt(): JoseSigner;
  setExpirationTime(input: string): JoseSigner;
  sign(key: Uint8Array): Promise<string>;
}

function joseFromApi(): Jose {
  return createRequire(BUILT_ROOM_TOKEN)('jose') as Jose;
}

function loadBuiltMinter(): MintRoomToken {
  if (!existsSync(BUILT_ROOM_TOKEN)) {
    throw new Error(
      `${path.relative(REPO_ROOT, BUILT_ROOM_TOKEN)} is missing. Run \`pnpm --filter api build\` ` +
        'first — `pnpm test:gates` does — so this probe exercises the token the process ships.',
    );
  }
  const require = createRequire(import.meta.url);
  const loaded = require(BUILT_ROOM_TOKEN) as { mintRoomToken?: unknown };
  if (typeof loaded.mintRoomToken !== 'function') {
    throw new Error('the built room-token module does not export mintRoomToken');
  }
  return loaded.mintRoomToken as MintRoomToken;
}

/** A token as `apps/api` mints it, for the room and person above, valid for two minutes. */
async function minted(overrides: Partial<RoomTokenInput> = {}): Promise<string> {
  const mintRoomToken = loadBuiltMinter();
  const now = new Date();
  return mintRoomToken({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    roomId: ROOM_ID,
    userId: USER_ID,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 120_000),
    ...overrides,
  });
}

/**
 * The same token with its `video` claim rewritten, re-signed with the same secret.
 *
 * Assembled by hand from the minted token's own payload rather than by calling
 * `mintRoomToken` with different arguments, because `mintRoomToken` has no
 * argument that removes `room` or flips `roomJoin` — and that is the point of the
 * function. The near-side mutation the spec names ("bỏ `video.room` khỏi claim")
 * is exactly what this helper simulates on the far side, so the two must agree.
 */
async function resigned(
  token: string,
  rewriteVideo: (video: Record<string, unknown>) => Record<string, unknown> | undefined,
  secret = API_SECRET,
): Promise<string> {
  const { SignJWT, decodeJwt } = joseFromApi();
  const payload = decodeJwt(token);
  const video = rewriteVideo({ ...(payload['video'] as Record<string, unknown>) });
  const claims: Record<string, unknown> = { ...payload };
  delete claims['video'];
  if (video !== undefined) {
    claims['video'] = video;
  }
  const signer = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' });
  return signer.sign(new TextEncoder().encode(secret));
}

interface UpgradeOutcome {
  readonly status: number;
  readonly body: string;
}

/**
 * The upgrade a browser's `WebSocket` sends, with `node:http` and nothing else.
 *
 * On `101` Node emits `upgrade` with the socket; it is destroyed at once — no
 * frame is ever sent, so nothing about LiveKit's signalling protocol is assumed.
 * Anything else arrives as an ordinary `response`, whose status and body are what
 * the examples read.
 */
function upgrade(host: string, port: number, token: string, query = ''): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      method: 'GET',
      path: `/rtc?access_token=${encodeURIComponent(token)}${query}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, body: '' });
    });
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * `ListRooms`, through LiveKit's Twirp API, with an ADMIN token minted here in
 * the test and nowhere in the product. It is how the "only the room it names"
 * half is read back: after an upgrade, the room LiveKit created is the one the
 * token named, whatever the query string said.
 */
async function listRooms(host: string, port: number): Promise<string[]> {
  const { SignJWT } = joseFromApi();
  const admin = await new SignJWT({ video: { roomList: true } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(API_KEY)
    .setSubject('gate-admin')
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(new TextEncoder().encode(API_SECRET));

  const response = await fetch(`http://${host}:${String(port)}/twirp/livekit.RoomService/ListRooms`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`ListRooms answered ${String(response.status)}: ${await response.text()}`);
  }
  const parsed = (await response.json()) as { rooms?: ReadonlyArray<{ name?: string }> };
  return (parsed.rooms ?? []).map((room) => room.name ?? '');
}

const suite = testcontainersDisabled ? describe.skip : describe;

suite('Story 2.2 — a real livekit-server accepts the token apps/api mints, for its room only', () => {
  let container: StartedTestContainer;
  let host: string;
  let port: number;

  beforeAll(async () => {
    container = await new GenericContainer(LIVEKIT_IMAGE)
      // The pair the server trusts. `apps/api` holds the same two strings in
      // `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`; this is the deployment's whole
      // trust relationship, expressed once.
      .withEnvironment({ LIVEKIT_KEYS: `${API_KEY}: ${API_SECRET}` })
      // Without `--bind` the server listens on localhost inside the container and
      // the published port reaches nothing. No config file: single-node routing,
      // no Redis, default `room.auto_create: true` so an upgrade for a room
      // nobody created is judged on the TOKEN rather than on room existence.
      .withCommand(['--bind', '0.0.0.0'])
      .withExposedPorts(7880)
      .withWaitStrategy(Wait.forLogMessage(/starting LiveKit server/))
      .withStartupTimeout(180_000)
      .start();
    host = container.getHost();
    port = container.getMappedPort(7880);
  }, 300_000);

  afterAll(async () => {
    await container?.stop();
  }, 120_000);

  it('answers 101 to the upgrade — the token as minted opens its room', async () => {
    const outcome = await upgrade(host, port, await minted());
    expect(outcome.status, outcome.body).toBe(101);
  });

  it('answers 401 to the same claims signed with a different secret', async () => {
    const forged = await resigned(await minted(), (video) => video, `${API_SECRET}-not`);
    const outcome = await upgrade(host, port, forged);
    expect(outcome.status).toBe(401);
  });

  it('answers 401 to a token minted for a key the server does not know', async () => {
    // A wrong `iss` with the right secret: the server looks the key up first.
    const outcome = await upgrade(host, port, await minted({ apiKey: 'some-other-key' }));
    expect(outcome.status).toBe(401);
  });

  it('answers 401 when roomJoin is false', async () => {
    const outcome = await upgrade(
      host,
      port,
      await resigned(await minted(), (video) => ({ ...video, roomJoin: false })),
    );
    expect(outcome.status).toBe(401);
  });

  it('refuses a token with no video.room — measured as 400, and never 101', async () => {
    const outcome = await upgrade(
      host,
      port,
      await resigned(await minted(), ({ room: _room, ...rest }) => rest),
    );
    expect(outcome.status).not.toBe(101);
    // The measured code. The spec's frozen text says 401; the server says 400
    // "no room name". Pinned so a LiveKit upgrade that changes it is noticed.
    expect(outcome.status).toBe(400);
  });

  it('answers 401 when there is no video grant at all', async () => {
    const outcome = await upgrade(host, port, await resigned(await minted(), () => undefined));
    expect(outcome.status).toBe(401);
  });

  it('opens the room the TOKEN names, not the one the query string asks for', async () => {
    // The other half of "for its room only". LiveKit reads `?room=` only when the
    // token names none; a token that names a room is pinned to it. Without this,
    // the 101 above would also be satisfied by a server that let the client pick.
    const decoy = '019200f1-0000-7000-8000-00000000dec0';
    const outcome = await upgrade(host, port, await minted(), `&room=${decoy}`);
    expect(outcome.status).toBe(101);

    const rooms = await listRooms(host, port);
    expect(rooms).toContain(ROOM_ID);
    expect(rooms).not.toContain(decoy);
  });

  it('carries none of the three admin grants, decoded from the token that was accepted', () => {
    // Read from the token rather than from `room-token.test.ts`'s fixture: this is
    // the string a real server just said yes to.
    return minted().then((token) => {
      const video = joseFromApi().decodeJwt(token)['video'] as Record<string, unknown>;
      expect(video).toEqual({
        room: ROOM_ID,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });
      for (const grant of ['roomCreate', 'roomAdmin', 'roomList']) {
        expect(video).not.toHaveProperty(grant);
      }
    });
  });
});

/* -------------------------------------------------------------------------- *
 * AC5 — no static LiveKit credential on the client side
 * -------------------------------------------------------------------------- */

/**
 * The two names that must never appear anywhere `apps/web` ships from.
 *
 * `LIVEKIT_URL` is deliberately NOT in this list: the client is TOLD the URL in
 * the token response, and a web build that read it from its own environment would
 * be wrong but not a credential. The key and the secret are the credential.
 */
const CLIENT_FORBIDDEN = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const WEB_NEXT_CONFIG = path.join(REPO_ROOT, 'apps', 'web', 'next.config.ts');
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-e2e', 'dist', 'coverage']);

function walk(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (/\.(?:[cm]?[jt]sx?|json|css|md|env.*)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** THE production function: which forbidden names a file contains, comments included. */
export function clientCredentialOffences(file: string): readonly string[] {
  // Comments are NOT stripped here, on purpose: a `process.env.LIVEKIT_API_KEY`
  // in a comment is still a name a bundler's env inliner may act on, and a
  // credential name in a client file has no legitimate use even as prose.
  const source = readFileSync(file, 'utf8');
  return CLIENT_FORBIDDEN.filter((name) => source.includes(name));
}

const CLIENT_FILES: readonly string[] = [...walk(WEB_SRC, []), WEB_NEXT_CONFIG];

const PROBE_FILE = path.join(WEB_SRC, 'livekit-gate-probe.generated.ts');

afterEach(() => {
  rmSync(PROBE_FILE, { force: true });
});

describe('AC5 — apps/web carries no LiveKit credential', () => {
  it('scans a meaningful number of client files, and the config', () => {
    // Anti-vacuity: a walker that found nothing would make the sweep below pass
    // over nothing.
    expect(CLIENT_FILES.length).toBeGreaterThanOrEqual(20);
    expect(CLIENT_FILES).toContain(WEB_NEXT_CONFIG);
  });

  it('finds no file under apps/web/src or next.config.ts naming the key or the secret', () => {
    const offenders = CLIENT_FILES.flatMap((file) =>
      clientCredentialOffences(file).map(
        (name) => `${path.relative(REPO_ROOT, file).replace(/\\/g, '/')} mentions ${name}`,
      ),
    );
    expect(
      offenders,
      'The LiveKit key pair belongs to apps/api and nowhere else (AD-9). The client ' +
        'gets a short-lived token from POST /v1/rooms/{roomId}/token; it never holds a ' +
        'credential that could mint one.',
    ).toEqual([]);
  });

  it.each(CLIENT_FORBIDDEN)('really reports a planted %s, through the production function', (name) => {
    // The self-check calls the SAME function the sweep runs, on a real file in a
    // scanned directory — the Story 2.0 lesson about gates that guard nothing.
    writeFileSync(PROBE_FILE, `export const leak = process.env['${name}'];\n`, 'utf8');
    try {
      expect(clientCredentialOffences(PROBE_FILE)).toEqual([name]);
      expect(walk(WEB_SRC, [])).toContain(PROBE_FILE);
    } finally {
      rmSync(PROBE_FILE, { force: true });
    }
  });

  it('leaves LIVEKIT_URL alone — the client is told the URL, it is not a credential', () => {
    writeFileSync(PROBE_FILE, `export const url = 'LIVEKIT_URL';\n`, 'utf8');
    try {
      expect(clientCredentialOffences(PROBE_FILE)).toEqual([]);
    } finally {
      rmSync(PROBE_FILE, { force: true });
    }
  });
});
