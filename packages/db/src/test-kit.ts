import { AUDIT_ACTIONS, SERVICE_NAMES } from '@stuwith/contracts';
import {
  AuditInputError,
  HeartbeatInputError,
  IdentityInputError,
  SessionInputError,
  type AuditEventInput,
  type AuditPort,
  type HeartbeatPort,
  type IdentityPort,
  type ProviderIdentity,
  type SessionGeneration,
  type SessionPort,
} from '@stuwith/domain';
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

/* ------------------------------------------------------------------------- *
 * IdentityPort — Story 1.2
 * ------------------------------------------------------------------------- */

export interface IdentityPortHarness {
  readonly port: IdentityPort;
  reset(): Promise<void>;
  teardown?(): Promise<void>;
  /**
   * Total number of user rows. The acceptance criterion is "logging in again must
   * not create a second account", and asserting only that the SAME id comes back
   * would still pass against an adapter that created a second, orphaned row and
   * then found the first one. Counting is the assertion that actually holds.
   */
  countUsers(): Promise<number>;
  /** See HeartbeatPortHarness.createFaultingPort — same reasoning, same rule. */
  createFaultingPort?(): Promise<IdentityPort>;
}

export interface IdentityPortContractOptions {
  readonly label: string;
  readonly createHarness: () => Promise<IdentityPortHarness>;
  readonly skip?: boolean;
  readonly hookTimeoutMs?: number;
}

function googleIdentity(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    provider: 'google',
    providerUserId: 'google-subject-1',
    email: 'an.nguyen@fpt.edu.vn',
    displayName: 'An Nguyen',
    avatarUrl: 'https://lh3.googleusercontent.com/a/an',
    ...overrides,
  };
}

