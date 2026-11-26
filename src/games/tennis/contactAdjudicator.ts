import { solveOutgoing, type BallState } from './ballistics';

/**
 * Pure swing adjudication by timing — the heart of the tennis design
 * (docs/design-tenis.md §3.4). No DOM, no Three.js, no randomness, no global time.
 *
 * This module carries two contracts over the same mechanic:
 *
 * - `adjudicateContact` — the integration API consumed by TennisGame. Direction comes
 *   from WHEN the swing peaked relative to the ball's arrival, computed spatially
 *   against the ball state rewound to the physical peak instant, so detection latency
 *   cannot corrupt timing. Adds spin, smash and movement-penalty effects.
 * - `adjudicateSwing` — the minimal temporal-input contract: the caller supplies the
 *   ideal plane-crossing timestamp and the swing's peak timestamp explicitly, and gets
 *   back contact/whiff with CEDO/PERFEITO/TARDE feedback, a continuous lateral angle
 *   mirrored for the backhand, and the exit speed. Nothing the other contract does not
 *   already imply — it exists for callers that adjudicate purely on timestamps.
 */

export interface SwingContactInput {
  side: 'forehand' | 'backhand';
  power01: number;
  /** Vertical wrist speed at the peak in shoulder widths/s, up positive — the spin proxy. */
  verticalSpeed: number;
  /** Wrist height relative to the shoulder at the peak, in shoulder widths. */
  contactY: number;
}

export interface ContactGeometry {
  /** z of the ideal contact plane in front of the player. */
  contactPlaneZ: number;
  /** Ball past playerZ + passMarginZ is dead regardless of timing. */
  playerZ: number;
  passMarginZ: number;
  /** Lateral distance from the avatar center the racket still covers. */
  reachRadius: number;
  /** Arcade contact window: |timing error| beyond this is a whiff. */
  maxTimingMs: number;
  /** Timing error mapped over this span reaches full lateral angle. */
  timingSpanMs: number;
  /** Lateral target at full span, in court units. */
  maxLateralTargetX: number;
  /** |aim| under this reads as a center shot. */
  centerAimX: number;
  /** Deepest/shallowest target depth past the net. */
  deepTargetZ: number;
  shallowTargetZ: number;
  /** Ball at or above this height at contact turns the stroke into a smash. */
  smashHeight: number;
  /** Forward speeds in court units/s; flight time derives from them. */
  minForwardSpeed: number;
  maxForwardSpeed: number;
}

