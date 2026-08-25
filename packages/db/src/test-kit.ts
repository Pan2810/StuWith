import type { HeartbeatPort } from '@stuwith/domain';
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
  });
}
