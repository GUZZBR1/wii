import { describe, expect, it } from 'vitest';
import { createBall, type BallState } from '../src/games/tennis/ballistics';
import {
  adjudicateContact,
  adjudicateSwing,
  DEFAULT_ADJUDICATOR_CONFIG,
  spatialTimingErrorMs,
  type AdjudicateSwingInput,
  type AdjudicationQuery,
  type SwingContactInput,
} from '../src/games/tennis/contactAdjudicator';

const swing = (overrides: Partial<SwingContactInput> = {}): SwingContactInput => ({
  side: 'forehand',
  power01: 0.65,
  verticalSpeed: 0,
  contactY: 0,
  ...overrides,
});

/** Incoming ball frozen at the contact plane at a hittable height — the perfect-contact setup. */
const incoming = (overrides: { x?: number; y?: number; z?: number; vz?: number; bounces?: number } = {}): BallState => {
  const { x = 0, y = 1.1, z = 7.2, vz = 14, bounces = 0 } = overrides;
  const ball = createBall({ x, y, z }, { x: 0, y: -1, z: vz }, 'opponent');
  return { ...ball, bounces };
};

const query = (overrides: Partial<AdjudicationQuery> = {}): AdjudicationQuery => ({
  ballAtPeak: incoming(),
  playerX: 0,
  movementPenalty01: 0,
  swing: swing(),
  ...overrides,
});

describe('spatialTimingErrorMs', () => {
  it('is zero exactly at the contact plane, negative before it (early), positive past it (late)', () => {
    expect(spatialTimingErrorMs(incoming(), 7.2)).toBeCloseTo(0, 5);
    // Ball 1.4 m short of the plane at 14 u/s: the swing happened 100 ms too early.
    expect(spatialTimingErrorMs(incoming({ z: 5.8 }), 7.2)).toBeCloseTo(-100, 5);
    expect(spatialTimingErrorMs(incoming({ z: 8.6 }), 7.2)).toBeCloseTo(100, 5);
  });

  it('is undefined when the ball is not approaching', () => {
    expect(spatialTimingErrorMs(incoming({ vz: 0 }), 7.2)).toBeUndefined();
  });
});

