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

export interface HeartbeatPort {
  /**
   * Must be a single conditional write — never read-then-write. The Postgres
   * adapter expresses it as `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, mirroring
   * the shape AD-6 mandates for `debit()`.
   */
  record(serviceKey: string, observedAt: Date): Promise<RecordHeartbeatResult>;
  latest(serviceKey: string): Promise<Heartbeat | null>;
}
