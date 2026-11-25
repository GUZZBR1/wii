import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from '../../src/cv/protocol';

export function pose(timestampMs: number, options: { kneeLeft?: number; kneeRight?: number; hipRise?: number; wristLateral?: number; confidence?: number } = {}): PoseSnapshot {
  const points: Point3[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: options.confidence ?? 0.95, presence: options.confidence ?? 0.95 }));
  const hipY = 0.55 - (options.hipRise ?? 0) * 0.4;
  points[11] = { ...points[11]!, x: 0.43, y: hipY - 0.4 };
  points[12] = { ...points[12]!, x: 0.57, y: hipY - 0.4 };
  points[23] = { ...points[23]!, x: 0.46, y: hipY };
  points[24] = { ...points[24]!, x: 0.54, y: hipY };
  points[25] = { ...points[25]!, x: 0.46, y: hipY + 0.2 - (options.kneeLeft ?? 0) * 0.4 };
  points[26] = { ...points[26]!, x: 0.54, y: hipY + 0.2 - (options.kneeRight ?? 0) * 0.4 };
  points[27] = { ...points[27]!, x: 0.46, y: hipY + 0.4 };
  points[28] = { ...points[28]!, x: 0.54, y: hipY + 0.4 };
  points[15] = { ...points[15]!, x: 0.39, y: hipY - 0.12 };
  points[16] = { ...points[16]!, x: 0.61, y: hipY - 0.12 };

  const world: Point3[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: options.confidence ?? 0.95, presence: options.confidence ?? 0.95 }));
  world[11] = { ...world[11]!, x: -0.2, y: 0.4 };
  world[12] = { ...world[12]!, x: 0.2, y: 0.4 };
  world[15] = { ...world[15]!, x: -0.25, y: -0.1 };
  world[16] = { ...world[16]!, x: 0.2 + (options.wristLateral ?? 0), y: -0.1 };
  world[23] = { ...world[23]!, x: -0.1, y: 0 };
  world[24] = { ...world[24]!, x: 0.1, y: 0 };
  return { timestampMs, landmarks: points, worldLandmarks: world, trackingState: 'tracked', bodyConfidence: options.confidence ?? 0.95 };
}

export function calibration(hand: Hand = 'right'): CalibrationProfile {
  return {
    version: 1, completedAtMs: 3000, dominantHand: hand,
    image: { torsoHeight: 0.4, hipY0: 0.55, kneeToHipY0: { left: -0.5, right: -0.5 }, shoulderWidth: 0.14, torsoLeanRad0: 0 },
    world: { shoulderWidth: 0.4, readyWristLocal: { x: 0, y: -1.25, z: 0 } },
    quality: { validFrameRatio: 1, medianConfidence: 0.95 },
  };
}
