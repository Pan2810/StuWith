import { AUDIT_ACTIONS, SERVICE_NAMES } from '@stuwith/contracts';
import {
  AuditInputError,
  HeartbeatInputError,
  IdentityInputError,
  RateLimitInputError,
  SessionInputError,
  type AuditEventInput,
  type AuditPort,
  type HeartbeatPort,
  type IdentityPort,
  type ProviderIdentity,
  type RateLimitDecision,
  type RateLimitPort,
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

    /* --------------------------------------------------------------------- *
     * Story 1.4 — the date of birth is written exactly once
     * --------------------------------------------------------------------- */

    describe('records a date of birth exactly once', () => {
      /**
       * Runs against BOTH adapters, and that is the whole value of it. The
       * in-memory store cannot express a concurrent UPDATE, so a read-then-write
       * implementation looks perfect there; Postgres is where the race is real.
       * Conversely, a Postgres-only suite would let the in-memory adapter drift
       * into accepting a second write, and every `apps/api` test runs against
       * that one.
       */
      const createdUserId = async (): Promise<string> => {
        const created = await (await port()).findOrCreateByIdentity(googleIdentity(), t0);
        return created.user.id;
      };

      it('starts a brand-new profile with no date of birth', async () => {
        // The Story 1.2 half of the contract: first login must not require, invent
        // or default one. `null` is what makes the profile "not finished yet", and
        // it is the only representation of that state.
        const created = await (await port()).findOrCreateByIdentity(googleIdentity(), t0);
        expect(created.user.dateOfBirth).toBeNull();
      });

      it('writes it on a profile that has none, and reports the updated user', async () => {
        const p = await port();
        const userId = await createdUserId();

        const outcome = await p.recordDateOfBirth(userId, '1999-04-02', t1);

        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.user.dateOfBirth).toBe('1999-04-02');
        // And it is durable, not just returned: reading the row back is what
        // catches an adapter that answered from the argument it was handed.
        expect((await p.findUserById(userId))?.dateOfBirth).toBe('1999-04-02');
      });

      /**
       * The read path nothing covered: a SECOND login.
       *
       * Every other example here reaches a user through the INSERT branch of
       * `findOrCreateByIdentity` or through `findUserById`, and neither of those
       * builds the join. The second login goes through `findByIdentity`, which is
       * the one query that qualifies the select list with a table alias — and the
       * date of birth is the one column in that list that is not a bare column
       * name but a `to_char(...) AS date_of_birth`.
       *
       * Losing that alias is a one-word edit: Postgres then names the output column
       * `to_char`, `row.date_of_birth` is `undefined`, and nothing typechecks
       * differently because the row object comes from a driver. The user handed
       * back from every subsequent login would carry no date of birth, `/me` would
       * report the profile as incomplete for ever — or, with the fail-OPEN
       * `isProfileComplete` this story shipped with, as COMPLETE for ever, which is
       * worse: the endpoint then refuses the one write the person is allowed.
       */
      it('keeps the date of birth on the user a SECOND login returns', async () => {
        const p = await port();
        const first = await p.findOrCreateByIdentity(googleIdentity(), t0);
        await p.recordDateOfBirth(first.user.id, '1999-04-02', t1);

        const again = await p.findOrCreateByIdentity(googleIdentity(), t1);

        expect(again.created).toBe(false);
        expect(again.user.id).toBe(first.user.id);
        expect(again.user.dateOfBirth).toBe('1999-04-02');
      });

      it('reports a brand-new profile through the same path as null, not undefined', async () => {
        // The other half: an absent value has to be `null` on every read path, so
        // "not declared yet" is one value rather than two that behave differently.
        const p = await port();
        await p.findOrCreateByIdentity(googleIdentity(), t0);

        const again = await p.findOrCreateByIdentity(googleIdentity(), t1);

        expect(again.user.dateOfBirth).toBeNull();
      });

      it('reads back exactly the day that was written, with no time zone shift', async () => {
        // The `pg` driver parses a `date` column into a Date at LOCAL midnight, so
        // an adapter that let a Date through would return the previous day for
        // anybody east of UTC. The 1st of January is the spelling where a one-day
        // shift also changes the year, which is what makes it worth choosing.
        const p = await port();
        const userId = await createdUserId();

        await p.recordDateOfBirth(userId, '2000-01-01', t1);

        expect((await p.findUserById(userId))?.dateOfBirth).toBe('2000-01-01');
      });

      it('refuses a second write and leaves the first value untouched', async () => {
        const p = await port();
        const userId = await createdUserId();
        await p.recordDateOfBirth(userId, '1999-04-02', t1);

        const second = await p.recordDateOfBirth(userId, '1970-01-01', t1);

        expect(second.ok).toBe(false);
        expect(!second.ok && second.reason).toBe('AlreadyRecorded');
        // The refusal is worthless if the value moved anyway.
        expect((await p.findUserById(userId))?.dateOfBirth).toBe('1999-04-02');
      });

      it('lets exactly ONE of two concurrent writes win', async () => {
        // The row this design exists for, and the one a read-then-write adapter
        // fails. Both callers see an empty profile at the same moment; only the
        // conditional write can decide between them, and in production the failure
        // is silent — two "saved" answers and whichever value landed last.
        const p = await port();
        const userId = await createdUserId();

        const outcomes = await Promise.all([
          p.recordDateOfBirth(userId, '1999-04-02', t1),
          p.recordDateOfBirth(userId, '1970-01-01', t1),
        ]);

        const winners = outcomes.filter((outcome) => outcome.ok);
        expect(winners.length, 'exactly one write may succeed').toBe(1);
        for (const loser of outcomes.filter((outcome) => !outcome.ok)) {
          expect(!loser.ok && loser.reason).toBe('AlreadyRecorded');
        }

        // And the stored value is the winner's, not a blend and not the loser's.
        const stored = (await p.findUserById(userId))?.dateOfBirth;
        const winner = winners[0];
        expect(stored).toBe(winner?.ok === true ? winner.user.dateOfBirth : undefined);
        expect(['1999-04-02', '1970-01-01']).toContain(stored);
      });

      it('survives a burst of concurrent writes with one winner, not one per connection', async () => {
        // Two requests can be a coincidence of scheduling. Five is the shape a
        // double-tapped submit on a flaky connection actually takes, and against a
        // real pool each one runs on its own connection.
        const p = await port();
        const userId = await createdUserId();

        const outcomes = await Promise.all(
          ['2001-01-01', '2002-02-02', '2003-03-03', '2004-04-04', '2005-05-05'].map((day) =>
            p.recordDateOfBirth(userId, day, t1),
          ),
        );

        expect(outcomes.filter((outcome) => outcome.ok).length).toBe(1);
      });

      it('refuses for a user nobody owns, and says so distinctly', async () => {
        // Distinct from `AlreadyRecorded` because the two need different answers
        // at the boundary: one is "your profile is already complete", the other is
        // "your session points at a profile that is gone".
        const outcome = await (await port()).recordDateOfBirth(
          '019200ff-0000-7000-8000-00000000ffff',
          '1999-04-02',
          t1,
        );

        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.reason).toBe('UserNotFound');
      });

      it('does not create a user as a side effect of a refused write', async () => {
        await (await port()).recordDateOfBirth(
          '019200ff-0000-7000-8000-00000000ffff',
          '1999-04-02',
          t1,
        );
        expect(await (await use()).countUsers()).toBe(0);
      });

      describe('rejects input that cannot be a date of birth', () => {
        const badDates: ReadonlyArray<readonly [string, unknown]> = [
          ['a day that does not exist', '2026-02-30'],
          ['a 29th of February in a non-leap year', '2025-02-29'],
          ['unpadded parts', '1999-4-2'],
          ['an ISO instant', '1999-04-02T00:00:00.000Z'],
          ['a trailing time zone', '1999-04-02Z'],
          ['surrounding whitespace', ' 1999-04-02 '],
          ['an empty string', ''],
          ['a Date object', new Date('1999-04-02T00:00:00.000Z')],
          ['a number', 19_990_402],
          ['null', null],
        ];

        it.each(badDates)('throws IdentityInputError for %s', async (_label, value) => {
          const p = await port();
          const userId = await createdUserId();

          await expect(
            p.recordDateOfBirth(userId, value as string, t1),
          ).rejects.toBeInstanceOf(IdentityInputError);
        });

        it('stores nothing when the date was rejected', async () => {
          const p = await port();
          const userId = await createdUserId();

          await expect(p.recordDateOfBirth(userId, '2026-02-30', t1)).rejects.toThrow();

          expect((await p.findUserById(userId))?.dateOfBirth).toBeNull();
        });

        it('throws for an empty user id', async () => {
          await expect(
            (await port()).recordDateOfBirth('', '1999-04-02', t1),
          ).rejects.toBeInstanceOf(IdentityInputError);
        });

        it('throws for an Invalid Date as `now`', async () => {
          const p = await port();
          const userId = await createdUserId();

          await expect(
            p.recordDateOfBirth(userId, '1999-04-02', new Date('not-a-date')),
          ).rejects.toBeInstanceOf(IdentityInputError);
        });
      });

      it('lets an infrastructure fault propagate instead of reporting a refusal', async () => {
        // An adapter that turned an outage into `AlreadyRecorded` would tell
        // somebody their profile is finished when nothing was written — and there
        // is no second chance, because the endpoint refuses a second attempt.
        const create = harness?.createFaultingPort;
        if (create === undefined) {
          throw new Error(
            `harness "${options.label}" must provide createFaultingPort(): an adapter that ` +
              'turns an outage into "already recorded" would lock somebody out of the one ' +
              'write they are allowed.',
          );
        }
        const faulting = await create.call(harness);
        const outcome = await faulting
          .recordDateOfBirth('019200ff-0000-7000-8000-00000000ffff', '1999-04-02', t1)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          );

        expect(outcome.kind).toBe('rejected');
        expect(outcome.kind === 'rejected' && outcome.error).not.toBeInstanceOf(IdentityInputError);
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

/* ------------------------------------------------------------------------- *
 * RateLimitPort — Story 1.3 part 2
 * ------------------------------------------------------------------------- */

export interface RateLimitPortHarness {
  readonly port: RateLimitPort;
  /** Return the adapter to an empty state between examples. */
  reset(): Promise<void>;
  /**
   * Move time forward.
   *
   * A fake clock jumps; a real Valkey has to actually wait. Half of this port's
   * behaviour is about time — a countdown that really decreases, a window that
   * really expires, a lock that outlives an ordinary one — and none of it can be
   * asserted without saying "later" in a way both stores understand.
   */
  advance(milliseconds: number): Promise<void>;
  teardown?(): Promise<void>;
  /**
   * An INDEPENDENT port whose store is unreachable. Used to prove a fault
   * propagates rather than being laundered into an allowance — the failure mode
   * that switches the whole blocking layer off while every gate stays green.
   */
  createFaultingPort?(): Promise<RateLimitPort>;
  /**
   * Put a live key with NO expiry under this name, however the store spells that.
   *
   * Nothing the port does can produce one — both writes set an expiry — so the
   * repair branch that heals it had no coverage on either pass until the harness
   * could plant one.
   */
  plantKeyWithoutExpiry?(key: string): Promise<void>;
}

export interface RateLimitPortContractOptions {
  readonly label: string;
  readonly createHarness: () => Promise<RateLimitPortHarness>;
  readonly skip?: boolean;
  readonly hookTimeoutMs?: number;
}

/**
 * The suite both rate-limit adapters have to satisfy.
 *
 * Windows here are seconds rather than minutes because the Valkey pass pays for
 * every one of them in real elapsed time. They are still long enough for the
 * assertions to be about behaviour rather than about timer resolution.
 */
export function runRateLimitPortContract(options: RateLimitPortContractOptions): void {
  const suite = options.skip === true ? describe.skip : describe;
  /**
   * Applied to the EXAMPLES, not only to the hooks.
   *
   * `hookTimeoutMs` reached `beforeEach` and `afterAll` and nothing else, while
   * several examples below sleep 3.2-3.3 seconds against Vitest's 5-second default
   * for an `it`. On the Valkey pass that is a real wait on a real clock, so a
   * loaded CI runner was one slow container start away from a flake that looked
   * like a product bug.
   */
  const exampleTimeoutMs = options.hookTimeoutMs ?? 30_000;

  /** Three, not two: a decrease has to be VISIBLE in whole seconds. */
  const WINDOW_SECONDS = 3;
  const LIMIT = 3;
  /** Strictly longer than the window — that difference is a matrix row. */
  const LOCK_SECONDS = 6;

  suite(`RateLimitPort contract — ${options.label}`, () => {
    let harness: RateLimitPortHarness | undefined;

    const use = async (): Promise<RateLimitPortHarness> => {
      harness ??= await options.createHarness();
      return harness;
    };

    const port = async (): Promise<RateLimitPort> => (await use()).port;

    beforeEach(async () => {
      const active = await use();
      await active.reset();
    }, options.hookTimeoutMs ?? 120_000);

    afterAll(async () => {
      await harness?.teardown?.();
      harness = undefined;
    }, options.hookTimeoutMs ?? 120_000);

    /** Hit `key` until it is refused, and return that refusal. */
    const exhaust = async (key: string): Promise<RateLimitDecision> => {
      const p = await port();
      let last: RateLimitDecision = await p.hit(key, LIMIT, WINDOW_SECONDS);
      for (let attempt = 0; attempt < LIMIT + 2 && last.ok; attempt += 1) {
        last = await p.hit(key, LIMIT, WINDOW_SECONDS);
      }
      return last;
    };

    describe('counting inside one window', () => {
      it('allows exactly the configured number of attempts', async () => {
        const p = await port();
        for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
          const decision = await p.hit('c:allow', LIMIT, WINDOW_SECONDS);
          expect(decision.ok, `attempt ${attempt} of ${LIMIT} must be allowed`).toBe(true);
          expect(decision.ok && decision.count).toBe(attempt);
          expect(decision.ok && decision.remaining).toBe(LIMIT - attempt);
        }
      }, exampleTimeoutMs);

      it('REFUSES the attempt after the limit, by returning rather than throwing', async () => {
        const refusal = await exhaust('c:refuse');

        expect(refusal.ok).toBe(false);
        expect(refusal.ok === false && refusal.reason).toBe('RateLimited');
      }, exampleTimeoutMs);

      it('keeps refusing while the window is still open', async () => {
        await exhaust('c:keep');
        const again = await (await port()).hit('c:keep', LIMIT, WINDOW_SECONDS);

        expect(again.ok).toBe(false);
      }, exampleTimeoutMs);

      /**
       * The property the port docblock states as its whole reason for existing —
       * "two workers that both read 9 and both write 10 let twice the limit
       * through" — and which every example above missed, because they all call
       * `hit` one after another. A read-then-write adapter passes sequential
       * calls perfectly.
       *
       * `Promise.all` is not a thread, but it is enough: an implementation that
       * awaited a read before writing would interleave here and over-allow. On the
       * Valkey pass it is genuinely concurrent on the wire.
       */
      it('allows exactly the limit when the attempts arrive AT ONCE', async () => {
        const p = await port();
        const attempts = LIMIT + 5;

        const decisions = await Promise.all(
          Array.from({ length: attempts }, () => p.hit('c:race', LIMIT, WINDOW_SECONDS)),
        );

        expect(decisions.filter((decision) => decision.ok)).toHaveLength(LIMIT);
        expect(decisions.filter((decision) => !decision.ok)).toHaveLength(attempts - LIMIT);
      }, exampleTimeoutMs);

      it('gives each concurrent winner a distinct count, so none was lost', async () => {
        const p = await port();

        const decisions = await Promise.all(
          Array.from({ length: LIMIT }, () => p.hit('c:race-counts', LIMIT, WINDOW_SECONDS)),
        );

        // 1..LIMIT exactly once each. Two workers reading the same value would
        // produce a duplicate here even when the totals happened to add up.
        const counts = decisions.flatMap((decision) => (decision.ok ? [decision.count] : []));
        expect([...counts].sort((a, b) => a - b)).toEqual(
          Array.from({ length: LIMIT }, (_unused, index) => index + 1),
        );
      }, exampleTimeoutMs);

      it('counts each key on its own — one caller does not spend another budget', async () => {
        await exhaust('c:one');
        const other = await (await port()).hit('c:two', LIMIT, WINDOW_SECONDS);

        expect(other.ok).toBe(true);
      }, exampleTimeoutMs);
    });

    describe('Matrix row: the countdown is real', () => {
      it('answers with seconds that fit inside the window', async () => {
        const refusal = await exhaust('c:ttl');

        expect(refusal.ok).toBe(false);
        if (refusal.ok) return;
        expect(refusal.retryAfterSeconds).toBeGreaterThan(0);
        expect(refusal.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
      }, exampleTimeoutMs);

      it('DECREASES as time passes, instead of repeating a constant', async () => {
        const first = await exhaust('c:count-down');
        expect(first.ok).toBe(false);
        if (first.ok) return;

        await (await use()).advance(1_100);

        const later = await (await port()).hit('c:count-down', LIMIT, WINDOW_SECONDS);
        expect(later.ok).toBe(false);
        if (later.ok) return;

        // The whole acceptance criterion in one assertion: a configured constant
        // would come back identical, and somebody who waited exactly as long as
        // they were told would be refused again with the same number.
        expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds);
      }, exampleTimeoutMs);

      /**
       * The property the suite exists for, and which nothing here could see.
       *
       * "One atomic EVAL" is claimed by the adapter's docblock, by
       * `rate-limit-contract.valkey.test.ts` and by AGENTS.md — and rewriting
       * `hit` as `INCR` followed by an awaited `PEXPIRE` passed every example,
       * because no example looked at the expiry the FIRST hit left behind. That is
       * exactly the split that leaves a counter with no TTL when a process dies
       * between the two commands: a key that never resets, so the person it
       * belongs to is locked out permanently.
       */
      it('leaves an expiry on the key the very first hit created', async () => {
        const p = await port();

        const first = await p.hit('c:atomic', LIMIT, WINDOW_SECONDS);
        expect(first.ok).toBe(true);

        const remaining = await p.remainingSeconds('c:atomic');
        expect(remaining, 'the first hit must set the window, not a later one').not.toBeNull();
        expect(remaining ?? 0).toBeGreaterThan(0);
        expect(remaining ?? 0).toBeLessThanOrEqual(WINDOW_SECONDS);
      }, exampleTimeoutMs);

      /**
       * The repair branch, which was unreachable from either pass.
       *
       * A key alive with no expiry is the permanent-lockout state the atomic script
       * exists to prevent, and both `hit` and `remainingSeconds` claim to heal it.
       * The harness plants one directly, because nothing this port does can produce
       * it — which is why the branch had no coverage at all.
       */
      it('repairs a key that is alive with no expiry, on all THREE paths', async () => {
        const active = await use();
        const plant = active.plantKeyWithoutExpiry;
        if (plant === undefined) {
          throw new Error(
            `harness "${options.label}" must provide plantKeyWithoutExpiry(): the repair branch ` +
              'is the difference between a self-healing counter and a permanent lockout.',
          );
        }

        /**
         * The repair value is CHECKED, not just its existence.
         *
         * `remainingSeconds` took a `repairSeconds` argument that only its own
         * default could supply — it was on neither the port nor any call site — so
         * the branch healed to a constant nothing could observe and this example
         * could only say "not null". Healing to fifteen minutes and healing to a
         * century were the same assertion.
         */
        const REPAIR_SECONDS = 42;

        await plant.call(active, 'c:no-expiry');
        // Reading it heals it: this is the path a LOCK is read through, where a key
        // with no expiry is a lockout with nothing to release it.
        const healed = await active.port.remainingSeconds('c:no-expiry', REPAIR_SECONDS);
        expect(healed).not.toBeNull();
        expect(healed ?? 0).toBeGreaterThan(0);
        expect(healed ?? 0).toBeLessThanOrEqual(REPAIR_SECONDS);

        await plant.call(active, 'c:no-expiry-hit');
        await active.port.hit('c:no-expiry-hit', LIMIT, WINDOW_SECONDS);
        const afterHit = await active.port.remainingSeconds('c:no-expiry-hit');
        expect(afterHit).not.toBeNull();
        // `hit` heals to the WINDOW, which is the only lifetime it knows about.
        expect(afterHit ?? 0).toBeLessThanOrEqual(WINDOW_SECONDS);

        /**
         * `lock` was the path with no coverage at all, and the in-memory adapter
         * did not repair there while the Lua script did — so the two stores
         * disagreed on exactly the key whose missing expiry is a permanent
         * lockout. `SET … NX` is a no-op against an existing key, so without the
         * repair nothing would ever give that key an expiry.
         */
        await plant.call(active, 'c:no-expiry-lock');
        const relocked = await active.port.lock('c:no-expiry-lock', LOCK_SECONDS);
        expect(relocked).toBeGreaterThan(0);
        expect(relocked).toBeLessThanOrEqual(LOCK_SECONDS);
        const afterLock = await active.port.remainingSeconds('c:no-expiry-lock');
        expect(afterLock).not.toBeNull();
        expect(afterLock ?? 0).toBeLessThanOrEqual(LOCK_SECONDS);
      }, exampleTimeoutMs);

      it('does not push the window out when a refused attempt arrives', async () => {
        // A window renewed on every hit can never expire for somebody who keeps
        // hammering, and the countdown then never reaches zero.
        const first = await exhaust('c:no-extend');
        expect(first.ok).toBe(false);
        if (first.ok) return;

        await (await use()).advance(1_100);
        await (await port()).hit('c:no-extend', LIMIT, WINDOW_SECONDS);
        await (await use()).advance(2_100);

        const afterWindow = await (await port()).hit('c:no-extend', LIMIT, WINDOW_SECONDS);
        expect(afterWindow.ok).toBe(true);
      }, exampleTimeoutMs);
    });

    describe('Matrix row: waiting out the window', () => {
      it('allows again once the window has passed, counting from one', async () => {
        await exhaust('c:expire');
        await (await use()).advance(WINDOW_SECONDS * 1_000 + 300);

        const after = await (await port()).hit('c:expire', LIMIT, WINDOW_SECONDS);
        expect(after.ok).toBe(true);
        expect(after.ok && after.count).toBe(1);
      }, exampleTimeoutMs);
    });

    describe('Matrix row: a success clears the failure counter', () => {
      it('forgets a key entirely, so the next attempt starts from one', async () => {
        await exhaust('c:clear');
        await (await port()).clear('c:clear');

        const after = await (await port()).hit('c:clear', LIMIT, WINDOW_SECONDS);
        expect(after.ok).toBe(true);
        expect(after.ok && after.count).toBe(1);
      }, exampleTimeoutMs);

      it('clearing a key nobody ever touched is not an error', async () => {
        await expect((await port()).clear('c:never-existed')).resolves.toBeUndefined();
      }, exampleTimeoutMs);
    });

    describe('Matrix row: the brute-force lock', () => {
      it('reports nothing to wait for before a lock exists', async () => {
        expect(await (await port()).remainingSeconds('c:lock-a')).toBeNull();
      }, exampleTimeoutMs);

      it('reports a real remaining time once locked, without counting an attempt', async () => {
        const locked = await (await port()).lock('c:lock-b', LOCK_SECONDS);
        expect(locked).toBeGreaterThan(0);
        expect(locked).toBeLessThanOrEqual(LOCK_SECONDS);

        const first = await (await port()).remainingSeconds('c:lock-b');
        const second = await (await port()).remainingSeconds('c:lock-b');
        expect(first).not.toBeNull();
        // Reading the lock must not extend it: a client polling the countdown
        // would otherwise keep itself locked out for ever.
        expect(second ?? 0).toBeLessThanOrEqual(first ?? 0);
      }, exampleTimeoutMs);

      it('outlives an ordinary window — that is what makes it the LONGER lock', async () => {
        await (await port()).lock('c:lock-long', LOCK_SECONDS);
        await (await use()).advance(WINDOW_SECONDS * 1_000 + 300);

        expect(await (await port()).remainingSeconds('c:lock-long')).not.toBeNull();
      }, exampleTimeoutMs);

      it('does not restart when it is locked again', async () => {
        const first = await (await port()).lock('c:lock-again', LOCK_SECONDS);
        await (await use()).advance(1_100);
        const second = await (await port()).lock('c:lock-again', LOCK_SECONDS);

        // Re-locking on every later failure would make the number the person is
        // watching jump back up, and a lock that cannot run out is a ban.
        expect(second).toBeLessThan(first);
      }, exampleTimeoutMs);

      it('runs out on its own', async () => {
        await (await port()).lock('c:lock-expire', 2);
        await (await use()).advance(2_300);

        expect(await (await port()).remainingSeconds('c:lock-expire')).toBeNull();
      }, exampleTimeoutMs);

      /**
       * The place the two adapters could most easily disagree, and the reason this
       * example exists at all.
       *
       * Production never puts a counter and a lock on the same key — that is what
       * `bruteForceCounterKey` and `bruteForceLockKey` are for — so a divergence
       * here would be invisible until some later feature reused a key. Valkey has
       * ONE keyspace: a lock is a string with an expiry, `INCR` against it returns
       * 2, and `SET … NX` against a counter is a no-op that leaves the counter's
       * TTL alone. An in-memory adapter that modelled the two as separate stores
       * would pass every other example here and be wrong about both calls.
       */
      it('agrees with the real store when a counter and a lock share one key', async () => {
        const p = await port();

        const first = await p.lock('c:shared', LOCK_SECONDS);
        expect(first).toBeGreaterThan(0);

        // `SET NX` against an existing key does nothing but report its TTL.
        const relocked = await p.lock('c:shared', LOCK_SECONDS * 10);
        expect(relocked).toBeLessThanOrEqual(LOCK_SECONDS);

        // `INCR` against a lock value counts from the value that is there.
        const counted = await p.hit('c:shared', LIMIT, WINDOW_SECONDS);
        expect(counted.ok && counted.count).toBe(2);

        // And the lock's own, longer expiry survives the increment rather than
        // being replaced by the counter's window.
        const remaining = await p.remainingSeconds('c:shared');
        expect(remaining).not.toBeNull();
        expect(remaining ?? 0).toBeGreaterThan(WINDOW_SECONDS);
      }, exampleTimeoutMs);

      it('is NOT released by clearing a counter — the two are different keys', async () => {
        await (await port()).lock('c:lock-keep', LOCK_SECONDS);
        await (await port()).clear('c:counter-keep');

        // The two matrix rows that look contradictory: a success clears the
        // failure counter, and a lock already earned still runs its course.
        expect(await (await port()).remainingSeconds('c:lock-keep')).not.toBeNull();
      }, exampleTimeoutMs);
    });

    describe('a caller bug is a throw, not an outcome', () => {
      it.each([
        ['an empty key', '', LIMIT, WINDOW_SECONDS],
        ['a key with whitespace', 'has space', LIMIT, WINDOW_SECONDS],
        ['a key that is far too long', 'k'.repeat(300), LIMIT, WINDOW_SECONDS],
        ['a limit of zero', 'c:bad', 0, WINDOW_SECONDS],
        ['a fractional limit', 'c:bad', 1.5, WINDOW_SECONDS],
        ['a window of zero', 'c:bad', LIMIT, 0],
      ] as const)('rejects %s with RateLimitInputError', async (_label, key, limit, window) => {
        await expect((await port()).hit(key, limit, window)).rejects.toBeInstanceOf(
          RateLimitInputError,
        );
      }, exampleTimeoutMs);

      it('rejects a bad key on every read path too', async () => {
        const p = await port();
        await expect(p.remainingSeconds('')).rejects.toBeInstanceOf(RateLimitInputError);
        await expect(p.clear('')).rejects.toBeInstanceOf(RateLimitInputError);
        await expect(p.lock('', LOCK_SECONDS)).rejects.toBeInstanceOf(RateLimitInputError);
      }, exampleTimeoutMs);
    });

    describe('an outage is a fault, and never an allowance', () => {
      const faultingPort = async (): Promise<RateLimitPort> => {
        const active = await use();
        const create = active.createFaultingPort;
        if (create === undefined) {
          throw new Error(
            `harness "${options.label}" must provide createFaultingPort(): an adapter that ` +
              'answers "allowed" when its store is down has switched the blocking layer off ' +
              'silently, and no test anywhere would notice.',
          );
        }
        return create.call(active);
      };

      it('lets the store error propagate out of hit()', async () => {
        const faulting = await faultingPort();
        const outcome = await faulting.hit('c:fault', LIMIT, WINDOW_SECONDS).then(
          (decision) => ({ kind: 'resolved' as const, decision }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

        // Neither `{ ok: true }` (the layer is off and nobody knows) nor
        // `{ ok: false }` (an outage presented to a user as their own fault).
        // The decision about what to do belongs to apps/api, which can log it.
        expect(outcome.kind).toBe('rejected');
        expect(outcome.kind === 'rejected' && outcome.error).not.toBeInstanceOf(
          RateLimitInputError,
        );
      }, exampleTimeoutMs);

      it('lets the store error propagate out of the read and write paths', async () => {
        const faulting = await faultingPort();

        await expect(faulting.remainingSeconds('c:fault')).rejects.toBeTruthy();
        await expect(faulting.lock('c:fault', LOCK_SECONDS)).rejects.toBeTruthy();
        await expect(faulting.clear('c:fault')).rejects.toBeTruthy();
      }, exampleTimeoutMs);
    });
  });
}
