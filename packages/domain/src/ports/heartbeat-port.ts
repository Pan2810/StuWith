/**
 * AD-6, shape-only rehearsal.
 *
 * The rule AD-6 actually cares about is that a refusal is a *return branch the
 * caller is forced to handle*, not an optional exception — that is what makes one
 * shared contract suite able to catch "this adapter forgot the condition".
 * `debit()`/`InsufficientFunds` is the real instance of that shape and belongs to
 * Epic 3; `record()`/`StaleObservation` is the same shape applied to an
 * infrastructure-only concern, so Story 1.1 can prove the test-kit works without
 * inventing a money table two stories early.
 *
 * ## Three outcomes, three mechanisms
 *
 * Every adapter must agree on all three, and the shared contract suite checks all
 * three. Collapsing any two of them is how a real outage starts looking like a
 * business decision:
 *
 * | Outcome | Mechanism | Example |
 * | --- | --- | --- |
 * | **Refusal** — the write was validly declined by the rule | returns `{ ok: false }` | the stored observation is newer |
 * | **Invalid input** — the caller has a bug | throws `HeartbeatInputError` | empty key, `Invalid Date` |
 * | **Fault** — the store could not answer | the underlying error propagates | deadlock, connection lost, permission denied |
 *
 * A fault must NEVER be converted into a refusal. If a deadlock (40P01) or a
 * revoked GRANT (42501) came back as `{ ok: false, reason: 'StaleObservation' }`,
 * the caller would treat a broken database as a normal, expected decision and
 * carry on — and in Epic 3 the same collapse would mean a failed `debit()` reads
 * as "insufficient funds" and the session ends instead of erroring.
 */
export interface Heartbeat {
  readonly serviceKey: string;
  readonly observedAt: Date;
}

export type RecordHeartbeatResult =
  | { readonly ok: true; readonly heartbeat: Heartbeat }
  /**
   * Not an error to throw. An adapter that lost the race, or was handed an
   * observation older than the stored one, returns this and the caller must deal
   * with it. Every adapter is checked for it by the shared contract suite.
   */
  | { readonly ok: false; readonly reason: 'StaleObservation' };

/**
 * A caller passed something that cannot be a heartbeat. This is a defect in the
 * calling code, not an outcome of the domain rule, so it throws rather than
 * occupying a branch every correct caller would have to handle.
 *
 * It lives in the domain because both adapters have to raise the *same* error for
 * the *same* input. Left to each adapter, Postgres would raise a driver error and
 * the in-memory adapter would cheerfully store `Invalid Date`, and the two would
 * only be discovered to disagree in production.
 */
export class HeartbeatInputError extends Error {
  override readonly name = 'HeartbeatInputError';

  constructor(message: string) {
    super(message);
  }
}

/** Matches the `text` column; long enough for any service name we will have. */
export const MAX_SERVICE_KEY_LENGTH = 64;

export function assertValidServiceKey(serviceKey: unknown): asserts serviceKey is string {
  if (typeof serviceKey !== 'string' || serviceKey.trim().length === 0) {
    throw new HeartbeatInputError('serviceKey must be a non-empty string');
  }
  if (serviceKey.length > MAX_SERVICE_KEY_LENGTH) {
    throw new HeartbeatInputError(
      `serviceKey must be at most ${MAX_SERVICE_KEY_LENGTH} characters`,
    );
  }
}

export function assertValidObservedAt(observedAt: unknown): asserts observedAt is Date {
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    throw new HeartbeatInputError('observedAt must be a valid Date');
  }
}

export function assertValidHeartbeatInput(
  serviceKey: unknown,
  observedAt: unknown,
): asserts serviceKey is string {
  assertValidServiceKey(serviceKey);
  assertValidObservedAt(observedAt);
}

export interface HeartbeatPort {
  /**
   * Must be a single conditional write — never read-then-write. The Postgres
   * adapter expresses it as `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, mirroring
   * the shape AD-6 mandates for `debit()`.
   *
   * @throws {HeartbeatInputError} when the arguments cannot describe a heartbeat.
   */
  record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult>;

  /** @throws {HeartbeatInputError} when `serviceKey` is not a usable key. */
  latest(serviceKey: string): Promise<Heartbeat | null>;
}
