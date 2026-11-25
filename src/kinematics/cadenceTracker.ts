import type { PoseSnapshot } from '../cv/protocol';
import { median } from './math';
import { TorsoVerticalChannel } from './torsoVertical';

export interface CadenceResult { cadenceSpm: number; speed01: number; step?: 'left' | 'right' }

const MIN_STEP_INTERVAL_MS = 220;
/**
 * Hard ceiling for one inter-step interval: ~33 steps/min plus margin for the frame-sampled
 * observation of a step crossing. The adaptive stop rule below ends a stepping session well
 * before this; the ceiling only keeps a very late step from reusing a stale timestamp.
 */
const MAX_STEP_INTERVAL_MS = 1800;
/** The player has stopped once the next step is this many periods late. */
const STOP_AFTER_PERIODS = 1.6;
const MAX_STOP_DELAY_MS = 1600;
/**
 * Smallest torso oscillation that counts as stepping, in torsoHeights semi-amplitude.
 * Below this the motion is posture sway or estimator noise. The running literature puts real
 * bouncing at 0.11–0.29 torso semi-amplitude; marching in place is smaller but still well
 * above this floor — the adaptive hysteresis scales with the measured amplitude, so the floor
 * only decides whether ANY stepping exists.
 */
const MIN_OSCILLATION_TORSO = 0.012;
/**
 * Crossing hysteresis as a fraction of the measured oscillation amplitude. Fixed bands either
 * miss small-amplitude marching or double-count noise near the band edge; scaling the band
 * with the measured amplitude keeps the crossing point at a consistent phase of each cycle.
 */
const HYSTERESIS_RATIO = 0.35;
/**
 * Steps/min to game speed, interpolated. Anchors follow the CADENCE-Adults studies (100 steps/min is a
 * moderate walk; walking turns into running around 135-140). Those were measured moving forward, not in place.
 */
const SPEED_BY_CADENCE = [[40, 0.1], [100, 0.3], [137.5, 0.55], [200, 1]] as const;

export function speedFromCadence(spm: number): number {
  if (spm <= 0) return 0;
  let [fromSpm, fromSpeed]: readonly [number, number] = SPEED_BY_CADENCE[0];
  for (const [toSpm, toSpeed] of SPEED_BY_CADENCE) {
    if (spm <= toSpm) return toSpm === fromSpm ? toSpeed : fromSpeed + (toSpeed - fromSpeed) * Math.min(1, Math.max(0, (spm - fromSpm) / (toSpm - fromSpm)));
    [fromSpm, fromSpeed] = [toSpm, toSpeed];
  }
  return fromSpeed;
}

/**
 * Step cadence from the vertical oscillation of the torso: running and marching bounce the
 * torso once per step, so the oscillation frequency IS the step frequency. Self-referencing —
 * the rise is measured against the channel's own adaptive baseline, so no calibration is
 * needed and only the torso core landmarks [11,12,23,24] are read. Step side cannot be told
 * apart from torso motion alone, so left/right alternate per step; consumers only use it for
 * the run cycle animation.
 */
export class CadenceTracker {
  private readonly channel = new TorsoVerticalChannel();
  private high = false;
  private lastSteps: number[] = [];
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private lastStepSide?: 'left' | 'right';
  private previous?: { rise: number; timeMs: number };

  update(snapshot: PoseSnapshot): CadenceResult {
    const sample = this.channel.update(snapshot);
    let step: 'left' | 'right' | undefined;
    if (sample) {
      const active = sample.oscillationAmplitude >= MIN_OSCILLATION_TORSO;
      const band = sample.oscillationAmplitude * HYSTERESIS_RATIO;
      if (!this.high && sample.rise >= band) {
        this.high = true;
        if (active) {
          step = this.lastStepSide === 'left' ? 'right' : 'left';
          // Linear interpolation of the crossing time: frame-quantized step times would
          // dominate the interval error at high cadence (a 400 ms period is only ~12 frames).
          let crossTime = sample.timestampMs;
          if (this.previous && this.previous.rise < band && sample.rise > this.previous.rise) {
            const fraction = (band - this.previous.rise) / (sample.rise - this.previous.rise);
            crossTime = this.previous.timeMs + fraction * (sample.timestampMs - this.previous.timeMs);
          }
          const interval = crossTime - this.lastStepAt;
          // A step later than the session's stop deadline opens a fresh interval window: the old
          // cadence is dropped, but the measured interval still estimates the new pace. A step
          // beyond the acceptance ceiling is too old to pair with, so it only re-arms the tracker.
          const deadline = Math.min(median(this.lastSteps) * STOP_AFTER_PERIODS, MAX_STOP_DELAY_MS);
          if (interval > deadline) this.lastSteps = [];
          if (interval >= MIN_STEP_INTERVAL_MS && interval <= MAX_STEP_INTERVAL_MS) this.lastSteps = [...this.lastSteps, interval].slice(-3);
          this.lastStepAt = crossTime;
          this.lastStepSide = step;
        }
      } else if (this.high && sample.rise <= -band) {
        this.high = false;
      }
      this.previous = { rise: sample.rise, timeMs: sample.timestampMs };
    }
    // One interval (two steps) is enough to start moving. A late step slows the pace before it stops it.
    const period = median(this.lastSteps);
    const elapsed = snapshot.timestampMs - this.lastStepAt;
    const moving = period > 0 && elapsed <= Math.min(period * STOP_AFTER_PERIODS, MAX_STOP_DELAY_MS);
    const cadenceSpm = moving ? 60_000 / Math.max(period, elapsed) : 0;
    return { cadenceSpm, speed01: speedFromCadence(cadenceSpm), step };
  }

  reset(): void {
    this.channel.reset();
    this.high = false;
    this.lastSteps = [];
    this.lastStepAt = Number.NEGATIVE_INFINITY;
    this.lastStepSide = undefined;
    this.previous = undefined;
  }
}
