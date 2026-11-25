import type { PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '../cv/oneEuroFilter';
import { landmarkConfidence, midpoint } from './math';

export interface TorsoVerticalSample {
  timestampMs: number;
  /** Torso height above the adaptive baseline, in torsoHeights, positive upward. */
  rise: number;
  /** Filtered vertical velocity, torsoHeights/s, positive upward. */
  velocityUp: number;
  /** Semi-amplitude estimate of the recent oscillation, in torsoHeights; ~0 at rest. */
  oscillationAmplitude: number;
}

const MIN_TORSO_HEIGHT = 0.03;
const CORE_MIN_CONFIDENCE = 0.55;
/**
 * The amplitude envelope attacks fast and releases slowly, like a compressor envelope: real
 * bouncing should open the cadence gate within the first cycle (a slow EMA would add a second
 * of startup latency), while noise must not keep the gate open after the motion stops.
 */
const ATTACK_TAU_MS = 150;
const RELEASE_TAU_MS = 1000;

/**
 * Shared vertical channel for the torso: image-space hip-midpoint height normalized by the
 * frame's own torso height (so camera distance drift cancels out), lightly smoothed — the
 * passband must keep 2.5–3.5 Hz running oscillation, so the usual 1 Hz One Euro would eat
 * most of the signal — with a slow adaptive baseline. Feeding anything but genuine torso
 * motion (e.g. hallucinated leg geometry) is impossible by construction: only [11,12,23,24]
 * image landmarks are read. Frames without a confident torso core produce no sample and do
 * not advance any filter state.
 */
export class TorsoVerticalChannel {
  private readonly baselineTauMs: number;
  private readonly positionFilter = new OneEuroFilter({ minCutoff: 3.5, beta: 1.5, derivativeCutoff: 3 });
  private baseline?: number;
  private baselineTimeMs?: number;
  private amplitudeMeanAbs?: number;
  private previousEnvTimeMs?: number;
  private previous?: { position: number; timeMs: number };

  constructor(options: { baselineTauMs?: number } = {}) {
    this.baselineTauMs = options.baselineTauMs ?? 1000;
  }

  update(snapshot: PoseSnapshot): TorsoVerticalSample | undefined {
    const l = snapshot.landmarks;
    const leftShoulder = l[11];
    const rightShoulder = l[12];
    const leftHip = l[23];
    const rightHip = l[24];
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
    if (landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip) < CORE_MIN_CONFIDENCE) return undefined;
    const shoulders = midpoint(leftShoulder, rightShoulder);
    const hips = midpoint(leftHip, rightHip);
    const torsoHeight = hips.y - shoulders.y;
    if (!(torsoHeight >= MIN_TORSO_HEIGHT) || !Number.isFinite(torsoHeight)) return undefined;

    const raw = hips.y / torsoHeight;
    const position = this.positionFilter.filter(raw, snapshot.timestampMs);
    if (this.baseline === undefined) {
      this.baseline = position;
      this.baselineTimeMs = snapshot.timestampMs;
    } else {
      const dt = Math.max((snapshot.timestampMs - this.baselineTimeMs!) / 1000, 1 / 120);
      const alpha = 1 - Math.exp(-dt / (this.baselineTauMs / 1000));
      this.baseline += alpha * (position - this.baseline);
      this.baselineTimeMs = snapshot.timestampMs;
    }
    // Image y is down-positive: rising hips shrink the normalized position.
    const rise = this.baseline - position;

    let velocityUp = 0;
    if (this.previous !== undefined) {
      const dt = Math.max((snapshot.timestampMs - this.previous.timeMs) / 1000, 1 / 120);
      velocityUp = -(position - this.previous.position) / dt;
    }
    this.previous = { position, timeMs: snapshot.timestampMs };

    const absRise = Math.abs(rise);
    const env = this.amplitudeMeanAbs ?? 0;
    const dtMs = this.previousEnvTimeMs === undefined ? 33 : Math.max(snapshot.timestampMs - this.previousEnvTimeMs, 1);
    const tauMs = absRise > env ? ATTACK_TAU_MS : RELEASE_TAU_MS;
    const alphaAmp = 1 - Math.exp(-dtMs / tauMs);
    this.amplitudeMeanAbs = env + alphaAmp * (absRise - env);
    this.previousEnvTimeMs = snapshot.timestampMs;

    return {
      timestampMs: snapshot.timestampMs,
      rise,
      velocityUp,
      // mean-|rise| of a sinusoid is 2A/pi of its semi-amplitude: scale back so the envelope
      // reads in semi-amplitude units, the same units the literature and the input fixtures
      // use. The fast attack biases the envelope toward the peaks, so for a steady sinusoidal
      // bounce the estimate reads ~10-15% above the true semi-amplitude.
      oscillationAmplitude: this.amplitudeMeanAbs / 0.64,
    };
  }

  reset(): void {
    this.positionFilter.reset();
    this.baseline = undefined;
    this.baselineTimeMs = undefined;
    this.amplitudeMeanAbs = undefined;
    this.previousEnvTimeMs = undefined;
    this.previous = undefined;
  }
}
