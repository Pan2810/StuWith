import { SignJWT, importPKCS8 } from 'jose';

/**
 * Apple does not issue a client secret. It expects a short-lived ES256 JWT that
 * this process signs with the `.p8` key downloaded from the developer portal.
 *
 * The JWT is minted per exchange and cached only for a few minutes. Apple caps its
 * lifetime at six months; using the maximum would mean one long-lived bearer
 * credential sitting in memory and in every heap dump, so it is issued short and
 * regenerated. Signing costs well under a millisecond.
 */
export interface AppleClientSecretOptions {
  readonly teamId: string;
  readonly keyId: string;
  readonly clientId: string;
  /** The PKCS#8 PEM from AuthKey_XXXX.p8. */
  readonly privateKey: string;
  readonly now?: () => Date;
  readonly lifetimeSeconds?: number;
}

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const DEFAULT_LIFETIME_SECONDS = 300;

/**
 * An environment variable cannot hold a real newline in most deployment systems,
 * so a PEM arrives as one line with a literal `\n` in it. Converting it back here
 * — rather than expecting whoever writes the env file to get it right — turns a
 * baffling "invalid key" at login time into something that simply works.
 */
export function normalizePem(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export function createAppleClientSecretFactory(
  options: AppleClientSecretOptions,
): () => Promise<string> {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  const clock = options.now ?? (() => new Date());
  let cached: { token: string; expiresAtMs: number } | undefined;

  return async (): Promise<string> => {
    const nowMs = clock().getTime();
    // Re-sign a little before expiry so a slow request cannot be the one that
    // arrives at Apple with a just-expired secret.
    if (cached !== undefined && cached.expiresAtMs - 30_000 > nowMs) {
      return cached.token;
    }

    const key = await importPKCS8(normalizePem(options.privateKey), 'ES256');
    const issuedAt = Math.floor(nowMs / 1000);
    const expiresAt = issuedAt + lifetime;

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: options.keyId })
      .setIssuer(options.teamId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setAudience(APPLE_AUDIENCE)
      .setSubject(options.clientId)
      .sign(key);

    cached = { token, expiresAtMs: expiresAt * 1000 };
    return token;
  };
}
