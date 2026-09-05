import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { NO_TRUSTED_PROXIES, type ApiEnv } from '@stuwith/config';
import { SIGN_IN_RETURN_PATH_QUERY_PARAM, type AuthProvider } from '@stuwith/contracts';
import {
  InMemoryAuditAdapter,
  InMemoryIdentityAdapter,
  InMemoryRateLimitAdapter,
  InMemorySessionAdapter,
} from '@stuwith/db';
import { FixedClock, type ClockPort, type IdentityPort, type RateLimitPort } from '@stuwith/domain';
import { generateKeyPairSync } from 'node:crypto';
import { Logger as PinoLogger } from 'nestjs-pino';
import net from 'node:net';
import { Writable } from 'node:stream';
import { AppModule } from '../../app.module';
import { configureHttpApp, fastifyAdapterOptions } from '../../http-setup';
import { createProviderRegistry } from '../providers/registry';
import { FakeAuthorizationServer, type FakeProfile } from './fake-authorization-server';

/**
 * One place that stands the whole login flow up: a real NestJS + Fastify process
 * on a real port, real cookies over real HTTP, in-memory adapters, and an
 * in-process OpenID Connect provider that signs real tokens.
 *
 * It is shared by `auth.flow.test.ts` (behaviour) and `logging.test.ts` (the PII
 * assertion), because those two have to be looking at the SAME run. A PII test
 * against a logger the test built itself proves nothing about the process.
 */

/** Apple's client secret is a signed JWT, so the test needs a real EC key. */
function generateApplePrivateKey(): string {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  // Generated per run and never written down: nothing in this repository looks
  // like a private key to CI gate #1, which is the point.
  return privateKey;
}

/**
 * Obviously-fake, assembled at runtime rather than written as literals — the same
 * convention `playwright.config.ts` and the AD-14 gate use, so nothing in this
 * file reads as a credential to CI gate #1.
 */
const placeholder = (label: string): string => `flow-test-${label}-${'x'.repeat(16)}`;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not obtain a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

interface JarEntry {
  readonly name: string;
  readonly path: string;
  readonly value: string;
}

/**
 * The browser's cookie jar, reduced to what these tests need — but including
 * `Path`, which is not a detail.
 *
 * A jar keyed on name alone models a browser that ignores paths, and that model
 * hides a real class of bug: clearing the session cookie at `/v1/auth` instead of
 * `/` looks like a successful logout to a name-keyed jar, while a real browser
 * keeps the original cookie at `/` and the user stays signed in. Cookies are
 * therefore keyed on `(name, path)` and sent only to matching request paths, per
 * RFC 6265 §5.1.4.
 */
export class CookieJar {
  private readonly jar = new Map<string, JarEntry>();

  private static key(name: string, path: string): string {
    // The separator is a NUL, written as an ESCAPE and never as a literal byte.
    // A raw NUL here made git classify this whole file as binary, so the central
    // fixture of the login stories appeared in every diff as "Binary files
    // differ" and was skipped by grep and ripgrep — a file nobody could review
    // and no repo-wide check could see. Same runtime value, file stays text.
    return `${path}\u0000${name}`;
  }

