import proxyaddr from '@fastify/proxy-addr';
import type { TrustedProxyTrust } from '@stuwith/config';
import {
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type SignInOutcome,
} from '@stuwith/contracts';
import { UNKNOWN_CLIENT_IP, type RateLimitSubject } from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
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
 * The one shape a rate-limit key may be built from: a real address, folded so the
 * same machine cannot own two budgets.
 *
 * Three things happen here, and each one closes a way of getting a second budget
 * or an arbitrary one:
 *
 * - **the zone index is dropped.** `fe80::1%eth0` and `fe80::1%eth1` are the same
 *   machine on two interfaces, and Node hands back whichever the socket produced;
 * - **an IPv4-mapped address is folded to its plain IPv4 form**, because
 *   `::ffff:203.0.113.7` and `203.0.113.7` are the same machine and the listening
 *   socket decides which spelling arrives;
 * - **anything `node:net` does not recognise becomes {@link UNKNOWN_CLIENT_IP}.**
 *   `@fastify/proxy-addr` returns the left-most entry of `X-Forwarded-For` that is
 *   not trusted WITHOUT checking that it is an address at all, so a trusted proxy
 *   forwarding junk — or a compromised one appending it — turned that junk
 *   straight into a rate-limit key. Rotating the junk rotated the key, which is a
 *   way past the whole feature for anybody who is behind a declared proxy.
 *
 * The `node:net` check also holds up the sentinel guarantee in `packages/domain`:
 * because everything that comes out of here is either an address or the constant,
 * nothing from a header can arrive as a string spelled like the constant.
 */
function normalise(address: string | undefined | null): string {
  if (typeof address !== 'string' || address.length === 0) {
    return UNKNOWN_CLIENT_IP;
  }
  const lowered = address.toLowerCase();
  const zone = lowered.indexOf('%');
  const withoutZone = zone === -1 ? lowered : lowered.slice(0, zone);

  if (isIP(withoutZone) === 0) {
    return UNKNOWN_CLIENT_IP;
  }
  if (withoutZone.startsWith('::ffff:')) {
    const mapped = withoutZone.slice('::ffff:'.length);
    // Only the dotted form folds. `::ffff:cb00:7107` is the same address written
    // in hex, and slicing that would leave `cb00:7107`, which is not an address
    // at all — a second budget for one machine, spelled by whoever connects.
    if (isIP(mapped) === 4) {
      return mapped;
    }
  }
  return withoutZone;
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

/**
 * The address AND the credential for one request — the whole subject, computed
 * once, in one place.
 *
 * Both the guard and `AuthController` need the same answer for the same request:
 * the guard counts the attempt and reads the lock, the controller hands the same
 * pair to `AuthService` so a failed sign-in lands on the key the guard will later
 * read. They each used to build it themselves, and the copies had already drifted
 * — the controller's wrapped BOTH calls in one `try`, so a throw out of either
 * one discarded the other. In practice that meant a fault in the cookie half threw
 * away an address the guard had resolved perfectly well on the same request, and
 * the two halves of the brute-force bookkeeping then looked at different keys:
 * exactly the divergence one shared function exists to prevent.
 *
 * One `try` EACH, so a fault in one half cannot cost the other. Both functions are
 * total in themselves; this is the belt to that braces, on a layer whose whole
 * posture is to keep the request moving.
 */
export function rateLimitSubjectOf(
  request: FastifyRequest,
  trust: TrustedProxyTrust,
  sessionCookieSecret: string,
): RateLimitSubject {
  let clientIp: string;
  try {
    clientIp = clientIpOf(request, trust);
  } catch {
    clientIp = UNKNOWN_CLIENT_IP;
  }

  let userHandle: string | undefined;
  try {
    userHandle = userHandleOf(request, sessionCookieSecret);
  } catch {
    userHandle = undefined;
  }

  return { clientIp, userHandle };
}

/** The one outcome code a rate-limited browser leg is allowed to send back. */
export const RATE_LIMITED_OUTCOME: SignInOutcome = 'bi-khoa';
