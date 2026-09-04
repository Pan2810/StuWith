import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { testcontainersDisabled } from './postgres';

/**
 * Real Valkey 9.0.4 for the second pass of the rate-limit contract suite (TD-5).
 *
 * The image is the one `infra/docker-compose.yml` pins, not a generic `redis`:
 * the whole reason for a second pass is to prove the adapter's atomic script and
 * its millisecond TTLs behave on the server the product actually ships with. A
 * suite that passes against a different server has verified a different product.
 *
 * `testcontainersDisabled` is IMPORTED rather than re-derived. It carries the rule
 * that the escape hatch cannot be taken inside CI — gate 3 is a required check,
 * and a skipped required check reports success having executed nothing — and a
 * second copy of that rule is a second place for it to quietly diverge.
 */
export const VALKEY_IMAGE = 'valkey/valkey:9.0.4-alpine';

export { testcontainersDisabled };

export interface StartedValkey {
  readonly container: StartedTestContainer;
  readonly url: string;
  stop(): Promise<void>;
}

export async function startValkey(): Promise<StartedValkey> {
  const container = await new GenericContainer(VALKEY_IMAGE)
    // Persistence off: this container lives for one suite, and an fsync on every
    // write is pure latency in a test that measures TTLs.
    .withCommand(['valkey-server', '--save', '', '--appendonly', 'no'])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(180_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(6379);

  return {
    container,
    url: `redis://${host}:${port}`,
    stop: () => container.stop(),
  };
}
