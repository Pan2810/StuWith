import { z } from 'zod';

/**
 * AD-13 + spine "Hình dạng lỗi": exactly one error envelope for every boundary.
 *
 * `code` is a machine-readable constant, `message` is already i18n'd for a human.
 * A stack trace or an upstream provider's error code must never reach a client
 * (docs/prd.md US-0.1 AC4), so `details` is deliberately a shallow record of
 * already-safe values, not an arbitrary payload.
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'rate_limited',
  'conflict',
  'internal_error',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const errorEnvelopeSchema = z.object({
  error: errorBodySchema,
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean>,
): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