  /** RFC 6265 §5.1.4 path-match. */
  private static pathMatches(cookiePath: string, requestPath: string): boolean {
    if (cookiePath === requestPath) return true;
    if (!requestPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
  }

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      const pathAttribute = attributes
        .map((attribute) => attribute.trim())
        .find((attribute) => attribute.toLowerCase().startsWith('path='));
      // A browser defaults to the request's directory; every cookie this app sets
      // states a Path, so a missing one is a bug worth surfacing as a bad key
      // rather than papering over.
      const path = pathAttribute === undefined ? '/' : pathAttribute.slice('path='.length);

      const key = CookieJar.key(name, path);
      if (value.length === 0 || /max-age=0/i.test(raw)) {
        this.jar.delete(key);
      } else {
        this.jar.set(key, { name, path, value });
      }
    }
  }

  /** The `Cookie:` header a browser would send for this request path. */
  header(requestPath = '/'): string {
    return [...this.jar.values()]
      .filter((entry) => CookieJar.pathMatches(entry.path, requestPath))
      .map((entry) => `${entry.name}=${entry.value}`)
      .join('; ');
  }

  /** First value with this name, whatever its path. */
  get(name: string): string | undefined {
    return [...this.jar.values()].find((entry) => entry.name === name)?.value;
  }

  pathOf(name: string): string | undefined {
    return [...this.jar.values()].find((entry) => entry.name === name)?.path;
  }

  namesMatching(prefix: string): string[] {
    return [...this.jar.values()]
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => entry.name);
  }

  set(name: string, value: string, path = '/'): void {
    this.jar.set(CookieJar.key(name, path), { name, path, value });
  }

  /** Replace a value in place, keeping whatever path it already had. */
  replace(name: string, value: string): void {
    const existing = [...this.jar.values()].find((entry) => entry.name === name);
    if (existing === undefined) {
      throw new Error(`no cookie named ${name} to replace`);
    }
    this.jar.set(CookieJar.key(name, existing.path), { ...existing, value });
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const entry of this.jar.values()) {
      copy.set(entry.name, entry.value, entry.path);
    }
    return copy;
  }
}

export interface HarnessOptions {
  readonly enabledProviders?: readonly AuthProvider[];
  readonly microsoftTenantId?: string;
  readonly sessionTtlSeconds?: number;
  readonly refreshTtlSeconds?: number;
  readonly oauthStateTtlSeconds?: number;
  readonly captureLogs?: boolean;

  /**
   * Story 1.3 part 2. The proxy list the harness's server is started with.
   *
   * It defaults to {@link NO_TRUSTED_PROXIES}: the harness connects to the server
   * directly, so the socket address IS the client and `X-Forwarded-For` must be
   * ignored entirely. A test that wants the proxy rows of the matrix declares the
   * loopback peer here.
   */
  readonly trustedProxies?: string;

  /**
   * The rate-limit knobs. The defaults are deliberately HIGH — every existing
   * example in `auth.flow.test.ts` makes dozens of requests from `127.0.0.1`, and
   * a production-sized budget would turn them all into a cascade of 429s that had
   * nothing to do with what they are testing. The rate-limit suite sets them low
   * on purpose.
   */
  readonly ipLimit?: number;
  readonly ipWindowSeconds?: number;
  readonly userLimit?: number;
  readonly userWindowSeconds?: number;
  readonly bruteForceLimit?: number;
  readonly bruteForceLockSeconds?: number;
  /**
   * A port that throws on every call, standing in for a Valkey that is down or
   * too slow. The whole fail-open row of the matrix is unreachable without it.
   */
  readonly rateLimitPort?: RateLimitPort;

  /**
   * Wrap the in-memory identity adapter, so one method can refuse while the rest of
   * the login flow still works.
   *
   * It takes the real adapter and returns a port, rather than replacing it, because
   * every refusal worth testing here is a refusal that happens to a person who has
   * signed in normally: `recordDateOfBirth` answering `UserNotFound` means the
   * `users` row disappeared between authenticating the session and writing to it,
   * and reaching that state needs the login to have worked first.
   *
   * `harness.identity` still points at the wrapped adapter, so the assertions about
   * stored state read the same object either way.
   */
  readonly wrapIdentity?: (base: IdentityPort) => IdentityPort;

  /**
   * Extra controllers to mount on the real application.
   *
   * Story 1.5 needs it: no route in this product takes money IN yet (Epic 3 owns
   * them all), so the only way to show that a new endpoint is protected by nothing
   * but its `@MoneyIn()` mark is to mount one here and drive it over real HTTP,
   * behind the real global guard.
   */
  readonly controllers?: readonly Type<unknown>[];

