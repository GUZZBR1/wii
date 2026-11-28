import type { HandObservation, HandSnapshot } from '@nevergear/spatial-core';

export interface SyntheticHandOptions {
  scale?: number;
  rotationRad?: number;
  translate?: readonly [number, number, number];
  screenX?: number;
  pinchRatio?: number;
  handedness?: 'left' | 'right';
  pose?: 'open' | 'fist';
}

export function syntheticHand(options: SyntheticHandOptions = {}): HandObservation {
  const size = options.scale ?? 1;
  const angle = options.rotationRad ?? 0;
  const [tx, ty, tz] = options.translate ?? [0, 0, 0];
  const screenX = options.screenX ?? 0.5;
  const joints = [
    [0, 0, 0], // wrist
    [-0.035, 0.01, 0],
    [-0.025, 0.025, 0],
    [-0.01, 0.04, 0],
    [0.02, 0.06, 0], // thumb
    [0.025, 0.05, 0],
    [0.03, 0.07, 0],
    [0.03, 0.09, 0],
    [0.03, 0.11, 0], // index
    [0, 0.06, 0],
    [0, 0.085, 0],
    [0, 0.11, 0],
    [0, 0.13, 0], // middle
    [-0.025, 0.05, 0],
    [-0.03, 0.07, 0],
    [-0.03, 0.09, 0],
    [-0.03, 0.11, 0], // ring
    [-0.05, 0.035, 0],
    [-0.06, 0.05, 0],
    [-0.065, 0.07, 0],
    [-0.065, 0.09, 0], // pinky
  ];
  if (options.pose === 'fist') {
    joints[6] = [0.02, 0.047, 0];
    joints[7] = [0.015, 0.04, 0];
    joints[8] = [0.01, 0.035, 0];
    joints[10] = [0, 0.045, 0];
    joints[11] = [0.006, 0.03, 0];
    joints[12] = [0.018, 0.025, 0];
    joints[14] = [-0.02, 0.047, 0];
    joints[15] = [-0.015, 0.04, 0];
    joints[16] = [-0.008, 0.035, 0];
    joints[18] = [-0.04, 0.033, 0];
    joints[19] = [-0.03, 0.028, 0];
    joints[20] = [-0.02, 0.022, 0];
  }
  if (options.pinchRatio !== undefined) {
    const pinchGap = options.pinchRatio * 0.06;
    joints[4] = [joints[8]![0]! + pinchGap, joints[8]![1]!, joints[8]![2]!];
  } else if (options.pose === 'fist') {
    joints[4] = [-0.015, 0.04, 0];
  } else {
    const openGap = 0.8 * 0.06;
    joints[4] = [joints[8]![0]! + openGap, joints[8]![1]!, joints[8]![2]!];
  }

  const worldLandmarks = joints.map(([x, y, z]) => {
    const rotatedX = x! * Math.cos(angle) - y! * Math.sin(angle);
    const rotatedY = x! * Math.sin(angle) + y! * Math.cos(angle);
    return { x: rotatedX * size + tx, y: rotatedY * size + ty, z: z! * size + tz };
  });
  const landmarks = joints.map(([x, y, z]) => ({ x: screenX + x! * size, y: 0.5 - y! * size, z: z! * size }));
  return { landmarks, worldLandmarks, handedness: options.handedness ?? 'right', handednessScore: 0.99 };
}

export function handSnapshot(timestampMs: number, options: SyntheticHandOptions = {}): HandSnapshot {
  return { timestampMs, hands: [syntheticHand(options)] };
}
