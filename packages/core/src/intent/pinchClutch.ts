import type { Point3 } from '../types';

export const DEFAULT_PINCH_CLOSE_RATIO = 0.28;
export const DEFAULT_PINCH_RELEASE_RATIO = 0.4;

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Thumb-tip to index-tip distance divided by the wrist-to-middle-MCP palm length. */
export function pinchDistanceRatio(landmarks: readonly Point3[]): number | undefined {
  if (landmarks.length < 21) return undefined;
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  if (!wrist || !middleMcp || !thumbTip || !indexTip) return undefined;
  const palmLength = distance(wrist, middleMcp);
  const pinchDistance = distance(thumbTip, indexTip);
  if (![palmLength, pinchDistance].every(Number.isFinite) || palmLength <= 1e-8) return undefined;
  return pinchDistance / palmLength;
}

/** Deterministic pinch state with separate close and release thresholds. */
export class PinchClutch {
  private engaged = false;
  private readonly closeRatio: number;
  private readonly releaseRatio: number;

  constructor(closeRatio = DEFAULT_PINCH_CLOSE_RATIO, releaseRatio = DEFAULT_PINCH_RELEASE_RATIO) {
    if (
      !Number.isFinite(closeRatio) ||
      !Number.isFinite(releaseRatio) ||
      closeRatio < 0 ||
      closeRatio >= releaseRatio
    ) {
      throw new RangeError('Pinch close ratio must be finite, non-negative, and below the release ratio.');
    }
    this.closeRatio = closeRatio;
    this.releaseRatio = releaseRatio;
  }

  get isEngaged(): boolean {
    return this.engaged;
  }

  update(ratio: number | undefined): boolean {
    if (ratio === undefined || !Number.isFinite(ratio) || ratio < 0) {
      this.engaged = false;
    } else if (this.engaged) {
      if (ratio >= this.releaseRatio) this.engaged = false;
    } else if (ratio <= this.closeRatio) {
      this.engaged = true;
    }
    return this.engaged;
  }

  reset(): void {
    this.engaged = false;
  }
}
