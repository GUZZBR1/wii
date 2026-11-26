import type { PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { landmarkConfidence, midpoint } from './math';

export interface TorsoVerticalSample {
  timestampMs: number;
  /** Torso height above the adaptive baseline, in torsoHeights, positive upward. */
  rise: number;
  /** Filtered vertical velocity, torsoHeights/s, positive upward. */
  velocityUp: number;
  /** Fast semi-amplitude estimate used by the cadence gate. */
  oscillationAmplitude: number;
  /** Slower semi-amplitude estimate used to distinguish takeoff from sustained bounce. */
  sustainedOscillationAmplitude: number;
  /** Asymmetry between left and right shoulder vertical motion (0 = symmetric bounce, 1 = pure shrug/tilt). */
  shoulderAsymmetry01?: number;
  /** Alternating vertical limb differential (elbows/wrists or knees, in torsoHeights) for low-bounce running. */
  limbDrive?: number;
  /**
   * Which landmarks produced `rise`. Hips track the centre of mass; shoulders also move with
   * head, arms and torso lean, so shoulder-only samples are good enough for a periodic step
   * rhythm but must never be read as a jump.
   */
  source?: 'hips' | 'shoulders';
}

const MIN_TORSO_HEIGHT = 0.03;
const MIN_SHOULDER_WIDTH = 0.02;
const CORE_MIN_CONFIDENCE = 0.5;
/** Shoulder width in aspect-corrected image space is ~0.583 of torso height in canonical posture. */
const TORSO_TO_SHOULDER_RATIO = 0.4 / (0.14 * (1280 / 720));
/**
 * The amplitude envelope attacks fast and releases slowly, like a compressor envelope: real
 * bouncing opens the cadence gate within the first cycle while noise cannot keep the gate open
 * after motion stops. The jump detector separately compares takeoff rise with this envelope.
 */
const ATTACK_TAU_MS = 150;
const SUSTAINED_ATTACK_TAU_MS = 500;
const RELEASE_TAU_MS = 1000;
const MAX_ADAPTIVE_FREEZE_MS = 1200;

/**
 * Shared vertical channel for the torso: image-space shoulder-midpoint (and hip-midpoint when
 * visible) height normalized by torso height (or shoulder-width scale when hips are occluded
 * or degraded, so camera distance drift cancels out without injecting hip-occlusion jitter into
 * the denominator), lightly smoothed — the passband must keep 2.5–3.5 Hz running oscillation,
 * so the usual 1 Hz One Euro would eat most of the signal — with a slow adaptive baseline.
 * Only [11, 12] image shoulders are required so arm pump and high knees crossing the waist
 * never drop the cadence stream.
 */
export class TorsoVerticalChannel {
  private readonly baselineTauMs: number;
  private readonly positionFilter = new OneEuroFilter({ minCutoff: 3.5, beta: 1.5, derivativeCutoff: 3 });
  private torsoScale?: number;
  private baseline?: number;
  private baselineTimeMs?: number;
  private amplitudeMeanAbs?: number;
  private sustainedAmplitudeMeanAbs?: number;
  private previousEnvTimeMs?: number;
  private previous?: { position: number; timeMs: number };
  private previousShoulders?: { leftY: number; rightY: number };
  private adaptiveFreezeStartedAt?: number;

  constructor(options: { baselineTauMs?: number } = {}) {
    this.baselineTauMs = options.baselineTauMs ?? 1000;
  }

  update(snapshot: PoseSnapshot, freezeAdaptiveState = false): TorsoVerticalSample | undefined {
    const l = snapshot.landmarks;
    const leftShoulder = l[11];
    const rightShoulder = l[12];
    if (!leftShoulder || !rightShoulder) return undefined;
    if (landmarkConfidence(leftShoulder, rightShoulder) < CORE_MIN_CONFIDENCE) return undefined;
    const shoulders = midpoint(leftShoulder, rightShoulder);
    if (!Number.isFinite(shoulders.x) || !Number.isFinite(shoulders.y)) return undefined;

    const aspect = snapshot.frameHeight > 0 && snapshot.frameWidth > 0
      ? snapshot.frameHeight / snapshot.frameWidth
      : 720 / 1280;
    const shoulderWidth = Math.hypot(
      leftShoulder.x - rightShoulder.x,
      (leftShoulder.y - rightShoulder.y) * aspect,
    );

    const leftHip = l[23];
    const rightHip = l[24];
    const hipsVisible = Boolean(
      leftHip && rightHip && landmarkConfidence(leftHip, rightHip) >= CORE_MIN_CONFIDENCE,
    );
    const hips = hipsVisible ? midpoint(leftHip!, rightHip!) : undefined;
    const measuredTorsoHeight = hips
      ? hips.y - shoulders.y
      : undefined;

    const torsoHeight = measuredTorsoHeight !== undefined && Number.isFinite(measuredTorsoHeight) && measuredTorsoHeight >= MIN_TORSO_HEIGHT
      ? measuredTorsoHeight
      : this.torsoScale ?? (Number.isFinite(shoulderWidth) && shoulderWidth >= MIN_SHOULDER_WIDTH
        ? shoulderWidth * TORSO_TO_SHOULDER_RATIO
        : undefined);
    if (torsoHeight === undefined) return undefined;
    this.torsoScale = torsoHeight;

    if (freezeAdaptiveState) this.adaptiveFreezeStartedAt ??= snapshot.timestampMs;
    else this.adaptiveFreezeStartedAt = undefined;
    const shouldFreeze = freezeAdaptiveState && snapshot.timestampMs - this.adaptiveFreezeStartedAt! <= MAX_ADAPTIVE_FREEZE_MS;

    // When hips are confident, use hips.y / torsoHeight directly; when hips are occluded by
    // running arms or high knees, fall back seamlessly to shoulders.y + torsoHeight so the
    // normalized value stays in the exact same domain without dropping the frame.
    const raw = (hips ? hips.y : shoulders.y + torsoHeight) / torsoHeight;
    let shoulderAsymmetry01 = 0;
    if (this.previousShoulders) {
      const dL = (this.previousShoulders.leftY - leftShoulder.y) / torsoHeight;
      const dR = (this.previousShoulders.rightY - rightShoulder.y) / torsoHeight;
      const sumAbs = Math.abs(dL) + Math.abs(dR);
      if (sumAbs > 0.004) {
        // Real vertical torso bounce moves both shoulders in the same vertical direction (dL * dR > 0);
        // shrugging one shoulder, waving one arm or tilting the upper body produces high |dL - dR| / (|dL| + |dR|).
        shoulderAsymmetry01 = Math.min(1, Math.abs(dL - dR) / sumAbs);
      }
    }
    this.previousShoulders = { leftY: leftShoulder.y, rightY: rightShoulder.y };

    // Complementary alternating limb drive (knees 25/26 or elbows 13/14) normalized by torsoHeight:
    // supports high-cadence running where the runner glides with minimal vertical torso bounce.
    let limbDrive: number | undefined;
    const leftKnee = l[25];
    const rightKnee = l[26];
    const leftElbow = l[13];
    const rightElbow = l[14];
    if (leftKnee && rightKnee && landmarkConfidence(leftKnee, rightKnee) >= CORE_MIN_CONFIDENCE) {
      limbDrive = (rightKnee.y - leftKnee.y) / torsoHeight;
    } else if (leftElbow && rightElbow && landmarkConfidence(leftElbow, rightElbow) >= CORE_MIN_CONFIDENCE) {
      limbDrive = (rightElbow.y - leftElbow.y) / torsoHeight;
    }
    const position = this.positionFilter.filter(raw, snapshot.timestampMs);
    if (this.baseline === undefined) {
      this.baseline = position;
      this.baselineTimeMs = snapshot.timestampMs;
    } else {
      const dt = Math.min(Math.max((snapshot.timestampMs - this.baselineTimeMs!) / 1000, 1 / 120), 0.1);
      if (!shouldFreeze) {
        const alpha = 1 - Math.exp(-dt / (this.baselineTauMs / 1000));
        this.baseline += alpha * (position - this.baseline);
      }
      // Keep the next adaptation step tied to the next frame, even while frozen.
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
    const sustainedEnv = this.sustainedAmplitudeMeanAbs ?? 0;
    // Cap dtMs on the release path so a tracking blackout gap (>100 ms without samples) does not
    // artificially drain the amplitude envelope in a single post-gap frame.
    const rawDtMs = this.previousEnvTimeMs === undefined ? 33 : Math.max(snapshot.timestampMs - this.previousEnvTimeMs, 1);
    const dtMs = Math.min(rawDtMs, 66);
    if (!shouldFreeze) {
      const cadenceTau = absRise > env ? ATTACK_TAU_MS : RELEASE_TAU_MS;
      const cadenceAlpha = 1 - Math.exp(-dtMs / cadenceTau);
      this.amplitudeMeanAbs = env + cadenceAlpha * (absRise - env);

      const sustainedTau = absRise > sustainedEnv ? SUSTAINED_ATTACK_TAU_MS : RELEASE_TAU_MS;
      const sustainedAlpha = 1 - Math.exp(-dtMs / sustainedTau);
      this.sustainedAmplitudeMeanAbs = sustainedEnv + sustainedAlpha * (absRise - sustainedEnv);
    }
    this.previousEnvTimeMs = snapshot.timestampMs;

    return {
      timestampMs: snapshot.timestampMs,
      rise,
      velocityUp,
      // Mean-|rise| of a sinusoid is 2A/pi of its semi-amplitude: scale both envelopes back to
      // semi-amplitude units, the same units as the fixtures and detector thresholds.
      oscillationAmplitude: (this.amplitudeMeanAbs ?? 0) / 0.64,
      sustainedOscillationAmplitude: (this.sustainedAmplitudeMeanAbs ?? 0) / 0.64,
      shoulderAsymmetry01,
      limbDrive,
      source: hips ? 'hips' : 'shoulders',
    };
  }

  reset(): void {
    this.positionFilter.reset();
    this.torsoScale = undefined;
    this.baseline = undefined;
    this.baselineTimeMs = undefined;
    this.amplitudeMeanAbs = undefined;
    this.sustainedAmplitudeMeanAbs = undefined;
    this.previousEnvTimeMs = undefined;
    this.previous = undefined;
    this.previousShoulders = undefined;
    this.adaptiveFreezeStartedAt = undefined;
  }
}
