import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@stuwith/config';

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
