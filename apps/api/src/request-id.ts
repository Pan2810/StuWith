import { REQUEST_ID_HEADER, resolveRequestId } from '@stuwith/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

/**
 * The id that is already on every log line for this request.
 *
 * Fastify's `genReqId` (see `http-setup.ts`) decides it once, and the `onRequest`
 * hook stamps it on the raw response as `x-request-id` before any handler runs —
 * so reading it back here is what makes an audit row and its log lines join up
 * (AD-15). The fallbacks exist because an audit row without a request id is not an
 * audit row — `AuditPort` rejects one — and a request must not fail because the
 * logging middleware was not wired.
 *
 * It lived as a private function in `auth.controller.ts` until Story 2.2 gave the
 * process a second controller that writes audit rows. One function, two callers:
 * a copy would be a second reading of "which id is this request" that drifts the
 * day one of them changes a fallback.
 */
export function requestIdOf(request: FastifyRequest, reply: FastifyReply): string {
  const stamped = reply.raw.getHeader(REQUEST_ID_HEADER);
  if (typeof stamped === 'string' && stamped.length > 0) {
    return stamped;
  }
  const onRaw = (request.raw as unknown as { id?: unknown }).id;
  if (typeof onRaw === 'string' && onRaw.length > 0) {
    return onRaw;
  }
  // Last resort: derive one the same way the logger would have.
  return resolveRequestId(request.headers[REQUEST_ID_HEADER], randomUUID);
}
