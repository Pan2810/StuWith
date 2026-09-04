import {
  AUTH_COOKIE_PATH,
  OAUTH_STATE_COOKIE_PREFIX,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
} from '@stuwith/contracts';

/**
 * Cookie handling, written out rather than pulled in.
 *
 * `@fastify/cookie` would do this, and adding it was not on the approved
 * dependency list for this story. What is actually needed is one parser and one
 * serialiser with fixed attributes — the flags below are not configurable on
 * purpose, so no future call site can quietly drop `HttpOnly`.
 */

export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
  readonly path: string;
}

/**
 * The attributes every cookie this app sets carries, with no way to opt out:
 *
 * - `HttpOnly` — JavaScript cannot read it, so an XSS bug does not immediately
 *   become a stolen session.
 * - `Secure` — never sent over plain HTTP, and unconditionally so. The tempting
 *   alternative, making it depend on `NODE_ENV`, is how a production deployment
 *   ends up shipping session cookies in the clear because one env file said
 *   `development`. See below for what this costs locally: less than it looks.
 * - `SameSite=Lax` — NOT `Strict`. The provider redirects the browser back to
 *   `/v1/auth/:provider/callback` as a top-level cross-site navigation, and
 *   `Strict` withholds cookies on exactly that request, so every single login
 *   would fail with "state missing". `Lax` sends cookies on top-level GET
 *   navigations and withholds them from cross-site POSTs and subresources, which
 *   is the behaviour this flow needs and the CSRF protection it wants.
 *
 * ## What `Secure` costs in local development
 *
 * Not a TLS setup, in the usual case. Chrome (≥ 89) and Firefox (≥ 75) treat
 * `http://localhost` as a secure context and accept `Secure` cookies from it, so
 * `pnpm dev` on `http://localhost:3000` + `http://localhost:3001` signs in
 * normally.
 *
 * It does break in two situations, and both are worth knowing before you spend an
 * afternoon on it: Safari is stricter about this, and ANY non-localhost plain-HTTP
 * origin (a LAN IP so a phone can reach your laptop, a bare staging box) will
 * silently drop the cookie — the login redirect succeeds and `/v1/auth/me` then
 * answers 401. Put a TLS terminator in front of it for those. Note that Caddy is
 * NOT part of `infra/docker-compose.yml`; the compose stack is deliberately the
 * four backing services only, and TLS terminates at the VPS edge in production.
 */
export function serializeCookie(cookie: SetCookie): string {
  return [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    `Max-Age=${cookie.maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/**
 * Clearing is `Max-Age=0` with an empty value on the SAME path. A different path
 * creates a second cookie instead of removing the first, and the browser then
 * sends the stale one forever — which for the session cookie means "logged out"
 * in the UI and still signed in on the wire.
 */
export function clearCookie(name: string, path: string): string {
  return serializeCookie({ name, value: '', maxAgeSeconds: 0, path });
}

/**
 * Minimal `Cookie:` header parser.
 *
 * Values are NOT URL-decoded: everything this app sets is base64url, which needs
 * no encoding, and decoding would turn a `%` in someone else's cookie into a
 * decoding error on a request that had nothing to do with us.
 */
export function parseCookies(header: unknown): Record<string, string> {
  const jar: Record<string, string> = {};
  if (typeof header !== 'string' || header.length === 0) {
    return jar;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name.length === 0 || Object.prototype.hasOwnProperty.call(jar, name)) {
      // First occurrence wins. A duplicated cookie name is a classic way to make
      // the server and the browser disagree about which value is "the" value.
      continue;
    }
    jar[name] = part.slice(separator + 1).trim();
  }
  return jar;
}

export function sessionCookie(value: string, maxAgeSeconds: number): SetCookie {
  return { name: SESSION_COOKIE_NAME, value, maxAgeSeconds, path: SESSION_COOKIE_PATH };
}

export function refreshCookie(value: string, maxAgeSeconds: number): SetCookie {
  // Scoped to `/v1/auth`: the refresh token is only ever presented to the refresh
  // endpoint, so it should not be attached to every other request in the app.
  return { name: REFRESH_COOKIE_NAME, value, maxAgeSeconds, path: AUTH_COOKIE_PATH };
}

/** Cookie names are tokens; a base64url handle is not one, so hex it is. */
export function oauthStateCookieName(handle: string): string {
  return `${OAUTH_STATE_COOKIE_PREFIX}${handle}`;
}

export function oauthStateCookie(
  handle: string,
  value: string,
  maxAgeSeconds: number,
): SetCookie {
  return {
    name: oauthStateCookieName(handle),
    value,
    maxAgeSeconds,
    path: AUTH_COOKIE_PATH,
  };
}

/**
 * Every in-flight login attempt the browser is carrying, newest first is not
 * knowable — so the caller checks all of them and keeps the one whose signed
 * payload matches the `state` that came back. Two open tabs means two entries;
 * an abandoned attempt leaves one until its `Max-Age` expires.
 */
export function oauthStateCookies(jar: Record<string, string>): Array<[string, string]> {
  return Object.entries(jar).filter(([name]) => name.startsWith(OAUTH_STATE_COOKIE_PREFIX));
}

/**
 * Everything a completed or failed login should leave behind: nothing.
 *
 * The jar is passed in because the state cookies have per-attempt names that this
 * function cannot guess. Without it, a failed callback would clear the session and
 * leave the handshake cookies to linger for their full TTL.
 */
export function clearAllAuthCookies(jar: Record<string, string> = {}): string[] {
  return [
    clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_PATH),
    clearCookie(REFRESH_COOKIE_NAME, AUTH_COOKIE_PATH),
    ...oauthStateCookies(jar).map(([name]) => clearCookie(name, AUTH_COOKIE_PATH)),
  ];
}
