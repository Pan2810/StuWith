import { AUTH_PROVIDERS, isAuthProvider, type AuthProvider } from '@stuwith/contracts';
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

/** Seconds, as an operational knob rather than a secret. */
const seconds = (min: number, max: number, fallback: number) =>
  z.coerce
    .number({ error: 'must be a whole number of seconds' })
    .int()
    .min(min)
    .max(max)
    .default(fallback);

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
