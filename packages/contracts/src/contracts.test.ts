import { describe, expect, it } from 'vitest';
import { auditEventSchema } from './audit';
import { errorEnvelopeSchema, makeError } from './error';
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

  it('rejects a stack trace smuggled through details', () => {
    expect(() =>
      errorEnvelopeSchema.parse({
        error: { code: 'internal_error', message: 'x', details: { stack: { deep: true } } },
      }),
    ).toThrow();
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
  it('requires a request id so a row is traceable across both processes', () => {
    const row = {
      id: '019200f0-0000-7000-8000-000000000000',
      source_service: 'api',
      action: 'auth.signed_in',
      actor_user_id: null,
      subject_id: null,
      request_id: 'req-1',
      occurred_at: new Date('2026-08-21T00:00:00.000Z'),
      metadata: {},
    };
    expect(auditEventSchema.parse(row)).toBeTruthy();

    const { request_id, ...withoutRequestId } = row;
    void request_id;
    expect(() => auditEventSchema.parse(withoutRequestId)).toThrow();
  });
});

describe('OpenAPI emission (AD-13)', () => {
  it('produces a document with the registered component schemas', () => {
    const doc = toOpenApiDocument() as {
      openapi: string;
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      'ErrorEnvelope',
      'HealthResponse',
    ]);
    expect(doc.paths['/healthz']).toBeTruthy();
  });
});
