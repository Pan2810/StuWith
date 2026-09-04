import { createValkeyClient, type ValkeyClient } from './valkey/client';
import { ValkeyRateLimitAdapter } from './valkey/rate-limit-adapter';
import { runRateLimitPortContract } from './test-kit';
import { startValkey, testcontainersDisabled, type StartedValkey } from './__testing__/valkey';

/**
 * CI gate #3, pass 2 of 2. Same suite, real Valkey 9.0.4.
 *
 * This is the pass that catches what an in-memory Map cannot express. The
 * adapter's whole claim is that "increment, and set the expiry only on the first
 * hit" happens as ONE atomic step and that the countdown comes from the server's
 * own PTTL. Both of those are properties of Lua running inside Valkey, not of
 * TypeScript — split the script back into `INCR` then `PEXPIRE` and every
 * in-memory assertion still passes while production grows keys that never expire.
 */
runRateLimitPortContract({
  label: 'valkey-9.0.4 (testcontainers)',
  skip: testcontainersDisabled,
  // The suite's `advance()` is a REAL wait here, and there are several of them.
  hookTimeoutMs: 300_000,
  createHarness: async () => {
    /**
     * Scoped to this harness, not to the module.
     *
     * A module-level `started` assigned in here meant a second `createHarness` —
     * one retry, one added suite — silently orphaned the first container, which
     * then lived until the CI runner was recycled. Everything the teardown has to
     * close is now closed over by the closure that created it.
     */
    const started: StartedValkey = await startValkey();

    // The production client, with the production options — only the URL differs.
    // A test client built with friendlier settings would prove nothing about the
    // timeouts the fail-open decision depends on.
    const client = createValkeyClient(started.url, { commandTimeoutMs: 2_000 });
    await client.connect();

    const faultingClients: ValkeyClient[] = [];

    return {
      port: new ValkeyRateLimitAdapter(client),
      reset: async () => {
        await client.flushdb();
      },
      /**
       * A real wait. There is no way to move a server's clock from outside it,
       * and the alternative — asserting against a stub — would leave exactly the
       * behaviour this pass exists to check unverified.
       */
      advance: (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),

      /**
       * A client pointed at a port nothing is listening on — a genuine connection
       * fault rather than a stub. Proves the adapter lets it propagate instead of
       * quietly answering "allowed" and switching the whole layer off.
       */
      createFaultingPort: async () => {
        // One per harness, reused by every example that asks for it. Minting a
        // fresh client per call left a growing pile of reconnecting sockets for
        // the whole run.
        const existing = faultingClients[0];
        if (existing !== undefined) {
          return new ValkeyRateLimitAdapter(existing);
        }
        const unreachable = createValkeyClient('redis://127.0.0.1:1', {
          commandTimeoutMs: 500,
          connectTimeoutMs: 500,
        });
        faultingClients.push(unreachable);
        return new ValkeyRateLimitAdapter(unreachable);
      },

      /**
       * Every step runs even if an earlier one rejects, so a client that refuses
       * to quit cannot leak a container onto the CI runner for the rest of the job.
       */
      teardown: async () => {
        const failures: unknown[] = [];
        const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
          try {
            await fn();
          } catch (error) {
            failures.push(new Error(`${label} failed: ${String(error)}`));
          }
        };

        /**
         * `disconnect()` rather than `quit()`: `quit` waits for the server to
         * acknowledge, and the container may already be on its way down.
         */
        for (const unreachable of faultingClients) {
          await attempt('faulting client disconnect', async () => {
            unreachable.disconnect();
          });
        }
        faultingClients.length = 0;
        await attempt('client disconnect', async () => {
          client.disconnect();
        });
        await attempt('container stop', () => started.stop());

        if (failures.length > 0) {
          throw new AggregateError(failures, 'teardown did not complete cleanly');
        }
      },
    };
  },
});