export function runIdentityPortContract(options: IdentityPortContractOptions): void {
  const suite = options.skip === true ? describe.skip : describe;
  const t0 = new Date('2026-09-04T09:00:00.000Z');
  const t1 = new Date('2026-09-04T09:05:00.000Z');

  suite(`IdentityPort contract — ${options.label}`, () => {
    let harness: IdentityPortHarness | undefined;

    const use = async (): Promise<IdentityPortHarness> => {
      harness ??= await options.createHarness();
      return harness;
    };
    const port = async (): Promise<IdentityPort> => (await use()).port;

    beforeEach(async () => {
      harness ??= await options.createHarness();
      await harness.reset();
    }, options.hookTimeoutMs ?? 120_000);

    afterAll(async () => {
      await harness?.teardown?.();
      harness = undefined;
    }, options.hookTimeoutMs ?? 120_000);

    it('creates a user and reports that it did, on first sight of an identity', async () => {
      const result = await (await port()).findOrCreateByIdentity(googleIdentity(), t0);

      expect(result.created).toBe(true);
      expect(result.user.role).toBe('user');
      expect(result.user.displayName).toBe('An Nguyen');
      expect(await (await use()).countUsers()).toBe(1);
    });

    it('maps a second login onto the SAME user and creates no second row', async () => {
      const p = await port();
      const first = await p.findOrCreateByIdentity(googleIdentity(), t0);
      const second = await p.findOrCreateByIdentity(googleIdentity(), t1);

      expect(second.created).toBe(false);
      expect(second.user.id).toBe(first.user.id);
      expect(await (await use()).countUsers()).toBe(1);
    });

    it('keeps two providers sharing ONE email as two separate users', async () => {
      // Deliberate, not a bug: merging on email is an account-takeover route, and
      // an email is not an identity. Account linking is a later epic.
      const p = await port();
      const email = 'shared@fpt.edu.vn';
      const google = await p.findOrCreateByIdentity(
        googleIdentity({ providerUserId: 'g-shared', email }),
        t0,
      );
      const facebook = await p.findOrCreateByIdentity(
        googleIdentity({ provider: 'facebook', providerUserId: 'f-shared', email }),
        t0,
      );

      expect(facebook.created).toBe(true);
      expect(facebook.user.id).not.toBe(google.user.id);
      expect(await (await use()).countUsers()).toBe(2);
    });

    it('keeps the same subject on two DIFFERENT providers apart', async () => {
      // `(provider, provider_user_id)` is the key — not the subject alone. Two
      // providers can and do issue the same-looking opaque id.
      const p = await port();
      const a = await p.findOrCreateByIdentity(googleIdentity({ providerUserId: 'same' }), t0);
      const b = await p.findOrCreateByIdentity(
        googleIdentity({ provider: 'microsoft', providerUserId: 'same' }),
        t0,
      );
      expect(b.user.id).not.toBe(a.user.id);
      expect(await (await use()).countUsers()).toBe(2);
    });

    it('creates exactly ONE user when the same new identity arrives concurrently', async () => {
      // The row this whole design exists for. A read-then-write adapter passes
      // every other example here and fails this one — and in production it fails
      // it silently, as duplicate accounts nobody can merge.
      const p = await port();
      const results = await Promise.all([
        p.findOrCreateByIdentity(googleIdentity({ providerUserId: 'racy' }), t0),
        p.findOrCreateByIdentity(googleIdentity({ providerUserId: 'racy' }), t0),
        p.findOrCreateByIdentity(googleIdentity({ providerUserId: 'racy' }), t0),
      ]);

      const ids = new Set(results.map((r) => r.user.id));
      expect(ids.size, 'all three callers must be given the same user').toBe(1);
      expect(results.filter((r) => r.created).length, 'exactly one caller created it').toBe(1);
      expect(await (await use()).countUsers()).toBe(1);
    });

    it('stores a withheld email as null instead of inventing one', async () => {
      const result = await (await port()).findOrCreateByIdentity(
        googleIdentity({
          provider: 'apple',
          providerUserId: 'apple-1',
          email: null,
          avatarUrl: null,
        }),
        t0,
      );
      expect(result.user.email).toBeNull();
      expect(result.user.avatarUrl).toBeNull();
    });

    it('finds a user by id, and returns null for an id nobody owns', async () => {
      const p = await port();
      const created = await p.findOrCreateByIdentity(googleIdentity(), t0);

      expect((await p.findUserById(created.user.id))?.id).toBe(created.user.id);
      expect(await p.findUserById('019200ff-0000-7000-8000-00000000ffff')).toBeNull();
    });

    describe('rejects input that cannot describe an identity', () => {
      const badIdentities: ReadonlyArray<readonly [string, ProviderIdentity]> = [
        ['an empty subject', googleIdentity({ providerUserId: '' })],
        ['a whitespace-only subject', googleIdentity({ providerUserId: '   ' })],
        ['an over-long subject', googleIdentity({ providerUserId: 'x'.repeat(256) })],
        ['a blank display name', googleIdentity({ displayName: '  ' })],
      ];

      it.each(badIdentities)('throws IdentityInputError for %s', async (_label, identity) => {
        await expect((await port()).findOrCreateByIdentity(identity, t0)).rejects.toBeInstanceOf(
          IdentityInputError,
        );
      });

      it('throws for an Invalid Date', async () => {
        await expect(
          (await port()).findOrCreateByIdentity(googleIdentity(), new Date('not-a-date')),
        ).rejects.toBeInstanceOf(IdentityInputError);
      });

      it('throws on findUserById for an empty id', async () => {
        await expect((await port()).findUserById('')).rejects.toBeInstanceOf(IdentityInputError);
      });

      it('stores nothing when the input was rejected', async () => {
        const p = await port();
        await expect(
          p.findOrCreateByIdentity(googleIdentity({ providerUserId: '' }), t0),
        ).rejects.toThrow();
        expect(await (await use()).countUsers()).toBe(0);
      });
    });

    describe('lets an infrastructure fault propagate', () => {
      it('throws instead of quietly returning a user when the store is unreachable', async () => {
        const create = harness?.createFaultingPort;
        if (create === undefined) {
          throw new Error(
            `harness "${options.label}" must provide createFaultingPort(): an adapter that ` +
              'turns an outage into "found an existing user" would sign the wrong person in.',
          );
        }
        const faulting = await create.call(harness);
        const outcome = await faulting.findOrCreateByIdentity(googleIdentity(), t0).then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

        expect(outcome.kind).toBe('rejected');
        expect(outcome.kind === 'rejected' && outcome.error).not.toBeInstanceOf(IdentityInputError);
      });
    });
  });
}

