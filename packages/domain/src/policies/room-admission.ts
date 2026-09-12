import type { ClockPort } from '../ports/clock-port';

/**
 * AD-9 — "may this person enter a study room", as a pure function.
 *
 * The token endpoint checks four conditions in one place: signed in, not banned,
 * old enough, a seat left. The first is answered by `SessionAuthenticator` (there
 * is no user to ask about until it has), and the last is answered inside the
 * reservation transaction (a count outside it is a hint, not a gate — AD-22). The
 * two in the middle are questions about the PERSON, and this is where they live.
 *
 * ## Why here and not in `RoomsService`
 *
 * For the reason `canReceiveMoney` and `isAdult` live here: a rule written in a
 * NestJS service is a rule `apps/realtime-gateway` cannot read and no test can run
 * without a request. Story 2.4's gateway will need "may this person still be in
 * this room" when it re-checks a revoked session, and it must call THIS function
 * rather than grow a second reading of `bannedAt`.
 *
 * ## The outcomes
 *
 * - `admitted` — nothing about the person refuses them. Whether there is a seat is
 *   a question for the store, asked next, under a lock.
 * - `banned` — `bannedAt` is not `null`. No exception, no grace, no "banned but
 *   only from chat": a ban is the whole product.
 * - `underage` — DECLARED AND UNREACHABLE TODAY, on purpose. The PRD (US-0.5 AC3)
 *   puts no age floor on entering a room: a fifteen-year-old may study with
 *   strangers, and only money has an age gate (`canReceiveMoney`). The branch is
 *   named so that when Story 3.x adds a rule that does read the date of birth —
 *   an adults-only room, a tutor session — it is added HERE, with the `clock`
 *   this function already receives, and not as a second age rule in a controller.
 *   Two age rules on one column is what `date-of-birth.ts` cost four review
 *   rounds to remove.
 *
 * `clock` is accepted today and read by nothing. That is the signature the future
 * rule needs and the one the spec fixed; a function that gained a parameter later
 * would change every caller on the day the rule arrived.
 */
export type RoomAdmission = 'admitted' | 'banned' | 'underage';

/**
 * The shape this function reads. A `User` satisfies it; so does a fixture that
 * carries only these fields, which is what keeps the policy tests free of a whole
 * profile.
 */
export interface RoomAdmissionSubject {
  readonly bannedAt: Date | null;
  readonly dateOfBirth: string | null;
}

export function roomAdmission(user: RoomAdmissionSubject, clock: ClockPort): RoomAdmission {
  // The parameter is part of the contract (see the docblock), not of today's rule.
  // Reading it into `void` is what keeps `noUnusedParameters` honest without
  // renaming it `_clock`, which would tell the next reader it is meant to stay
  // unused.
  void clock;

  // `!== null`, and NOT `instanceof Date`: a `bannedAt` of `undefined` — the shape a
  // select list that lost the column produces, with every type still satisfied —
  // must refuse, not admit. Fail closed, the way every rule in this package does.
  if (user.bannedAt !== null) {
    return 'banned';
  }

  // No age floor for entering a room today (PRD US-0.5 AC3). See the docblock for
  // where the `underage` branch goes when a story needs it.
  return 'admitted';
}