  /**
   * The `ClockPort` the whole process reads time through.
   *
   * It defaults to the {@link FixedClock} every existing suite relies on. The seam
   * exists because "one request, one instant" was UNTESTABLE without it: with a
   * fixed clock, code that reads the clock once and code that reads it three times
   * produce identical answers, so the property `SessionAuthenticator` was extracted
   * to hold could be reverted with every example still green.
   *
   * A test that supplies a clock which MOVES will usually want to supply
   * `rateLimitPort` as well — the default in-memory limiter is built on this same
   * clock, and its reads would otherwise be interleaved with the ones under test.
   */
  readonly clock?: ClockPort;
}

export interface AuthHarness {
  readonly baseUrl: string;
  readonly webBaseUrl: string;
  readonly config: ApiEnv;
  readonly fake: FakeAuthorizationServer;
  readonly identity: InMemoryIdentityAdapter;
  readonly sessions: InMemorySessionAdapter;
  readonly audit: InMemoryAuditAdapter;
  /**
   * The clock the process is running on.
   *
   * `ClockPort`, not `FixedClock`, because {@link HarnessOptions.clock} can replace
   * it — a suite that calls `.advance(...)` is relying on the default and says so
   * by not passing one.
   */
  readonly clock: ClockPort;
  readonly rateLimit: RateLimitPort;
  readonly logLines: readonly string[];
  request(path: string, init?: RequestInit & { jar?: CookieJar }): Promise<Response>;
  /**
   * Drives start -> consent -> callback and returns the resulting cookie jar.
   *
   * See {@link LoginOptions} for what the third argument carries. It is an object
   * rather than two more positional parameters because `login(p, profile,
   * undefined, path)` — a call site padding past a jar it does not care about — is
   * a shape that gets one `undefined` wrong exactly once and then passes a cookie
   * jar as a return path.
   */
  login(
    provider: AuthProvider,
    profile: FakeProfile,
    options?: LoginOptions,
  ): Promise<{ jar: CookieJar; callback: Response }>;
  close(): Promise<void>;
}

/**
 * Everything optional about one scripted login.
 *
 * The docblock lives HERE and nowhere else. It used to be duplicated almost word
 * for word on the interface member and on the implementation, which is two places
 * to update and therefore one place that goes stale.
 */
export interface LoginOptions {
  /** Reuse a jar to sign in as a second person in the same browser. */
  readonly jar?: CookieJar;
  /**
   * The RAW value of the `quay-ve` parameter on the `/start` leg — not a
   * validated one.
   *
   * The point of driving it from here is that a hostile spelling (`//evil.com`,
   * an absolute URL, an encoded slash) travels the same road a real proposal
   * does: real HTTP, Fastify's own query decoding, a real signed state cookie and
   * a real callback. Asserting against the validator in isolation misses every
   * difference the transport introduces. Omitted means the parameter is absent
   * altogether, which is the shape every call site written before Story 1.3c has.
   */
  readonly returnPath?: string;
}

const WEB_BASE_URL = 'http://127.0.0.1:39999';

