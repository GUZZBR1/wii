import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { distance2, distance3, median, midpoint } from '../kinematics/math';

const IDX = { leftShoulder: 11, rightShoulder: 12, leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26 } as const;

function point(points: readonly Point3[], index: number): Point3 | undefined { return points[index]; }

export class Calibrator {
  private startedAt?: number;
  private samples: PoseSnapshot[] = [];

  start(timestampMs: number): void {
    this.startedAt = timestampMs;
    this.samples = [];
  }

  add(snapshot: PoseSnapshot): void {
    if (this.startedAt !== undefined && snapshot.trackingState === 'tracked') this.samples.push(snapshot);
  }

  finish(hand: Hand): CalibrationProfile | null {
    if (this.startedAt === undefined || this.samples.length < 12) return null;
    const first = this.samples[0]!.timestampMs;
    const last = this.samples.at(-1)!.timestampMs;
    if (last - first < 2800) return null;

    const valid = this.samples.flatMap((sample) => {
      const l = sample.landmarks;
      const w = sample.worldLandmarks;
      const leftShoulder = point(l, IDX.leftShoulder);
      const rightShoulder = point(l, IDX.rightShoulder);
      const leftHip = point(l, IDX.leftHip);
      const rightHip = point(l, IDX.rightHip);
      const leftKnee = point(l, IDX.leftKnee);
      const rightKnee = point(l, IDX.rightKnee);
      const wrist = point(w, hand === 'right' ? IDX.rightWrist : IDX.leftWrist);
      const shoulder = point(w, hand === 'right' ? IDX.rightShoulder : IDX.leftShoulder);
      const worldLeftShoulder = point(w, IDX.leftShoulder);
      const worldRightShoulder = point(w, IDX.rightShoulder);
      if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !leftKnee || !rightKnee || !wrist || !shoulder || !worldLeftShoulder || !worldRightShoulder) return [];
      const shoulderCenter = midpoint(leftShoulder, rightShoulder);
      const hipCenter = midpoint(leftHip, rightHip);
      const shoulderWidth = distance2(leftShoulder, rightShoulder);
      const torsoHeight = Math.abs(hipCenter.y - shoulderCenter.y);
      const worldShoulderWidth = distance3(worldLeftShoulder, worldRightShoulder);
      if (torsoHeight < 0.03 || shoulderWidth < 0.03 || worldShoulderWidth < 0.03) return [];
      const lean = Math.atan2(shoulderCenter.x - hipCenter.x, hipCenter.y - shoulderCenter.y);
      const wristLocal = { x: (wrist.x - shoulder.x) / worldShoulderWidth, y: (wrist.y - shoulder.y) / worldShoulderWidth, z: (wrist.z - shoulder.z) / worldShoulderWidth };
      return [{ hipY: hipCenter.y, torsoHeight, shoulderWidth, kneeLeft: (hipCenter.y - leftKnee.y) / torsoHeight, kneeRight: (hipCenter.y - rightKnee.y) / torsoHeight, lean, worldShoulderWidth, wristLocal, confidence: sample.bodyConfidence }];
    });
    if (valid.length < this.samples.length * 0.65) return null;
    const values = <K extends keyof (typeof valid)[number]>(key: K): number[] => valid.map((item) => item[key] as number);
    const wristLocal = {
      x: median(valid.map((v) => v.wristLocal.x)),
      y: median(valid.map((v) => v.wristLocal.y)),
      z: median(valid.map((v) => v.wristLocal.z)),
    };
    const profile: CalibrationProfile = {
      version: 1,
      completedAtMs: last,
      dominantHand: hand,
      image: {
        torsoHeight: median(values('torsoHeight')),
        hipY0: median(values('hipY')),
        kneeToHipY0: { left: median(values('kneeLeft')), right: median(values('kneeRight')) },
        shoulderWidth: median(values('shoulderWidth')),
        torsoLeanRad0: median(values('lean')),
      },
      world: { shoulderWidth: median(values('worldShoulderWidth')), readyWristLocal: wristLocal },
      quality: { validFrameRatio: valid.length / this.samples.length, medianConfidence: median(values('confidence')) },
    };
    this.startedAt = undefined;
    this.samples = [];
    return profile;
  }

  reset(): void { this.startedAt = undefined; this.samples = []; }
}
