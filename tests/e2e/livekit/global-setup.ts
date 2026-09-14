import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { LIVEKIT_HANDOFF_FILE, LIVEKIT_PROJECT } from '../../../playwright.config';

/**
 * This file is `tests/e2e/livekit/`, so the repository root is three up.
 *
 * `__dirname`, for the reason `playwright.config.ts` records beside
 * {@link LIVEKIT_HANDOFF_FILE}: Playwright loads these modules as CommonJS and
 * `import.meta.url` is a `SyntaxError` there, before any test runs.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * A real `livekit-server`, started before the browser suite that talks to it.
 *
 * ## Why the far side has to be real
 *
 * `AGENTS.md` §4: a story that crosses a boundary declares the probe that runs IN
 * THAT MEDIUM and the mutation on the far side that turns it red. Story 2.4's
 * boundary is the browser ↔ LiveKit, and `deferred-work.md` records that nothing
 * had ever opened it: `tests/gates/livekit-token.test.ts` reaches the WebSocket
 * upgrade with raw `node:http`, which proves the token is ACCEPTED and says
 * nothing about whether a browser can then hear anybody. This file is what makes
 * the far side a thing that can be changed.
 *
 * The image is the one `infra/docker-compose.yml:64` pins, for the reason
 * `packages/db/src/__testing__/postgres.ts` pins PostgreSQL: a probe against a
 * different server is a probe about a different product.
 *
 * ## Three facts about Playwright that shape this file, all measured
 *
 * 1. **`webServer` starts BEFORE `globalSetup`.** `createGlobalSetupTasks` in
 *    `playwright/lib/runner/index.js` is `[removeOutputDirs, ...pluginSetup,
 *    ...globalTeardowns, ...globalSetups]`, and each `webServer` is a plugin. So
 *    the stand-in API is already listening by the time this runs and cannot be
 *    handed the container's key pair through its environment. It is handed a PATH
 *    instead — {@link LIVEKIT_HANDOFF_FILE}, written here and read lazily per
 *    request — and the absence of that file is what keeps every other spec on the
 *    Story 2.3 placeholder token.
 * 2. **`FullConfig.projects` is NOT filtered by `--project`.** `common/index.js`
 *    assigns `config.projects` from every configured project before the runner
 *    filters, so a `globalSetup` cannot ask the config which projects will run. The
 *    filter is therefore read from `process.argv`, the same place Playwright reads
 *    it — and a run with no filter at all runs the `livekit` project too, so it
 *    starts the container as well.
 * 3. **ICE needs a media port that is the SAME number inside and outside.** LiveKit
 *    advertises candidates with its own port, so a randomly mapped host port would
 *    hand Chromium an address nothing is listening on and the connection would
 *    stall with every signal exchanged correctly. One UDP mux port, bound 1:1, is
 *    what makes `bytesReceived > 0` reachable; the signalling port is mapped
 *    normally because nothing but the client reads it.
 */

const LIVEKIT_IMAGE = 'livekit/livekit-server:v1.13.5';

/** LiveKit's signalling/HTTP port inside the container. */
const SIGNAL_PORT = 7880;

/**
 * The single UDP mux port, bound to the same number on the host — see fact 3.
 *
 * Deliberately NOT one of the numbers `infra/docker-compose.yml` publishes
 * (7880, 7881, 50000-50019): a developer with the local stack up should be able
 * to run this suite without taking it down, and the one port that must be free is
 * a port nothing else in this repository claims.
 */
const MEDIA_UDP_PORT = 7882;

/**
 * A key pair for this run and no other, assembled at runtime so that nothing in
 * this file looks like a credential to CI gate #1. LiveKit refuses a secret
 * shorter than 32 characters, which two uuids comfortably clear.
 */
function freshKeyPair(): { apiKey: string; apiSecret: string } {
  const strip = (value: string): string => value.split('-').join('');
  return {
    apiKey: `e2e${strip(randomUUID()).slice(0, 13)}`,
    apiSecret: `${strip(randomUUID())}${strip(randomUUID())}`,
  };
}

