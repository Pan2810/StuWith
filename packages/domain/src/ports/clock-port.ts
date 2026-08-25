/**
 * The one port Story 1.1 needs: enough of a seam to prove the hexagon stands up.
 * Real money/session ports arrive in Epic 3.
 *
 * A port is a plain TypeScript interface. It names no driver, no library and no
 * transport — that is the whole point of AD-1.
 */
export interface ClockPort {
  /** Current instant, always UTC. */
  now(): Date;
}

/**
 * A deterministic clock, usable by domain unit tests without touching the OS clock.
 * Lives in the domain because it is pure data + arithmetic, not infrastructure.
 */
export class FixedClock implements ClockPort {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}
