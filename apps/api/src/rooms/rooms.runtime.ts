import type { AuditPort, RoomPort, RoomReservationPort } from '@stuwith/domain';

/**
 * Everything `RoomsService` needs, and nothing else.
 *
 * A narrow structural type rather than `AuthRuntime`, for the reason
 * `SessionAuthenticatorRuntime` gives about itself: a module handed the whole
 * runtime can quietly grow a reason to touch the provider registry or the
 * rate-limit store, and nothing would say so at review time. `AuthRuntime`
 * satisfies this, so there is still ONE `pg` pool for the process — see the `rooms`
 * field's docblock there for why a second runtime object would be worse.
 *
 * ## Three ports now, and each addition is a story
 *
 * - `rooms` — Story 2.1, creating and reading a room.
 * - `reservations` — Story 2.2, the atomic seat. It is a separate port from
 *   `rooms` rather than a method on `RoomPort` because it is a separate TABLE with
 *   a separate lifetime (the writing process reaps it) and a separate proof (the
 *   130-concurrent example); a `RoomPort` that also reserved seats would make the
 *   room contract suite responsible for a concurrency property it cannot show.
 * - `audit` — Story 2.2, `room_token.issued`. Story 2.1 deliberately left this
 *   port OUT because creating a room writes no audit row and `AUDIT_ACTIONS` has
 *   no name for it. Issuing a token is different: the action has been in
 *   `AUDIT_ACTIONS` since Story 1.1, and AD-9 makes the token the one admission
 *   decision — an admission nobody can trace is the shape an incident takes.
 *   Creating a room STILL writes no row; the port's presence here does not change
 *   that, and `deferred-work.md` still owns the question.
 *
 * ## There is still no `ClockPort` here, and the absence is still the point
 *
 * A token is stamped with the instant its caller's SESSION was resolved at, which
 * arrives on the `AuthenticatedCaller` that `SessionAuthenticator` hands back, and
 * its expiry is the reserved seat's — computed by the adapter from that same
 * instant. A clock in this object would be a second reading of the wall clock
 * inside a request that has already decided what "now" is — the defect Story 1.4
 * spent a review round removing from the date-of-birth path. Not having one here
 * makes a second reading unspellable.
 */
export const ROOMS_RUNTIME = Symbol('ROOMS_RUNTIME');

export interface RoomsRuntime {
  readonly rooms: RoomPort;
  readonly reservations: RoomReservationPort;
  readonly audit: AuditPort;
}
