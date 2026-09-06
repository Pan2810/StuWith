import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { REQUEST_ID_HEADER, resolveRequestId } from '@stuwith/config';
import { randomUUID } from 'node:crypto';

/**
 * The request-id wiring, spelled the same way as `apps/api/src/http-setup.ts`.
 *
 * ## Why this file exists rather than two lines in `main.ts`
 *
 * `request_id` is the single join between a log line in one process, a log line in
 * the other, and an `audit_events` row (spine, "Logging"). A join that is decided
 * one way here and another way there is not a join, and `main.ts` is the one file
 * in this process that no test constructs — so a decision made only there is a
 * decision nothing can execute.
 *
 * ## What was broken until Story 1.7
 *
 * `genReqId` lived in `logging.ts` and was handed to `pino-http`, which writes
 * `req.id = req.id || genReqId(req, res)`. Fastify assigns an id before any
 * middleware runs, so that branch never executed — in either process, since Story
 * 1.1. Two consequences, both measured:
 *
 *  - an inbound `x-request-id` was ignored, so a trace could not cross the hop
 *    between the two processes, which is the entire reason the header exists;
 *  - the id was Fastify's sequential counter. BOTH processes mint `req-1`,
 *    `req-2`, … independently, so a gateway request and an api request collide on
 *    the same id and a search for one returns the other.
 *
 * Fastify asks once, here. `request.raw.id` carries the answer to `pino-http`, so
 * the log line cannot disagree with the id anything else reads.
 *
 * ## The value is attacker-controlled, and `resolveRequestId` is the only guard
 *
 * It reaches every log line for the request and is echoed in a response header, so
 * a raw value would buy log forging (a newline injects whole fake records) and
 * unbounded log growth (a megabyte header, repeated per line). `resolveRequestId`
 * accepts the caller's value only when it already looks like an id and mints a
 * fresh one otherwise. Story 1.7 is the first release in which that guard actually
 * runs, so it is exercised end to end rather than only as a function.
 */
type FastifyAdapterOptions = NonNullable<ConstructorParameters<typeof FastifyAdapter>[0]>;

export function fastifyAdapterOptions(): FastifyAdapterOptions {
  return {
    // The one decision point, shared with `apps/api` through `resolveRequestId`.
    // Do not re-implement it per app (AD-15).
    genReqId: (req) => resolveRequestId(req.headers[REQUEST_ID_HEADER], randomUUID),
  };
}

/**
 * Echo the request id, and echo only the SANITISED one.
 *
 * `request.id` and not `request.headers['x-request-id']`: echoing the raw header
 * back would make every endpoint a reflection point for whatever the caller sent.
 * `request.id` is the value `resolveRequestId` already approved or replaced.
 *
 * `onRequest` rather than `onSend`, so the header is present on every response
 * including the ones an exception filter builds — and including `/healthz`, which
 * is the only route this process serves today.
 */
export function configureHttpApp(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });
}
