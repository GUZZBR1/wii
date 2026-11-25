import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { distance2, distance3, landmarkConfidence, median, midpoint } from '../kinematics/math';
import { bodyLocalPoint, legsVertical, torsoLeanRad } from '../kinematics/bodyFrame';

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
    if (this.startedAt !== undefined) this.samples.push(snapshot);
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
      const worldLeftHip = point(w, IDX.leftHip);
      const worldRightHip = point(w, IDX.rightHip);
      if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !leftKnee || !rightKnee || !wrist || !shoulder || !worldLeftShoulder || !worldRightShoulder || !worldLeftHip || !worldRightHip) return [];
      const confidence = landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip, leftKnee, rightKnee, wrist, shoulder, worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip);
      if (confidence < 0.55) return [];
      const shoulderCenter = midpoint(leftShoulder, rightShoulder);
      const hipCenter = midpoint(leftHip, rightHip);
      const shoulderWidth = distance2(leftShoulder, rightShoulder);
      const torsoHeight = Math.abs(hipCenter.y - shoulderCenter.y);
      const worldShoulderWidth = distance3(worldLeftShoulder, worldRightShoulder);
      if (torsoHeight < 0.03 || shoulderWidth < 0.03 || worldShoulderWidth < 0.03) return [];
      const wristLocal = bodyLocalPoint(wrist, shoulder, worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip, 1);
      if (!wristLocal) return [];
      return [{ hipY: hipCenter.y, torsoHeight, shoulderWidth, kneeLeft: (hipCenter.y - leftKnee.y) / torsoHeight, kneeRight: (hipCenter.y - rightKnee.y) / torsoHeight, up: legsVertical(sample), worldShoulderWidth, wristLocal, confidence, sample }];
    });
    if (valid.length < this.samples.length * 0.65) return null;
    // The lean reference is only trusted when the leg geometry verified it — a trunk-direction
    // fallback would store the player's habitual posture and turn a body rotation into ghost lean,
    // so the lane detector simply stays disabled when the legs could not be verified.
    const legUps = valid.flatMap((v) => v.up ? [v.up] : []);
    let leanUp0: Point3 | undefined;
    let torsoLeanRad0 = 0;
    if (legUps.length >= valid.length * 0.65) {
      const upMedian = {
        x: median(legUps.map((v) => v.x)),
        y: median(legUps.map((v) => v.y)),
        z: median(legUps.map((v) => v.z)),
      };
      const upMagnitude = Math.hypot(upMedian.x, upMedian.y, upMedian.z);
      if (upMagnitude >= 1e-6) {
        leanUp0 = { x: upMedian.x / upMagnitude, y: upMedian.y / upMagnitude, z: upMedian.z / upMagnitude };
        torsoLeanRad0 = median(valid.map((v) => torsoLeanRad(v.sample, leanUp0!) ?? 0));
      }
    }
    const values = <K extends keyof (typeof valid)[number]>(key: K): number[] => valid.map((item) => item[key] as number);
    const worldShoulderWidth = median(values('worldShoulderWidth'));
    const wristLocal = {
      x: median(valid.map((v) => v.wristLocal.x)) / worldShoulderWidth,
      y: median(valid.map((v) => v.wristLocal.y)) / worldShoulderWidth,
      z: median(valid.map((v) => v.wristLocal.z)) / worldShoulderWidth,
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
      },
      world: { shoulderWidth: worldShoulderWidth, leanUp0, torsoLeanRad0, readyWristLocal: wristLocal },
      quality: { validFrameRatio: valid.length / this.samples.length, medianConfidence: median(values('confidence')) },
    };
    this.startedAt = undefined;
    this.samples = [];
    return profile;
  }

  reset(): void { this.startedAt = undefined; this.samples = []; }
}