export const DEFAULT_GEOMETRY: ContactGeometry = {
  contactPlaneZ: 7.2,
  playerZ: 8.3,
  passMarginZ: 1.2,
  reachRadius: 1.15,
  maxTimingMs: 280,
  timingSpanMs: 200,
  maxLateralTargetX: 2.8,
  centerAimX: 0.9,
  deepTargetZ: -9.2,
  shallowTargetZ: -6.8,
  smashHeight: 1.8,
  minForwardSpeed: 11,
  maxForwardSpeed: 20,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampSigned = (value: number) => Math.min(1, Math.max(-1, value));

/**
 * Timing error in milliseconds derived spatially: how far the ball is from the contact plane,
 * converted by its own approach speed. Exactly `t_peak − t_ideal` under constant approach speed
 * (see design doc §3.4): negative = early, positive = late. Undefined when not approaching.
 * Constant-vz approximation: exact while airborne, slightly off across a frictioned bounce.
 */
export function spatialTimingErrorMs(ballAtPeak: BallState, contactPlaneZ: number): number | undefined {
  const vz = ballAtPeak.velocity.z;
  if (vz === 0) return undefined;
  return ((ballAtPeak.position.z - contactPlaneZ) / vz) * 1000;
}

export type ContactOutcome =
  | { kind: 'ignore' }
  | { kind: 'whiff'; reason: 'early' | 'late' | 'out-of-reach' | 'dead-ball' }
  | {
      kind: 'contact';
      outgoing: { x: number; y: number; z: number };
      direction: 'cross' | 'center' | 'line';
      aimX: number;
      timingErrorMs: number;
      quality01: number;
      spin: number;
      smash: boolean;
    };

export interface AdjudicationQuery {
  /** Ball state resolved back at the swing's physical peak instant (the rewind). */
  ballAtPeak: BallState;
  playerX: number;
  /** 0 = avatar set, 1 = avatar still sprinting to reach — taxes the return pace. */
  movementPenalty01: number;
  swing: SwingContactInput;
  /** Temporal error when the caller computes it directly (serve toss); spatial otherwise. */
  timingErrorOverrideMs?: number;
  geometry?: Partial<ContactGeometry>;
}

/**
 * Wii-style contact adjudication: direction comes from WHEN the swing peaked relative to the
 * ball's arrival, never from where the arm ended up. Everything is computed against the ball
 * state rewound to the physical peak instant, so detection latency cannot corrupt timing.
 */
export function adjudicateContact(query: AdjudicationQuery): ContactOutcome {
  const geo: ContactGeometry = { ...DEFAULT_GEOMETRY, ...query.geometry };
  const { ballAtPeak, swing } = query;

  const timingErrorMs =
    query.timingErrorOverrideMs ??
    (ballAtPeak.velocity.z > 0.5 ? spatialTimingErrorMs(ballAtPeak, geo.contactPlaneZ) : undefined);
  if (timingErrorMs === undefined || !Number.isFinite(timingErrorMs)) return { kind: 'ignore' };

  if (ballAtPeak.bounces >= 2 || ballAtPeak.position.z > geo.playerZ + geo.passMarginZ) {
    return { kind: 'whiff', reason: 'dead-ball' };
  }
  if (Math.abs(ballAtPeak.position.x - query.playerX) > geo.reachRadius) {
    return { kind: 'whiff', reason: 'out-of-reach' };
  }
  if (timingErrorMs < -geo.maxTimingMs) return { kind: 'whiff', reason: 'early' };
  if (timingErrorMs > geo.maxTimingMs) return { kind: 'whiff', reason: 'late' };

  const quality01 = 1 - clamp01(Math.abs(timingErrorMs) / geo.maxTimingMs);

  // Direction: the continuous timing-to-angle mapping, mirrored for the backhand — early
  // contact pulls across, late contact pushes down the line, like the real sport.
  const normalizedTiming = clampSigned(timingErrorMs / geo.timingSpanMs);
  const sideMirror = swing.side === 'forehand' ? 1 : -1;
  const aimX = normalizedTiming * sideMirror * geo.maxLateralTargetX;
  const direction =
    Math.abs(aimX) < geo.centerAimX
      ? ('center' as const)
      : aimX * sideMirror < 0
        ? ('cross' as const)
        : ('line' as const);

  // Pace: swing speed taxed by mistiming and by a still-moving avatar.
  const smash = ballAtPeak.position.y >= geo.smashHeight;
  const movementCap = 1 - 0.35 * clamp01(query.movementPenalty01);
  const qualityCap = 0.7 + 0.3 * quality01;
  const powerCap = movementCap * qualityCap * (smash ? 1.2 : 1);
  const forwardSpeed =
    geo.minForwardSpeed + (geo.maxForwardSpeed - geo.minForwardSpeed) * clamp01(swing.power01) * powerCap;

  // Depth follows pace: harder shots land deeper; flight time is imposed by the pace.
  const depthT = clamp01((forwardSpeed - geo.minForwardSpeed) / (geo.maxForwardSpeed - geo.minForwardSpeed));
  const targetZ = geo.shallowTargetZ + (geo.deepTargetZ - geo.shallowTargetZ) * depthT;
  const flightTime = (ballAtPeak.position.z - targetZ) / forwardSpeed;

  const outgoing = solveOutgoing(ballAtPeak.position, { x: aimX, z: targetZ }, flightTime);
  const spin = clampSigned(swing.verticalSpeed / 3);

  return {
    kind: 'contact',
    outgoing,
    direction,
    aimX,
    timingErrorMs,
    quality01,
    spin,
    smash,
  };
}

// ---------------------------------------------------------------------------
// Minimal temporal contract — adjudication purely on timestamps.
// ---------------------------------------------------------------------------

export type SwingSide = 'forehand' | 'backhand';
export type ContactFeedback = 'CEDO' | 'PERFEITO' | 'TARDE';
export type TimingWhiffReason = 'dead-ball' | 'timing' | 'out-of-reach';

export interface AdjudicatorConfig {
  /** Half-window around the ideal instant inside which contact is possible. */
  readonly windowMs: number;
  /** Half-window inside which the timing reads as PERFEITO. */
  readonly perfectWindowMs: number;
  /** Lateral distance from the avatar centre within which the ball is reachable. */
  readonly lateralReach: number;
  /** Angle swept at the edge of the timing window; extreme timing misses wide by geometry. */
  readonly maxLateralAngleRad: number;
  /** Exit speed range in units/s, interpolated by power01. */
  readonly minExitSpeed: number;
  readonly maxExitSpeed: number;
}

export const DEFAULT_ADJUDICATOR_CONFIG: AdjudicatorConfig = {
  windowMs: 280,
  perfectWindowMs: 80,
  lateralReach: 1.15,
  maxLateralAngleRad: (20 * Math.PI) / 180,
  minExitSpeed: 11,
  maxExitSpeed: 20,
};

export interface AdjudicateSwingInput {
  /** Best estimate of the ball state at the contact moment (position and bounces are read). */
  readonly ball: BallState;
  /** Absolute time the ball crosses the contact plane in the hittable band. */
  readonly idealCrossingTimestampMs: number;
  /** Absolute time of the swing peak as estimated by the detector. */
  readonly peakTimestampMs: number;
  readonly side: SwingSide;
  /** Swing power 0..1 as reported by the detector; clamped defensively. */
  readonly power01: number;
  /** Lateral position of the hitting avatar's centre. */
  readonly avatarX: number;
}

export interface ContactHit {
  readonly kind: 'contact';
  /** Signed: negative means the swing peaked before the ideal instant (early). */
  readonly timingErrorMs: number;
  /** 1 at perfect timing, decaying linearly to 0 at the window edge. */
  readonly quality01: number;
  readonly feedback: ContactFeedback;
  /**
   * Signed lateral angle of the outgoing shot: positive sweeps toward +x for a
   * forehand as the contact gets later, and the backhand mirrors it. Convert to a
   * lateral target downstream with x0 + tan(angle) · forwardDistance.
   */
  readonly lateralAngleRad: number;
  /** Ball speed right after the hit, in units/s. */
  readonly exitSpeed: number;
}

export interface ContactWhiff {
  readonly kind: 'whiff';
  readonly timingErrorMs: number;
  readonly reason: TimingWhiffReason;
}

export type SwingAdjudication = ContactHit | ContactWhiff;

/**
 * Timestamp-contract adjudication: `timingErrorMs = peakTimestampMs − idealCrossingTimestampMs`,
 * both on the same clock so detection latency cancels out. Contact requires the error inside
 * the window, a live ball (fewer than two bounces) and the ball inside the lateral reach.
 */
export function adjudicateSwing(
  input: AdjudicateSwingInput,
  config: AdjudicatorConfig = DEFAULT_ADJUDICATOR_CONFIG,
): SwingAdjudication {
  const timingErrorMs = input.peakTimestampMs - input.idealCrossingTimestampMs;

  if (input.ball.bounces >= 2) return { kind: 'whiff', timingErrorMs, reason: 'dead-ball' };
  // NaN/Infinity never compare true against the window, so without the explicit
  // finite guard they would slip through and be judged perfect contact.
  if (!Number.isFinite(timingErrorMs) || Math.abs(timingErrorMs) > config.windowMs) {
    return { kind: 'whiff', timingErrorMs, reason: 'timing' };
  }
  if (Math.abs(input.ball.position.x - input.avatarX) > config.lateralReach) {
    return { kind: 'whiff', timingErrorMs, reason: 'out-of-reach' };
  }

  const normalizedError = timingErrorMs / config.windowMs;
  const quality01 = 1 - Math.abs(normalizedError);
  const feedback: ContactFeedback =
    Math.abs(timingErrorMs) <= config.perfectWindowMs ? 'PERFEITO' : timingErrorMs < 0 ? 'CEDO' : 'TARDE';
  const mirror = input.side === 'forehand' ? 1 : -1;
  const lateralAngleRad = normalizedError * config.maxLateralAngleRad * mirror;
  // Non-finite power means a detector glitch, never a super-powered shot: floor at 0.
  const power01 = Number.isFinite(input.power01) ? Math.min(1, Math.max(0, input.power01)) : 0;
  const exitSpeed = config.minExitSpeed + power01 * (config.maxExitSpeed - config.minExitSpeed);

  return { kind: 'contact', timingErrorMs, quality01, feedback, lateralAngleRad, exitSpeed };
}
