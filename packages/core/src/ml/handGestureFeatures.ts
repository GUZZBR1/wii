import type { CanonicalHandFeatures } from '../geometry/handFeatures';

export interface HandGestureVectorOptions {
  maxArticulationSpeed?: number;
  maxWristSpeed?: number;
}

const ANGLE_WEIGHT = Math.sqrt(0.4);
const PINCH_WEIGHT = Math.sqrt(0.25);
const ARTICULATION_WEIGHT = Math.sqrt(0.1);
const WRIST_WEIGHT = Math.sqrt(0.25);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Fixed-size 81-value pose-and-motion descriptor for DTW templates. */
export function handGestureVector(features: CanonicalHandFeatures, options: HandGestureVectorOptions = {}): number[] {
  const maxArticulationSpeed = options.maxArticulationSpeed ?? 6;
  const maxWristSpeed = options.maxWristSpeed ?? 8;
  if (
    !Number.isFinite(maxArticulationSpeed) ||
    maxArticulationSpeed <= 0 ||
    !Number.isFinite(maxWristSpeed) ||
    maxWristSpeed <= 0
  ) {
    throw new RangeError('Gesture speed scales must be finite and positive.');
  }
  if (
    features.jointCosines.length !== 15 ||
    features.landmarks.length !== 21 ||
    features.landmarkVelocities.length !== 21
  ) {
    throw new RangeError('Hand gesture features require 21 landmarks, 15 joint angles, and 21 landmark velocities.');
  }
  const thumbTip = features.landmarks[4]!;
  const indexTip = features.landmarks[8]!;
  if (
    features.jointCosines.some((value) => !Number.isFinite(value)) ||
    features.landmarks.some(({ x, y, z }) => ![x, y, z].every(Number.isFinite)) ||
    features.landmarkVelocities.some(({ x, y, z }) => ![x, y, z].every(Number.isFinite)) ||
    ![features.imageVelocity.x, features.imageVelocity.y].every(Number.isFinite)
  ) {
    throw new RangeError('Hand gesture features must contain only finite values.');
  }

  const angleScale = ANGLE_WEIGHT / Math.sqrt(features.jointCosines.length);
  const articulationScale = ARTICULATION_WEIGHT / Math.sqrt(features.landmarkVelocities.length * 3);
  const wristScale = WRIST_WEIGHT / Math.SQRT2;
  const pinchRatio = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y, thumbTip.z - indexTip.z);
  return [
    ...features.jointCosines.map((value) => value * angleScale),
    pinchRatio * PINCH_WEIGHT,
    ...features.landmarkVelocities.flatMap(({ x, y, z }) =>
      [x, y, z].map((value) => clamp(value / maxArticulationSpeed, -1, 1) * articulationScale),
    ),
    clamp(features.imageVelocity.x / maxWristSpeed, -1, 1) * wristScale,
    clamp(features.imageVelocity.y / maxWristSpeed, -1, 1) * wristScale,
  ];
}
