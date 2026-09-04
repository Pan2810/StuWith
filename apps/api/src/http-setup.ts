import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@stuwith/config';
import { requireTrustedProxies } from '@stuwith/domain';

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
 * unchanged. That is the same list `resolveClientIp` in `packages/domain` is given,
 * so Fastify's `request.ip` and the rate-limit key agree by construction rather
 * than by coincidence.
 *
 * `false` when the deployment declared no proxy: with nothing in front, the header
 * is not evidence of anything and must not be read at all.
 *
 * The guard uses the domain function rather than `request.ip` because that one is
 * unit-testable with a hand-written header and no server. This setting is here so
 * that everything ELSE Fastify reports — `request.ip` in a log line above all —
 * says the same thing.
 */
type FastifyAdapterOptions = NonNullable<ConstructorParameters<typeof FastifyAdapter>[0]>;

export function fastifyAdapterOptions(config: ApiEnv): FastifyAdapterOptions {
  // Throws rather than continuing with a shortened list: the config layer already
  // validated this, so anything invalid here is a bug, and a quietly narrowed set
  // of trusted proxies is the failure nobody would notice.
  const proxies = requireTrustedProxies(config.TRUSTED_PROXY_ADDRESSES);
  if (proxies.length === 0) {
    return { trustProxy: false };
  }
  // `source` and not the parsed form: `proxy-addr` wants the text an operator
  // wrote, and round-tripping through our own formatter would be one more place
  // for the two views of the list to drift.
  return { trustProxy: proxies.map((proxy) => proxy.source).join(',') };
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
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    // `Vary: Origin` matters once a cache sits in front of this: without it a
    // response allowed for one origin can be replayed to another.
    allowedHeaders: ['content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
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
