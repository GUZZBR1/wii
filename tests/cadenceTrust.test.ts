import { describe, expect, it } from 'vitest';
import { cadenceHarness } from './fixtures/torsoHarness';
import { poseWithHipBounce } from './fixtures/syntheticPose';

/**
 * The effort gate opens when vertical bounce is corroborated — by lateral weight transfer or by
 * rhythmic strides — because neither shape appears without real locomotion: violent arm swinging
 * bounces the torso but arrhythmically and with the weight centered, while centered two-foot
 * jogging bounces rhythmically without sway. Once open, lateral motion alone only bridges a few
 * seconds: a sideways shuffle must not renew the verdict forever.
 */
function drive(times: number[], vertical: (t: number) => number, lateral: (t: number) => number) {
  const { feed } = cadenceHarness();
  return times.map((t) => feed(poseWithHipBounce(t, vertical(t), undefined, lateral(t))));
}

const bounce = (t: number) => 0.016 * Math.sin((2 * Math.PI * 2.5 * t) / 1000);
const sway = (t: number) => 0.05 * Math.cos((2 * Math.PI * 2.5 * t) / 1000);
const times = Array.from({ length: 120 }, (_, i) => i * 33);

describe('effort-gate trust in the cadence tracker', () => {
  it('opens for rhythmic vertical bounce alone — the centered two-foot jog', () => {
    const results = drive(times, bounce, () => 0);
    expect(results.some((r) => r.running)).toBe(true);
  });

  it('never opens for arrhythmic vertical flicker — the violent arm-swing shape', () => {
    // Short irregular bursts of torso oscillation: `moving` fires inside a burst, but the rises
    // never chain into consecutive stride intervals and the weight never transfers.
    const flicker = (t: number) => (t % 1900 < 500 ? bounce(t) : 0);
    const results = drive(times, flicker, () => 0);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('never opens for weight transfer without vertical bounce', () => {
    const results = drive(times, () => 0, sway);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('opens when bounce and weight transfer corroborate before the rhythm establishes', () => {
    // Lateral corroboration is the fast path: the trust opens within the first strides, before
    // three stride intervals could possibly have accumulated.
    const { feed } = cadenceHarness();
    const early = times.slice(0, 40).map((t) => feed(poseWithHipBounce(t, bounce(t), undefined, sway(t))));
    expect(early.some((r) => r.running)).toBe(true);
  });

  it('bridges a flat stretch on weight transfer but caps the bridge without fresh strides', () => {
    const { feed } = cadenceHarness();
    for (const t of times) feed(poseWithHipBounce(t, bounce(t), undefined, sway(t)));
    let t = times.at(-1)!;
    // The bounce stops but the weight keeps shifting — a flat jog with a stable head.
    const bridged = [];
    for (t += 33; t <= times.at(-1)! + 2000; t += 33) bridged.push(feed(poseWithHipBounce(t, 0, undefined, sway(t))));
    expect(bridged.every((r) => r.running)).toBe(true);
    // The shuffle continues past the bridge cap: lateral motion alone cannot renew the verdict.
    const shuffled = [];
    for (; t <= times.at(-1)! + 7000; t += 33) shuffled.push(feed(poseWithHipBounce(t, 0, undefined, sway(t))));
    expect(shuffled.at(-1)!.running).toBe(false);
  });

  it('closes when everything stops', () => {
    const { feed } = cadenceHarness();
    for (const t of times) feed(poseWithHipBounce(t, bounce(t), undefined, sway(t)));
    const still = [];
    for (let t = times.at(-1)! + 33; t <= times.at(-1)! + 4800; t += 33) still.push(feed(poseWithHipBounce(t, 0, undefined, 0)));
    expect(still.at(-1)!.running).toBe(false);
  });
});
