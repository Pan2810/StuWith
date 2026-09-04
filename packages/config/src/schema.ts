import { AUTH_PROVIDERS, isAuthProvider, type AuthProvider } from '@stuwith/contracts';
// One implementation of "who is trusted", shared with Fastify. See
// `trusted-proxies.ts` for why there is no parser of our own any more.
import { NO_TRUSTED_PROXIES, compileTrustedProxies } from './trusted-proxies';
import { z } from 'zod';

/**
 * AD-14 — every knob comes from an environment variable, validated once at
 * startup, and NOTHING in here supplies a default for a secret.
 *
 * The only `.default()` calls below are on operational knobs that are safe to
 * guess wrong (log level, declared version, a TTL). A connection string, a signing
 * key or an API secret must be absent-or-explicit: guessing one is how a dev laptop
 * silently talks to something it should not.
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const port = z.coerce
  .number({ error: 'must be a TCP port number' })
  .int()
  .min(1)
  .max(65535);

/** A secret: required, non-empty, never defaulted. */
const secret = (minLength = 1) =>
  z.string({ error: 'is required and must not be empty' }).min(minLength);

const url = z.string({ error: 'is required' }).min(1);

/** A browser-reachable origin. The scheme is checked because a redirect target
 * without one is not a URL a browser will follow, and the failure would otherwise
 * appear as a broken login rather than as a configuration error. */
const httpUrl = z
  .string({ error: 'is required' })
  .min(1)
  .regex(/^https?:\/\/[^\s]+$/, 'must be an absolute http(s) URL')
  // A trailing slash silently produces `https://host//v1/auth/...`, which several
  // providers reject as a redirect_uri mismatch with no useful message.
  .refine((value) => !value.endsWith('/'), 'must not end with a trailing slash');

/**
 * A whole number written as digits, and nothing else.
 *
 * NOT `z.coerce.number()`, which is `Number()` underneath and therefore accepts
 * `0x10` (16), `1e3` (1000), `' 30 '` and `'30.0'`. None of those is the number
 * the operator typed, and a limit that silently means something else is the kind
 * of setting nobody re-reads. A digit string is what every one of these values is
 * in `.env.example`, so the strictness costs nothing and removes a whole class of
 * "the config says 1e3 and the log says 1000".
 *
 * The `unknown` input type is deliberate: `process.env` values are strings, but a
 * test may pass a number, and a number that is already a whole number is fine.
 */
function onlyDigits(value: unknown): unknown {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]{1,12}$/.test(value)) {
    return Number(value);
  }
  // Anything else reaches `z.number()` unchanged and is rejected there, naming
  // the variable — rather than being coerced into a number nobody wrote.
  return value;
}

const wholeNumber = (label: string, min: number, max: number, fallback: number) =>
  z.preprocess(onlyDigits, z.number({ error: label }).int().min(min).max(max)).default(fallback);

/** Seconds, as an operational knob rather than a secret. */
const seconds = (min: number, max: number, fallback: number) =>
  wholeNumber('must be a whole number of seconds, written as digits', min, max, fallback);

/** A count, as an operational knob rather than a secret. */
const count = (min: number, max: number, fallback: number) =>
  wholeNumber('must be a whole number, written as digits', min, max, fallback);

