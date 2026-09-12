import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@stuwith/config';
import { REQUEST_ID_HEADER, compileTrustedProxies, resolveRequestId } from '@stuwith/config';
import {
  BROWSER_READABLE_RESPONSE_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_REQUEST_HEADERS,
  CORS_ALLOW_CREDENTIALS,
} from '@stuwith/contracts';
import { randomUUID } from 'node:crypto';

/**
 * The Fastify options `main.ts` and the flow-test harness must BOTH construct the
 * adapter with.
 *
 * `trustProxy` is the whole content of this function and it is the most dangerous
 * setting in the story, because it is wrong silently in two opposite directions:
 *
 * - left at its default `false` behind Caddy, `request.ip` is Caddy's address, so
 *   every visitor is squashed into one bucket and the first person to trip the
 *   limit locks out the entire product;
 * - set to a bare `true`, `X-Forwarded-For` is whatever the client typed, and
 *   anybody picks their own rate-limit key — a blocking layer that exists and
 *   blocks nothing.
 *
 * Neither shows up in CI. The value therefore comes from a REQUIRED environment
 * variable with no default (`TRUSTED_PROXY_ADDRESSES`): the operator has to name
 * the proxies, and the word `none` is a legitimate answer that has to be written
 * down rather than inferred from absence.
 *
 * ## The value is an address list, and a NUMBER must never be used here
 *
 * Two copies of Fastify are installed and they disagree about what a number means:
 *
 * - `fastify@5.11.3`, the copy `@nestjs/platform-fastify` resolves and therefore
 *   the one that actually runs, honours it as "trust this many hops";
 * - `fastify@5.12.1`, the copy `apps/api` declares, **removed** that meaning as a
 *   security fix. Its `getTrustProxyFn` returns `() => false` for a number
 *   ("hop-count-only trust cannot validate the immediate peer"), and its type no
 *   longer accepts one.
 *
 * So a numeric literal would mean "trust N hops" today and "trust nothing" after a
 * routine bump of a transitive dependency — silently, with `request.ip` quietly
 * becoming Caddy's address for everybody. The trap is real; the answer is not a
 * predicate but the STRING form, which both versions hand to `proxy-addr.compile`
 * unchanged.
 *
 * That string comes from `compileTrustedProxies`, the same function the schema
 * validated with and the same one that hands `clientIpOf` its predicate. One
 * library at one pinned version decides both, so Fastify's `request.ip` and the
 * rate-limit key cannot disagree — a property of the wiring rather than of a test
 * comparing two implementations.
 *
 * `false` when the deployment declared no proxy: with nothing in front, the header
 * is not evidence of anything and must not be read at all.
 */
type FastifyAdapterOptions = NonNullable<ConstructorParameters<typeof FastifyAdapter>[0]>;

/**
 * ## `genReqId` belongs to FASTIFY, not to pino-http, and putting it in the wrong
 * place is a silent no-op
 *
 * It lived in `logging.ts` until Story 1.7 and never executed once. `pino-http`
 * writes `req.id = req.id || genReqId(req, res)`, and Fastify has already assigned
 * an id by the time any middleware runs — so the `||` short-circuited on every
 * request, for every deployment, since Story 1.1. Two things followed, and both
 * were measured rather than reasoned about:
 *
 *  - an inbound `x-request-id` was never honoured, so a trace could not survive a
 *    hop. `resolveRequestId` — the most heavily tested function in
 *    `packages/config` — had never run on a real request;
 *  - the id on every line was Fastify's sequential counter (`req-1`, `req-2`, …).
 *    Both processes mint that same sequence independently, so two unrelated
 *    requests in the two processes collide on one id. That is worse than
 *    untraceable: it joins log lines that have nothing to do with each other.
 *
 * Fastify asks exactly once, here, and everything downstream reads the answer:
 * `request.id`, `request.raw.id` (which is what `pino-http` picks up, so the log
 * line and the audit row cannot disagree) and the echoed response header.
 *
 * ## What this makes attacker-controlled, and what stops it
 *
 * The value now flows from a request header into every log line and every audit
 * row for that request. `resolveRequestId` is the guard and has been since Story
 * 1.1 — it accepts the caller's value only when it already looks like an id
 * (`REQUEST_ID_PATTERN`, `REQUEST_ID_MAX_LENGTH`) and mints a fresh one otherwise.
 * This is the first release in which that guard is load-bearing, so
 * `logging.test.ts` exercises it end to end through a real request rather than
 * through the function alone.
 */
export function fastifyAdapterOptions(config: ApiEnv): FastifyAdapterOptions {
  // Throws rather than continuing with a value the library refused: the config
  // layer already validated this, so anything unusable here is a bug, and a
  // quietly narrowed set of trusted proxies is the failure nobody would notice.
  const compiled = compileTrustedProxies(config.TRUSTED_PROXY_ADDRESSES);
  if (!compiled.ok) {
    throw new Error(
      `TRUSTED_PROXY_ADDRESSES ${compiled.problem} The environment schema should have ` +
        'refused to start; this is a bug in packages/config.',
    );
  }
  return {
    trustProxy: compiled.forFastify,
    // The one decision point, shared with `apps/realtime-gateway` through
    // `resolveRequestId`. Do not re-implement it per app (AD-15).
    genReqId: (req) => resolveRequestId(req.headers[REQUEST_ID_HEADER], randomUUID),
  };
}

