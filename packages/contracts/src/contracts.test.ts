import { describe, expect, it } from 'vitest';
import { auditEventSchema, toAuditWireTimestamp } from './audit';
import {
  DETAIL_VALUE_MAX_LENGTH,
  RESERVED_DETAIL_KEYS,
  errorEnvelopeSchema,
  makeError,
} from './error';
import { healthResponseSchema } from './health';
import { toOpenApiDocument } from './openapi';

describe('error envelope', () => {
  it('accepts the one shape the whole system is allowed to emit', () => {
    expect(errorEnvelopeSchema.parse(makeError('rate_limited', 'Thử lại sau ít giây.'))).toEqual({
      error: { code: 'rate_limited', message: 'Thử lại sau ít giây.' },
    });
  });

  it('rejects an unknown code, so a provider error cannot be forwarded verbatim', () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: 'oauth_provider_500', message: 'boom' } }),
    ).toThrow();
  });
});

describe('error details — the constraints that actually hold', () => {
  const withDetails = (details: unknown) => ({
    error: { code: 'internal_error', message: 'x', details },
  });

  it('rejects a stack trace passed as a PLAIN STRING, not just as a nested object', () => {
    // The original version of this test only nested an object under `stack`, so it
    // passed because `details` refuses objects — not because it refuses stack
    // traces. A plain string is the shape a real leak takes.
    const result = errorEnvelopeSchema.safeParse(
      withDetails({ stack: 'Error: boom\n    at handler (/srv/app/dist/main.js:41:7)' }),
    );
    expect(result.success).toBe(false);
  });

  it.each(RESERVED_DETAIL_KEYS)('rejects the reserved diagnostic key %s', (key) => {
    expect(errorEnvelopeSchema.safeParse(withDetails({ [key]: 'anything' })).success).toBe(false);
  });

  it('rejects a multi-line value under ANY key — no stack trace fits on one line', () => {
    expect(
      errorEnvelopeSchema.safeParse(withDetails({ note: 'line one\n    at line two' })).success,
    ).toBe(false);
  });

  it('rejects a value longer than the cap', () => {
    expect(
      errorEnvelopeSchema.safeParse(withDetails({ note: 'z'.repeat(DETAIL_VALUE_MAX_LENGTH + 1) }))
        .success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse(withDetails({ note: 'z'.repeat(DETAIL_VALUE_MAX_LENGTH) }))
        .success,
    ).toBe(true);
  });

  it('rejects a nested object', () => {
    expect(errorEnvelopeSchema.safeParse(withDetails({ meta: { deep: true } })).success).toBe(false);
  });

  it('still allows the short scalars a client genuinely needs', () => {
    expect(
      errorEnvelopeSchema.parse(withDetails({ retry_after_seconds: 30, field: 'date_of_birth' })),
    ).toBeTruthy();
  });
});

describe('health response', () => {
  it('accepts both services and nothing else', () => {
    for (const service of ['api', 'realtime-gateway'] as const) {
      expect(healthResponseSchema.parse({ status: 'ok', service, version: '0.1.0' })).toEqual({
        status: 'ok',
        service,
        version: '0.1.0',
      });
    }
    expect(() =>
      healthResponseSchema.parse({ status: 'ok', service: 'web', version: '0.1.0' }),
    ).toThrow();
  });
});

describe('audit event', () => {
  const row = {
    id: '019200f0-0000-7000-8000-000000000000',
    source_service: 'api',
    action: 'auth.signed_in',
    actor_user_id: null,
    subject_id: null,
    request_id: 'req-1',
    occurred_at: '2026-08-21T00:00:00.000Z',
    metadata: {},
  };

  it('validates a row that has been through JSON', () => {
    // The point of the fix: a row serialised and re-parsed must still validate.
    // With `z.date()` this threw, which meant the "runtime validated" claim in the
    // spec was false for every row that crossed the process boundary.
    expect(auditEventSchema.parse(JSON.parse(JSON.stringify(row)))).toBeTruthy();
  });

  it('accepts the ISO string produced by toAuditWireTimestamp', () => {
    const at = new Date('2026-08-21T09:30:00.000Z');
    expect(
      auditEventSchema.parse({ ...row, occurred_at: toAuditWireTimestamp(at) }).occurred_at,
    ).toBe('2026-08-21T09:30:00.000Z');
  });

  it('rejects a bare Date instance — the wire type is a string', () => {
    expect(auditEventSchema.safeParse({ ...row, occurred_at: new Date() }).success).toBe(false);
  });

  it('rejects a timestamp with no zone, because "UTC" must be stated not assumed', () => {
    expect(auditEventSchema.safeParse({ ...row, occurred_at: '2026-08-21 00:00:00' }).success).toBe(
      false,
    );
  });

  it('requires a request id so a row is traceable across both processes', () => {
    const { request_id, ...withoutRequestId } = row;
    void request_id;
    expect(auditEventSchema.safeParse(withoutRequestId).success).toBe(false);
  });
});

describe('OpenAPI emission (AD-13)', () => {
  const doc = toOpenApiDocument() as {
    openapi: string;
    components: { schemas: Record<string, unknown> };
    paths: Record<string, unknown>;
  };

  it('emits a document', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths['/healthz']).toBeTruthy();
  });

  // Membership, deliberately not an exact-set assertion. The previous version
  // asserted the component list was exactly ['ErrorEnvelope','HealthResponse'],
  // which turned the missing audit schema from a bug into a documented fixture —
  // adding the schema would have failed the test that was supposed to protect it.
  it.each(['ErrorEnvelope', 'HealthResponse', 'AuditEvent'])('publishes %s', (name) => {
    expect(Object.keys(doc.components.schemas)).toContain(name);
  });

  it('emits the audit timestamp as a JSON string, not an unrepresentable Date', () => {
    const audit = doc.components.schemas['AuditEvent'] as {
      properties: { occurred_at: { type: string; format?: string } };
    };
    expect(audit.properties.occurred_at.type).toBe('string');
    expect(audit.properties.occurred_at.format).toBe('date-time');
  });
});
