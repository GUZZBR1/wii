import type { PoseSnapshot } from '@nevergear/spatial-core';
import { describe, expect, it } from 'vitest';
import { BODY_DODGE, BodyDodgeDetector } from '../src/kinematics/bodyDodge';

const WIDTH = 0.2;
let clock = 0;

/** A body at `x`, its shoulders `lean` and its head `drop` shoulder widths off the rest pose. */
function body({ x = 0.5, lean = 0, drop = 0, scale = 1 } = {}): PoseSnapshot {
  clock += 90;
  const width = WIDTH * scale;
  const point = (px: number, y: number) => ({ x: px, y, z: 0, visibility: 1 });
  const landmarks = Array.from({ length: 33 }, () => point(0, 0));
  const top = x + lean * width;
  landmarks[0] = point(top, 0.3 + drop * width);
  landmarks[11] = point(top + width / 2, 0.45 + drop * width);
  landmarks[12] = point(top - width / 2, 0.45 + drop * width);
  landmarks[23] = point(x + width / 3, 0.75);
  landmarks[24] = point(x - width / 3, 0.75);
  return { timestampMs: clock, landmarks, worldLandmarks: [] } as unknown as PoseSnapshot;
}

function hold(detector: BodyDodgeDetector, pose: Parameters<typeof body>[0], seconds = 0.4, punching = false) {
  let out = detector.update(body(pose), punching);
  for (let i = 1; i < (seconds * 1000) / 90; i += 1) out = detector.update(body(pose), punching);
  return out;
}

function rested() {
  const detector = new BodyDodgeDetector();
  hold(detector, {}, 1.5);
  return detector;
}

describe('BodyDodgeDetector', () => {
  it('reads a lean to each side and a duck', () => {
    const detector = rested();
    expect(hold(detector, { lean: 0.6 })).toEqual({ zone: -1, duck: false });
    expect(hold(detector, {})).toEqual({ zone: 0, duck: false });
    expect(hold(detector, { lean: -0.6 })).toEqual({ zone: 1, duck: false });
    hold(detector, {});
    expect(hold(detector, { drop: 0.9 })).toEqual({ zone: 0, duck: true });
  });

  it('is not fooled by stepping aside or away', () => {
    const detector = rested();
    for (let i = 0; i <= 20; i += 1) expect(detector.update(body({ x: 0.5 + i * 0.01 }))).toEqual({ zone: 0, duck: false });
    expect(hold(detector, { x: 0.7, scale: 0.8 }, 4)).toEqual({ zone: 0, duck: false });
  });

  it('takes a pose held longer than any dodge as the new rest', () => {
    const detector = rested();
    expect(hold(detector, { lean: 0.6 })).toMatchObject({ zone: -1 });
    expect(hold(detector, { lean: 0.6 }, BODY_DODGE.maxHoldMs / 1000 + 0.5)).toEqual({ zone: 0, duck: false });
  });

  it('measures whoever comes back from scratch', () => {
    const detector = rested();
    clock += BODY_DODGE.forgetMs + 500;
    expect(detector.update(body({ lean: 0.6 }))).toBeUndefined();
    expect(hold(detector, { lean: 0.6 }, 1.5)).toEqual({ zone: 0, duck: false });
  });

  it('starts no dodge while a punch twists the shoulders, and needs more than one frame', () => {
    const detector = rested();
    expect(hold(detector, { lean: 0.6 }, 0.4, true)).toMatchObject({ zone: 0 });
    hold(detector, {});
    expect(detector.update(body({ lean: 0.6 }))).toMatchObject({ zone: 0 });
  });
});
