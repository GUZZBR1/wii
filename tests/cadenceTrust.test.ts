import { describe, expect, it } from 'vitest';
import { cadenceHarness } from './fixtures/torsoHarness';
import { poseWithHipBounce } from './fixtures/syntheticPose';

/**
 * The effort gate opens only when vertical bounce and lateral weight transfer agree: running in
 * place always does both, while even violent arm swinging bounces the torso without shifting the
 * body's weight — the separation the real clips show (arms xRMS 0.02-0.03, running 0.06-0.13
 * shoulder widths).
 */
function drive(times: number[], vertical: (t: number) => number, lateral: (t: number) => number) {
  const { feed } = cadenceHarness();
  return times.map((t) => feed(poseWithHipBounce(t, vertical(t), undefined, lateral(t))));
}

const bounce = (t: number) => 0.016 * Math.sin((2 * Math.PI * 2.5 * t) / 1000);
const sway = (t: number) => 0.05 * Math.cos((2 * Math.PI * 2.5 * t) / 1000);
const times = Array.from({ length: 120 }, (_, i) => i * 33);

describe('effort-gate trust in the cadence tracker', () => {
  it('never opens for vertical torso bounce without weight transfer — the violent arm-swing shape', () => {
    const results = drive(times, bounce, () => 0);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('never opens for weight transfer without vertical bounce', () => {
    const results = drive(times, () => 0, sway);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('opens when bounce and weight transfer confirm each other', () => {
    const results = drive(times, bounce, sway);
    expect(results.some((r) => r.running)).toBe(true);
  });

  it('holds through a flat stretch on weight transfer alone once open, and closes after it stops', () => {
    const { feed } = cadenceHarness();
    const running = [];
    for (const t of times) running.push(feed(poseWithHipBounce(t, bounce(t), undefined, sway(t))));
    expect(running.at(-1)!.running).toBe(true);
    // The bounce stops but the weight keeps shifting — a flat jog with a stable head.
    const flat = [];
    for (let t = 3996 + 33; t <= 3996 + 1200; t += 33) flat.push(feed(poseWithHipBounce(t, 0, undefined, sway(t))));
    expect(flat.every((r) => r.running)).toBe(true);
    // Everything stops: the gate closes once the lateral window drains and the hold elapses.
    const still = [];
    for (let t = 3996 + 1233; t <= 3996 + 1233 + 3600; t += 33) still.push(feed(poseWithHipBounce(t, 0, undefined, 0)));
    expect(still.at(-1)!.running).toBe(false);
  });
});
