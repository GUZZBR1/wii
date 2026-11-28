/**
 * Leans and ducks read from the body's own shape and recent past, never from where it stands.
 * A lean is the shoulders leaving the line above the hips, so walking sideways moves both and
 * counts as nothing. A duck is the head dropping from where it was moments ago. Both rest
 * references follow the player while nothing is happening and re-anchor on a pose held longer
 * than any dodge, so a new spot, distance or player needs no calibration. Pure.
 */
import type { PoseSnapshot } from '@nevergear/spatial-core';

export const BODY_DODGE = {
  /** Shoulder offset over the hips, in shoulder widths, that starts and ends a lean. */
  enterLean: 0.35,
  exitLean: 0.17,
  /** Head drop, in shoulder widths, that starts and ends a duck. */
  enterDuck: 0.6,
  exitDuck: 0.3,
  restTauMs: 1200,
  /** Frames in a row past a threshold before a dodge starts: one noisy frame is not a move. */
  enterFrames: 2,
  /** Held longer than this, a "dodge" is simply how the player now stands. */
  maxHoldMs: 2500,
  /** Out of view for this long, whoever comes back is measured from scratch. */
  forgetMs: 1000,
  warmupMs: 600,
} as const;

interface Reading { lean?: number; headY: number; width: number }

function read(snapshot: PoseSnapshot): Reading | undefined {
  const [nose, left, right, leftHip, rightHip] = [0, 11, 12, 23, 24].map((index) => snapshot.landmarks[index]);
  if (!nose || !left || !right) return undefined;
  if ([nose, left, right].some((point) => (point.visibility ?? 1) < 0.5)) return undefined;
  const width = Math.hypot(left.x - right.x, left.y - right.y);
  if (!(width > 0.03)) return undefined;
  const hips = leftHip && rightHip && Math.min(leftHip.visibility ?? 1, rightHip.visibility ?? 1) >= 0.5;
  return {
    // Without hips the head over the shoulders still tilts, only less.
    lean: hips ? ((left.x + right.x) / 2 - (leftHip.x + rightHip.x) / 2) / width : undefined,
    headY: nose.y,
    width,
  };
}

export class BodyDodgeDetector {
  private rest?: Required<Reading>;
  private zone: -1 | 0 | 1 = 0;
  private duck = false;
  private leanFrames = 0;
  private duckFrames = 0;
  private seenAtMs?: number;
  private startedAtMs = 0;
  private activeSinceMs?: number;

  reset(): void {
    this.rest = this.seenAtMs = this.activeSinceMs = undefined;
    this.zone = 0;
    this.duck = false;
    this.leanFrames = this.duckFrames = 0;
  }

  /** Undefined while the body cannot be read or the rest pose is not known yet. */
  update(snapshot: PoseSnapshot, punching = false): { zone: -1 | 0 | 1; duck: boolean } | undefined {
    const now = read(snapshot);
    const t = snapshot.timestampMs;
    if (!now) return undefined;
    if (this.seenAtMs !== undefined && t - this.seenAtMs > BODY_DODGE.forgetMs) this.reset();
    const dt = this.seenAtMs === undefined ? 0 : t - this.seenAtMs;
    this.seenAtMs = t;
    if (!this.rest) {
      this.rest = { lean: now.lean ?? 0, headY: now.headY, width: now.width };
      this.startedAtMs = t;
    }
    const rest = this.rest;
    if (t - this.startedAtMs < BODY_DODGE.warmupMs) {
      this.follow(now, 0.3);
      return undefined;
    }
    // A punch twists the shoulders, so no new dodge starts during one.
    const lean = now.lean === undefined ? 0 : now.lean - rest.lean;
    const drop = (now.headY - rest.headY) / rest.width;
    const side = lean > 0 ? -1 : 1;
    this.leanFrames = Math.abs(lean) >= BODY_DODGE.enterLean && !punching ? this.leanFrames + 1 : 0;
    this.duckFrames = drop >= BODY_DODGE.enterDuck && !punching ? this.duckFrames + 1 : 0;
    const held = this.zone === side && Math.abs(lean) >= BODY_DODGE.exitLean;
    this.zone = held || this.leanFrames >= BODY_DODGE.enterFrames ? side : 0;
    this.duck = (this.duck && drop >= BODY_DODGE.exitDuck) || this.duckFrames >= BODY_DODGE.enterFrames;
    if (this.zone === 0 && !this.duck) {
      this.activeSinceMs = undefined;
      // Only near rest: the start of a slow dodge must not be absorbed before it counts.
      if (Math.abs(lean) < BODY_DODGE.exitLean && Math.abs(drop) < BODY_DODGE.exitDuck) {
        this.follow(now, 1 - Math.exp(-dt / BODY_DODGE.restTauMs));
      }
    } else {
      this.activeSinceMs ??= t;
      if (t - this.activeSinceMs > BODY_DODGE.maxHoldMs) {
        this.follow(now, 1);
        this.zone = 0;
        this.duck = false;
        this.activeSinceMs = undefined;
      }
    }
    // Standing up from a crouch, or walking back, must not leave the head reference below the head.
    if (drop < -BODY_DODGE.exitDuck) this.follow(now, 1 - Math.exp(-dt / (BODY_DODGE.restTauMs / 4)));
    return { zone: this.zone, duck: this.duck };
  }

  private follow(now: Reading, amount: number): void {
    const rest = this.rest!;
    if (now.lean !== undefined) rest.lean += (now.lean - rest.lean) * amount;
    rest.headY += (now.headY - rest.headY) * amount;
    rest.width += (now.width - rest.width) * amount;
  }
}
