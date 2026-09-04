import type { IdentityPort, ProviderIdentity, ResolvedIdentity, User } from '@stuwith/domain';
import { identityKey, normalizeProviderUserId } from '@stuwith/domain';
import { assertValidIdentity, assertValidUserId } from '../pg/identity-adapter';

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
