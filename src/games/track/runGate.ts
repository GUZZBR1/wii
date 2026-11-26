const COUNTDOWN_S = 3;
/**
 * Seconds of continuous 'SEM POSE' the run tolerates before pausing. Brief tracking blackouts
 * — a fast jump carrying the torso out of a tight frame, a blur burst — must not freeze the
 * race; only a sustained loss means the player actually left.
 */
const LOST_GRACE_S = 0.8;

export type RunPhase = 'countdown' | 'running' | 'paused';

/**
 * Decides whether the run may progress. Owned and written by TrackGame only: camera tracking and
 * key presses come in as calls, time comes in from the fixed-step loop.
 *
 * Losing the camera pauses only a player the camera has actually seen, so keyboard-only runs never
 * pause. A key press while paused gives up on the camera until it tracks again.
 */
export class RunGate {
  private current: RunPhase = 'countdown';
  private remaining = COUNTDOWN_S;
  private cameraSeen = false;
  /** True while the latest tracking label is 'SEM POSE'; `lostFor` times that continuous window. */
  private poseMissing = false;
  private lostFor = 0;

  get phase(): RunPhase {
    return this.current;
  }

  /** Whole seconds left to show during the countdown. */
  get count(): number {
    return Math.ceil(this.remaining);
  }

  /** `tracking` is the app's camera label; 'PROCURANDO' still sees the body intermittently,
   * so it ends the continuous-loss window instead of counting toward the pause. */
  setTracking(tracking: string): void {
    if (tracking === 'TRACKING' || tracking.startsWith('TRACKING · ')) {
      this.poseMissing = false;
      this.lostFor = 0;
      this.cameraSeen = true;
      if (this.current === 'paused') this.restart();
    } else if (tracking === 'SEM POSE') {
      this.poseMissing = true;
    } else {
      this.poseMissing = false;
      this.lostFor = 0;
    }
  }

  /** Returns true when the press was consumed to leave the pause. */
  resumeByKey(): boolean {
    if (this.current !== 'paused') return false;
    this.cameraSeen = false;
    this.restart();
    return true;
  }

  advance(dt: number): void {
    if (this.poseMissing) {
      this.lostFor += dt;
      if (this.lostFor >= LOST_GRACE_S && this.cameraSeen && this.current !== 'paused') this.current = 'paused';
    }
    if (this.current !== 'countdown') return;
    this.remaining -= dt;
    // Tolerance for the accumulated error of fixed steps.
    if (this.remaining <= 1e-9) this.current = 'running';
  }

  private restart(): void {
    this.current = 'countdown';
    this.remaining = COUNTDOWN_S;
  }
}
