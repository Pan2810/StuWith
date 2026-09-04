import { z } from 'zod';
import { auditEventSchema } from './audit';
import { currentUserSchema } from './auth';
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
  CurrentUser: currentUserSchema,
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

const unauthenticated = {
  description: 'No usable session',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
  },
} as const;

/**
 * The auth paths are described here rather than in `apps/api` for the same reason
 * the schemas are: a mobile client reads this document, and a path that only
 * exists as a NestJS decorator is invisible to it (AD-13).
 *
 * The redirect endpoints (`/start`, `/callback`) carry no response body at all —
 * they answer `302` or an error envelope — so there is nothing to register beyond
 * the envelope itself.
 */
function authPaths(): Record<string, unknown> {
  return {
    '/v1/auth/{provider}/start': {
      get: {
        summary: 'Begin an OAuth 2.0 authorization-code + PKCE login',
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '302': { description: 'Redirect to the provider authorization endpoint' },
          '404': {
            description: 'The provider is not enabled on this deployment',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
            },
          },
        },
      },
    },
    '/v1/auth/{provider}/callback': {
      get: {
        summary: 'Provider redirect target — opens a session on success',
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '302': { description: 'Session opened; redirect back to the web client' },
          '401': unauthenticated,
          '404': {
            description: 'The provider is not enabled on this deployment',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
            },
          },
        },
      },
    },
    '/v1/auth/refresh': {
      post: {
        summary: 'Rotate the refresh token and re-issue both session cookies',
        responses: {
          '204': { description: 'Rotated; new cookies are set' },
          '401': unauthenticated,
        },
      },
    },
    '/v1/auth/logout': {
      post: {
        summary: 'Revoke the whole session chain and clear the cookies',
        responses: { '204': { description: 'Cookies cleared' } },
      },
    },
    '/v1/auth/me': {
      get: {
        summary: 'The signed-in profile — no email, no provider id',
        responses: {
          '200': {
            description: 'The signed-in user',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CurrentUser' } },
            },
          },
          '401': unauthenticated,
        },
      },
    },
  };
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
      ...authPaths(),
    },
    components: toOpenApiComponents(),
  };
}
