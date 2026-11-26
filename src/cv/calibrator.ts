import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { distance2, distance3, isFinitePoint, landmarkConfidence, median, midpoint } from '../kinematics/math';
import { bodyLocalPoint, legsVertical, torsoLeanRad } from '../kinematics/bodyFrame';

const IDX = { leftShoulder: 11, rightShoulder: 12, leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24 } as const;
const COVERAGE_RATIO = 0.65;
// The 1.8 s floor is an engineering hypothesis, not a webcam minimum validated for BlazePose.
const MIN_SPAN_MS = 2000;
const VALID_SIGNAL_MS = 1800;
const MAX_SIGNAL_GAP_MS = 350;
/** Bounded rolling evidence window: movement/invalidation can delay convergence without unbounded growth. */
const WINDOW_MS = 5000;
/** Minimum observed stable time for an independent wrist reference. */
const MIN_WRIST_SIGNAL_MS = 1000;

type CoverageField = 'valid' | 'stanceValid' | 'leftWristValid' | 'rightWristValid';

interface CoverageSample {
  timestampMs: number;
  valid: boolean;
  stanceValid: boolean;
  leftWristValid: boolean;
  rightWristValid: boolean;
}

export interface CalibrationStability {
  core?: boolean;
  wrists?: Partial<Record<Hand, boolean>>;
}

interface StoredSample {
  snapshot: PoseSnapshot;
  stability: CalibrationStability;
}

function point(points: readonly Point3[], index: number): Point3 | undefined {
  const value = points[index];
  return isFinitePoint(value) ? value : undefined;
}

function normalize(vector: Point3): Point3 | undefined {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6) return undefined;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function coveredDurationMs(
  samples: readonly CoverageSample[],
  startMs: number,
  endMs: number,
  field: CoverageField,
): number {
  let coveredMs = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const gapMs = current.timestampMs - previous.timestampMs;
    if (gapMs <= 0 || gapMs > MAX_SIGNAL_GAP_MS || !previous[field] || !current[field]) continue;
    const overlapStart = Math.max(startMs, previous.timestampMs);
    const overlapEnd = Math.min(endMs, current.timestampMs);
    if (overlapEnd > overlapStart) coveredMs += overlapEnd - overlapStart;
  }
  return coveredMs;
}

/** Optional references are estimated from timestamped observations, counting each sample only
 * until the next callback. This keeps a single missing ankle frame from erasing both adjacent
 * intervals while still treating long callback gaps as unobserved time. */
function observedDurationMs(
  samples: readonly CoverageSample[],
  startMs: number,
  endMs: number,
  field: CoverageField,
): number {
  let observedMs = 0;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const current = samples[index]!;
    const next = samples[index + 1]!;
    const gapMs = next.timestampMs - current.timestampMs;
    if (gapMs <= 0 || gapMs > MAX_SIGNAL_GAP_MS || !current[field]) continue;
    const overlapStart = Math.max(startMs, current.timestampMs);
    const overlapEnd = Math.min(endMs, next.timestampMs);
    if (overlapEnd > overlapStart) observedMs += overlapEnd - overlapStart;
  }
  return observedMs;
}

/**
 * Upper-body calibration. A valid frame needs only the torso core in image and world space.
 * Legs improve the neutral vertical when an extended stance is observed; otherwise the trunk
 * direction is used. Wrist references are independent per hand and require their own temporal coverage.
 */