/**
 * The two pieces of Fastify wiring the login flow cannot work without.
 *
 * They live here, in one function called by BOTH `main.ts` and the test harness,
 * because the alternative — configuring them only in `main.ts` — is what let the
 * first version of this story ship with a login page that could never read a
 * session back. Node's `fetch` ignores CORS entirely, so a flow test that
 * configures its own app would have gone green against a browser-broken server.
 */
export function configureHttpApp(app: NestFastifyApplication, config: ApiEnv): void {
  /**
   * CORS, with credentials.
   *
   * `apps/web` and `apps/api` are two processes on two origins, and every call the
   * login page makes is `credentials: 'include'` because the session lives in an
   * `httpOnly` cookie. Without this the browser blocks the response before any
   * JavaScript sees it.
   *
   * The origin is `WEB_BASE_URL`, never `*`: the wildcard is not merely lax here,
   * it is *invalid* — the fetch spec rejects `Access-Control-Allow-Origin: *`
   * whenever credentials are included, so a wildcard would fail closed and look
   * like a mysterious CORS error rather than an over-permissive one. Naming the
   * origin is both the working configuration and the safe one.
   */
  app.enableCors({
    origin: config.WEB_BASE_URL,
    /**
     * From the contract, never a literal — the same trade `exposedHeaders` below
     * records, arrived at the same way.
     *
     * Story 2.1's probe declared that deleting this line would turn a BROWSER test
     * red. It did not: the E2E fake API carried its own copy of the CORS answer, so
     * the browser kept getting a working `Access-Control-Allow-Credentials` from
     * the fake while the real server had stopped sending one. Two assertions went
     * red, neither of them a browser, and they are in
     * `apps/api/src/auth/auth.flow.test.ts` — at `allows the configured web origin,
     * with credentials` and `answers the preflight a credentialed POST triggers`.
     *
     * Round 1 of the review wrote `http-setup.test.ts` there, in this docblock and
     * in three other places, and that was wrong: that file tests
     * `fastifyAdapterOptions` and `trustProxy` and contains the word `cors` nowhere.
     * The measurement was real; the address was not — which is worse than no
     * citation, because somebody checking the premise finds an empty file and
     * concludes the gate rests on nothing.
     *
     * `tests/gates/cors-policy.test.ts` is what makes the declared mutation true for
     * `credentials`. It is a TEXT gate and therefore the weaker half: the
     * `advertises exactly the methods and request headers the contract declares`
     * case in `auth.flow.test.ts` is what reads the values off a real preflight.
     */
    credentials: CORS_ALLOW_CREDENTIALS,
    methods: [...CORS_ALLOWED_METHODS],
    // `Vary: Origin` matters once a cache sits in front of this: without it a
    // response allowed for one origin can be replayed to another.
    allowedHeaders: [...CORS_ALLOWED_REQUEST_HEADERS],
    /**
     * From the contract, never a literal.
     *
     * This line read `['x-request-id']` for all of Epic 1 while every `429` also
     * carried `Retry-After` — so the browser dropped that header before any
     * JavaScript saw it, three screens read `null`, and the retry button they
     * disable on a countdown stayed enabled for the whole lockout. Nothing failed:
     * the API's own flow tests use Node's `fetch`, which ignores CORS.
     *
     * Spreading a shared `as const` array is what stops the next header from
     * repeating it: `tests/gates/cors-exposed-headers.test.ts` scans the response
     * headers this process actually sets and fails when one is neither exposed
     * here nor declared server-only.
     */
    exposedHeaders: [...BROWSER_READABLE_RESPONSE_HEADERS],
    maxAge: 600,
  });

  /**
   * Echo the request id, and echo only the SANITISED one.
   *
   * `Access-Control-Expose-Headers: x-request-id` above has advertised this header
   * since Story 1.1 while nothing ever set it — the echo was supposed to happen in
   * `pino-http`'s `genReqId`, which never ran. So a caller correlating a failure
   * with a support ticket had nothing to quote.
   *
   * `request.id` and not `request.headers['x-request-id']`, and the difference is
   * the whole security argument: echoing the raw header back makes this endpoint a
   * reflection point for whatever the caller sent. `request.id` is the value
   * `resolveRequestId` already approved or replaced.
   *
   * `onRequest` rather than `onSend`, so the header is present on every response
   * including the ones an exception filter builds.
   */
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });

  /**
   * `application/x-www-form-urlencoded` — Apple's callback transport — needs NO
   * wiring here, and this note exists so nobody adds it twice.
   *
   * Apple REQUIRES `response_mode=form_post` once the scope includes `name` or
   * `email`, and then delivers the callback as a cross-site POST with a
   * form-encoded body instead of a redirect with query parameters
   * (`AuthController.callbackFormPost` is the route it lands on). Fastify itself
   * ships no parser for that content type — but `@nestjs/platform-fastify`
   * registers one during `init()`/`listen()`, via `registerUrlencodedContentParser`,
   * so `request.body` is already a plain object by the time a handler sees it.
   *
   * Registering our own here throws `Content type parser
   * 'application/x-www-form-urlencoded' already present` the moment the app
   * starts — which is how this was discovered rather than assumed.
   */
}
