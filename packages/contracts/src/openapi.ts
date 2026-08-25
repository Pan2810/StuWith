import { z } from 'zod';
import { errorEnvelopeSchema } from './error';
import { healthResponseSchema } from './health';

/**
 * AD-13 requires the contract package to be able to *emit* OpenAPI, so that a
 * compatibility diff against the published `/v1` is a mechanical check rather
 * than a reviewer's memory (TD-6 chose this over Pact for the MVP).
 */
export const CONTRACT_VERSION = 'v1';

const REGISTERED_SCHEMAS = {
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
