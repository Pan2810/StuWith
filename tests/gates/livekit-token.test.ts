import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
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
 * How long one upgrade may sit with neither `upgrade` nor `response` before the
 * example is failed by name. Without it a server that accepts the TCP connection
 * and never answers — a wrong `--bind`, a container that is up but not serving —
 * holds the example until the project's 300-second `testTimeout`, and the failure
 * reads as "timed out" with no clue which request hung.
 */
const UPGRADE_TIMEOUT_MS = 15_000;

/**
 * The upgrade a browser's `WebSocket` sends, with `node:http` and nothing else.
 *
 * On `101` Node emits `upgrade` with the socket; it is destroyed at once — no
 * frame is ever sent, so nothing about LiveKit's signalling protocol is assumed.
 * Anything else arrives as an ordinary `response`, whose status and body are what
 * the examples read. `label` names the example in the timeout's error.
 */
function upgrade(
  host: string,
  port: number,
  token: string,
  options: { readonly label: string; readonly query?: string },
): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      method: 'GET',
      path: `/rtc?access_token=${encodeURIComponent(token)}${options.query ?? ''}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    });
    request.setTimeout(UPGRADE_TIMEOUT_MS, () => {
      request.destroy(
        new Error(
          `livekit-server accepted the connection but answered neither upgrade nor response ` +
            `within ${String(UPGRADE_TIMEOUT_MS)}ms for the example "${options.label}"`,
        ),
      );
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
      // A response whose stream is reset or aborted before `end` would otherwise
      // never settle this promise — the same silent hang the request timeout
      // above exists to prevent, one layer down.
      response.on('error', reject);
      response.on('aborted', () =>
        reject(new Error(`livekit-server aborted the response for the example "${options.label}"`)),
      );
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
    // Bounded for the same reason `upgrade` is: a server that accepts the socket
    // and never answers must fail this example by name, not by the 300s timeout.
    signal: AbortSignal.timeout(UPGRADE_TIMEOUT_MS),
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
    const outcome = await upgrade(host, port, await minted(), { label: 'as minted' });
    expect(outcome.status, outcome.body).toBe(101);
  });

  it('answers 401 to the same claims signed with a different secret', async () => {
    const forged = await resigned(await minted(), (video) => video, `${API_SECRET}-not`);
    const outcome = await upgrade(host, port, forged, { label: 'different secret' });
    expect(outcome.status).toBe(401);
  });

  it('answers 401 to a token minted for a key the server does not know', async () => {
    // A wrong `iss` with the right secret: the server looks the key up first.
    const outcome = await upgrade(host, port, await minted({ apiKey: 'some-other-key' }), {
      label: 'unknown key',
    });
    expect(outcome.status).toBe(401);
  });

  it('answers 401 when roomJoin is false', async () => {
    const outcome = await upgrade(
      host,
      port,
      await resigned(await minted(), (video) => ({ ...video, roomJoin: false })),
      { label: 'roomJoin false' },
    );
    expect(outcome.status).toBe(401);
  });

  it('refuses a token with no video.room — measured as 400, and never 101', async () => {
    const outcome = await upgrade(
      host,
      port,
      await resigned(await minted(), ({ room: _room, ...rest }) => rest),
      { label: 'no video.room' },
    );
    expect(outcome.status).not.toBe(101);
    // The measured code. The spec's frozen text says 401; the server says 400
    // "no room name". Pinned so a LiveKit upgrade that changes it is noticed.
    expect(outcome.status).toBe(400);
  });

  it('answers 401 when there is no video grant at all', async () => {
    const outcome = await upgrade(host, port, await resigned(await minted(), () => undefined), {
      label: 'no video grant',
    });
    expect(outcome.status).toBe(401);
  });

  it('answers 401 to a token whose exp has passed — the seat/token coupling rests on this', async () => {
    // `ROOM_TOKEN_TTL_SECONDS` is one number for the seat's `expires_at` and the
    // token's `exp`, and the whole argument that "a lapsed seat never has a live
    // token in front of it" assumes the far side ENFORCES `exp`. Nothing above
    // proves that; this does, with a token minted as `apps/api` mints one, already
    // two minutes past its expiry.
    const now = new Date();
    const outcome = await upgrade(
      host,
      port,
      await minted({
        issuedAt: new Date(now.getTime() - 240_000),
        expiresAt: new Date(now.getTime() - 120_000),
      }),
      { label: 'expired token' },
    );
    expect(outcome.status).toBe(401);
  });

  it('opens the room the TOKEN names, not the one the query string asks for', async () => {
    // The other half of "for its room only". LiveKit reads `?room=` only when the
    // token names none; a token that names a room is pinned to it. Without this,
    // the 101 above would also be satisfied by a server that let the client pick.
    //
    // A room of its OWN, so the positive half is not already satisfied by the
    // `101` example above having created `ROOM_ID` a moment earlier: this example
    // has to hold in any order and on its own.
    const named = '019200f1-0000-7000-8000-00000000c0de';
    const decoy = '019200f1-0000-7000-8000-00000000dec0';
    const outcome = await upgrade(host, port, await minted({ roomId: named }), {
      label: 'decoy room in the query string',
      query: `&room=${decoy}`,
    });
    expect(outcome.status).toBe(101);

    const rooms = await listRooms(host, port);
    expect(rooms).toContain(named);
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
        canPublishSources: ['microphone', 'camera'],
      });
      for (const grant of ['roomCreate', 'roomAdmin', 'roomList']) {
        expect(video).not.toHaveProperty(grant);
      }
    });
  });

  it('permits the microphone and the camera as sources, and nothing else', () => {
    /**
     * Story 2.7, and pinned BY NAME on top of the exact-equality above for the
     * reason the admin grants are: the failure this catches is somebody WIDENING
     * the array rather than deleting it, and one more string in a list of two
     * reads as harmless. `screen_share` is the one that is not — a study room that
     * can share a screen is a room that can put somebody's desktop on the wire.
     *
     * Read off the token a real `livekit-server` has just accepted, so it is a
     * claim about what the deployment issues rather than about a literal in a
     * source file.
     */
    return minted().then((token) => {
      const video = joseFromApi().decodeJwt(token)['video'] as Record<string, unknown>;
      const sources = video['canPublishSources'] as readonly string[];
      expect(sources).toEqual(['microphone', 'camera']);
      expect(sources).not.toContain('screen_share');
      expect(sources).not.toContain('screen_share_audio');
      expect(JSON.stringify(video)).not.toContain('screen_share');
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

const WEB_ROOT = path.join(REPO_ROOT, 'apps', 'web');
const WEB_SRC = path.join(WEB_ROOT, 'src');
const WEB_NEXT_CONFIG = path.join(WEB_ROOT, 'next.config.ts');
/**
 * Two more places a client build ships from, added in review round 1.
 *
 * `apps/web/.env*`: Next.js reads `.env`, `.env.local`, `.env.production` and
 * friends from the app directory and inlines any `NEXT_PUBLIC_*` value into the
 * bundle — so a credential NAME in one of those files is a credential VALUE in
 * the browser, and a sweep of `src/` alone would never see it. `apps/web/public/`:
 * everything in it is served verbatim, whatever its extension. Neither exists
 * today; the walker tolerates that, and the self-checks below plant a file in
 * each to prove it is scanned the day one appears.
 */
const WEB_PUBLIC = path.join(WEB_ROOT, 'public');
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-e2e', 'dist', 'coverage']);

const SOURCE_LIKE = /\.(?:[cm]?[jt]sx?|json|css|md|env.*)$/;

function walk(dir: string, found: string[], accept: RegExp = SOURCE_LIKE): string[] {
  if (!existsSync(dir)) {
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found, accept);
    } else if (accept.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** The `.env*` files directly under `apps/web` — not recursive: Next.js reads only these. */
function webEnvFiles(): string[] {
  return readdirSync(WEB_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('.env'))
    .map((entry) => path.join(WEB_ROOT, entry.name));
}

/**
 * THE list the sweep runs over, computed by one function so the self-checks can
 * ask "would the sweep have seen this file" through the same code path.
 */
function clientFiles(): string[] {
  return [
    ...walk(WEB_SRC, []),
    WEB_NEXT_CONFIG,
    ...webEnvFiles(),
    // Every file, whatever its name: a `.svg` or a `.txt` under `public/` is served
    // byte for byte.
    ...walk(WEB_PUBLIC, [], /./),
  ];
}

/** THE production function: which forbidden names a file contains, comments included. */
export function clientCredentialOffences(file: string): readonly string[] {
  // Comments are NOT stripped here, on purpose: a `process.env.LIVEKIT_API_KEY`
  // in a comment is still a name a bundler's env inliner may act on, and a
  // credential name in a client file has no legitimate use even as prose.
  const source = readFileSync(file, 'utf8');
  return CLIENT_FORBIDDEN.filter((name) => source.includes(name));
}

const CLIENT_FILES: readonly string[] = clientFiles();

const PROBE_FILE = path.join(WEB_SRC, 'livekit-gate-probe.generated.ts');

/**
 * One planted file per root the sweep covers. `public/` may not exist; when the
 * probe has to create it, the probe removes it again — but only if it is EMPTY
 * once the planted file is gone (`rmdirSync`, never a recursive delete), so a real
 * `public/` with anything in it is never removed by a test, whenever it appeared.
 */
const PLANTED: ReadonlyArray<{ readonly root: string; readonly file: string }> = [
  { root: 'apps/web/src', file: PROBE_FILE },
  { root: 'apps/web/.env*', file: path.join(WEB_ROOT, '.env.livekit-gate-probe') },
  { root: 'apps/web/public', file: path.join(WEB_PUBLIC, 'livekit-gate-probe.generated.txt') },
];

function removePlanted(): void {
  for (const { file } of PLANTED) {
    rmSync(file, { force: true });
  }
  try {
    rmdirSync(WEB_PUBLIC);
  } catch {
    // Absent, or not empty: either way it is not ours to remove.
  }
}

afterEach(removePlanted);

describe('AC5 — apps/web carries no LiveKit credential', () => {
  it('scans a meaningful number of client files, and the config', () => {
    // Anti-vacuity: a walker that found nothing would make the sweep below pass
    // over nothing.
    expect(CLIENT_FILES.length).toBeGreaterThanOrEqual(20);
    expect(CLIENT_FILES).toContain(WEB_NEXT_CONFIG);
  });

  it('finds no file under apps/web/src, next.config.ts, apps/web/.env* or apps/web/public naming the key or the secret', () => {
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
      expect(clientFiles()).toContain(PROBE_FILE);
    } finally {
      rmSync(PROBE_FILE, { force: true });
    }
  });

  it.each(PLANTED)('would see a file planted under $root, through the same walker the sweep uses', ({ file }) => {
    // Each root the sweep claims to cover, proved by planting rather than by
    // reading the code: a root the walker silently skips — a missing directory, a
    // dotfile a glob ignores — is a root the sweep does not cover, whatever the
    // test name says.
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `NEXT_PUBLIC_X=${CLIENT_FORBIDDEN[1]}\n`, 'utf8');
    try {
      expect(clientFiles()).toContain(file);
      expect(clientCredentialOffences(file)).toEqual([CLIENT_FORBIDDEN[1]]);
    } finally {
      removePlanted();
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