/**
 * The addresses of the reverse proxies that sit in front of this process.
 *
 * REQUIRED, with no default, and the one operational knob in this file that is
 * treated like a secret — because every possible guess is wrong in a way nothing
 * reports:
 *
 * - guess "no proxy" while Caddy terminates TLS in front, and every request
 *   appears to come from Caddy — one person tripping the rate limit locks out the
 *   entire product;
 * - guess "trust the header" on a deployment with no proxy, and `X-Forwarded-For`
 *   is whatever the client typed — anybody picks their own rate-limit key, so the
 *   blocking layer exists and blocks nothing.
 *
 * Both produce a green CI run and a healthy-looking deployment.
 *
 * ## Why an address list rather than a hop count
 *
 * A hop count cannot check WHO the immediate peer is, so a client connecting
 * straight to the API port walks past it by supplying enough hops. `fastify@5.12.1`
 * removed numeric `trustProxy` for exactly that reason. The value here is a list
 * of addresses and CIDRs; `X-Forwarded-For` is read only when the socket peer is
 * one of them.
 *
 * ## Why "names no proxy" is rejected in every spelling but one
 *
 * Three near-empty values used to pass, each producing `trustProxy: false` in
 * silence — the "every visitor is one bucket" failure, arriving from a typo:
 *
 * - `''`. It was read with `z.coerce.number()`, and `Number('')` is `0`, which
 *   passed the old `.min(0)`. Because zod raised nothing, `toProblems`'
 *   empty-string-means-missing mapping never ran either.
 * - `','` and `' , '`. Length is 1, so `.trim().min(1)` was satisfied, and the
 *   parser returned zero proxies with an empty `invalid` list, so nothing
 *   complained.
 *
 * The parser now reports "this names no proxy" as invalid unless the operator
 * literally wrote {@link NO_TRUSTED_PROXIES}. A range wide enough to trust every
 * peer (`0.0.0.0/0`, `::/0`) is refused the same way, from the other direction.
 */
const trustedProxyAddresses = z
  .string({ error: 'is required — proxy addresses/CIDRs, or the word "none"' })
  .trim()
  .min(1, 'must not be empty — write "none" if no proxy sits in front of this process')
  .superRefine((raw, ctx) => {
    const compiled = compileTrustedProxies(raw);
    if (!compiled.ok) {
      ctx.addIssue({ code: 'custom', message: compiled.problem });
    }
  });