export class Calibrator {
  private startedAt?: number;
  private collectionAt?: number;
  private samples: StoredSample[] = [];
  private wristEpochs: Record<Hand, number> = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };

  /** settleMs excludes verified stillness from the blackout ratio, but includes it in signal time. */
  start(timestampMs: number, settleMs = 0): void {
    this.startedAt = timestampMs;
    this.collectionAt = timestampMs + settleMs;
    this.samples = [];
    this.wristEpochs = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  }

  add(snapshot: PoseSnapshot, stability: CalibrationStability = {}): void {
    if (this.startedAt === undefined) return;
    this.samples.push({ snapshot, stability });
    const cutoff = snapshot.timestampMs - WINDOW_MS;
    this.samples = this.samples.filter((sample) => sample.snapshot.timestampMs >= cutoff);
  }

  /** Core evidence before timestampMs belongs to another neutral posture and must not be reused. */
  invalidateCore(timestampMs: number): void {
    this.samples = this.samples.filter((sample) => sample.snapshot.timestampMs >= timestampMs);
    this.wristEpochs = {
      left: Math.max(this.wristEpochs.left, timestampMs),
      right: Math.max(this.wristEpochs.right, timestampMs),
    };
  }

  /** Wrist evidence before timestampMs was not verified still and must not enter that hand's median. */
  invalidateWrist(hand: Hand, timestampMs: number): void {
    this.wristEpochs[hand] = Math.max(this.wristEpochs[hand], timestampMs);
  }

  /** Non-destructive so AutoCalibrator can probe convergence on every frame. */
  finish(): CalibrationProfile | null {
    if (this.startedAt === undefined || this.samples.length < 12) return null;
    const first = this.samples[0]!.snapshot.timestampMs;
    const last = this.samples.at(-1)!.snapshot.timestampMs;
    if (last - first < MIN_SPAN_MS) return null;

    const valid: {
      worldShoulderWidth: number;
      trunkUp: Point3;
      sample: PoseSnapshot;
      confidence: number;
    }[] = [];
    const stance: { up: Point3; sample: PoseSnapshot }[] = [];
    const wrists: Record<Hand, { timestampMs: number; point: Point3 }[]> = { left: [], right: [] };
    const coverageSamples: CoverageSample[] = [];

    for (const stored of this.samples) {
      const sample = stored.snapshot;
      const coverage: CoverageSample = {
        timestampMs: sample.timestampMs,
        valid: false,
        stanceValid: false,
        leftWristValid: false,
        rightWristValid: false,
      };
      coverageSamples.push(coverage);
      const l = sample.landmarks;
      const w = sample.worldLandmarks;
      const leftShoulder = point(l, IDX.leftShoulder);
      const rightShoulder = point(l, IDX.rightShoulder);
      const leftHip = point(l, IDX.leftHip);
      const rightHip = point(l, IDX.rightHip);
      const worldLeftShoulder = point(w, IDX.leftShoulder);
      const worldRightShoulder = point(w, IDX.rightShoulder);
      const worldLeftHip = point(w, IDX.leftHip);
      const worldRightHip = point(w, IDX.rightHip);
      if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !worldLeftShoulder || !worldRightShoulder || !worldLeftHip || !worldRightHip) continue;

      const confidence = landmarkConfidence(
        leftShoulder, rightShoulder, leftHip, rightHip,
        worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip,
      );
      if (confidence < 0.55) continue;
      const shoulderCenter = midpoint(leftShoulder, rightShoulder);
      const hipCenter = midpoint(leftHip, rightHip);
      const torsoHeight = Math.abs(hipCenter.y - shoulderCenter.y);
      const shoulderWidth = distance2(leftShoulder, rightShoulder);
      const worldShoulderWidth = distance3(worldLeftShoulder, worldRightShoulder);
      if (torsoHeight < 0.03 || shoulderWidth < 0.03 || worldShoulderWidth < 0.03) continue;

      const worldShoulderCenter = midpoint(worldLeftShoulder, worldRightShoulder);
      const worldHipCenter = midpoint(worldLeftHip, worldRightHip);
      const trunkUp = normalize({
        x: worldShoulderCenter.x - worldHipCenter.x,
        y: worldShoulderCenter.y - worldHipCenter.y,
        z: worldShoulderCenter.z - worldHipCenter.z,
      });
      if (!trunkUp || !(stored.stability.core ?? true)) continue;

      valid.push({ worldShoulderWidth, trunkUp, sample, confidence });
      coverage.valid = true;

      const stancePoints = [23, 24, 25, 26, 27, 28].map((index) => point(w, index));
      if (stancePoints.every(isFinitePoint)) {
        const up = legsVertical(sample);
        if (up) {
          stance.push({ up, sample });
          coverage.stanceValid = true;
        }
      }

      const wristCandidates = [
        { hand: 'left' as const, wristIndex: IDX.leftWrist, shoulder: worldLeftShoulder, field: 'leftWristValid' as const },
        { hand: 'right' as const, wristIndex: IDX.rightWrist, shoulder: worldRightShoulder, field: 'rightWristValid' as const },
      ];
      for (const candidate of wristCandidates) {
        if (sample.timestampMs < this.wristEpochs[candidate.hand]) continue;
        if (!(stored.stability.wrists?.[candidate.hand] ?? true)) continue;
        const wristPoint = point(w, candidate.wristIndex);
        if (!wristPoint || landmarkConfidence(wristPoint) < 0.55) continue;
        const local = bodyLocalPoint(wristPoint, candidate.shoulder, worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip, 1);
        if (!local) continue;
        wrists[candidate.hand].push({ timestampMs: sample.timestampMs, point: local });
        coverage[candidate.field] = true;
      }
    }

    const validSignalMs = coveredDurationMs(coverageSamples, first, last, 'valid');
    if (validSignalMs < VALID_SIGNAL_MS) return null;
    const collectionStart = Math.max(first, this.collectionAt ?? first);
    const collectionSpanMs = last - collectionStart;
    if (collectionSpanMs <= 0) return null;
    const collectedValidMs = coveredDurationMs(coverageSamples, collectionStart, last, 'valid');
    if (collectedValidMs < collectionSpanMs * COVERAGE_RATIO) return null;

    const stanceValidMs = observedDurationMs(coverageSamples, collectionStart, last, 'stanceValid');
    const stanceVerified = stanceValidMs >= collectionSpanMs * COVERAGE_RATIO;
    const verticalSource = stanceVerified ? stance.map((sample) => sample.up) : valid.map((sample) => sample.trunkUp);
    const upMedian = normalize({
      x: median(verticalSource.map((up) => up.x)),
      y: median(verticalSource.map((up) => up.y)),
      z: median(verticalSource.map((up) => up.z)),
    });
    if (!upMedian) return null;
    const leanUp0 = upMedian;
    const torsoLeanRad0 = median(valid.map((sample) => torsoLeanRad(sample.sample, leanUp0) ?? 0));

    const values = <K extends keyof (typeof valid)[number]>(key: K): number[] => valid.map((item) => item[key] as number);
    const worldShoulderWidth = median(values('worldShoulderWidth'));

    const wristReferences: Partial<Record<Hand, Point3>> = {};
    for (const hand of ['left', 'right'] as const) {
      const field: CoverageField = hand === 'left' ? 'leftWristValid' : 'rightWristValid';
      const wristStart = Math.max(collectionStart, this.wristEpochs[hand]);
      const wristSpanMs = last - wristStart;
      if (wristSpanMs <= 0) continue;
      const wristCoverageMs = observedDurationMs(coverageSamples, wristStart, last, field);
      if (wristCoverageMs < MIN_WRIST_SIGNAL_MS || wristCoverageMs < wristSpanMs * COVERAGE_RATIO) continue;
      const samples = wrists[hand].filter((sample) => sample.timestampMs >= this.wristEpochs[hand]);
      if (samples.length < 8) continue;
      wristReferences[hand] = {
        x: median(samples.map((sample) => sample.point.x)) / worldShoulderWidth,
        y: median(samples.map((sample) => sample.point.y)) / worldShoulderWidth,
        z: median(samples.map((sample) => sample.point.z)) / worldShoulderWidth,
      };
    }
    const readyWristLocal = Object.keys(wristReferences).length > 0 ? wristReferences : undefined;

    return {
      version: 3,
      completedAtMs: last,
      world: { shoulderWidth: worldShoulderWidth, leanUp0, torsoLeanRad0, readyWristLocal },
      quality: { validFrameRatio: valid.length / this.samples.length, medianConfidence: median(values('confidence')) },
    };
  }

  reset(): void {
    this.startedAt = undefined;
    this.collectionAt = undefined;
    this.samples = [];
    this.wristEpochs = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  }
}
