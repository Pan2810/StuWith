import { HeartbeatInputError, type HeartbeatPort } from '@stuwith/domain';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * AD-6 / TD-5 — the shared adapter contract suite.
 *
 * One suite, exported, run once per adapter. The spine's warning is the reason it
 * exists: "if not, an adapter that forgets a condition still satisfies every AD".
 * A new adapter is only finished when this function passes against it.
 *
 * Deliberately exported from `@stuwith/db/test-kit`, a separate entry point, so
 * that importing the package at runtime never pulls `vitest` into a server bundle.
 */
export interface HeartbeatPortHarness {
  readonly port: HeartbeatPort;
  /** Return the adapter to an empty state between examples. */
  reset(): Promise<void>;
  /** Release connections/containers once the suite is done. */
  teardown?(): Promise<void>;
  /**
   * An INDEPENDENT port instance whose store is guaranteed to be unreachable —
   * a closed pool, a torn-down map. Used to prove the adapter lets a fault
   * propagate instead of laundering it into a refusal.
   *
   * Independent on purpose: breaking the harness's own port to test this would
   * make every later example order-dependent on the one that broke it.
   */
  createFaultingPort?(): Promise<HeartbeatPort>;
}

export interface HeartbeatPortContractOptions {
  /** Shown in the test name, e.g. "in-memory" or "postgres-18". */
  readonly label: string;
  readonly createHarness: () => Promise<HeartbeatPortHarness>;
  /** Optional: skip (rather than fail) when the environment cannot host it. */
  readonly skip?: boolean;
  readonly hookTimeoutMs?: number;
}

export function runHeartbeatPortContract(options: HeartbeatPortContractOptions): void {
  const suite = options.skip === true ? describe.skip : describe;
  const t0 = new Date('2026-08-21T00:00:00.000Z');
  const t1 = new Date('2026-08-21T00:00:05.000Z');
  const t2 = new Date('2026-08-21T00:00:10.000Z');

  suite(`HeartbeatPort contract — ${options.label}`, () => {
    let harness: HeartbeatPortHarness | undefined;

    const port = async (): Promise<HeartbeatPort> => {
      harness ??= await options.createHarness();
      return harness.port;
    };

    beforeEach(async () => {
      harness ??= await options.createHarness();
      await harness.reset();
    }, options.hookTimeoutMs ?? 120_000);

    afterAll(async () => {
      await harness?.teardown?.();
      harness = undefined;
    }, options.hookTimeoutMs ?? 120_000);

    it('reports no heartbeat for an unknown key', async () => {
      expect(await (await port()).latest('unknown')).toBeNull();
    });

    it('stores the first observation', async () => {
      const result = await (await port()).record('api', t1);
      expect(result.ok).toBe(true);
      const stored = await (await port()).latest('api');
      expect(stored?.serviceKey).toBe('api');
      expect(stored?.observedAt.toISOString()).toBe(t1.toISOString());
    });

    it('accepts a strictly newer observation', async () => {
      const p = await port();
      await p.record('api', t1);
      const result = await p.record('api', t2);
      expect(result.ok).toBe(true);
      expect((await p.latest('api'))?.observedAt.toISOString()).toBe(t2.toISOString());
    });

    it('REFUSES an older observation and leaves the stored row untouched', async () => {
      const p = await port();
      await p.record('api', t2);
      const result = await p.record('api', t1);
      expect(result).toEqual({ ok: false, reason: 'StaleObservation' });
      expect((await p.latest('api'))?.observedAt.toISOString()).toBe(t2.toISOString());
    });

    it('REFUSES a replay of the same observation — equal is not newer', async () => {
      const p = await port();
      await p.record('api', t1);
      const result = await p.record('api', t1);
      expect(result).toEqual({ ok: false, reason: 'StaleObservation' });
    });

    it('refuses by returning, never by throwing', async () => {
      const p = await port();
      await p.record('api', t2);
      await expect(p.record('api', t0)).resolves.toMatchObject({ ok: false });
    });

    it('keys are independent — one service does not shadow another', async () => {
      const p = await port();
      await p.record('api', t2);
      const result = await p.record('realtime-gateway', t1);
      expect(result.ok).toBe(true);
      expect((await p.latest('api'))?.observedAt.toISOString()).toBe(t2.toISOString());
      expect((await p.latest('realtime-gateway'))?.observedAt.toISOString()).toBe(t1.toISOString());
    });

    it('survives concurrent writers without losing the newest observation', async () => {
      const p = await port();
      const results = await Promise.all([
        p.record('api', t0),
        p.record('api', t1),
        p.record('api', t2),
      ]);
      // Some of these legitimately lose the race; what must hold is that the row
      // ends on the newest value and that every loser said so by returning.
      expect(results.some((r) => r.ok)).toBe(true);
      expect((await p.latest('api'))?.observedAt.toISOString()).toBe(t2.toISOString());
    });

    /**
     * Invalid input is a caller defect, not a domain outcome, so it throws — and
     * every adapter must throw the SAME error for the SAME input.
     *
     * This block exists because the two adapters used to disagree in exactly the
     * way that never shows up in development: the in-memory adapter stored an
     * `Invalid Date` quite happily, while Postgres raised a driver error. Whichever
     * adapter you tested against, the other one behaved differently in production.
     */
    describe('rejects input that cannot describe a heartbeat', () => {
      const badInputs: ReadonlyArray<readonly [string, string, Date]> = [
        ['an empty service key', '', t1],
        ['a whitespace-only service key', '   ', t1],
        ['an over-long service key', 'k'.repeat(65), t1],
        ['an Invalid Date', 'api', new Date('not-a-date')],
      ];

      it.each(badInputs)('throws HeartbeatInputError for %s', async (_label, key, at) => {
        await expect((await port()).record(key, at)).rejects.toBeInstanceOf(HeartbeatInputError);
      });

      it('throws for a bad key on latest() too, not only on record()', async () => {
        await expect((await port()).latest('')).rejects.toBeInstanceOf(HeartbeatInputError);
      });

      it('stores nothing when the input was rejected', async () => {
        const p = await port();
        await expect(p.record('api', new Date('not-a-date'))).rejects.toThrow();
        expect(await p.latest('api')).toBeNull();
      });
    });

    /**
     * A fault is not a refusal. If this ever starts returning `{ ok: false }`, a
     * database outage becomes indistinguishable from "the stored value was newer",
     * and the caller carries on as though nothing happened — which in Epic 3 is
     * the difference between "the debit failed, error out" and "insufficient
     * funds, end the session".
     */
    describe('lets an infrastructure fault propagate', () => {
      it('throws instead of returning a refusal when the store is unreachable', async () => {
        // `beforeEach` has already built the harness by the time this runs.
        const create = harness?.createFaultingPort;
        if (create === undefined) {
          throw new Error(
            `harness "${options.label}" must provide createFaultingPort(): a contract that ` +
              'cannot distinguish a fault from a refusal is not being checked.',
          );
        }

        const faulting = await create.call(harness);
        const outcome = await faulting.record('api', t1).then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

        expect(
          outcome.kind,
          `expected a thrown fault, got ${JSON.stringify(
            outcome.kind === 'resolved' ? outcome.value : null,
          )}`,
        ).toBe('rejected');
        // And specifically NOT the input-validation error, which would mean the
        // fault path was never actually exercised.
        expect(outcome.kind === 'rejected' && outcome.error).not.toBeInstanceOf(
          HeartbeatInputError,
        );
      });
    });
  });
}
