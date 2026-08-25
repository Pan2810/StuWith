import { z } from 'zod';
import { auditEventSchema } from './audit';
import { errorEnvelopeSchema } from './error';
import { healthResponseSchema } from './health';

/**
 * AD-13 requires the contract package to be able to *emit* OpenAPI, so that a
 * compatibility diff against the published `/v1` is a mechanical check rather
 * than a reviewer's memory (TD-6 chose this over Pact for the MVP).
 */
export const CONTRACT_VERSION = 'v1';

/**
 * Everything the contract package publishes. A schema that is not in this map is
 * not part of the emitted contract, so leaving one out is a silent omission —
 * which is why `contracts.test.ts` asserts membership per schema rather than
 * asserting the exact size of the map. An assertion on the size turns "we forgot
 * one" into "the test that would have caught it also needs updating".
 *
 * `AuditEvent` belongs here even though it is a database row rather than an HTTP
 * body: AD-8 has BOTH processes writing `audit_events`, so its shape is a
 * cross-process contract and has to be published like one.
 */
const REGISTERED_SCHEMAS = {
  AuditEvent: auditEventSchema,
  ErrorEnvelope: errorEnvelopeSchema,
  HealthResponse: healthResponseSchema,
} as const;

export type RegisteredSchemaName = keyof typeof REGISTERED_SCHEMAS;

export function toOpenApiComponents(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(REGISTERED_SCHEMAS)) {
    schemas[name] = z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output' });
  }
  return { schemas };
}

export function toOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'StuWith API', version: CONTRACT_VERSION },
    paths: {
      '/healthz': {
        get: {
          summary: 'Liveness probe',
          responses: {
            '200': {
              description: 'Service is up',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
          },
        },
      },
    },
    components: toOpenApiComponents(),
  };
}
