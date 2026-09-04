import type { ClockPort } from '../ports/clock-port';
import { isAdult } from './date-of-birth';

/**
 * The money gate, as a pure function. No database, no HTTP, no `new Date()`.
 *
 * ## This is a PROJECTION of the age rule, not a second rule
 *
 * {@link canReceiveMoney} calls {@link isAdult} and does nothing else. It does not
 * read the stored string, does not compare two days, and does not carry a
 * threshold of its own — because a second reading of `users.date_of_birth` is
 * precisely the defect `date-of-birth.ts` spent four review rounds removing. That
 * file used to answer two questions with two rules on one column and produced a
 * state (`1899-12-31`) that was simultaneously "profile complete" and "under 18",
 * permanently, with nothing able to name it.
 *
 * So the body below is one call, and that is the point of the file rather than a
 * sign that the file is not pulling its weight. What it adds is a NAME: `apps/api`
 * marks a route as inbound money and asks this question, so the age threshold is
 * never written down anywhere near an endpoint. When the product's answer to
 * "who may take money" stops being exactly "an adult" — a verified account, a
 * suspended one, a country rule — this is the one function that changes, and every
 * marked endpoint changes with it without being edited.
 *
 * ## Everything here fails CLOSED
 *
 * `not-declared`, `unusable`, a broken clock: {@link isAdult} answers `false` to
 * all of them, and so does this. A control that protects minors must never read
 * its own ignorance as permission.
 *
 * ## Only the INBOUND direction
 *
 * The epic is explicit and the asymmetry is deliberate: coins the SYSTEM grants
 * (an opening balance, a reputation reward) are untouched by the age rule, and
 * somebody under 18 may still SPEND coins — to ask a private question, to enter a
 * room, to hide their face. Nothing in this file may grow a second export that
 * decides an outbound question; a spending gate keyed on age would silently make
 * this repository's most careful rule mean the opposite of what it says.
 */

/**
 * Whether this account may be on the receiving end of money that comes from
 * another person.
 *
 * ## Why it takes the USER and not a date
 *
 * Same reason {@link isAdult} does: the value that is never passed around is the
 * value that never reaches a log line or a response body. A caller holding a
 * `dateOfBirth` in a local variable is one debug statement away from an
 * unremovable PII row in `audit_events`.
 *
 * ## Why it takes a `ClockPort` and not a `Date`
 *
 * Because the age rule receives time through the port, and this is a projection of
 * the age rule rather than a paraphrase of it. A caller that already holds the
 * request's single instant wraps it with `fixedAt`, so every question asked during
 * one request is answered about the same millisecond — the guard in `apps/api`
 * does exactly that.
 */
export function canReceiveMoney(
  user: { readonly dateOfBirth: string | null },
  clock: ClockPort,
): boolean {
  return isAdult(user, clock);
}
