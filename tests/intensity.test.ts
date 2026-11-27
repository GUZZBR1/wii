import { describe, expect, it } from 'vitest';
import { IntensityMeter } from '../src/kinematics/intensity';

const WIDTH = 0.2;
/** Steps/second of alternating wrists and a head bounce in shoulder widths, for a few seconds. */
function level({ swaps = 0, armSw = 0.4, bounceSw = 0, seconds = 5 }) {
  const meter = new IntensityMeter();
  let value = 0;
  for (let t = 0; t <= seconds * 1000; t += 33) {
    // One swap per half cycle of the left-minus-right wrist signal.
    const arms = armSw * WIDTH * Math.sin(Math.PI * swaps * (t / 1000));
    const y = bounceSw * WIDTH * Math.SQRT2 * Math.sin((2 * Math.PI * 2.7 * t) / 1000);
    value = meter.update(t, { head: 0.3 + y, left: 0.5 + y, right: 0.5 + y, width: WIDTH, arms });
  }
  return value;
}

describe('running intensity', () => {
  it('is zero standing still', () => {
    expect(level({})).toBe(0);
  });

  it('rises with how fast the arms pump, with no bounce at all', () => {
    const [slow, run, sprint] = [1.3, 2.7, 3.6].map((swaps) => level({ swaps }));
    expect(slow).toBeLessThan(0.25);
    expect(run).toBeGreaterThan(0.4);
    expect(sprint).toBeGreaterThan(run!);
  });

  it('ignores hands that barely move', () => {
    expect(level({ swaps: 3, armSw: 0.1 })).toBe(0);
  });

  it('still reads someone who bounces without pumping the arms', () => {
    expect(level({ bounceSw: 0.07 })).toBeGreaterThan(0.6);
  });

  it('fades instead of dropping when the player cannot be read', () => {
    const meter = new IntensityMeter();
    let value = 0;
    for (let t = 0; t <= 4000; t += 33) value = meter.update(t, { head: 0.3, left: 0.5, right: 0.5, width: WIDTH, arms: 0.08 * Math.sin(Math.PI * 3 * (t / 1000)) });
    const after = meter.update(4200);
    expect(after).toBeGreaterThan(value * 0.6);
    expect(after).toBeLessThan(value);
  });
});
