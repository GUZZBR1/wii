import type { HandObservation } from '../providers/handProtocol';
import { OneEuroFilter } from '../filters/oneEuroFilter';
import type { OneEuroOptions } from '../filters/oneEuroFilter';

export interface ImageDimensions {
  width: number;
  height: number;
}

function finiteLandmark(hand: HandObservation, index: number) {
  const point = hand.landmarks[index];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
}

/** Wrist separation in average palm lengths, corrected for the source image's aspect ratio. */
export function bimanualSeparationRatio(
  hands: readonly HandObservation[],
  dimensions: ImageDimensions,
): number | undefined {
  if (
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new RangeError('Image dimensions must be finite and positive.');
  }
  const left = hands.find((hand) => hand.handedness === 'left');
  const right = hands.find((hand) => hand.handedness === 'right');
  if (!left || !right) return undefined;

  const leftWrist = finiteLandmark(left, 0);
  const leftMiddleMcp = finiteLandmark(left, 9);
  const rightWrist = finiteLandmark(right, 0);
  const rightMiddleMcp = finiteLandmark(right, 9);
  if (!leftWrist || !leftMiddleMcp || !rightWrist || !rightMiddleMcp) return undefined;

  const x = (leftWrist.x - rightWrist.x) * dimensions.width;
  const y = (leftWrist.y - rightWrist.y) * dimensions.height;
  const separation = Math.hypot(x, y);
  const leftPalm = Math.hypot(
    (leftMiddleMcp.x - leftWrist.x) * dimensions.width,
    (leftMiddleMcp.y - leftWrist.y) * dimensions.height,
  );
  const rightPalm = Math.hypot(
    (rightMiddleMcp.x - rightWrist.x) * dimensions.width,
    (rightMiddleMcp.y - rightWrist.y) * dimensions.height,
  );
  const averagePalm = (leftPalm + rightPalm) / 2;
  if (![separation, averagePalm].every(Number.isFinite) || averagePalm <= 1e-8) return undefined;
  return separation / averagePalm;
}

/** Low-pass filtered two-hand separation; mapping this ratio to zoom is left to the consuming context. */
export class BimanualSeparationTracker {
  private readonly filter: OneEuroFilter;

  constructor(options: OneEuroOptions = {}) {
    this.filter = new OneEuroFilter(options);
  }

  update(hands: readonly HandObservation[], dimensions: ImageDimensions, timestampMs: number): number | undefined {
    if (!Number.isFinite(timestampMs) || timestampMs < 0)
      throw new RangeError('Timestamp must be finite and non-negative.');
    const ratio = bimanualSeparationRatio(hands, dimensions);
    if (ratio === undefined) {
      this.reset();
      return undefined;
    }
    return this.filter.filter(ratio, timestampMs);
  }

  reset(): void {
    this.filter.reset();
  }
}

/** Snaps a normalized continuous value to configurable magnetic points with release hysteresis. */
export class MagneticSnapFilter {
  private readonly points: readonly number[];
  private readonly snapRadius: number;
  private readonly releaseRadius: number;
  private snappedPoint?: number;

  constructor(points: readonly number[] = [0, 0.5, 1], snapRadius = 0.025, releaseRadius = 0.06) {
    if (points.length === 0 || points.some((point) => !Number.isFinite(point) || point < 0 || point > 1)) {
      throw new RangeError('Snap points must be a non-empty list of normalized values.');
    }
    if (
      !Number.isFinite(snapRadius) ||
      !Number.isFinite(releaseRadius) ||
      snapRadius < 0 ||
      releaseRadius <= snapRadius
    ) {
      throw new RangeError('Release radius must be greater than a non-negative snap radius.');
    }
    this.points = [...new Set(points)].sort((a, b) => a - b);
    this.snapRadius = snapRadius;
    this.releaseRadius = releaseRadius;
  }

  update(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value)) {
      this.reset();
      return undefined;
    }
    const normalized = Math.max(0, Math.min(1, value));
    if (this.snappedPoint !== undefined) {
      if (Math.abs(normalized - this.snappedPoint) <= this.releaseRadius) return this.snappedPoint;
      this.snappedPoint = undefined;
    }

    const nearest = this.points.reduce((best, point) =>
      Math.abs(point - normalized) < Math.abs(best - normalized) ? point : best,
    );
    if (Math.abs(nearest - normalized) <= this.snapRadius) {
      this.snappedPoint = nearest;
      return nearest;
    }
    return normalized;
  }

  reset(): void {
    this.snappedPoint = undefined;
  }
}
