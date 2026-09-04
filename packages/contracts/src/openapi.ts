import { z } from 'zod';
import { auditEventSchema } from './audit';
import {
  SIGN_IN_OUTCOME_QUERY_PARAM,
  currentUserSchema,
  signInOutcomeSchema,
} from './auth';
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
  // Published as a component rather than only described in prose: a client
  // reading this document has to be able to DISCOVER that `that-bai` and
  // `da-huy` are the whole set. A closed enum that only exists in a sentence is
  // one a consumer will re-derive by guessing from the values it happens to see.
  SignInOutcome: signInOutcomeSchema,
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
 * they answer a redirect or an error envelope — so there is nothing to register
 * beyond the envelope and the outcome vocabulary.
 */
/**
 * The callback, described once and published under BOTH methods.
 *
 * `@Get` and `@Post` share a single outcome path in the service — that is the
 * story's stated invariant and there is a test for the POST cancellation — so a
 * document that mentions only `get:` tells an Apple integrator the form_post
 * transport is unsupported. Apple REQUIRES `response_mode=form_post` once the
 * scope asks for `name` or `email`, which makes the POST the normal case for one
 * of the four providers rather than an edge.
 */
function callbackPath(): Record<string, unknown> {
  const description =
    'Every outcome except an unknown provider is a redirect back to the web ' +
    "client's login page. A failed or cancelled attempt carries " +
    `?${SIGN_IN_OUTCOME_QUERY_PARAM}=<SignInOutcome>; a successful one carries ` +
    'no query at all. The code never carries a provider name, a provider error ' +
    'code or an internal reason.';

  const parameters = [
    { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
  ];

  const responses = {
    // Deliberately NOT a 401 with an error envelope. The person arrives here by a
    // browser redirect from the provider, so a JSON body would be the page they
    // end up staring at.
    '302': { description: 'Session opened; redirect back to the web client' },
    // 303 rather than 302 for the outcome redirect, so that the method is
    // unambiguously downgraded to GET after Apple's form POST. There is no body:
    // the outcome rides in the Location header's query string, which is why it is
    // documented as a header rather than as content.
    '303': {
      description: 'The attempt ended without a session; redirect back to the login page',
      headers: {
        Location: {
          description:
            'The login page URL, carrying ' +
            `?${SIGN_IN_OUTCOME_QUERY_PARAM}=<SignInOutcome>. The permitted ` +
            'values are published as the SignInOutcome component schema.',
          schema: { type: 'string', format: 'uri' },
        },
      },
    },
    '404': {
      description: 'The provider is not enabled on this deployment',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
      },
    },
  };

  return {
    get: {
      summary: 'Provider redirect target — opens a session on success',
      description,
      parameters: [
        ...parameters,
        { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        {
          name: 'error',
          in: 'query',
          required: false,
          description: "The provider's own refusal code, if it refused.",
          schema: { type: 'string' },
        },
      ],
      responses,
    },
    post: {
      summary: "Apple's form_post callback — the same outcomes, delivered as a body",
      description,
      parameters,
      requestBody: {
        required: false,
        content: {
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                state: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      responses,
    },
  };
}

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
    '/v1/auth/{provider}/callback': callbackPath(),
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
