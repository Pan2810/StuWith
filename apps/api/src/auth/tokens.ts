import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Every random value and every hash the login flow uses, in one file.
 *
 * `node:crypto` is allowed here and forbidden in `packages/domain` (AD-1), which is
 * exactly why `SessionPort` takes hashes rather than tokens: the domain names the
 * rule, this shell supplies the primitive.
 */

/** base64url, no padding — safe in a URL, a cookie and a JSON body alike. */
export function base64Url(input: Buffer): string {
  return input.toString('base64url');
}

/**
 * 32 bytes = 256 bits of entropy. Session tokens, refresh tokens, `state` and the
 * PKCE verifier all use this: there is no case here where a shorter value would be
 * meaningfully cheaper, and one under-sized token is enough to lose an account.
 */
export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

/**
 * A short hex id, safe to put in a cookie NAME (base64url is not: a cookie name is
 * an HTTP token and `=` is the separator).
 *
 * 8 bytes is plenty — this only has to distinguish the handful of login attempts
 * one browser has open at once, and it is not a secret: the secret is inside the
 * signed payload the cookie carries.
 */
export function randomHandle(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Base64Url(input: string): string {
  return base64Url(createHash('sha256').update(input, 'ascii').digest());
}

/**
 * PKCE (RFC 7636) with S256. The verifier stays in a cookie on this origin; only
 * its hash travels to the provider, so an attacker who intercepts the redirect
 * cannot exchange the authorization code they stole.
 *
 * `plain` is deliberately not offered. It is still in the RFC and it defeats the
 * entire mechanism.
 */
export function createPkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: sha256Base64Url(verifier) };
}

/**
 * What actually goes into `sessions.access_token_hash` / `refresh_token_hash`.
 *
 * HMAC rather than a bare SHA-256: the tokens are 256-bit random strings, so a
 * rainbow table is not the threat — but keying the hash means a stolen database
 * dump on its own is not enough to look a token up, the attacker also needs
 * `SESSION_COOKIE_SECRET`, which lives in a different place.
 *
 * No stretching (bcrypt/argon2) on purpose: these are high-entropy random values,
 * not passwords, so a slow KDF buys nothing and would add real latency to every
 * authenticated request.
 */
export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison for values an attacker can influence — `state`, above
 * all. `a === b` leaks the length of the matching prefix through timing, and
 * `state` is the CSRF defence for the whole login flow.
 */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Signs a short-lived payload for a cookie: `<base64url(json)>.<base64url(hmac)>`.
 *
 * The payload is signed, NOT encrypted, and everything that goes in it is chosen
 * on that basis. It is readable by anyone who can read the cookie — which, given
 * `httpOnly` + `Secure`, means someone who already owns the browser.
 */
export function signPayload(secret: string, payload: unknown): string {
  const body = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64Url(createHmac('sha256', secret).update(body, 'utf8').digest());
  return `${body}.${signature}`;
}

/**
 * Verifies and decodes. Returns `null` for anything that is not exactly right —
 * a bad signature, a truncated cookie, malformed JSON. There is no partial
 * success: a caller that could tell "wrong signature" from "bad JSON" would be an
 * oracle, and no caller here needs the distinction.
 */
export function verifyPayload<T>(secret: string, value: string | undefined): T | null {
  if (typeof value !== 'string') {
    return null;
  }
  const separator = value.lastIndexOf('.');
  if (separator <= 0) {
    return null;
  }
  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = base64Url(createHmac('sha256', secret).update(body, 'utf8').digest());
  if (!safeEquals(signature, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
