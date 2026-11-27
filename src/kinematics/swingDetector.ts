import type { Hand, PoseSnapshot } from '../cv/protocol';
import { clamp, landmarkConfidence } from './math';

export interface SwingSignal {
  side: 'forehand' | 'backhand';
  power01: number;
  confidence: number;
  peakTimestampMs: number;
  /** Frame where the onset threshold was crossed — the stroke's physical start. */
  onsetTimestampMs: number;
  /** Wrist height relative to its shoulder at the speed peak, in shoulder widths, up positive. */
  contactY: number;
  /** Vertical wrist speed at the peak in shoulder widths/s, up positive — topspin/slice proxy. */
  verticalSpeed: number;
}

/**
 * What one detector update yields. `onset` is the real-time, unconfirmed notice emitted on the
 * frame the wrist crosses the onset threshold — backswings and aborted strokes fire it too, so it
 * serves animation, never adjudication. `confirmed` is the measured stroke, emitted after the
 * follow-through proves it, carrying the peak-frame measurements.
 */
export type SwingOutput =
  | { kind: 'onset'; timestampMs: number }
  | ({ kind: 'confirmed' } & SwingSignal);

/*
 * A stroke is the wrist travelling far in very little time, mostly sideways or sideways and up.
 * Measured in the image against the shoulder midpoint, in shoulder widths. Two recordings of one
 * player: exaggerated arm sweeps, and the compact low-to-chest stroke used while actually playing,
 * which covers too little sideways distance to count without its rise. Downward motion does not
 * count: that is the arm settling back.
 */
const STROKE_TRAVEL = 1.9;
const MIN_SIDEWAYS_TRAVEL = 0.8;
const STROKE_WINDOW_MS = 270;
/** After a stroke, the arm coming back the other way is not a second stroke. */
const RETURN_IGNORE_MS = 800;
const REFRACTORY_MS = 400;
/** Twisting the trunk collapses the apparent shoulder width, so the ruler only shrinks slowly. */
const RULER_HALF_LIFE_MS = 3000;
const MIN_WRIST_CONFIDENCE = 0.5;
const FULL_POWER_SPEED = 30;
const MIN_POWER_SPEED = 8;
export const SWING_MAX_DURATION_MS = 300;

interface Sample { x: number; y: number; time: number }

interface PendingSwing {
  direction: -1 | 1;
  startedAt: number;
  peak: { time: number; speed: number; verticalSpeed: number; y: number; confidence: number };
}

export class SwingDetector {
  constructor(private readonly hand: Hand) {}

  private samples: Sample[] = [];
  private ruler?: { width: number; time: number };
  private pending?: PendingSwing;
  private last?: { direction: -1 | 1; time: number };

  update(snapshot: PoseSnapshot): SwingOutput | undefined {
    const time = snapshot.timestampMs;
    const wrist = snapshot.landmarks[this.hand === 'right' ? 16 : 15];
    const left = snapshot.landmarks[11];
    const right = snapshot.landmarks[12];
    const previous = this.samples.at(-1);
    // A hole in the samples says nothing about how fast the wrist moved across it.
    if (previous && time - previous.time > STROKE_WINDOW_MS) this.forget();
    if (!wrist || !left || !right || landmarkConfidence(wrist) < MIN_WRIST_CONFIDENCE) {
      this.forget();
      return undefined;
    }
    const aspect = snapshot.frameHeight && snapshot.frameWidth ? snapshot.frameHeight / snapshot.frameWidth : 0.75;
    const apparent = Math.hypot(left.x - right.x, (left.y - right.y) * aspect);
    const faded = this.ruler ? this.ruler.width * 0.5 ** ((time - this.ruler.time) / RULER_HALF_LIFE_MS) : 0;
    const width = Math.max(apparent, faded);
    if (width <= 0) return undefined;
    this.ruler = { width, time };
    const sample = {
      x: (wrist.x - (left.x + right.x) / 2) / width,
      // Up positive.
      y: -((wrist.y - (left.y + right.y) / 2) * aspect) / width,
      time,
    };
    const before = this.samples.at(-1);
    this.samples = [...this.samples.filter((kept) => time - kept.time <= STROKE_WINDOW_MS), sample];
    if (!before) return undefined;
    const seconds = Math.max(time - before.time, 8) / 1000;
    const vx = (sample.x - before.x) / seconds;
    const vy = (sample.y - before.y) / seconds;
    const speed = Math.abs(vx);
    // Same landmarks the pipeline's gate reads, so a swing never claims more than the gate saw.
    const world = [11, 12, this.hand === 'right' ? 16 : 15].map((index) => snapshot.worldLandmarks[index]);
    const confidence = landmarkConfidence(...world.flatMap((point) => (point ? [point] : [])));

    const pending = this.pending;
    if (pending) {
      if (Math.sign(vx) === pending.direction && speed > pending.peak.speed) {
        pending.peak = { time, speed, verticalSpeed: vy, y: sample.y, confidence };
      }
      const slowed = Math.sign(vx) !== pending.direction || speed <= pending.peak.speed * 0.65;
      if (!slowed && time - pending.startedAt < SWING_MAX_DURATION_MS) return undefined;
      this.pending = undefined;
      // The wrist's own right (image left) toward its left is a right-hander's forehand.
      const forehand = this.hand === 'right' ? pending.direction > 0 : pending.direction < 0;
      return {
        kind: 'confirmed',
        side: forehand ? 'forehand' : 'backhand',
        power01: clamp((pending.peak.speed - MIN_POWER_SPEED) / (FULL_POWER_SPEED - MIN_POWER_SPEED)),
        confidence: pending.peak.confidence,
        peakTimestampMs: pending.peak.time,
        onsetTimestampMs: pending.startedAt,
        contactY: pending.peak.y,
        verticalSpeed: pending.peak.verticalSpeed,
      };
    }

    let travel = 0;
    let reach = 0;
    for (const kept of this.samples) {
      const sideways = sample.x - kept.x;
      const distance = Math.hypot(sideways, Math.max(0, sample.y - kept.y));
      if (Math.abs(sideways) >= MIN_SIDEWAYS_TRAVEL && distance > reach) {
        reach = distance;
        travel = sideways;
      }
    }
    if (reach < STROKE_TRAVEL) return undefined;
    const direction = Math.sign(travel) as -1 | 1;
    if (this.last) {
      const since = time - this.last.time;
      if (since < REFRACTORY_MS || (direction !== this.last.direction && since < RETURN_IGNORE_MS)) return undefined;
    }
    this.last = { direction, time };
    this.pending = { direction, startedAt: time, peak: { time, speed, verticalSpeed: vy, y: sample.y, confidence } };
    return { kind: 'onset', timestampMs: time };
  }

  /** A swing in flight that has not confirmed yet: the arbiter may hold a rival's confirmation for it. */
  hasPending(): boolean { return this.pending !== undefined; }

  private forget(): void {
    this.samples = [];
    this.pending = undefined;
  }

  reset(): void {
    this.forget();
    this.ruler = undefined;
    this.last = undefined;
  }
}
