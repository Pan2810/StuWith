/**
 * AD-22 — "a read-only check is a hint, not a gate."
 *
 * The capacity of a room is enforced by RESERVING a seat in the same atomic step
 * as counting the seats, never by counting first and writing second. This port is
 * that step. The `pg` transaction and the `FOR UPDATE` that make it atomic live in
 * `packages/db`; this file names no library at all.
 *
 * ## What a reservation is, and what it is not
 *
 * A reservation is "this person may enter this room, until this instant". It is
 * written by `apps/api` when a token is issued, for exactly as long as the token
 * lives, and it is what the token's `exp` is derived from. It is NOT presence:
 * `room_participants` (Story 2.4) is what the gateway writes from LiveKit's own
 * signals, and it lags by seconds — which is precisely why the cap cannot be
 * counted from it. Nothing here says whether the person ever connected.
 *
 * ## Four outcomes, one method
 *
 * | Outcome     | Meaning                                           | Written |
 * | ----------- | ------------------------------------------------- | ------- |
 * | `reserved`  | a seat is held (new, or the caller's own renewed) | yes     |
 * | `full`      | every seat under the cap is live                  | no      |
 * | `closed`    | the room is `closing` or `closed`                 | no      |
 * | `no_room`   | no room has this id                               | no      |
 *
 * Every refusal is a RETURN branch the caller must narrow past to reach the
 * reservation, the shape `HeartbeatPort` establishes and the money ports will keep.
 * A fault — the pool is gone, the transaction deadlocked, the GRANT was revoked —
 * is thrown and must propagate: laundering it into `full` would tell a person the
 * room is busy when the truth is that we are broken.
 *
 * ## Asking twice is renewing, not doubling
 *
 * The same person asking for the same room while their seat is live gets that seat
 * extended and a fresh token, not a second seat. The pre-join screen (Story 2.3)
 * calls the endpoint again every time somebody changes their mind about a camera,
 * and a "Vào phòng" button pressed twice must not eat two of six places. The
 * adapter decides this INSIDE the same lock as the count, so "is this a renewal"
 * and "is there room" are one question with one answer.
 *
 * ## Expired seats are removed by the reserving process, in the same step
 *
 * `apps/api` owns the table, including its housekeeping (AD-8, AD-22): a lapsed row
 * is deleted inside the reservation transaction, so the count that decides `full`
 * never includes a seat nobody can use. No scheduler, no second role, no reading
 * of `expires_at` by anybody else.
 */

export interface RoomReservation {
  readonly id: string;
  readonly roomId: string;
  readonly userId: string;
  readonly reservedAt: Date;
  /** The instant the seat — and the token issued against it — lapses. */
  readonly expiresAt: Date;
}

export interface ReserveSeatInput {
  readonly roomId: string;
  readonly userId: string;
  /**
   * How long the seat is held from `now`, in whole seconds. `apps/api` passes
   * `ROOM_TOKEN_TTL_SECONDS`; the adapter computes `expiresAt` from it so the
   * row's instant and the token's `exp` are one arithmetic, done once.
   */
  readonly holdForSeconds: number;
}

export type ReserveSeatResult =
  | {
      readonly kind: 'reserved';
      readonly reservation: RoomReservation;
      /**
       * `true` when the caller already held a live seat in this room and it was
       * extended rather than a new one taken. Reported so the CONTRACT SUITE can
       * tell the two apart; nothing on the wire carries it — not the response
       * body, and deliberately not the audit row either (`apps/api/src/rooms/
       * audit.ts`: two rows with one `reservation_id` are how a renewal reads).
       */
      readonly renewed: boolean;
    }
  | { readonly kind: 'full' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'no_room' };

/**
 * A caller handed something that cannot describe a reservation. A defect in the
 * calling code, not an outcome of a rule, so it throws — and it lives here so both
 * adapters raise the same error for the same input.
 */
export class RoomReservationInputError extends Error {
  override readonly name = 'RoomReservationInputError';

  constructor(message: string) {
    super(message);
  }
}

export interface RoomReservationPort {
  /**
   * Reserve — or renew — one seat for `userId` in `roomId`, as of `now`.
   *
   * The implementation MUST decide `full` inside the same atomic step that writes
   * the row, with the room's own row locked for the duration: 130 people asking
   * at once for a room of 100 get exactly 100 `reserved` and 30 `full`, and at no
   * instant do more than 100 live rows exist. A count followed by an insert, in
   * two statements without a lock, satisfies every type here and admits 130.
   *
   * `now` is the request's single instant (the one the session was resolved at),
   * never a clock read here. Expiry is judged against it too: a seat is live while
   * `now < expiresAt`.
   *
   * @throws {RoomReservationInputError} when the input cannot describe a seat.
   */
  reserveSeat(input: ReserveSeatInput, now: Date): Promise<ReserveSeatResult>;
}
