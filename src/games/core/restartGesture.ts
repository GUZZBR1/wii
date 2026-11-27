/** After a race or match, holding both hands up this long plays again: no mouse needed. */
export const RESTART_HOLD_S = 1.5;
/** The result is shown this long before hands count; arms are still up from playing. */
export const RESTART_AFTER_S = 2;

/** Counts the raise-both-hands gesture once a game is over. Pure: time comes from the caller's loop. */
export class RestartGesture {
  private handsUp = false;
  private sinceOverS = 0;
  /** The hands must have been seen down after the end before raising them means anything. */
  private armed = false;
  private heldS = 0;

  setHandsRaised(raised: boolean): void { this.handsUp = raised; }

  /** Call only while the game is over. */
  step(dt: number): void {
    this.sinceOverS += dt;
    if (this.sinceOverS >= RESTART_AFTER_S && !this.handsUp) this.armed = true;
    this.heldS = this.armed && this.handsUp ? this.heldS + dt : 0;
  }

  /** 0–1; 1 asks for a new game. */
  get progress01(): number { return Math.min(1, this.heldS / RESTART_HOLD_S); }
}