/**
 * The server's whole configuration, as the YAML body LiveKit reads out of
 * `LIVEKIT_CONFIG`.
 *
 * NOT `infra/livekit.yaml`: that file is the deployment's, it points `redis` at a
 * Valkey this suite does not start, and it sets `room.auto_create: false` because
 * on the real stack a room is created by the process that owns the admission
 * decision (AD-9). Here there is no such process — `apps/api` is not in this
 * path — so the room has to come into existence when the first valid token
 * arrives. Editing the deployment's file to make a test pass is the trade this
 * avoids, and changing it is an "Ask First" item in the spec.
 */
function serverConfig(): string {
  return [
    `port: ${SIGNAL_PORT}`,
    'rtc:',
    `  udp_port: ${MEDIA_UDP_PORT}`,
    '  use_external_ip: false',
    // The address the candidates carry. The container's own IP is unreachable
    // from the host, and 1:1 port binding makes loopback the true answer.
    '  node_ip: 127.0.0.1',
    'room:',
    '  auto_create: true',
    /**
     * The active-speaker observer, tuned for a SYNTHETIC microphone.
     *
     * Chromium's `--use-fake-device-for-media-stream` produces a quiet, periodic
     * beep rather than a voice, and against LiveKit's defaults (`active_level: 35`,
     * `min_percentile: 40`) it crossed the threshold about three runs in four — so
     * the "Đang nói" assertion in the probe was failing on the amplitude of a test
     * fixture rather than on anything the product does. A more sensitive level and
     * no percentile floor make the assertion about OUR handling of
     * `ActiveSpeakersChanged`, which is what it is there to check.
     */
    'audio:',
    '  active_level: 50',
    '  min_percentile: 0',
    '  update_interval: 400',
    'logging:',
    '  level: info',
    '  json: false',
  ].join('\n');
}

/**
 * The `--project` names of this run, read the way Playwright reads them.
 *
 * All four spellings the CLI accepts: `--project x`, `--project=x`, `-p x` and
 * `-p=x`. The last was missing for a round, which is the worst shape this bug
 * takes — `-p=livekit` selects the project, the container never starts, the probe
 * `test.skip`s itself, and the run reports success having opened nothing.
 */
function projectFilter(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    for (const prefix of ['--project=', '-p=']) {
      if (argument.startsWith(prefix)) {
        names.push(argument.slice(prefix.length));
      }
    }
    if (argument === '--project' || argument === '-p') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        names.push(next);
      }
    }
  }
  return names;
}

/**
 * The escape hatch, and the one place it is refused.
 *
 * Same rule and same wording as `packages/db/src/__testing__/postgres.ts`: a
 * machine with no Docker daemon may skip, CI may not. The workflow guards the
 * variable too, but that guard lives in a YAML file anyone can edit; this one
 * travels with the suite.
 */
