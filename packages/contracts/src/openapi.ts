import { z } from 'zod';
import { auditEventSchema } from './audit';
import {
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_ME_PATH,
  AUTH_REFRESH_PATH,
  DATE_OF_BIRTH_FIELD,
  DATE_OF_BIRTH_PATHNAME,
  MAX_SIGN_IN_RETURN_PATH_LENGTH,
  MIN_DATE_OF_BIRTH_YEAR,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETURN_PATH_QUERY_PARAM,
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
 * The answer a rate-limited `fetch` leg gets, which the document did not mention
 * anywhere at all.
 *
 * Every `/v1/auth` route but `logout` carries `@RateLimited(...)`, so `429` is an
 * ordinary answer rather than an exception — and a client written against a
 * document that does not mention it has no reason to read `Retry-After` and every
 * reason to retry immediately, which is the loop the limit exists to break.
 *
 * Only the `json`-channel legs are documented with it. `/start` and `/callback`
 * are reached by a browser following a navigation, so their refusal travels as a
 * `303` back to the login page rather than as an envelope; documenting a `429`
 * there would describe an answer those routes never give.
 */
const rateLimited = {
  description:
    'Too many attempts. The `Retry-After` header carries how many seconds to ' +
    'wait; the message says nothing about which limit was reached.',
  /**
   * DECLARED, not merely described in prose.
   *
   * The sentence above said the header exists and nothing machine-readable said
   * so, which means a generated client never sees it: the whole reason this story
   * documents `429` at all is that a client with no reason to read `Retry-After`
   * retries immediately, and that is the loop the limit exists to break. A
   * description is for a person; a `headers` block is for the code generator.
   */
  headers: {
    'Retry-After': {
      description:
        'Whole seconds to wait before trying again. Always a delay in seconds, ' +
        'never an HTTP date.',
      required: true,
      schema: { type: 'integer', minimum: 0 },
    },
  },
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
    // The rate-limited answer is HERE, folded into the outcome redirect, and not
    // as a `429` beside it. `/callback` carries `@RateLimited('auth_callback')` on
    // the BROWSER channel exactly as `/start` does, so a refusal travels as this
    // same 303 back to the login page — a `429` with an envelope would describe an
    // answer this route never gives, and leaving it undocumented left an
    // integrator reading `get:`/`post:` with no idea the limit applies here at all.
    '303': {
      description:
        'The attempt ended without a session; redirect back to the login page. ' +
        'A rate-limited attempt ends the same way and is not distinguishable ' +
        'from any other refusal by the browser.',
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
          {
            // Documented because a mobile client has the same problem — a session
            // that dies mid-use — and this is the ONE leg that accepts a return
            // path. The description says so, because an integrator who tried to
            // pass it on the callback instead would find it silently ignored and
            // have no way to learn why.
            name: SIGN_IN_RETURN_PATH_QUERY_PARAM,
            in: 'query',
            required: false,
            description:
              'An internal path to return to after a SUCCESSFUL sign-in, proposed ' +
              'by the client. It must begin with exactly one "/" and carry no ' +
              'host, scheme, percent escape, backslash or ".." segment; anything ' +
              'else is dropped in silence and the login lands on the default. The ' +
              'value is checked here, signed into the OAuth state, and read back ' +
              'from that signature — the callback never reads a path from a URL, ' +
              'a cookie of its own or a header. A failed attempt drops it.',
            schema: { type: 'string', maxLength: MAX_SIGN_IN_RETURN_PATH_LENGTH },
          },
        ],
        responses: {
          '302': { description: 'Redirect to the provider authorization endpoint' },
          // The browser channel's refusal: a rate-limited navigation goes back to
          // the login page carrying the outcome, not to a JSON body a person would
          // be shown as a page of braces.
          '303': {
            description:
              'Too many attempts. Redirect to the sign-in page carrying the ' +
              'rate-limited outcome and the seconds to wait.',
          },
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
    [AUTH_REFRESH_PATH]: {
      post: {
        summary: 'Rotate the refresh token and re-issue both session cookies',
        responses: {
          '204': { description: 'Rotated; new cookies are set' },
          '401': unauthenticated,
          '429': rateLimited,
        },
      },
    },
    '/v1/auth/logout': {
      post: {
        summary: 'Revoke the whole session chain and clear the cookies',
        responses: { '204': { description: 'Cookies cleared' } },
      },
    },
    [AUTH_ME_PATH]: {
      get: {
        summary: 'The signed-in profile — no email, no provider id, no date of birth',
        description:
          'Answers identically whether or not the profile has been completed; ' +
          'the two booleans say which. Refusing an incomplete profile here would ' +
          'lock somebody out of the only endpoint that can tell them what is ' +
          'missing.',
        responses: {
          '200': {
            description: 'The signed-in user',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CurrentUser' } },
            },
          },
          '401': unauthenticated,
          '429': rateLimited,
        },
      },
    },
    [AUTH_DATE_OF_BIRTH_PATH]: dateOfBirthPath(),
  };
}

/**
 * The first-login declaration, described here because a mobile client has the
 * same step to complete and a route that exists only as a NestJS decorator is
 * invisible to it (AD-13).
 *
 * Two things the document has to say that a schema cannot: that the write happens
 * exactly ONCE, and that there is no endpoint to change it afterwards. An
 * integrator who assumed a `PATCH` existed would build a settings screen around a
 * route that will never be added.
 */
function dateOfBirthPath(): Record<string, unknown> {
  return {
    post: {
      summary: 'Declare the date of birth — once, and only once',
      description:
        'Writes the date of birth on a profile that has none. A profile that ' +
        'already has one is refused with 409 and the stored value is unchanged, ' +
        'including when two requests arrive at the same moment: the write is a ' +
        'single conditional UPDATE, so exactly one of them can win. There is ' +
        'deliberately no endpoint that changes an existing value — that goes ' +
        'through support. The date is never echoed back and never appears in any ' +
        'response; what the caller gets is the same CurrentUser projection ' +
        `${'`GET /v1/auth/me`'} returns, carrying the two booleans. ` +
        // The half of `DATE_OF_BIRTH_PATHNAME`'s docblock that was not true until
        // this line existed: it claims `apps/api` publishes the web route in the
        // OpenAPI description of the endpoint behind it, and nothing here referred
        // to the constant at all. A mobile client has no `/khai-ngay-sinh` of its
        // own, but a web integrator sending somebody to the step needs the URL,
        // and this is the one document both processes read.
        `The browser-facing screen for this step lives at ${DATE_OF_BIRTH_PATHNAME}.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: [DATE_OF_BIRTH_FIELD],
              properties: {
                [DATE_OF_BIRTH_FIELD]: {
                  type: 'string',
                  // Published so a client formats it the one accepted way rather
                  // than sending `toISOString()` and being refused with a sentence
                  // that deliberately does not explain formats.
                  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                  description:
                    'A calendar day as YYYY-MM-DD. No time, no time zone, no ' +
                    'surrounding whitespace. Must name a day that exists, must ' +
                    `not be in the future, and must be in ${String(MIN_DATE_OF_BIRTH_YEAR)} or later.`,
                  example: '1999-04-02',
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Recorded; the updated profile, with no date of birth in it',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CurrentUser' } },
          },
        },
        '400': {
          description: 'The value is not a usable date of birth. Nothing was written.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
        '401': unauthenticated,
        '409': {
          description:
            'The profile already has a date of birth. The stored value is ' +
            'unchanged and is not disclosed.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
        '429': rateLimited,
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
