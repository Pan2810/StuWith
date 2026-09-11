import type { RoomPort } from '@stuwith/domain';

/**
 * Everything `RoomsService` needs, and nothing else.
 *
 * A narrow structural type rather than `AuthRuntime`, for the reason
 * `SessionAuthenticatorRuntime` gives about itself: a module handed the whole
 * runtime can quietly grow a reason to touch the provider registry, the audit port
 * or the rate-limit store, and nothing would say so at review time. `AuthRuntime`
 * satisfies this, so there is still ONE `pg` pool for the process — see the `rooms`
 * field's docblock there for why a second runtime object would be worse.
 *
 * ## There is no `ClockPort` here, and the absence is the point
 *
 * A room is stamped with the instant its caller's SESSION was resolved at, which
 * arrives on the `AuthenticatedCaller` that `SessionAuthenticator` hands back. A
 * clock in this object would be a second reading of the wall clock inside a request
 * that has already decided what "now" is — the defect Story 1.4 spent a review round
 * removing from the date-of-birth path, where the two readings straddled a midnight.
 * Not having one here makes a second reading unspellable.
 *
 * ## No `AuditPort` either, and that is a decision rather than an omission
 *
 * Creating a room writes no audit row. `AUDIT_ACTIONS` has no name for it, adding
 * one is an "Ask First" item in this story's spec (it is a CHECK constraint
 * duplicated by hand into a migration, on an append-only table no role can correct),
 * and the row would be permanent. `deferred-work.md` records it with the evidence.
 * The absence of the port is what makes that a decision somebody has to reverse
 * deliberately rather than a call somebody adds in passing.
 */
export const ROOMS_RUNTIME = Symbol('ROOMS_RUNTIME');

export interface RoomsRuntime {
  readonly rooms: RoomPort;
}
