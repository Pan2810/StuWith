import proxyaddr from '@fastify/proxy-addr';
import type { TrustedProxyTrust } from '@stuwith/config';
import {
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type SignInOutcome,
} from '@stuwith/contracts';
import { UNKNOWN_CLIENT_IP } from '@stuwith/domain';
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
 * ## Why this is a library call and not our own function
 *
 * It used to be a hand-written IP and CIDR parser in `packages/domain`, and three
 * review rounds found three different holes in it: hop counting, then `/0`, then
 * `/1` — plus acceptance of addresses `net.isIP` rejects. Each round patched the
 * example rather than the class. `@fastify/proxy-addr` is the library Fastify 5
 * itself resolves, at the same pinned version, so `request.ip` and the rate-limit
 * key are decided by ONE implementation. "Fastify and we cannot disagree" is now a
 * property of the wiring rather than of a test comparing two parsers.
 *
 * ## Total by construction
 *
 * The header and the socket are both attacker-supplied, and this runs on the
 * request path of a layer whose entire posture is to fail open. Anything the
 * library cannot resolve — a request with no socket, an address it will not parse
 * — becomes {@link UNKNOWN_CLIENT_IP} rather than a throw.
 */
export function clientIpOf(request: FastifyRequest, trust: TrustedProxyTrust): string {
  // `false` means the deployment declared no proxy: the header is not evidence of
  // anything and must not be read at all, so the socket address is the answer.
  if (trust === false) {
    return normalise(request.socket?.remoteAddress);
  }

  try {
    return normalise(proxyaddr(request.raw, trust));
  } catch {
    return UNKNOWN_CLIENT_IP;
  }
}

/**
 * An IPv4-mapped IPv6 address is the same machine as the plain IPv4 form, and Node
 * hands back whichever the listening socket happened to produce. Folding them
 * together stops one person owning two independent budgets.
 */
function normalise(address: string | undefined | null): string {
  if (typeof address !== 'string' || address.length === 0) {
    return UNKNOWN_CLIENT_IP;
  }
  const lowered = address.toLowerCase();
  const mapped = lowered.startsWith('::ffff:') ? lowered.slice('::ffff:'.length) : lowered;
  return mapped.length === 0 ? UNKNOWN_CLIENT_IP : mapped;
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
 *
 * Total, for the same reason `clientIpOf` is: the cookie header is written by the
 * caller, and a value that made this throw would be a 500 on a fail-open layer.
 */
export function userHandleOf(request: FastifyRequest, secret: string): string | undefined {
  try {
    const jar = parseCookies(request.headers?.cookie);
    const presented = jar[REFRESH_COOKIE_NAME] ?? jar[SESSION_COOKIE_NAME];
    if (presented === undefined || presented.length === 0) {
      return undefined;
    }
    // Half the digest is 128 bits — far beyond collision range for this use, and it
    // keeps the composed key comfortably inside MAX_RATE_LIMIT_KEY_LENGTH.
    return hashSessionToken(secret, presented).slice(0, 32);
  } catch {
    return undefined;
  }
}

/** The one outcome code a rate-limited browser leg is allowed to send back. */
export const RATE_LIMITED_OUTCOME: SignInOutcome = 'bi-khoa';
