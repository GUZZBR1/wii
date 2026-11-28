import type { PunchKind, PunchMeasurement, PunchTargetZone } from '@wii/spatial-core';
import { clamp } from './math';

export interface PunchClassification {
  readonly punchKind: PunchKind;
  readonly targetZone: PunchTargetZone;
  /** Distance to the nearest decision boundary mapped to 0..1; intentionally conservative. */
  readonly confidence01: number;
}

/**
 * Geometry-only first pass. `straight` is deliberately not named jab or cross here: that
 * distinction belongs to the player's stance, learned by the boxing tutorial.
 */
export function classifyPunch(measurement: PunchMeasurement): PunchClassification {
  const path = Math.max(measurement.pathLength, 1e-6);
  const forwardShare = measurement.forwardTravel / path;
  const verticalShare = measurement.verticalRise / path;
  const lateralShare = measurement.lateralExcursion / path;

  const uppercutScore = Math.min(measurement.verticalRise / 0.18, verticalShare / 0.28, measurement.forwardTravel / 0.12);
  const hookScore = Math.min(measurement.lateralExcursion / 0.18, lateralShare / 0.24, (1 - forwardShare) / 0.35);
  const straightScore = Math.min(measurement.forwardTravel / 0.22, forwardShare / 0.55, measurement.maxElbowCosine / 0.62);

  let punchKind: PunchKind = 'unknown';
  let score = 0;
  if (uppercutScore >= 1 && uppercutScore >= hookScore) {
    punchKind = 'uppercut';
    score = uppercutScore;
  } else if (hookScore >= 1 && hookScore >= straightScore * 0.8) {
    punchKind = 'hook';
    score = hookScore;
  } else if (straightScore >= 1) {
    punchKind = 'straight';
    score = straightScore;
  }

  const height = measurement.contact.vertical;
  let targetZone: PunchTargetZone = 'unknown';
  let targetMargin = 0;
  if (height >= -0.051) {
    targetZone = 'head';
    targetMargin = height + 0.05;
  } else if (height <= -0.3) {
    targetZone = 'body';
    targetMargin = -0.3 - height;
  }

  const confidence01 = clamp(Math.min(score / 1.8, 0.35 + targetMargin * 2, 1));
  return { punchKind, targetZone, confidence01 };
}
