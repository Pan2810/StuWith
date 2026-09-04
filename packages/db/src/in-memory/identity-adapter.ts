import type {
  IdentityPort,
  ProviderIdentity,
  RecordDateOfBirthResult,
  ResolvedIdentity,
  User,
} from '@stuwith/domain';
import { identityKey, normalizeProviderUserId } from '@stuwith/domain';
import {
  assertValidDateOfBirth,
  assertValidIdentity,
  assertValidNow,
  assertValidUserId,
} from '../pg/identity-adapter';

/**
 * TD-5 — the second implementation, so the shared contract suite runs twice.
 *
 * It lives in `packages/db` and not in `packages/domain`: an in-memory store is
 * still an adapter, and AD-1 says the domain imports no adapter at all.
 *
 * The validation helpers are imported from the Postgres adapter rather than
 * re-written here. Re-writing them is exactly how two adapters end up disagreeing
 * about what a legal call is, and the disagreement only ever surfaces against the
 * implementation you did NOT develop against.
 */
export class InMemoryIdentityAdapter implements IdentityPort {
  private readonly users = new Map<string, User>();
  private readonly identities = new Map<string, string>();
  private counter = 0;

  async findOrCreateByIdentity(identity: ProviderIdentity, now: Date): Promise<ResolvedIdentity> {
    assertValidIdentity(identity, now);
    const providerUserId = normalizeProviderUserId(identity.providerUserId);
    const key = identityKey(identity.provider, providerUserId);

    const existingUserId = this.identities.get(key);
    if (existingUserId !== undefined) {
      const user = this.users.get(existingUserId);
      if (user === undefined) {
        throw new Error(`identity ${key} points at a user that does not exist`);
      }
      return { user, created: false };
    }

    const user: User = {
      id: this.nextId(),
      displayName: identity.displayName,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
      role: 'user',
      // Not declared yet — the state Story 1.4's screen exists to move out of.
      // A brand-new user must start here in BOTH adapters, or the contract suite's
      // "a new profile is incomplete" example would only ever be true in one.
      dateOfBirth: null,
      createdAt: new Date(now.getTime()),
      updatedAt: new Date(now.getTime()),
    };
    this.users.set(user.id, user);
    this.identities.set(key, user.id);
    return { user, created: true };
  }

  async findUserById(userId: string): Promise<User | null> {
    assertValidUserId(userId);
    return this.users.get(userId) ?? null;
  }

  /**
   * The same write-once contract Postgres gets from
   * `UPDATE ... WHERE date_of_birth IS NULL`, reached a different way.
   *
   * There is no `await` between reading `user.dateOfBirth` and writing the new
   * value, so the read and the write are one indivisible step on the single
   * JavaScript thread and two concurrent callers cannot both see `null`. That is
   * what makes this adapter satisfy the same contract example as Postgres rather
   * than merely appearing to. Inserting an `await` anywhere between those two
   * lines re-opens exactly the race the SQL predicate exists to close.
   *
   * The stored `User` is REPLACED rather than mutated, so a caller still holding
   * the value it got back before the write keeps seeing what it was handed —
   * `User` is declared `readonly` throughout and an adapter that mutated in place
   * would be quietly breaking that promise for everyone sharing the reference.
   */
  async recordDateOfBirth(
    userId: string,
    dateOfBirth: string,
    now: Date,
  ): Promise<RecordDateOfBirthResult> {
    assertValidUserId(userId);
    assertValidDateOfBirth(dateOfBirth);
    assertValidNow(now);

    const user = this.users.get(userId);
    if (user === undefined) {
      return { ok: false, reason: 'UserNotFound' };
    }
    if (user.dateOfBirth !== null) {
      return { ok: false, reason: 'AlreadyRecorded' };
    }

    const updated: User = { ...user, dateOfBirth, updatedAt: new Date(now.getTime()) };
    this.users.set(userId, updated);
    return { ok: true, user: updated };
  }

  /** Test affordance: the suite asserts "no second user was created". */
  countUsers(): number {
    return this.users.size;
  }

  clear(): void {
    this.users.clear();
    this.identities.clear();
    this.counter = 0;
  }

  /**
   * A syntactically valid UUIDv7 so that ids from this adapter are accepted by the
   * same `z.uuid()` contract schemas the Postgres ones are. An adapter that hands
   * back `user-1` passes every test written against itself and fails the moment a
   * response is validated.
   */
  private nextId(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `019200f0-0000-7000-8000-${suffix}`;
  }
}
