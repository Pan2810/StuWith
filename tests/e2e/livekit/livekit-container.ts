import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getContainerRuntimeClient } from 'testcontainers';
import { LIVEKIT_HANDOFF_FILE } from '../../../playwright.config';

/**
 * **Reaching the running `livekit-server` from inside a spec — Story 2.5.**
 *
 * ## Why this is its own module
 *
 * `global-setup.ts` is the runner's file: it pulls in `GenericContainer`, image
 * pulling, wait strategies and the whole hand-off write. A spec that imported it
 * just to stop a container dragged all of that into every worker process. This
 * module holds the two verbs a spec needs and the constants both files share, so
 * the dependency goes one way — `global-setup.ts` imports THIS, never the
 * reverse.
 *
 * ## Why a spec cannot simply hold the container
 *
 * Playwright runs `globalSetup` in the runner process and specs in WORKER
 * processes, so the `StartedTestContainer` in that file's closure is unreachable
 * and module state is not shared. The container's id travels through the
 * hand-off file the stand-in API already reads, and these functions re-attach
 * through `testcontainers`' own runtime client rather than shelling out to
 * `docker` — the suite would otherwise stop working on a machine whose container
 * runtime is not Docker, and the library already knows which one it used.
 *
 * ## Why bậc 4 needs this at all
 *
 * `AGENTS.md` §4 wants the mutation on the other side of the boundary. For "mất
 * kết nối" there is no honest way to do that from inside the page — a wrapped
 * `WebSocket` is a mutation on OUR side, which is exactly what `deferred-work.md`
 * recorded Story 2.3 as unable to escape. The container going away IS the event,
 * in the medium where it happens.
 */

export const LIVEKIT_IMAGE = 'livekit/livekit-server:v1.13.5';

/** LiveKit's signalling/HTTP port inside the container. */
export const SIGNAL_PORT = 7880;

/**
 * The single UDP mux port, bound to the same number on the host.
 *
 * ICE needs a media port that is the SAME number inside and outside: LiveKit
 * advertises candidates carrying its own port, so a randomly mapped host port
 * would hand Chromium an address nothing is listening on and the connection
 * would stall with every signal exchanged correctly.
 *
 * Deliberately NOT one of the numbers `infra/docker-compose.yml` publishes
 * (7880, 7881, 50000-50019): a developer with the local stack up should be able
 * to run this suite without taking it down.
 */
export const MEDIA_UDP_PORT = 7882;

interface Handoff {
  readonly containerId: string;
  readonly url: string;
}

function handoff(): Handoff {
  const raw: unknown = JSON.parse(readFileSync(LIVEKIT_HANDOFF_FILE, 'utf8'));
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = record['containerId'];
  const url = record['url'];
  if (typeof id !== 'string' || id === '' || typeof url !== 'string' || url === '') {
    throw new Error(
      `${LIVEKIT_HANDOFF_FILE} carries no containerId. The bậc 4 probe drives its stimulus by ` +
        'stopping the real livekit-server, and without the id there is nothing to stop — a probe ' +
        'that silently asserted about a server nobody had touched.',
    );
  }
  return { containerId: id, url };
}

/**
 * Rewrite the hand-off file, keeping every key it already carries.
 *
 * Written to a temporary path and RENAMED, because the reader is a live server:
 * `tests/e2e/support/fake-api.cjs` reads this file on every token request, and a
 * `writeFileSync` straight to the final path is not one operation — a request
 * landing between the truncate and the last byte reads a partial file and the
 * fixture throws mid-dispatch. A rename within one directory is atomic on every
 * platform this runs on.
 */
export function updateHandoff(fields: Readonly<Record<string, unknown>>): void {
  const raw: unknown = JSON.parse(readFileSync(LIVEKIT_HANDOFF_FILE, 'utf8'));
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const pending = `${LIVEKIT_HANDOFF_FILE}.pending`;
  writeFileSync(pending, `${JSON.stringify({ ...record, ...fields }, null, 2)}\n`, 'utf8');
  renameSync(pending, LIVEKIT_HANDOFF_FILE);
}

export async function stopLiveKitContainer(): Promise<void> {
  const client = await getContainerRuntimeClient();
  await client.container.stop(client.container.getById(handoff().containerId));
}

/**
 * Start it again, re-publish its address, and WAIT until it answers.
 *
 * Three steps where one looks like it should do, and the middle one was measured
 * rather than foreseen: **the signalling port moves.** Testcontainers publishes
 * it with an empty `HostPort`, which means "pick a free one at START time" — so a
 * restarted container comes back on a DIFFERENT host port and the hand-off file
 * then names a port nothing is listening on. The first run of the bậc 4 probe
 * failed here, and it failed in the honest direction: the readiness poll refused
 * rather than letting the next case run against a dead address.
 *
 * The UDP mux port does not move, because {@link MEDIA_UDP_PORT} is bound 1:1 by
 * number — the same property ICE relies on.
 *
 * The readiness check is the one `globalSetup` waits on: LiveKit answers `200` on
 * `/` as soon as signalling is up. A container that has been told to start is not
 * a server that is listening, and the probe restarts it in a `finally` with
 * another case queued behind it.
 */
export async function startLiveKitContainer(): Promise<void> {
  const previous = handoff();
  const client = await getContainerRuntimeClient();
  const container = client.container.getById(previous.containerId);
  await client.container.start(container);

  const inspected = await client.container.inspect(container);
  const published = inspected.NetworkSettings.Ports[`${SIGNAL_PORT}/tcp`]?.[0]?.HostPort;
  const url = published === undefined ? previous.url : `ws://127.0.0.1:${published}`;
  if (url !== previous.url) {
    updateHandoff({ url });
    process.stdout.write(`[livekit probe] restarted; signalling moved to ${url}\n`);
  }

  const probeUrl = `${url.replace(/^ws/, 'http')}/`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(probeUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Still booting: the socket is refused until the listener is up.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${LIVEKIT_IMAGE} was started again but never answered on ${probeUrl}. Every case after ` +
          'the bậc 4 probe needs a live server, and letting them run against a dead one would ' +
          'report the ladder as broken when the container is.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