describe('adjudicateContact — whiffs', () => {
  it('ignores balls that are not even approaching the player', () => {
    expect(adjudicateContact(query({ ballAtPeak: incoming({ vz: -8 }) })).kind).toBe('ignore');
  });

  it('ignores non-finite timing overrides instead of turning them into perfect hits', () => {
    for (const timingErrorOverrideMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(adjudicateContact(query({ timingErrorOverrideMs }))).toEqual({ kind: 'ignore' });
    }
  });

  it('whiffs early and late outside the timing window', () => {
    // Slow ball (7 u/s) so the ±290 ms offsets stay inside the pass margin — isolating timing.
    expect(adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 - 7 * 0.29, vz: 7 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'early',
    });
    expect(adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 + 7 * 0.29, vz: 7 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'late',
    });
  });

  it('whiffs when the ball is beyond the lateral reach even with perfect timing', () => {
    expect(adjudicateContact(query({ ballAtPeak: incoming({ x: 1.4 }), playerX: 0 }))).toMatchObject({
      kind: 'whiff',
      reason: 'out-of-reach',
    });
    expect(adjudicateContact(query({ ballAtPeak: incoming({ x: 1.1 }), playerX: 0 })).kind).toBe('contact');
  });

  it('dead-balls after the second bounce and after passing the player', () => {
    expect(adjudicateContact(query({ ballAtPeak: incoming({ bounces: 2 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'dead-ball',
    });
    expect(adjudicateContact(query({ ballAtPeak: incoming({ z: 9.6 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'dead-ball',
    });
  });
});

describe('adjudicateContact — contacts', () => {
  it('perfect timing hits center with full quality', () => {
    const out = adjudicateContact(query());
    expect(out).toMatchObject({ kind: 'contact', direction: 'center' });
    if (out.kind !== 'contact') return;
    expect(out.quality01).toBeGreaterThan(0.95);
    expect(out.outgoing.z).toBeLessThan(0); // toward the opponent
  });

  it('early forehand pulls cross, late forehand pushes line — continuously', () => {
    // ±0.1 s at 14 u/s ≈ 1.4 m off-plane.
    const early = adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 - 1.4 }) }));
    const late = adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 + 1.4 }) }));
    expect(early).toMatchObject({ kind: 'contact', direction: 'cross' });
    expect(late).toMatchObject({ kind: 'contact', direction: 'line' });
    if (early.kind !== 'contact' || late.kind !== 'contact') return;
    expect(early.outgoing.x).toBeLessThan(0);
    expect(late.outgoing.x).toBeGreaterThan(0);
  });

  it('mirrors the timing-direction mapping for the backhand, like real tennis', () => {
    const earlyBackhand = adjudicateContact(
      query({ ballAtPeak: incoming({ z: 7.2 - 1.4 }), swing: swing({ side: 'backhand' }) }),
    );
    if (earlyBackhand.kind !== 'contact') throw new Error('expected contact');
    // Early on the backhand side sends the ball the opposite way than early on the forehand.
    expect(earlyBackhand.outgoing.x).toBeGreaterThan(0);
    expect(earlyBackhand.direction).toBe('cross');
  });

  it('the outgoing trajectory crosses the net toward the opponent court', () => {
    const out = adjudicateContact(query());
    if (out.kind !== 'contact') throw new Error('expected contact');
    expect(out.outgoing.z).toBeLessThan(-10); // real forward pace
    // Low net clearance is physical: from 1.1 m the arc peaks well above the 0.9 m net.
    expect(out.outgoing.y).toBeGreaterThan(0);
  });

  it('faster swings hit harder; mistiming and movement tax the pace', () => {
    const strong = adjudicateContact(query({ swing: swing({ power01: 1 }) }));
    const weak = adjudicateContact(query({ swing: swing({ power01: 0.2 }) }));
    if (strong.kind !== 'contact' || weak.kind !== 'contact') throw new Error('expected contact');
    expect(Math.abs(strong.outgoing.z)).toBeGreaterThan(Math.abs(weak.outgoing.z));

    const moving = adjudicateContact(query({ movementPenalty01: 1, swing: swing({ power01: 1 }) }));
    if (moving.kind !== 'contact') throw new Error('expected contact');
    expect(Math.abs(moving.outgoing.z)).toBeLessThan(Math.abs(strong.outgoing.z));
  });

  it('reads a rising wrist as topspin and a falling wrist as slice', () => {
    const topspin = adjudicateContact(query({ swing: swing({ verticalSpeed: 3 }) }));
    const slice = adjudicateContact(query({ swing: swing({ verticalSpeed: -3 }) }));
    if (topspin.kind !== 'contact' || slice.kind !== 'contact') throw new Error('expected contact');
    expect(topspin.spin).toBeGreaterThan(0.5);
    expect(slice.spin).toBeLessThan(-0.5);
  });

  it('smashes a high ball with bonus pace', () => {
    const high = adjudicateContact(query({ ballAtPeak: incoming({ y: 2.1 }), swing: swing({ power01: 0.65 }) }));
    const normal = adjudicateContact(query());
    if (high.kind !== 'contact' || normal.kind !== 'contact') throw new Error('expected contact');
    expect(high.smash).toBe(true);
    expect(Math.abs(high.outgoing.z)).toBeGreaterThan(Math.abs(normal.outgoing.z));
  });

  it('a ball below the net cord at contact lifts a steep, error-prone arc', () => {
    const low = adjudicateContact(query({ ballAtPeak: incoming({ y: 0.45 }) }));
    if (low.kind !== 'contact') throw new Error('expected contact');
    // Low contact must climb: vy positive and large relative to a normal contact.
    expect(low.outgoing.y).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Temporal timestamp contract — adjudicateSwing.
// ---------------------------------------------------------------------------

const IDEAL = 10_000;

const timedInput = (overrides: Partial<AdjudicateSwingInput> = {}): AdjudicateSwingInput => ({
  ball: createBall({ x: 0, y: 1.1, z: 7.2 }, { x: 0, y: 0, z: 5 }, 'opponent'),
  idealCrossingTimestampMs: IDEAL,
  peakTimestampMs: IDEAL,
  side: 'forehand',
  power01: 0.5,
  avatarX: 0,
  ...overrides,
});

describe('adjudicateSwing — temporal contract', () => {
  it('resolves a perfect swing as contact with full quality and a straight angle', () => {
    const result = adjudicateSwing(timedInput());
    expect(result.kind).toBe('contact');
    if (result.kind !== 'contact') return;
    expect(result.timingErrorMs).toBe(0);
    expect(result.feedback).toBe('PERFEITO');
    expect(result.quality01).toBe(1);
    expect(result.lateralAngleRad).toBe(0);
  });

  it('accepts contact at the exact window edge and whiffs just outside it', () => {
    const edge = DEFAULT_ADJUDICATOR_CONFIG.windowMs;
    expect(adjudicateSwing(timedInput({ peakTimestampMs: IDEAL + edge })).kind).toBe('contact');
    expect(adjudicateSwing(timedInput({ peakTimestampMs: IDEAL - edge })).kind).toBe('contact');
    const outside = adjudicateSwing(timedInput({ peakTimestampMs: IDEAL + edge + 1 }));
    expect(outside).toEqual({ kind: 'whiff', timingErrorMs: edge + 1, reason: 'timing' });
  });

  it('labels feedback CEDO/PERFEITO/TARDE around the perfect window', () => {
    const perfectBand = DEFAULT_ADJUDICATOR_CONFIG.perfectWindowMs;
    const feedbackAt = (errorMs: number) => {
      const result = adjudicateSwing(timedInput({ peakTimestampMs: IDEAL + errorMs }));
      return result.kind === 'contact' ? result.feedback : 'whiff';
    };
    expect(feedbackAt(0)).toBe('PERFEITO');
    expect(feedbackAt(perfectBand)).toBe('PERFEITO');
    expect(feedbackAt(-perfectBand)).toBe('PERFEITO');
    expect(feedbackAt(-perfectBand - 1)).toBe('CEDO');
    expect(feedbackAt(perfectBand + 1)).toBe('TARDE');
  });

  it('decays quality linearly from perfect timing to the window edge', () => {
    const qualityAt = (errorMs: number) => {
      const result = adjudicateSwing(timedInput({ peakTimestampMs: IDEAL + errorMs }));
      if (result.kind !== 'contact') throw new Error('expected contact');
      return result.quality01;
    };
    expect(qualityAt(0)).toBe(1);
    expect(qualityAt(140)).toBeCloseTo(0.5, 10);
    expect(qualityAt(-140)).toBeCloseTo(0.5, 10);
    expect(qualityAt(280)).toBeCloseTo(0, 10);
  });

  it('maps timing error to a continuous lateral angle, mirrored on the backhand', () => {
    const angleAt = (errorMs: number, side: 'forehand' | 'backhand') => {
      const result = adjudicateSwing(timedInput({ peakTimestampMs: IDEAL + errorMs, side }));
      if (result.kind !== 'contact') throw new Error('expected contact');
      return result.lateralAngleRad;
    };
    // Half-window error sweeps half the maximum angle (20° → 10° here).
    expect(angleAt(140, 'forehand')).toBeCloseTo((10 * Math.PI) / 180, 6);
    expect(angleAt(-140, 'forehand')).toBeCloseTo((-10 * Math.PI) / 180, 6);
    // Backhand mirrors the same timing.
    expect(angleAt(140, 'backhand')).toBeCloseTo((-10 * Math.PI) / 180, 6);
    expect(angleAt(-140, 'backhand')).toBeCloseTo((10 * Math.PI) / 180, 6);
    // Monotone in the timing error: later contact opens the angle further.
    expect(Math.abs(angleAt(200, 'forehand'))).toBeGreaterThan(Math.abs(angleAt(100, 'forehand')));
    // At the window edge the angle saturates at ±20°.
    expect(angleAt(280, 'forehand')).toBeCloseTo((20 * Math.PI) / 180, 6);
  });

  it('scales exit speed with clamped power between the configured range', () => {
    const speedAt = (power01: number) => {
      const result = adjudicateSwing(timedInput({ power01 }));
      if (result.kind !== 'contact') throw new Error('expected contact');
      return result.exitSpeed;
    };
    expect(speedAt(0)).toBe(11);
    expect(speedAt(1)).toBe(20);
    expect(speedAt(0.5)).toBeCloseTo(15.5, 10);
    expect(speedAt(2)).toBe(20);
    expect(speedAt(-1)).toBe(11);
  });

  it('whiffs on a dead ball even with perfect timing', () => {
    const dead = createBall({ x: 0, y: 0, z: 7.2 }, { x: 0, y: 0, z: 0 }, 'opponent');
    const ball = { ...dead, bounces: 2 };
    const result = adjudicateSwing(timedInput({ ball }));
    expect(result).toEqual({ kind: 'whiff', timingErrorMs: 0, reason: 'dead-ball' });
  });

  it('whiffs when the ball is beyond the lateral reach of the avatar', () => {
    const far = createBall({ x: 2, y: 1.1, z: 7.2 }, { x: 0, y: 0, z: 5 }, 'opponent');
    const result = adjudicateSwing(timedInput({ ball: far, avatarX: 0 }));
    expect(result.kind).toBe('whiff');
    if (result.kind !== 'whiff') return;
    expect(result.reason).toBe('out-of-reach');
    // Exactly at the reach boundary the contact still counts.
    const atReach = createBall(
      { x: DEFAULT_ADJUDICATOR_CONFIG.lateralReach, y: 1.1, z: 7.2 },
      { x: 0, y: 0, z: 5 },
      'opponent',
    );
    expect(adjudicateSwing(timedInput({ ball: atReach, avatarX: 0 })).kind).toBe('contact');
  });

  it('never produces contact from non-finite timing input', () => {
    // NaN comparisons are false — without an explicit guard a NaN error would slip
    // through the window check and be judged a perfect contact.
    for (const peakTimestampMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(adjudicateSwing(timedInput({ peakTimestampMs })).kind).toBe('whiff');
    }
    expect(adjudicateSwing(timedInput({ idealCrossingTimestampMs: Number.NaN })).kind).toBe('whiff');
  });

  it('is deterministic: identical inputs give identical results', () => {
    const input = timedInput({ peakTimestampMs: IDEAL + 137, power01: 0.73, side: 'backhand' });
    expect(adjudicateSwing(input)).toEqual(adjudicateSwing(input));
  });
});
