import { REQUEST_ID_HEADER } from '@stuwith/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requestIdOf } from './request-id';

/**
 * The three fallbacks of `requestIdOf`, each reached on purpose, and their order.
 *
 * Until this file existed only the first branch was exercised, indirectly, by the
 * flow suites: Fastify always stamps the header, so branches two and three were
 * code nobody had run. A fallback nobody has run is a fallback that can be
 * inverted with a green suite — and this one decides which id an AUDIT row is
 * joined to.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Shape {
  /** What `reply.raw.getHeader` answers: `string`, `number`, `string[]` or nothing. */
  readonly stamped?: unknown;
  readonly rawId?: unknown;
  readonly inbound?: string;
}

/** Just enough of a request/reply pair to reach every branch. */
function pair(shape: Shape): { request: FastifyRequest; reply: FastifyReply } {
  const headers: Record<string, string> = {};
  if (shape.inbound !== undefined) {
    headers[REQUEST_ID_HEADER] = shape.inbound;
  }
  const request = {
    headers,
    raw: shape.rawId === undefined ? {} : { id: shape.rawId },
  } as unknown as FastifyRequest;
  const reply = {
    raw: { getHeader: () => shape.stamped },
  } as unknown as FastifyReply;
  return { request, reply };
}

describe('requestIdOf — each source, in order', () => {
  it('reads the id the logger already stamped on the raw response (branch 1)', () => {
    const { request, reply } = pair({ stamped: 'stamped-0001' });
    expect(requestIdOf(request, reply)).toBe('stamped-0001');
  });

  it("falls back to Fastify's request.raw.id when nothing was stamped (branch 2)", () => {
    const { request, reply } = pair({ rawId: 'raw-0002' });
    expect(requestIdOf(request, reply)).toBe('raw-0002');
  });

  it('derives one from a VALID inbound header when neither is present (branch 3)', () => {
    // The same rule Fastify's `genReqId` applies: an inbound value that already
    // looks like an id is kept, so a trace can survive a hop.
    const inbound = '3f9d2c1e-1111-4222-8333-444455556666';
    const { request, reply } = pair({ inbound });
    expect(requestIdOf(request, reply)).toBe(inbound);
  });

  it('mints a fresh UUID when the inbound header is not an id (branch 3, refused)', () => {
    // AD-15: a raw header is never trusted verbatim — newlines, braces and length
    // are what `resolveRequestId` refuses. A fresh id, never the caller's bytes.
    const { request, reply } = pair({ inbound: 'not an id {"x":1}\n' });
    const id = requestIdOf(request, reply);
    expect(id).toMatch(UUID);
    expect(id).not.toContain('{');
  });

  it('mints a fresh UUID when there is no source at all', () => {
    const { request, reply } = pair({});
    expect(requestIdOf(request, reply)).toMatch(UUID);
  });

  describe('precedence', () => {
    it('prefers the stamped header over both fallbacks', () => {
      const { request, reply } = pair({
        stamped: 'stamped-wins',
        rawId: 'raw-loses',
        inbound: '3f9d2c1e-1111-4222-8333-444455556666',
      });
      expect(requestIdOf(request, reply)).toBe('stamped-wins');
    });

    it('prefers request.raw.id over the inbound header', () => {
      const { request, reply } = pair({
        rawId: 'raw-wins',
        inbound: '3f9d2c1e-1111-4222-8333-444455556666',
      });
      expect(requestIdOf(request, reply)).toBe('raw-wins');
    });

    it.each([
      ['an empty stamped header', { stamped: '', rawId: 'raw-0003' }, 'raw-0003'],
      // `getHeader` may answer a number or an array — the two shapes the
      // `typeof === 'string'` guard exists for. Neither is an id to join a row to.
      ['a numeric stamped header', { stamped: 42, rawId: 'raw-0004' }, 'raw-0004'],
      ['an array-valued stamped header', { stamped: ['a', 'b'], rawId: 'raw-0005' }, 'raw-0005'],
      ['an empty raw id', { rawId: '', inbound: '3f9d2c1e-1111-4222-8333-444455556666' }, '3f9d2c1e-1111-4222-8333-444455556666'],
      ['a non-string raw id', { rawId: 42, inbound: '3f9d2c1e-1111-4222-8333-444455556666' }, '3f9d2c1e-1111-4222-8333-444455556666'],
    ] as const)('skips %s rather than returning it', (_label, shape, expected) => {
      const { request, reply } = pair(shape);
      expect(requestIdOf(request, reply)).toBe(expected);
    });
  });
});
