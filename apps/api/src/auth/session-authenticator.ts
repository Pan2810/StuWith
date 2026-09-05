import { SESSION_COOKIE_NAME } from '@stuwith/contracts';
import type { ClockPort, IdentityPort, SessionPort, User } from '@stuwith/domain';
import { parseCookies } from './cookies';
import { hashSessionToken } from './tokens';

/**
 * "Which PERSON is calling?", answered in exactly one place for the whole process.
 *
 * It was a private method on `AuthService`, which was correct while `/v1/auth/me`
 * and the date-of-birth declaration were the only two callers. Story 1.5 adds a
 * third — a GUARD, which runs before any handler — and a guard that authenticated
 * its own way would be a second answer to the question the service already
 * answers. Two readings of one session is the same class of defect
 * `date-of-birth.ts` spent four review rounds removing from one column, with a
 * worse blast radius: the guard would decide the age question about one person
 * while the handler served another.
 *
 * ## `POST /v1/auth/logout` does NOT go through here, and that is not an oversight
 *
 * The claim above is about identifying a PERSON. Logout does not need one: it
 * needs the CHAIN to revoke, which it gets from `revokeChainByRefreshTokenHash`
 * and from `readByAccessTokenHash(...).session.sessionId`. This function throws
 * that id away — it returns a `User` — so routing logout through it would mean
 * either widening the return type for one caller or reading the session twice.
 * Nothing about logout branches on who the person is; it answers 204 whatever was
 * presented, deliberately, so that logging out is not a place to tell a caller
 * whether the token they held was real.
 *
 * It collapses "no cookie", "unknown or expired session" and "the session points
 * at a user that no longer exists" into one `null` on purpose: all three are a 401
 * to the caller, and distinguishing them in the response tells somebody probing
 * which of the three they achieved.
 */
export const SESSION_AUTHENTICATOR = Symbol('SESSION_AUTHENTICATOR');

/**
 * Everything {@link SessionAuthenticator} needs, and nothing else.
 *
 * A narrow structural type rather than `AuthRuntime` so this file cannot quietly
 * grow a reason to touch the audit port, the provider registry or the rate-limit
 * store. `AuthRuntime` satisfies it.
 */
export interface SessionAuthenticatorRuntime {
  readonly identity: IdentityPort;
  readonly sessions: SessionPort;
  readonly clock: ClockPort;
}

/**
 * A resolved caller, together with the instant their session was resolved AT.
 *
 * The instant travels with the user because the alternative is every later
 * question in the request reading the clock again. A request that asks "is this
 * session live" at 23:59:59.999 and "is this person eighteen" at 00:00:00.001
 * straddles a midnight and answers about two different days — and on the money
 * gate, one of those two answers is "yes, take their money".
 */
export interface AuthenticatedCaller {
  readonly user: User;
  /** The request's single instant. Wrap it with `fixedAt` before asking the domain. */
  readonly at: Date;
}

export class SessionAuthenticator {
  constructor(
    private readonly cookieSecret: string,
    private readonly runtime: SessionAuthenticatorRuntime,
  ) {}

  /**
   * The person behind a session cookie, or `null` for every reason there is.
   *
   * The clock is read ONCE, first, and the same instant is used to judge the
   * session's expiry and handed back for whatever the caller asks next.
   */
  async authenticate(cookieHeader: unknown): Promise<AuthenticatedCaller | null> {
    const at = this.runtime.clock.now();

    const presented = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
    // Empty is the same as absent, and checking it here is not tidiness: a browser
    // that has just been sent a clearing `Set-Cookie` presents `stuwith_session=`
    // on its next request, and every signed-out visitor to a gated route would
    // otherwise spend one HMAC and one round trip to the session store before
    // being told the obvious. `parseCookies` yields `''` for that spelling, and
    // `''` can never be a token this process issued.
    if (presented === undefined || presented.length === 0) {
      return null;
    }

    const read = await this.runtime.sessions.readByAccessTokenHash(
      hashSessionToken(this.cookieSecret, presented),
      at,
    );
    if (!read.ok) {
      return null;
    }

    const user = await this.runtime.identity.findUserById(read.session.userId);
    return user === null ? null : { user, at };
  }
}
