import { z } from 'zod';

/**
 * AD-14 — every knob comes from an environment variable, validated once at
 * startup, and NOTHING in here supplies a default for a secret.
 *
 * The only `.default()` calls below are on operational knobs that are safe to
 * guess wrong (log level, declared version). A connection string, a signing key
 * or an API secret must be absent-or-explicit: guessing one is how a dev laptop
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

export const apiEnvSchema = sharedEnvSchema.extend({
  API_PORT: port,
  /** Connects as the `stuwith_api` role (AD-8). */
  API_DATABASE_URL: secret(),
  /** Session cookie signing key — httpOnly + secure cookies per the spine. */
  SESSION_COOKIE_SECRET: secret(32),
});

export const realtimeGatewayEnvSchema = sharedEnvSchema.extend({
  GATEWAY_PORT: port,
  /** Connects as the `stuwith_realtime` role (AD-8). */
  REALTIME_DATABASE_URL: secret(),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type RealtimeGatewayEnv = z.infer<typeof realtimeGatewayEnvSchema>;
