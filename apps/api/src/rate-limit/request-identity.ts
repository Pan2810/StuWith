import {
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type SignInOutcome,
} from '@stuwith/contracts';
import { resolveClientIp, type TrustedProxy } from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { parseCookies } from '../auth/cookies';
import { hashSessionToken } from '../auth/tokens';

/**
 * Turning a Fastify request into the two values the policy needs, and nothing
 * else.
 *
 * It is a separate file because BOTH the guard and `AuthController` need the same
 * answer for the same request: the guard counts the attempt, and the controller
 * hands the address to `AuthService` so a failed sign-in lands on the same
 * brute-force key. Two call sites computing "the client's IP" independently is how
 * they end up disagreeing.
 */

/**
 * The address to count against.
 *
 * The inference itself is `resolveClientIp` in `packages/domain` — a pure function
 * of (socket, header, declared proxies) with its own unit tests. What is left here
 * is the unwrapping of Fastify, which is exactly the division AD-1 asks for.
 *
 * Total by construction: `resolveClientIp` returns the `unknown` bucket rather
 * than throwing for anything it cannot read, which matters because this runs on
 * the request path of a layer that is supposed to fail open.
 */
export function clientIpOf(
  request: FastifyRequest,
  trustedProxies: readonly TrustedProxy[],
): string {
  return resolveClientIp({
    socketAddress: request.socket?.remoteAddress,
    forwardedFor: request.headers['x-forwarded-for'],
    trustedProxies,
  });
}

/**
 * A stable, non-reversible handle for whoever is behind this request — or
 * `undefined` when the request carries no credential at all.
 *
 * ## Why the credential and not a user id
 *
 * The guard runs BEFORE the handler, so there is no authenticated user yet and no
 * database lookup is available to it (one would also mean a query per rejected
 * request, which is a gift to whoever is sending them). What the request does
 * carry on the two `fetch` legs is a session or refresh cookie, and that value
 * does not change when the caller's address does. So twenty machines replaying one
 * stolen refresh token share one budget, which is the matrix row "cùng user,
 * nhiều IP khác nhau" in the terms actually available here.
 *
 * ## Why it is hashed
 *
 * The key ends up in Valkey and could end up in a log line if anything ever
 * printed it. A session token in either place is a session anybody can take over,
 * so the raw value never leaves this function — the same HMAC, with the same key,
 * that `sessions` already stores its tokens under.
 *
 * The refresh cookie is preferred over the session cookie because it is the one
 * that survives an expiry: after the session token ages out, `/v1/auth/refresh`
 * still presents the same refresh token, so the budget follows the person rather
 * than resetting every hour.
 */
export function userHandleOf(request: FastifyRequest, secret: string): string | undefined {
  const jar = parseCookies(request.headers.cookie);
  const presented = jar[REFRESH_COOKIE_NAME] ?? jar[SESSION_COOKIE_NAME];
  if (presented === undefined || presented.length === 0) {
    return undefined;
  }
  // Half the digest is 128 bits — far beyond collision range for this use, and it
  // keeps the composed key comfortably inside MAX_RATE_LIMIT_KEY_LENGTH.
  return hashSessionToken(secret, presented).slice(0, 32);
}

/** The one outcome code a rate-limited browser leg is allowed to send back. */
export const RATE_LIMITED_OUTCOME: SignInOutcome = 'bi-khoa';
