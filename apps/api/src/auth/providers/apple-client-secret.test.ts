import { generateKeyPairSync } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAppleClientSecretFactory, normalizePem } from './apple-client-secret';

/**
 * The Apple client secret is the one credential this system MINTS rather than
 * reads, and it is minted from a PEM that arrives through an environment
 * variable.
 *
 * That last part is why `normalizePem` exists and why it needs its own test: a
 * `.p8` file is multi-line, an environment variable in practice is not, so
 * `.env.example` documents the one-line form with literal `\n` sequences — the
 * form production will actually use. Every other test in this repo feeds a real
 * multi-line PEM, so the escaped branch was never taken: deleting the
 * transformation left every suite green and would have broken the first real
 * Apple login.
 */
function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  // Generated per run, never written down — nothing here reads as a key to CI gate #1.
  return { privateKey, publicKey };
}

/** The single-line form an environment variable can actually carry. */
function toEnvVarForm(pem: string): string {
  return pem.replace(/\n/g, '\\n');
}

describe('normalizePem', () => {
  it('turns the escaped one-line form back into a real PEM', () => {
    const { privateKey } = generateKeyPair();
    const escaped = toEnvVarForm(privateKey);

    expect(escaped).not.toContain('\n');
    expect(normalizePem(escaped)).toBe(privateKey);
  });

  it('leaves an already-multi-line PEM untouched', () => {
    const { privateKey } = generateKeyPair();
    expect(normalizePem(privateKey)).toBe(privateKey);
  });
});

describe('the Apple client secret', () => {
  const claims = {
    teamId: 'TEAMFORTEST',
    keyId: 'KEYFORTEST1',
    clientId: 'vn.stuwith.test',
  };

  it('is a verifiable ES256 JWT when the key arrives in the ESCAPED env-var form', async () => {
    // The end-to-end version of the test above: the value goes in exactly as an
    // operator would paste it into `.env`, and what comes out has to verify.
    const { privateKey, publicKey } = generateKeyPair();
    const factory = createAppleClientSecretFactory({
      ...claims,
      privateKey: toEnvVarForm(privateKey),
    });

    const secret = await factory();
    const { payload, protectedHeader } = await jwtVerify(
      secret,
      await importSPKI(publicKey, 'ES256'),
      { issuer: claims.teamId, audience: 'https://appleid.apple.com' },
    );

    expect(protectedHeader.alg).toBe('ES256');
    // Apple looks the signing key up by `kid`; without it the token is rejected.
    expect(protectedHeader.kid).toBe(claims.keyId);
    expect(payload.sub).toBe(claims.clientId);
  });

  it('produces the same JWT for the multi-line form, so the two are interchangeable', async () => {
    const { privateKey, publicKey } = generateKeyPair();
    const now = () => new Date('2026-09-04T09:00:00.000Z');

    const fromRaw = await createAppleClientSecretFactory({ ...claims, privateKey, now })();
    const fromEscaped = await createAppleClientSecretFactory({
      ...claims,
      privateKey: toEnvVarForm(privateKey),
      now,
    })();

    // ECDSA signatures are randomised, so the tokens differ — what must match is
    // that BOTH verify against the same public key.
    // Both tokens were minted against the injected clock, so they must be
    // verified against it too. Verifying against the real clock made this test
    // a time bomb: the pair carries a 5-minute lifetime starting at the instant
    // below, so the suite was green until that instant passed and red every run
    // afterwards, for a reason that has nothing to do with the code under test.
    const key = await importSPKI(publicKey, 'ES256');
    await expect(jwtVerify(fromRaw, key, { currentDate: now() })).resolves.toBeTruthy();
    await expect(jwtVerify(fromEscaped, key, { currentDate: now() })).resolves.toBeTruthy();
  });

  it('re-signs once the cached token nears expiry, rather than serving a stale one', async () => {
    const { privateKey } = generateKeyPair();
    let instant = new Date('2026-09-04T09:00:00.000Z');
    const factory = createAppleClientSecretFactory({
      ...claims,
      privateKey,
      lifetimeSeconds: 300,
      now: () => instant,
    });

    const first = await factory();
    expect(await factory()).toBe(first);

    // Past the refresh-early margin: a request that took a moment must not be the
    // one that reaches Apple with a just-expired secret.
    instant = new Date(instant.getTime() + 280_000);
    expect(await factory()).not.toBe(first);
  });

  it('refuses a key that is not a PKCS#8 PEM instead of signing nonsense', async () => {
    const factory = createAppleClientSecretFactory({ ...claims, privateKey: 'not-a-key' });
    await expect(factory()).rejects.toThrow();
  });
});
