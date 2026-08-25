import type { ClockPort } from '../ports/clock-port';
import type { Heartbeat } from '../ports/heartbeat-port';

/**
 * Pure policy: testable with no DB and no network. That constraint is the real
 * reason AD-1 exists (spine, "Deferred" table), not tidiness.
 */
export const DEFAULT_LIVENESS_TTL_MS = 30_000;

export function isHeartbeatStale(
  heartbeat: Heartbeat | null,
  clock: ClockPort,
  ttlMs: number = DEFAULT_LIVENESS_TTL_MS,
): boolean {
  if (heartbeat === null) {
    return true;
  }
  return clock.now().getTime() - heartbeat.observedAt.getTime() > ttlMs;
}

/**
 * An observation only supersedes the stored one if it is strictly newer.
 * Adapters must agree with this; the contract suite asserts they do.
 */
export function supersedes(incoming: Date, stored: Date | null): boolean {
  if (stored === null) {
    return true;
  }
  return incoming.getTime() > stored.getTime();
}
