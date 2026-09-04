import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  RateLimitAction,
  RateLimitPort,
  RateLimitSettings,
  RateLimitSubject,
  TrustedProxy,
} from '@stuwith/domain';
import {
  RateLimitInputError,
  bruteForceSubjectFor,
  bruteForceLockKey,
  channelForAction,
  isRateLimitAction,
  requireTrustedProxies,
  rateLimitRulesFor,
} from '@stuwith/domain';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config.token';
import { RateLimitHealth } from './rate-limit-health';
import { RATE_LIMIT_ACTION_METADATA } from './rate-limit.decorator';
import { RATE_LIMIT_PORT } from './rate-limit.tokens';
import { RateLimitedException } from './rate-limited.exception';
import { clientIpOf, userHandleOf } from './request-identity';

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
 * {@link RateLimitInputError} is a defect in this code: a malformed key, a hashing
 * bug, a limit of zero from a misread config. Swallowing it as "the store is down"
 * would report a permanent bug as a Valkey outage for ever, and the layer would
 * never block anybody again. It is rethrown, so it surfaces as the 500 it is.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly settings: RateLimitSettings;
  private readonly trustedProxies: readonly TrustedProxy[];

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
    // Parsed once. The environment was already validated at startup, so an
    // invalid list cannot reach here — the process would not have opened a port.
    this.trustedProxies = requireTrustedProxies(config.TRUSTED_PROXY_ADDRESSES);
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
      // Reading the address and the credential is INSIDE the try. They parse a
      // header and a cookie header, both attacker-supplied; outside, a value that
      // made either of them throw would be a 500 on a layer whose entire posture
      // is to fail open.
      await this.enforce(action, this.subjectOf(request));
      this.health.recordSuccess();
    } catch (error) {
      if (error instanceof RateLimitedException) {
        // The store answered, and the answer was "no".
        this.health.recordSuccess();
        throw error;
      }
      if (error instanceof RateLimitInputError) {
        // Our bug, not an outage. Do not launder it into a fail-open.
        throw error;
      }
      this.health.recordFailure(`the ${action} check`, error);
      return true;
    }

    return true;
  }

  private subjectOf(request: FastifyRequest): RateLimitSubject {
    return {
      clientIp: clientIpOf(request, this.trustedProxies),
      userHandle: userHandleOf(request, this.config.SESSION_COOKIE_SECRET),
    };
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
        throw new RateLimitedException(channel, locked);
      }
    }

    for (const rule of rateLimitRulesFor(action, subject, this.settings)) {
      const decision = await this.rateLimit.hit(rule.key, rule.limit, rule.windowSeconds);
      if (!decision.ok) {
        throw new RateLimitedException(channel, decision.retryAfterSeconds);
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
    const declared = this.reflector.getAllAndOverride<unknown>(RATE_LIMIT_ACTION_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    return isRateLimitAction(declared) ? declared : null;
  }
}