/* ------------------------------------------------------------------------- *
 * SessionPort — Story 1.2
 * ------------------------------------------------------------------------- */

export interface SessionPortHarness {
  readonly port: SessionPort;
  reset(): Promise<void>;
  teardown?(): Promise<void>;
  /** A user id the store will accept as a foreign key. */
  createUserId(): Promise<string>;
  createFaultingPort?(): Promise<SessionPort>;
}

export interface SessionPortContractOptions {
  readonly label: string;
  readonly createHarness: () => Promise<SessionPortHarness>;
  readonly skip?: boolean;
  readonly hookTimeoutMs?: number;
}

export function runSessionPortContract(options: SessionPortContractOptions): void {
  const suite = options.skip === true ? describe.skip : describe;
  const t0 = new Date('2026-09-04T09:00:00.000Z');
  const t1 = new Date('2026-09-04T09:30:00.000Z');
  const accessExpiry = new Date('2026-09-04T10:00:00.000Z');
  const refreshExpiry = new Date('2026-10-04T09:00:00.000Z');

  // Hashes, not tokens: the port takes no plaintext, so an adapter is physically
  // unable to store something replayable.
  const hash = (label: string): string => `sha256:${label}${'0'.repeat(48)}`;

  suite(`SessionPort contract — ${options.label}`, () => {
    let harness: SessionPortHarness | undefined;

    const use = async (): Promise<SessionPortHarness> => {
      harness ??= await options.createHarness();
      return harness;
    };
    const port = async (): Promise<SessionPort> => (await use()).port;

    const open = async (suffix = 'a'): Promise<SessionGeneration> => {
      const userId = await (await use()).createUserId();
      return (await port()).open({
        userId,
        accessTokenHash: hash(`access-${suffix}`),
        refreshTokenHash: hash(`refresh-${suffix}`),
        issuedAt: t0,
        expiresAt: accessExpiry,
        refreshExpiresAt: refreshExpiry,
      });
    };

    beforeEach(async () => {
      harness ??= await options.createHarness();
      await harness.reset();
    }, options.hookTimeoutMs ?? 120_000);

    afterAll(async () => {
      await harness?.teardown?.();
      harness = undefined;
    }, options.hookTimeoutMs ?? 120_000);

    it('opens a live session that reads back by its access token hash', async () => {
      const opened = await open();
      const read = await (await port()).readByAccessTokenHash(hash('access-a'), t0);

      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.session.sessionId).toBe(opened.sessionId);
        expect(read.session.userId).toBe(opened.userId);
      }
    });

    it('refuses an access token nobody issued', async () => {
      await open();
      expect(await (await port()).readByAccessTokenHash(hash('nope'), t0)).toEqual({
        ok: false,
        reason: 'SessionNotFound',
      });
    });

    it('refuses a session once its TTL has passed', async () => {
      await open();
      const afterTtl = new Date(accessExpiry.getTime() + 1);
      expect(await (await port()).readByAccessTokenHash(hash('access-a'), afterTtl)).toEqual({
        ok: false,
        reason: 'SessionExpired',
      });
    });

    it('refuses at the exact expiry instant — the boundary is closed, not open', async () => {
      await open();
      expect(await (await port()).readByAccessTokenHash(hash('access-a'), accessExpiry)).toEqual({
        ok: false,
        reason: 'SessionExpired',
      });
    });

    it('rotates: same chain id, new generation, old access token spent', async () => {
      const opened = await open();
      const p = await port();

      const rotated = await p.rotate({
        presentedRefreshTokenHash: hash('refresh-a'),
        accessTokenHash: hash('access-b'),
        refreshTokenHash: hash('refresh-b'),
        issuedAt: t1,
        expiresAt: new Date(t1.getTime() + 3_600_000),
        refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
      });

      expect(rotated.ok).toBe(true);
      if (!rotated.ok) return;

      // The chain id is what a revocation targets and what Epic 2 will hold, so it
      // must survive rotation.
      expect(rotated.session.sessionId).toBe(opened.sessionId);
      expect(rotated.session.id).not.toBe(opened.id);

      expect((await p.readByAccessTokenHash(hash('access-b'), t1)).ok).toBe(true);
      // Superseded, not merely old: a stolen previous cookie must stop working the
      // instant a newer generation exists, not when its own TTL runs out.
      expect(await p.readByAccessTokenHash(hash('access-a'), t1)).toEqual({
        ok: false,
        reason: 'SessionExpired',
      });
    });

    it('marks the rotated generation, keeping the chain auditable', async () => {
      const opened = await open();
      const p = await port();
      await p.rotate({
        presentedRefreshTokenHash: hash('refresh-a'),
        accessTokenHash: hash('access-b'),
        refreshTokenHash: hash('refresh-b'),
        issuedAt: t1,
        expiresAt: new Date(t1.getTime() + 3_600_000),
        refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
      });

      const chain = await p.listChain(opened.sessionId);
      expect(chain.length).toBe(2);
      expect(chain[0]?.rotatedAt).not.toBeNull();
      expect(chain[1]?.rotatedAt).toBeNull();
    });

    it('REVOKES THE WHOLE CHAIN when an already-rotated refresh token comes back', async () => {
      // This is the theft signal. A spent refresh token should exist nowhere but a
      // stolen copy, so the answer is to end the chain — not to refuse politely and
      // leave the newest generation working for whoever else holds it.
      const opened = await open();
      const p = await port();
      await p.rotate({
        presentedRefreshTokenHash: hash('refresh-a'),
        accessTokenHash: hash('access-b'),
        refreshTokenHash: hash('refresh-b'),
        issuedAt: t1,
        expiresAt: new Date(t1.getTime() + 3_600_000),
        refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
      });

      const replay = await p.rotate({
        presentedRefreshTokenHash: hash('refresh-a'),
        accessTokenHash: hash('access-c'),
        refreshTokenHash: hash('refresh-c'),
        issuedAt: new Date(t1.getTime() + 60_000),
        expiresAt: new Date(t1.getTime() + 3_660_000),
        refreshExpiresAt: new Date(t1.getTime() + 86_460_000),
      });

      expect(replay.ok).toBe(false);
      if (replay.ok) return;
      expect(replay.reason).toBe('RefreshTokenReused');
      expect(replay.revokedSessionId).toBe(opened.sessionId);

      // Every generation, including the one the legitimate client is holding.
      const after = await p.readByAccessTokenHash(
        hash('access-b'),
        new Date(t1.getTime() + 61_000),
      );
      expect(after).toEqual({ ok: false, reason: 'SessionRevoked' });
      for (const generation of await p.listChain(opened.sessionId)) {
        expect(generation.revokedAt).not.toBeNull();
      }
    });

    it('refuses to rotate a refresh token nobody issued', async () => {
      await open();
      const refusal = await (await port()).rotate({
        presentedRefreshTokenHash: hash('never-issued'),
        accessTokenHash: hash('access-z'),
        refreshTokenHash: hash('refresh-z'),
        issuedAt: t1,
        expiresAt: new Date(t1.getTime() + 3_600_000),
        refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
      });
      expect(refusal).toMatchObject({ ok: false, reason: 'SessionNotFound' });
    });

    it('refuses to rotate a refresh token that has itself expired', async () => {
      await open();
      const afterRefreshTtl = new Date(refreshExpiry.getTime() + 1);
      const refusal = await (await port()).rotate({
        presentedRefreshTokenHash: hash('refresh-a'),
        accessTokenHash: hash('access-b'),
        refreshTokenHash: hash('refresh-b'),
        issuedAt: afterRefreshTtl,
        expiresAt: new Date(afterRefreshTtl.getTime() + 3_600_000),
        refreshExpiresAt: new Date(afterRefreshTtl.getTime() + 86_400_000),
      });
      expect(refusal).toMatchObject({ ok: false, reason: 'SessionExpired' });
    });

    it('lets exactly one of two concurrent rotations win', async () => {
      await open();
      const p = await port();
      const attempt = (suffix: string) =>
        p.rotate({
          presentedRefreshTokenHash: hash('refresh-a'),
          accessTokenHash: hash(`access-${suffix}`),
          refreshTokenHash: hash(`refresh-${suffix}`),
          issuedAt: t1,
          expiresAt: new Date(t1.getTime() + 3_600_000),
          refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
        });

      const results = await Promise.all([attempt('x'), attempt('y')]);
      expect(results.filter((r) => r.ok).length, 'one token, one new generation').toBe(1);
    });

    it('revokes a chain, and revoking twice is not an error', async () => {
      const opened = await open();
      const p = await port();
      await p.revokeChain(opened.sessionId, t1);
      await p.revokeChain(opened.sessionId, t1);

      expect(await p.readByAccessTokenHash(hash('access-a'), t1)).toEqual({
        ok: false,
        reason: 'SessionRevoked',
      });
    });

    it('reports a revoked session as revoked even after its TTL — an incident needs the reason', async () => {
      const opened = await open();
      const p = await port();
      await p.revokeChain(opened.sessionId, t1);

      expect(
        await p.readByAccessTokenHash(hash('access-a'), new Date(accessExpiry.getTime() + 1)),
      ).toEqual({ ok: false, reason: 'SessionRevoked' });
    });

    it('refuses to rotate a revoked chain', async () => {
      const opened = await open();
      const p = await port();
      await p.revokeChain(opened.sessionId, t1);

      expect(
        await p.rotate({
          presentedRefreshTokenHash: hash('refresh-a'),
          accessTokenHash: hash('access-b'),
          refreshTokenHash: hash('refresh-b'),
          issuedAt: t1,
          expiresAt: new Date(t1.getTime() + 3_600_000),
          refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
        }),
      ).toMatchObject({ ok: false, reason: 'SessionRevoked' });
    });

    it('revokes a chain from the REFRESH token, which is what logout has to do', async () => {
      const opened = await open();
      const p = await port();

      expect(await p.revokeChainByRefreshTokenHash(hash('refresh-a'), t1)).toBe(opened.sessionId);
      expect(await p.readByAccessTokenHash(hash('access-a'), t1)).toEqual({
        ok: false,
        reason: 'SessionRevoked',
      });
    });

    it('revokes from a refresh token whose own generation is already SPENT', async () => {
      // The defect this pins: logging out an hour into a session, when the access
      // token has expired and the refresh token has been rotated once. A logout
      // that only works while the access token is live leaves a 30-day chain alive
      // and clears cookies the attacker never had.
      const opened = await open();
      const p = await port();
      await p.rotate({
        presentedRefreshTokenHash: hash('refresh-a'),
        accessTokenHash: hash('access-b'),
        refreshTokenHash: hash('refresh-b'),
        issuedAt: t1,
        expiresAt: new Date(t1.getTime() + 3_600_000),
        refreshExpiresAt: new Date(t1.getTime() + 86_400_000),
      });

      const later = new Date(accessExpiry.getTime() + 60_000);
      expect(await p.revokeChainByRefreshTokenHash(hash('refresh-a'), later)).toBe(
        opened.sessionId,
      );

      for (const generation of await p.listChain(opened.sessionId)) {
        expect(generation.revokedAt).not.toBeNull();
      }
      expect(await p.readByAccessTokenHash(hash('access-b'), later)).toEqual({
        ok: false,
        reason: 'SessionRevoked',
      });
    });

    it('reports null for a refresh token nobody issued, and revokes nothing', async () => {
      const opened = await open();
      const p = await port();

      expect(await p.revokeChainByRefreshTokenHash(hash('never-issued'), t1)).toBeNull();
      expect((await p.readByAccessTokenHash(hash('access-a'), t1)).ok).toBe(true);
      void opened;
    });

    it('is idempotent — logging out twice is not an error', async () => {
      const opened = await open();
      const p = await port();

      expect(await p.revokeChainByRefreshTokenHash(hash('refresh-a'), t1)).toBe(opened.sessionId);
      // Still reports the chain it ended, so a caller cannot tell "already out"
      // from "was not signed in" by the return value alone.
      expect(await p.revokeChainByRefreshTokenHash(hash('refresh-a'), t1)).toBe(opened.sessionId);
    });

    describe('rejects input that cannot describe a session', () => {
      it('throws for a blank refresh token hash on the logout path', async () => {
        await expect(
          (await port()).revokeChainByRefreshTokenHash('', t0),
        ).rejects.toBeInstanceOf(SessionInputError);
      });

      it('throws for a blank access token hash', async () => {
        await expect((await port()).readByAccessTokenHash('', t0)).rejects.toBeInstanceOf(
          SessionInputError,
        );
      });

      it('throws for an Invalid Date', async () => {
        await expect(
          (await port()).readByAccessTokenHash(hash('access-a'), new Date('not-a-date')),
        ).rejects.toBeInstanceOf(SessionInputError);
      });

      it('throws when the session would expire before it was issued', async () => {
        const userId = await (await use()).createUserId();
        await expect(
          (await port()).open({
            userId,
            accessTokenHash: hash('access-bad'),
            refreshTokenHash: hash('refresh-bad'),
            issuedAt: accessExpiry,
            expiresAt: t0,
            refreshExpiresAt: refreshExpiry,
          }),
        ).rejects.toBeInstanceOf(SessionInputError);
      });
    });

    describe('lets an infrastructure fault propagate', () => {
      it('throws instead of returning a refusal when the store is unreachable', async () => {
        const create = harness?.createFaultingPort;
        if (create === undefined) {
          throw new Error(
            `harness "${options.label}" must provide createFaultingPort(): an outage that reads ` +
              'as "SessionNotFound" logs every user out and looks like normal behaviour.',
          );
        }
        const faulting = await create.call(harness);
        const outcome = await faulting.readByAccessTokenHash(hash('access-a'), t0).then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

        expect(
          outcome.kind,
          `expected a thrown fault, got ${JSON.stringify(
            outcome.kind === 'resolved' ? outcome.value : null,
          )}`,
        ).toBe('rejected');
        expect(outcome.kind === 'rejected' && outcome.error).not.toBeInstanceOf(SessionInputError);
      });
    });
  });
}