export async function createAuthHarness(options: HarnessOptions = {}): Promise<AuthHarness> {
  const enabled = options.enabledProviders ?? (['google', 'facebook', 'apple', 'microsoft'] as const);
  const tenantId = options.microsoftTenantId ?? 'organizations';

  // The port is chosen BEFORE the config is built: `OAUTH_REDIRECT_BASE_URL` has
  // to be this server's own origin, because the fake provider redirects the
  // "browser" back to it exactly as a real one would.
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const config: ApiEnv = {
    NODE_ENV: 'test',
    // Quiet unless a test is reading the lines: the flow suite makes a few hundred
    // requests, and a wall of JSON hides the one assertion that failed.
    LOG_LEVEL: options.captureLogs === true ? 'info' : 'fatal',
    APP_VERSION: '0.1.0-flow-test',
    VALKEY_URL: 'redis://127.0.0.1:6379',
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'flow-test-key',
    LIVEKIT_API_SECRET: 'x'.repeat(32),
    API_PORT: port,
    API_DATABASE_URL: 'postgres://unused@127.0.0.1:5432/unused',
    SESSION_COOKIE_SECRET: 'z'.repeat(48),
    WEB_BASE_URL,
    OAUTH_REDIRECT_BASE_URL: baseUrl,
    AUTH_ENABLED_PROVIDERS: [...enabled],
    SESSION_TTL_SECONDS: options.sessionTtlSeconds ?? 3_600,
    SESSION_REFRESH_TTL_SECONDS: options.refreshTtlSeconds ?? 2_592_000,
    OAUTH_STATE_TTL_SECONDS: options.oauthStateTtlSeconds ?? 600,
    // No proxy by default: the harness talks to the server directly, so the
    // socket address IS the client and X-Forwarded-For is ignored entirely. A
    // test that wants the proxy rows declares the loopback peer.
    TRUSTED_PROXY_ADDRESSES: options.trustedProxies ?? NO_TRUSTED_PROXIES,
    RATE_LIMIT_IP_MAX: options.ipLimit ?? 10_000,
    RATE_LIMIT_IP_WINDOW_SECONDS: options.ipWindowSeconds ?? 60,
    RATE_LIMIT_USER_MAX: options.userLimit ?? 10_000,
    RATE_LIMIT_USER_WINDOW_SECONDS: options.userWindowSeconds ?? 60,
    RATE_LIMIT_BRUTE_FORCE_MAX: options.bruteForceLimit ?? 10_000,
    RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS: options.bruteForceLockSeconds ?? 900,
    VALKEY_COMMAND_TIMEOUT_MS: 250,
    GOOGLE_CLIENT_ID: placeholder('google-id'),
    GOOGLE_CLIENT_SECRET: placeholder('google-secret'),
    FACEBOOK_CLIENT_ID: placeholder('facebook-id'),
    FACEBOOK_CLIENT_SECRET: placeholder('facebook-secret'),
    MICROSOFT_CLIENT_ID: placeholder('microsoft-id'),
    MICROSOFT_CLIENT_SECRET: placeholder('microsoft-secret'),
    MICROSOFT_TENANT_ID: tenantId,
    APPLE_CLIENT_ID: placeholder('apple-services-id'),
    APPLE_TEAM_ID: placeholder('apple-team'),
    APPLE_KEY_ID: placeholder('apple-key-id'),
    APPLE_PRIVATE_KEY: generateApplePrivateKey(),
  };

  const fake = new FakeAuthorizationServer();
  await fake.start();
  for (const provider of enabled) {
    const clientId = {
      google: config.GOOGLE_CLIENT_ID,
      facebook: config.FACEBOOK_CLIENT_ID,
      apple: config.APPLE_CLIENT_ID,
      microsoft: config.MICROSOFT_CLIENT_ID,
    }[provider];
    fake.register(provider, clientId ?? '', tenantId);
  }

  const identity = new InMemoryIdentityAdapter();
  const sessions = new InMemorySessionAdapter();
  const audit = new InMemoryAuditAdapter();
  const clock = options.clock ?? new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  // The SAME clock the rest of the flow runs on, so `harness.clock.advance(...)`
  // moves the rate-limit windows too and a "wait out the window" example needs no
  // real sleeping.
  const rateLimit = options.rateLimitPort ?? new InMemoryRateLimitAdapter(clock);

  const logLines: string[] = [];
  const destination = options.captureLogs === true
    ? new Writable({
        write(chunk, _encoding, callback) {
          logLines.push(String(chunk));
          callback();
        },
      })
    : undefined;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forConfig(config, {
      authRuntime: {
        // The wrapper, when a test asked for one. It delegates everything it does
        // not override, so the login that has to happen first still happens.
        identity: options.wrapIdentity === undefined ? identity : options.wrapIdentity(identity),
        sessions,
        audit,
        clock,
        rateLimit,
        // The production registry, built from the production config — only
        // `fetch` is replaced. Discovery, the tenant segment, PKCE, the token
        // exchange and id_token verification all run for real.
        registry: createProviderRegistry(config, fake.fetch),
      },
      ...(destination === undefined ? {} : { logDestination: destination }),
      ...(options.controllers === undefined ? {} : { fixtureControllers: options.controllers }),
    }),
    // The SAME adapter options `main.ts` builds. `trustProxy` is in there, and a
    // harness that built its own would leave the two proxy rows of the matrix
    // testing a server nobody deploys.
    new FastifyAdapter(fastifyAdapterOptions(config)),
    { logger: false, bufferLogs: options.captureLogs === true },
  );

  /**
   * The SAME logger wiring `main.ts` applies, and only when a test is reading the
   * lines.
   *
   * Without `useLogger`, `new Logger(...)` inside a guard or a service writes to
   * the console and never reaches pino — so a test could assert an outage was
   * reported by spying on `Logger.prototype.error`, pass, and say nothing at all
   * about whether production writes that line. Removing `app.useLogger(...)` from
   * `main.ts` would have left every such test green while the one control
   * AGENTS.md tells operators to alert on emitted nothing.
   *
   * `logLines` therefore holds what a REAL pino actually wrote, through the real
   * redaction config, which is also what `logging.test.ts` reads.
   */
  if (options.captureLogs === true) {
    app.useLogger(app.get(PinoLogger));
  }

  // The SAME wiring `main.ts` applies. Without this the harness would be testing a
  // server that has neither CORS nor a form-encoded body parser — which is exactly
  // how a login page that no browser can use passed every test once already.
  configureHttpApp(app, config);
  await app.listen({ port, host: '127.0.0.1' });

  const request = async (
    path: string,
    init: RequestInit & { jar?: CookieJar } = {},
  ): Promise<Response> => {
    const { jar, ...rest } = init;
    const url = new URL(path.startsWith('http') ? path : `${baseUrl}${path}`);
    const headers = new Headers(rest.headers);
    if (jar !== undefined) {
      // Path-aware, like a browser: the refresh cookie at `/v1/auth` is not sent
      // to `/healthz`, and a session cookie cleared at the wrong path is still
      // sent to `/`.
      const cookie = jar.header(url.pathname);
      if (cookie.length > 0) {
        headers.set('cookie', cookie);
      }
    }
    const response = await fetch(url, {
      ...rest,
      headers,
      // Never follow: every assertion here is about the 302 itself — where it
      // points and which cookies ride with it.
      redirect: 'manual',
    });
    jar?.absorb(response);
    return response;
  };

  /** A whole login, `/start` through `/callback`. See {@link LoginOptions}. */
  const login = async (
    provider: AuthProvider,
    profile: FakeProfile,
    options: LoginOptions = {},
  ): Promise<{ jar: CookieJar; callback: Response }> => {
    const { returnPath } = options;
    const jar = options.jar ?? new CookieJar();
    const startPath =
      returnPath === undefined
        ? `/v1/auth/${provider}/start`
        : `/v1/auth/${provider}/start?${SIGN_IN_RETURN_PATH_QUERY_PARAM}=${encodeURIComponent(returnPath)}`;
    const started = await request(startPath, { jar });
    const location = started.headers.get('location');
    if (started.status !== 302 || location === null) {
      throw new Error(`start did not redirect: ${started.status}`);
    }
    const authorized = fake.authorize(location, profile);

    if (authorized.responseMode === 'form_post') {
      // Apple. A cross-site top-level FORM POST, not a redirect — the transport
      // the `SameSite=Lax` state cookie has to survive, and the one that needs a
      // urlencoded body parser on the server.
      const target = new URL(authorized.callbackUrl);
      const body = new URLSearchParams({ code: authorized.code, state: authorized.state });
      const callback = await request(`${target.origin}${target.pathname}`, {
        jar,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return { jar, callback };
    }

    const callback = await request(authorized.callbackUrl, { jar });
    return { jar, callback };
  };

  return {
    baseUrl,
    webBaseUrl: WEB_BASE_URL,
    config,
    fake,
    identity,
    sessions,
    audit,
    clock,
    rateLimit,
    logLines,
    request,
    login,
    close: () => app.close(),
  };
}
