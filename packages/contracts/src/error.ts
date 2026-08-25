import { z } from 'zod';

/**
 * AD-13 + spine "Hình dạng lỗi": exactly one error envelope for every boundary.
 *
 * `code` is a machine-readable constant, `message` is already i18n'd for a human.
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

/**
 * `details` is where diagnostics leak out of a system, so the shape is narrow by
 * construction rather than by convention.
 *
 * Two rules, both mechanical:
 *
 *  1. **Reserved key names are rejected.** `stack`, `trace`, `sql`, `cause` and
 *     friends are the names a developer reaches for when they want to "just
 *     include a bit more context"; refusing them at the boundary makes that an
 *     explicit decision instead of an accident. Enforced by the negative
 *     lookahead below, which JSON Schema keeps as a `pattern`.
 *  2. **Values are short, single-line scalars.** A stack trace, a SQL statement
 *     and a provider error body are all multi-line, or long, or both. Capping at
 *     one line of 200 characters means none of them fits, whatever key it is
 *     given. This is the property the schema actually guarantees — not "contains
 *     no stack trace" in the abstract, which no schema can decide.
 *
 * Anything richer than that belongs in the log (behind the AD-15 PII filter),
 * never in a response body (docs/prd.md US-0.1 AC4).
 *
 * Caveat worth knowing: zod emits the VALUE constraints into JSON Schema but
 * drops the record's key constraint, so the published OpenAPI is a weaker
 * projection of this schema than the runtime check is. The runtime check is the
 * one that runs at the boundary; consumers reading the OpenAPI just see a
 * slightly looser contract than they will actually be held to.
 */
export const RESERVED_DETAIL_KEYS = [
  'stack',
  'stacktrace',
  'stack_trace',
  'trace',
  'traceback',
  'cause',
  'exception',
  'sql',
  'query',
  'sqlstate',
  'internal',
  'provider_error',
  'providererror',
] as const;

export const DETAIL_VALUE_MAX_LENGTH = 200;

const reservedKeyAlternation = RESERVED_DETAIL_KEYS.join('|');

/**
 * A lower_snake_case identifier that is not one of the reserved names.
 * `(?!...)` is ECMA-262, which is the dialect JSON Schema `pattern` uses, so this
 * survives OpenAPI emission instead of being silently dropped.
 */
export const detailKeySchema = z
  .string()
  .regex(
    new RegExp(`^(?!(?:${reservedKeyAlternation})$)[a-z][a-z0-9_]{0,39}$`),
    'detail keys must be lower_snake_case and must not be a reserved diagnostic name',
  );

export const detailValueSchema = z.union([
  z
    .string()
    .max(DETAIL_VALUE_MAX_LENGTH)
    .regex(/^[^\r\n]*$/, 'detail values must be a single line'),
  z.number(),
  z.boolean(),
]);

export const errorDetailsSchema = z.record(detailKeySchema, detailValueSchema);

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  details: errorDetailsSchema.optional(),
});

export const errorEnvelopeSchema = z.object({
  error: errorBodySchema,
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean>,
): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
