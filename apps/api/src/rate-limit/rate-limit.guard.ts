import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { compileTrustedProxies, type TrustedProxyTrust } from '@stuwith/config';
import type {
  RateLimitAction,
  RateLimitPort,
  RateLimitSettings,
  RateLimitSubject,
} from '@stuwith/domain';
import {
  bruteForceSubjectFor,
  bruteForceLockKey,
  channelForAction,
  isRateLimitAction,
  rateLimitRulesFor,
} from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { RateLimitHealth } from './rate-limit-health';
import { RATE_LIMIT_ACTION_METADATA } from './rate-limit.decorator';
import { RATE_LIMIT_PORT } from './rate-limit.tokens';
import { RateLimitedException } from './rate-limited.exception';
import { rateLimitSubjectOf } from './request-identity';
import { isStoreFault } from './store-fault';

/**
 * The blocking layer in front of `/v1/auth/*`, and the one place the fail-open
 * decision is taken.
 *
 * ## Fail open, and never silently
 *
 * A human decided on 2026-09-04 that when Valkey cannot answer, the request goes
 * through. That is a real trade — for the length of the outage there is no limit
 * at all — and it is only defensible if somebody finds out, which is what
 * {@link RateLimitHealth} is for.
 *
 * The decision lives HERE rather than in the adapter on purpose. An adapter that
 * catches its own connection error and answers "allowed" has turned a fault into a
 * normal outcome — the collapse `heartbeat-port.ts` forbids — and there is nowhere
 * in `packages/db` with the context to write that log line.
 *
 * ## What fail-open does NOT cover
 *
 * A defect in this code — a malformed key, a hashing bug, a `TypeError` — is NOT
 * a store fault. Swallowing one would report a permanent bug as a Valkey outage
 * for ever, point the alert at the wrong system, and leave the layer off.
 * `isStoreFault` decides, positively: only something that looks like a connection,
 * timeout or protocol failure from the client library earns the fail-open.
 * Everything else is rethrown and surfaces as the 500 it is.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly settings: RateLimitSettings;
  private readonly trust: TrustedProxyTrust;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RATE_LIMIT_PORT) private readonly rateLimit: RateLimitPort,
    private readonly health: RateLimitHealth,
  ) {
    this.settings = {
      ipLimit: config.RATE_LIMIT_IP_MAX,
      ipWindowSeconds: config.RATE_LIMIT_IP_WINDOW_SECONDS,
      userLimit: config.RATE_LIMIT_USER_MAX,
      userWindowSeconds: config.RATE_LIMIT_USER_WINDOW_SECONDS,
      bruteForceLimit: config.RATE_LIMIT_BRUTE_FORCE_MAX,
      bruteForceLockSeconds: config.RATE_LIMIT_BRUTE_FORCE_LOCK_SECONDS,
    };
    // Compiled once, by the same function the schema validated with and
    // `fastifyAdapterOptions` builds `trustProxy` from. The environment was
    // already checked at startup, so an unusable list cannot reach here — the
    // process would not have opened a port.
    const compiled = compileTrustedProxies(config.TRUSTED_PROXY_ADDRESSES);
    if (!compiled.ok) {
      throw new Error(`TRUSTED_PROXY_ADDRESSES ${compiled.problem}`);
    }
    this.trust = compiled.trust;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.actionFor(context);
    if (action === null) {
      // No decorator, no limit. This is the branch `POST /v1/auth/logout` takes,
      // and it takes it because there is no action name that could be written on
      // that route — not because of an exemption somebody could delete.
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();

    try {
      // Reading the address and the credential is inside the try only so that the
      // `RateLimitedException` path below is the same shape for both; it is NOT a
      // safety net for them. The `catch` lets through store faults and nothing
      // else, so a `TypeError` out of `clientIpOf` is a 500 exactly as it would be
      // outside this block. Both functions are total in themselves — a header and
      // a cookie header are attacker-supplied, so neither may throw at all — and
      // that, rather than this `try`, is what keeps a hostile value from becoming
      // a 500 on a layer whose whole posture is to fail open.
      await this.enforce(action, this.subjectOf(request));
      this.health.recordSuccess();
    } catch (error) {
      if (error instanceof RateLimitedException) {
        // The store answered, and the answer was "no".
        this.health.recordSuccess();
        throw error;
      }
      /**
       * Fail open for a STORE FAULT, and for nothing else.
       *
       * The branch used to be "anything that is not a `RateLimitInputError`",
       * which swallowed every `TypeError` and `RangeError` in this file too. A
       * plain bug — a property read on `undefined`, an off-by-one — was then
       * reported for ever as "the counter store did not answer", pointed the alert
       * at Valkey, and left the layer permanently off while looking like an
       * infrastructure incident. A defect in our code must surface as the 500 it
       * is; only a store that could not answer earns the fail-open.
       */
      if (!isStoreFault(error)) {
        throw error;
      }
      this.health.recordFailure(`the ${action} check`, error);
      return true;
    }

    return true;
  }

  /**
   * The same FUNCTION `AuthController` calls, not the same pair of calls written
   * out twice. The leg that counts an attempt and the leg that records a failure
   * have to key on identical values, and two call sites inferring "who is this"
   * separately is how they stop doing so.
   */
  private subjectOf(request: FastifyRequest): RateLimitSubject {
    return rateLimitSubjectOf(request, this.trust, this.config.SESSION_COOKIE_SECRET);
  }

  /**
   * The checks, in the order that costs least: standing locks first (somebody
   * already locked out should not also spend counter budget), then the counters.
   */
  private async enforce(action: RateLimitAction, subject: RateLimitSubject): Promise<void> {
    const channel = channelForAction(action);

    /**
     * ONE dimension per channel, and it is the same one `AuthService` counts.
     *
     * `bruteForceSubjectFor` is the single place that decision lives, so the leg
     * that EARNS a lock and the leg that ENFORCES it can no longer disagree. They
     * used to, and both directions were defects: refresh failures earned an
     * ADDRESS lock that then blocked `/start` and `/callback` for everyone behind
     * that address — the very thing skipping the address lock on `fetch` legs was
     * meant to prevent — while a session cookie riding along on a cross-site
     * callback counted a failure against a CREDENTIAL that was never part of the
     * attempt.
     */
    const bruteForce = bruteForceSubjectFor(channel, subject);
    if (bruteForce !== null) {
      const locked = await this.rateLimit.remainingSeconds(
        bruteForceLockKey(bruteForce.dimension, bruteForce.value),
      );
      if (locked !== null) {
        throw new RateLimitedException(channel, locked, action);
      }
    }

    for (const rule of rateLimitRulesFor(action, subject, this.settings)) {
      const decision = await this.rateLimit.hit(rule.key, rule.limit, rule.windowSeconds);
      if (!decision.ok) {
        throw new RateLimitedException(channel, decision.retryAfterSeconds, action);
      }
    }
  }

  /**
   * The action this route declared, or `null`.
   *
   * `isRateLimitAction` rather than a cast: metadata is `unknown`, and a typo in a
   * decorator would otherwise build a key namespaced under a name nothing else
   * uses — a limit that exists, counts, and never blocks anything.
   */
  private actionFor(context: ExecutionContext): RateLimitAction | null {
    // The HANDLER only, never the class. `getAllAndOverride` also reads class
    // metadata, so ONE class-level decorator would have rate-limited every route
    // in the controller — `POST /v1/auth/logout` included, the route the spec's
    // Never list and three docblocks say can never be limited. `@RateLimited` is
    // typed `MethodDecorator` now, so writing it on a class is a compile error,
    // and reading only the handler means reflection could not put it there either.
    const declared: unknown = this.reflector.get(
      RATE_LIMIT_ACTION_METADATA,
      context.getHandler(),
    );
    return isRateLimitAction(declared) ? declared : null;
  }
}
