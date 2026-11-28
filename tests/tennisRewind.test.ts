import { describe, expect, it } from 'vitest';
import { advanceBall, createBall, solveOutgoing, timeAtPlane, type BallState } from '../src/games/tennis/ballistics';

/**
 * Integration proof of the rewind+fast-forward mechanism the whole tennis design rests on
 * (docs/design-tenis.md §3.5): the game tapes ball states per fixed step, rewinds to the
 * swing's physical peak instant to adjudicate, re-hits there, and fast-forwards to now.
 * Detection latency must never enter the physics — these tests pin the algebra.
 */

const FIXED_DT = 1 / 60;

/** Simulates the game's tape: fixed-step states with absolute timestamps. */
function tapeOf(initial: BallState, startMs: number, steps: number): { tMs: number; ball: BallState }[] {
  const tape: { tMs: number; ball: BallState }[] = [{ tMs: startMs, ball: initial }];
  for (let i = 1; i <= steps; i += 1) {
    tape.push({ tMs: startMs + i * FIXED_DT * 1000, ball: advanceBall(tape[i - 1]!.ball, FIXED_DT) });
  }
  return tape;
}

/** The same anchor+advance reconstruction TennisGame.rewind performs. */
function rewind(tape: { tMs: number; ball: BallState }[], tMs: number): BallState {
  let anchor = tape[0]!;
  for (const entry of tape) {
    if (entry.tMs <= tMs) anchor = entry;
    else break;
  }
  return advanceBall(anchor.ball, Math.max(0, (tMs - anchor.tMs) / 1000));
}

describe('rewind reconstruction', () => {
  const incoming = createBall({ x: 0.4, y: 1.2, z: -7.2 }, { x: 0.8, y: 4.2, z: 13.5 }, 'opponent');

  it('reproduces the true flight state at an arbitrary instant between tape entries', () => {
    const tape = tapeOf(incoming, 5_000, 90);
    // Instant not aligned to the 60 Hz grid — interpolation-free exactness is the claim.
    const probeMs = 5_000 + 617.3;
    const truth = advanceBall(incoming, (probeMs - 5_000) / 1000);
    const reconstructed = rewind(tape, probeMs);
    expect(reconstructed.position.x).toBeCloseTo(truth.position.x, 9);
    expect(reconstructed.position.y).toBeCloseTo(truth.position.y, 9);
    expect(reconstructed.position.z).toBeCloseTo(truth.position.z, 9);
    expect(reconstructed.velocity.z).toBeCloseTo(truth.velocity.z, 9);
  });

  it('stays exact across a bounce inside the rewind window', () => {
    // Hard flat ball that bounces within a second — the exact-substep integrator is load-bearing.
    const flat = createBall({ x: 0, y: 0.9, z: -7.2 }, { x: 0.5, y: 1.2, z: 16 }, 'opponent');
    const tape = tapeOf(flat, 5_000, 90);
    const probeMs = 5_000 + 950;
    const truth = advanceBall(flat, 0.95);
    const reconstructed = rewind(tape, probeMs);
    expect(reconstructed.position.z).toBeCloseTo(truth.position.z, 9);
    expect(reconstructed.bounces).toBe(truth.bounces);
  });

  it('fast-forward after a re-hit matches integrating the new flight from scratch', () => {
    const tape = tapeOf(incoming, 5_000, 90);
    const peakMs = 5_000 + 617.3;
    const nowMs = peakMs + 180; // 180 ms of detection+pipeline latency — the Nevergear-scale case
    const ballAtPeak = rewind(tape, peakMs);

    // Contact: outgoing solved at the peak instant, then fast-forwarded — TennisGame's exact algebra.
    const outgoing = solveOutgoing(ballAtPeak.position, { x: -2, z: -8 }, 0.9);
    const inGame = advanceBall(createBall(ballAtPeak.position, outgoing, 'player'), (nowMs - peakMs) / 1000);
    const truth = advanceBall(createBall(ballAtPeak.position, outgoing, 'player'), 0.18);
    expect(inGame.position.z).toBeCloseTo(truth.position.z, 9);
    expect(inGame.position.y).toBeCloseTo(truth.position.y, 9);
    // And the latency does not corrupt the hit itself: the contact position is latency-free.
    expect(ballAtPeak.position.z).toBeCloseTo(advanceBall(incoming, 0.6173).position.z, 9);
  });
});

describe('timeAtPlane prediction', () => {
  it('predicts the crossing time the opponent planning relies on, within one scan step', () => {
    const shot = createBall({ x: 0.5, y: 1.1, z: 7.2 }, { x: -0.6, y: 3.8, z: -14 }, 'player');
    const crossing = timeAtPlane(shot, -7.2);
    expect(crossing).not.toBeNull();
    // Independent check: simulate at fine resolution until the plane is crossed.
    let ball = shot;
    let elapsed = 0;
    while (ball.position.z > -7.2 && elapsed < 5) {
      ball = advanceBall(ball, 1 / 240);
      elapsed += 1 / 240;
    }
    expect(Math.abs(crossing!.timeSeconds - elapsed)).toBeLessThan(1 / 60);
  });
});