function testcontainersDisabled(): boolean {
  if (process.env['STUWITH_SKIP_TESTCONTAINERS'] !== '1') {
    return false;
  }
  if (process.env['CI']) {
    throw new Error(
      'STUWITH_SKIP_TESTCONTAINERS is set while CI is set. Refusing to skip: the LiveKit probe ' +
        'is the only thing in this repository that proves a browser can hear a room, and a ' +
        'skipped run reports success having opened nothing.',
    );
  }
  return true;
}

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  // A stale file from a killed run would put the stand-in API into real-token mode
  // with a key pair no container holds, and every spec would fail on a refusal
  // nobody could explain. Cleared first, always.
  rmSync(LIVEKIT_HANDOFF_FILE, { force: true });

  const selected = projectFilter(process.argv);
  if (selected.length > 0 && !selected.includes(LIVEKIT_PROJECT)) {
    return;
  }
  if (testcontainersDisabled()) {
    process.stdout.write(
      `[livekit setup] STUWITH_SKIP_TESTCONTAINERS=1 — the ${LIVEKIT_PROJECT} project will skip.\n`,
    );
    return;
  }

  /**
   * `apps/api` has to be BUILT, and the failure is worth catching here.
   *
   * `tests/e2e/support/fake-api.cjs` signs the probe's token with the product's
   * own `mintRoomToken` out of `apps/api/dist` — that is what makes the second
   * mutation travel the whole seam. Unbuilt, the `require` fails inside a
   * stand-in HTTP server in the middle of a test, and what a reader sees is a
   * 500 on a token request. Said here, it names the command.
   */
  const MINT_PATH = path.join(REPO_ROOT, 'apps', 'api', 'dist', 'rooms', 'room-token.js');
  if (!existsSync(MINT_PATH)) {
    throw new Error(
      `The ${LIVEKIT_PROJECT} project signs its tokens with apps/api's own mintRoomToken, and ` +
        `${path.relative(REPO_ROOT, MINT_PATH)} is not built. Run: corepack pnpm run build:packages ` +
        '&& corepack pnpm --filter api build',
    );
  }

  const { apiKey, apiSecret } = freshKeyPair();
  /**
   * THE MUTATION, and it lives on the far side rather than in our code.
   *
   * Give the container a secret that is not the one the token is signed with —
   * append a character to the value below and nothing else — and `Room.connect`
   * is refused at the first step while every line of `apps/web` and every line of
   * `room-token.ts` stays exactly as it is. That is what "a mutation on the far
   * side" means, and until this file existed there was no such thing to change.
   */
  const containerSecret = apiSecret;

  let container: StartedTestContainer;
  try {
    container = await new GenericContainer(LIVEKIT_IMAGE)
      .withEnvironment({
        LIVEKIT_KEYS: `${apiKey}: ${containerSecret}`,
        LIVEKIT_CONFIG: serverConfig(),
      })
      .withExposedPorts(SIGNAL_PORT, {
        container: MEDIA_UDP_PORT,
        host: MEDIA_UDP_PORT,
        protocol: 'udp',
      })
      // LiveKit answers `200 OK` on `/` as soon as signalling is up. A log-message
      // wait would couple this to a sentence the server is free to reword.
      .withWaitStrategy(Wait.forHttp('/', SIGNAL_PORT).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    /**
     * The 1:1 UDP binding is the one thing here that can collide with the machine
     * rather than with the code — a second concurrent run of this suite, or
     * anything else holding the port. Docker's own message names a port number and
     * nothing else, so it reads like an infrastructure mystery; this says what the
     * port is FOR and why it cannot simply be remapped (see fact 3 above).
     */
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not start ${LIVEKIT_IMAGE}. UDP port ${MEDIA_UDP_PORT} must be free on this machine ` +
        'and bound 1:1, because LiveKit advertises ICE candidates carrying its own port number — a ' +
        'remapped port would hand the browser an address nothing is listening on. A second ' +
        `concurrent run of the ${LIVEKIT_PROJECT} project is the usual cause. Underlying: ${detail}`,
    );
  }

  const url = `ws://127.0.0.1:${container.getMappedPort(SIGNAL_PORT)}`;
  mkdirSync(path.dirname(LIVEKIT_HANDOFF_FILE), { recursive: true });
  /**
   * Written to a temporary path and RENAMED, because the reader is a live server.
   *
   * `tests/e2e/support/fake-api.cjs` is already listening and reads this file on
   * every token request. A `writeFileSync` straight to the final path is not one
   * operation: a request landing between the truncate and the last byte reads a
   * partial file, and the fixture throws mid-dispatch. A rename within one
   * directory is atomic on every platform this runs on.
   */
  const pending = `${LIVEKIT_HANDOFF_FILE}.pending`;
  writeFileSync(pending, `${JSON.stringify({ url, apiKey, apiSecret }, null, 2)}\n`, 'utf8');
  renameSync(pending, LIVEKIT_HANDOFF_FILE);
  process.stdout.write(`[livekit setup] ${LIVEKIT_IMAGE} listening on ${url}\n`);

  return async () => {
    rmSync(LIVEKIT_HANDOFF_FILE, { force: true });
    await container.stop();
  };
}