function splitProviders(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

/**
 * Which of the four providers this deployment actually offers.
 *
 * The list exists because the acceptance criterion wants four providers while the
 * real credentials do not exist yet (human decision, 2026-09-04). Requiring all
 * four would mean `api` cannot start on any developer machine; giving a credential
 * a default would break AD-14. An explicit list keeps both: "half configured" is a
 * state that cannot exist, because an enabled provider with a missing secret kills
 * the process and a provider that is not listed answers `404`.
 *
 * The default is the EMPTY list — fail closed. A deployment that forgets this
 * variable offers no logins, which is visible immediately; the alternative default
 * would be to guess which providers someone has registered an app with.
 */
const enabledProviders = z
  .string()
  .default('')
  .superRefine((raw, ctx) => {
    const names = splitProviders(raw);
    for (const name of names) {
      if (!isAuthProvider(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown provider "${name}" — allowed values are ${AUTH_PROVIDERS.join(', ')}`,
        });
      }
    }
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', message: 'must not list the same provider twice' });
    }
  })
  .transform((raw): readonly AuthProvider[] => splitProviders(raw).filter(isAuthProvider));

/**
 * Per-provider credentials are declared optional HERE and made mandatory BELOW by
 * `superRefine`, conditional on the provider being enabled.
 *
 * Declaring them `optional()` is not a softening of AD-14: a credential for a
 * provider nobody offers is genuinely not required, and demanding it would force
 * an operator to invent a value — which is precisely the "make something up"
 * behaviour AD-14 exists to prevent.
 */
const optionalSecret = z.string().min(1).optional();

/**
 * Which variables each provider needs, and therefore which names the startup
 * failure will print. One table, so the config error and the provider adapter
 * cannot disagree about what "configured" means.
 */
export const PROVIDER_CREDENTIAL_VARIABLES = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  facebook: ['FACEBOOK_CLIENT_ID', 'FACEBOOK_CLIENT_SECRET'],
  // Entra needs the tenant: it selects the authority URL, and `common` vs a
  // tenant id is the difference between accepting any Microsoft account and
  // accepting one organisation's accounts.
  microsoft: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID'],
  // Apple has no static client secret: it is a short-lived ES256 JWT signed with a
  // downloaded .p8 key, so the team id, key id and key itself are all required.
  apple: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'],
} as const satisfies Record<AuthProvider, readonly string[]>;

export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),

  // Infrastructure both processes talk to.
  VALKEY_URL: url,
  LIVEKIT_URL: url,
  LIVEKIT_API_KEY: secret(),
  LIVEKIT_API_SECRET: secret(32),
});

const apiEnvShape = sharedEnvSchema.extend({
  API_PORT: port,
  /** Connects as the `stuwith_api` role (AD-8). */
  API_DATABASE_URL: secret(),
  /**
   * Session cookie signing key — httpOnly + secure cookies per the spine. Also the
   * HMAC key the session and refresh tokens are hashed with before they are
   * stored, so a stolen database dump alone is not enough to forge a cookie.
   */
  SESSION_COOKIE_SECRET: secret(32),

  /** Where a completed login sends the browser back to. */
  WEB_BASE_URL: httpUrl,
  /**
   * The public origin of `apps/api`, used to build `redirect_uri`. It is separate
   * from `WEB_BASE_URL` because the two are different hosts in production and the
   * value must match, byte for byte, what is registered with each provider.
   */
  OAUTH_REDIRECT_BASE_URL: httpUrl,

  AUTH_ENABLED_PROVIDERS: enabledProviders,

  /** One hour: long enough not to be noticed, short enough that a stolen cookie ages out. */
  SESSION_TTL_SECONDS: seconds(60, 86_400, 3_600),
  /** Thirty days, rotated on every use. */
  SESSION_REFRESH_TTL_SECONDS: seconds(300, 7_776_000, 2_592_000),
  /** How long a half-finished login may sit at the provider's consent screen. */
  OAUTH_STATE_TTL_SECONDS: seconds(60, 3_600, 600),

  /**
   * Story 1.3 part 2 — the blocking layer in front of `/v1/auth/*`.
   *
   * Everything below except the proxy list is an operational knob with a sensible
   * default, which is the same distinction AD-14 already draws for the session
   * TTLs: a limit that is guessed slightly wrong is visible and adjustable, while
   * a credential that is guessed at all is a security hole. The proxy list is the
   * one exception in this block and is required with no default — see
   * {@link trustedProxyAddresses}.
   */
  TRUSTED_PROXY_ADDRESSES: trustedProxyAddresses,

  /**
   * Per address, and the number ALLOWED — the request after it is the one refused.
   * Generous: a shared office NAT is one address for everybody in it.
   */
  RATE_LIMIT_IP_MAX: count(1, 10_000, 30),
  RATE_LIMIT_IP_WINDOW_SECONDS: seconds(1, 3_600, 60),

  /**
   * Per credential, and therefore per account holder, whichever address they
   * arrive from. Tighter than the IP budget because it cannot be shared by
   * innocent bystanders the way one NAT address can.
   */
  RATE_LIMIT_USER_MAX: count(1, 10_000, 10),
  RATE_LIMIT_USER_WINDOW_SECONDS: seconds(1, 3_600, 60),

  /**
   * Consecutive sign-in failures ALLOWED before the longer lock starts — the one
   * after this number is the one that locks — and how long that lock lasts. Deliberately separate from the two budgets above: an ordinary
   * window forgives a burst of noise in a minute, while repeated failure is the
   * shape of somebody working through a list and should cost a great deal more.
   */
  RATE_LIMIT_BRUTE_FORCE_MAX: count(1, 1_000, 5),
  RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS: seconds(1, 86_400, 900),

  /**
   * How long one Valkey command may take before it is treated as an outage.
   *
   * Small on purpose. The layer is fail-open (human decision, 2026-09-04), so a
   * slow Valkey ends with the request going through anyway — and every
   * millisecond spent waiting for that conclusion is added to a login that was
   * always going to succeed.
   */
  VALKEY_COMMAND_TIMEOUT_MS: count(10, 10_000, 250),

  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,

  FACEBOOK_CLIENT_ID: optionalSecret,
  FACEBOOK_CLIENT_SECRET: optionalSecret,

  MICROSOFT_CLIENT_ID: optionalSecret,
  MICROSOFT_CLIENT_SECRET: optionalSecret,
  MICROSOFT_TENANT_ID: optionalSecret,

  APPLE_CLIENT_ID: optionalSecret,
  APPLE_TEAM_ID: optionalSecret,
  APPLE_KEY_ID: optionalSecret,
  APPLE_PRIVATE_KEY: optionalSecret,
});

/**
 * AD-14's conditional half: a provider that is switched on must be switched on
 * completely.
 *
 * The issue is raised against the exact variable name, so `formatProblems` prints
 * `GOOGLE_CLIENT_SECRET` rather than "OAuth is misconfigured" — and because the
 * whole check runs before `app.listen()`, the port never opens on a half-configured
 * provider. Silently disabling the provider instead would be worse than failing:
 * the deployment would come up looking healthy and simply stop offering a login
 * that its users had yesterday.
 */
export const apiEnvSchema = apiEnvShape.superRefine((config, ctx) => {
  // When AUTH_ENABLED_PROVIDERS itself failed to parse, zod hands this check the
  // RAW string rather than the transformed list — and iterating a string yields
  // its characters, which used to crash here instead of reporting the real
  // problem. The already-reported field error is the useful message; there is
  // nothing to add.
  const enabled: readonly AuthProvider[] = Array.isArray(config.AUTH_ENABLED_PROVIDERS)
    ? (config.AUTH_ENABLED_PROVIDERS as readonly unknown[]).filter(isAuthProvider)
    : [];

  for (const provider of enabled) {
    for (const variable of PROVIDER_CREDENTIAL_VARIABLES[provider]) {
      const value = (config as Record<string, unknown>)[variable];
      if (typeof value !== 'string' || value.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [variable],
          message: `is required because ${provider} is listed in AUTH_ENABLED_PROVIDERS`,
        });
      }
    }
  }
});

export const realtimeGatewayEnvSchema = sharedEnvSchema.extend({
  GATEWAY_PORT: port,
  /** Connects as the `stuwith_realtime` role (AD-8). */
  REALTIME_DATABASE_URL: secret(),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type RealtimeGatewayEnv = z.infer<typeof realtimeGatewayEnvSchema>;

/**
 * The credentials of the providers this deployment actually offers, in a shape
 * that has no `undefined` in it.
 *
 * `apps/api` never reads an environment variable name: it asks for this list. That
 * keeps the mapping from "provider" to "which four variables" in exactly one place
 * — the same place that produced the startup error naming them.
 *
 * The throws below are unreachable by construction (the schema refuses to produce
 * a config that would reach them). They are `throw` rather than `!` because an
 * unreachable branch that is wrong should stop the process, not hand a provider
 * adapter the string "undefined" as a client secret.
 */
export type ProviderCredentials =
  | { readonly provider: 'google'; readonly clientId: string; readonly clientSecret: string }
  | { readonly provider: 'facebook'; readonly clientId: string; readonly clientSecret: string }
  | {
      readonly provider: 'microsoft';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly tenantId: string;
    }
  | {
      readonly provider: 'apple';
      readonly clientId: string;
      readonly teamId: string;
      readonly keyId: string;
      readonly privateKey: string;
    };

function required(config: ApiEnv, variable: string): string {
  const value = (config as unknown as Record<string, unknown>)[variable];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `[config] ${variable} is missing although its provider is enabled. ` +
        'The environment schema should have refused to start; this is a bug in packages/config.',
    );
  }
  return value;
}

export function providerCredentials(config: ApiEnv, provider: AuthProvider): ProviderCredentials {
  switch (provider) {
    case 'google':
      return {
        provider,
        clientId: required(config, 'GOOGLE_CLIENT_ID'),
        clientSecret: required(config, 'GOOGLE_CLIENT_SECRET'),
      };
    case 'facebook':
      return {
        provider,
        clientId: required(config, 'FACEBOOK_CLIENT_ID'),
        clientSecret: required(config, 'FACEBOOK_CLIENT_SECRET'),
      };
    case 'microsoft':
      return {
        provider,
        clientId: required(config, 'MICROSOFT_CLIENT_ID'),
        clientSecret: required(config, 'MICROSOFT_CLIENT_SECRET'),
        tenantId: required(config, 'MICROSOFT_TENANT_ID'),
      };
    case 'apple':
      return {
        provider,
        clientId: required(config, 'APPLE_CLIENT_ID'),
        teamId: required(config, 'APPLE_TEAM_ID'),
        keyId: required(config, 'APPLE_KEY_ID'),
        privateKey: required(config, 'APPLE_PRIVATE_KEY'),
      };
  }
}

export function enabledProviderCredentials(config: ApiEnv): readonly ProviderCredentials[] {
  return config.AUTH_ENABLED_PROVIDERS.map((provider) => providerCredentials(config, provider));
}