/* ------------------------------------------------------------------------- *
 * AuditPort — Story 1.2
 * ------------------------------------------------------------------------- */

export interface AuditPortHarness {
  readonly port: AuditPort;
  reset(): Promise<void>;
  teardown?(): Promise<void>;
  /** Every row the store now holds, oldest first. */
  rows(): Promise<readonly AuditEventInput[]>;
  createFaultingPort?(): Promise<AuditPort>;
}

export interface AuditPortContractOptions {
  readonly label: string;
  readonly createHarness: () => Promise<AuditPortHarness>;
  readonly skip?: boolean;
  readonly hookTimeoutMs?: number;
}

/**
 * The suite that stops `PgAuditAdapter` from shipping untested.
 *
 * Every audit assertion in `apps/api` runs against the in-memory adapter, so a
 * swapped parameter, a misnamed column or a dropped `JSON.stringify` on
 * `metadata` in the Postgres INSERT would be green everywhere and broken in
 * production — in the one table that cannot be corrected afterwards. The Postgres
 * pass connects as `stuwith_api`, so it also proves the INSERT-only GRANT is
 * sufficient for this exact statement.
 */
export function runAuditPortContract(options: AuditPortContractOptions): void {
  const suite = options.skip === true ? describe.skip : describe;
  const t0 = new Date('2026-09-04T09:00:00.000Z');
  const t1 = new Date('2026-09-04T09:00:01.000Z');

  const signedIn = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
    sourceService: 'api',
    action: 'auth.signed_in',
    actorUserId: null,
    subjectId: null,
    requestId: 'req-contract-1',
    occurredAt: t0,
    metadata: { provider: 'google', first_login: true },
    ...overrides,
  });

  suite(`AuditPort contract — ${options.label}`, () => {
    let harness: AuditPortHarness | undefined;

    const use = async (): Promise<AuditPortHarness> => {
      harness ??= await options.createHarness();
      return harness;
    };
    const port = async (): Promise<AuditPort> => (await use()).port;

    beforeEach(async () => {
      harness ??= await options.createHarness();
      await harness.reset();
    }, options.hookTimeoutMs ?? 120_000);

    afterAll(async () => {
      await harness?.teardown?.();
      harness = undefined;
    }, options.hookTimeoutMs ?? 120_000);

    it('appends a row and reads back every field it was given', async () => {
      await (await port()).append(signedIn());

      const rows = await (await use()).rows();
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        sourceService: 'api',
        action: 'auth.signed_in',
        requestId: 'req-contract-1',
      });
      // The exact defect a missing `JSON.stringify` would produce: metadata that
      // reads back as `[object Object]`, or not at all.
      expect(rows[0]?.metadata).toEqual({ provider: 'google', first_login: true });
      expect(rows[0]?.occurredAt.toISOString()).toBe(t0.toISOString());
    });

    it('keeps null actor and subject as null, not as the string "null"', async () => {
      await (await port()).append(signedIn({ action: 'auth.sign_in_failed' }));
      const row = (await (await use()).rows())[0];
      expect(row?.actorUserId).toBeNull();
      expect(row?.subjectId).toBeNull();
    });

    it('stores an empty metadata object rather than refusing it', async () => {
      await (await port()).append(signedIn({ metadata: {} }));
      expect((await (await use()).rows())[0]?.metadata).toEqual({});
    });

    it('preserves all three scalar types through the round trip', async () => {
      // A store that JSON-encodes the object but reads it back as text would turn
      // `first_login: true` into `"true"`, and an incident review would stop being
      // able to filter on it.
      await (await port()).append(
        signedIn({ metadata: { provider: 'apple', attempt: 2, first_login: false } }),
      );
      expect((await (await use()).rows())[0]?.metadata).toEqual({
        provider: 'apple',
        attempt: 2,
        first_login: false,
      });
    });

    it('APPENDS — a second row does not replace the first', async () => {
      const p = await port();
      await p.append(signedIn({ requestId: 'req-one' }));
      await p.append(signedIn({ requestId: 'req-two', occurredAt: t1 }));

      const rows = await (await use()).rows();
      expect(rows.length).toBe(2);
      expect(rows.map((row) => row.requestId).sort()).toEqual(['req-one', 'req-two']);
    });

    it('accepts two rows that are identical in every field', async () => {
      // There is no natural key here and there must not be one: two identical
      // failed attempts a second apart are two facts, not a duplicate.
      const p = await port();
      await p.append(signedIn());
      await p.append(signedIn());
      expect((await (await use()).rows()).length).toBe(2);
    });

    it('accepts every declared action and both source services', async () => {
      const p = await port();
      for (const action of AUDIT_ACTIONS) {
        for (const sourceService of SERVICE_NAMES) {
          await p.append(signedIn({ action, sourceService }));
        }
      }
      expect((await (await use()).rows()).length).toBe(AUDIT_ACTIONS.length * SERVICE_NAMES.length);
    });

    describe('rejects input that cannot be an audit row', () => {
      const bad: ReadonlyArray<readonly [string, AuditEventInput]> = [
        ['an unknown action', signedIn({ action: 'auth.exploded' as AuditEventInput['action'] })],
        [
          'an unknown source service',
          signedIn({ sourceService: 'web' as AuditEventInput['sourceService'] }),
        ],
        ['a blank request id', signedIn({ requestId: '  ' })],
        ['an Invalid Date', signedIn({ occurredAt: new Date('not-a-date') })],
        [
          'a nested object in metadata',
          signedIn({
            metadata: { payload: { token: 'leak' } } as unknown as AuditEventInput['metadata'],
          }),
        ],
      ];

      it.each(bad)('throws AuditInputError for %s', async (_label, event) => {
        await expect((await port()).append(event)).rejects.toBeInstanceOf(AuditInputError);
      });

      it('stores nothing when the input was rejected', async () => {
        await expect((await port()).append(signedIn({ requestId: '' }))).rejects.toThrow();
        expect((await (await use()).rows()).length).toBe(0);
      });
    });

    describe('lets an infrastructure fault propagate', () => {
      it('throws instead of silently dropping the row when the store is unreachable', async () => {
        const create = harness?.createFaultingPort;
        if (create === undefined) {
          throw new Error(
            `harness "${options.label}" must provide createFaultingPort(): an audit trail that ` +
              'swallows a write failure is worse than no audit trail, because it is trusted.',
          );
        }
        const faulting = await create.call(harness);
        const outcome = await faulting.append(signedIn()).then(
          () => ({ kind: 'resolved' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

        expect(outcome.kind).toBe('rejected');
        expect(outcome.kind === 'rejected' && outcome.error).not.toBeInstanceOf(AuditInputError);
      });
    });
  });
}
