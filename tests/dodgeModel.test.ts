import type { PoseSnapshot } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { DodgeModel } from '../src/kinematics/personal/dodgeModel';

let clock = 0;
/** Nose and shoulders only, shifted from a relaxed pose by shoulder widths. */
function frame(dx = 0, dy = 0): PoseSnapshot {
  clock += 90;
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  const jitter = ((clock / 90) % 3) * 0.001;
  landmarks[0] = { x: 0.5 + dx * 0.2 + jitter, y: 0.3 + dy * 0.2, z: 0, visibility: 1 };
  landmarks[11] = { x: 0.6 + dx * 0.2 + jitter, y: 0.45 + dy * 0.2, z: 0, visibility: 1 };
  landmarks[12] = { x: 0.4 + dx * 0.2 + jitter, y: 0.45 + dy * 0.2, z: 0, visibility: 1 };
  return { timestampMs: clock, landmarks, worldLandmarks: [] } as unknown as PoseSnapshot;
}

function taught() {
  const model = new DodgeModel();
  for (let i = 0; i < 20; i += 1) model.teach('neutral', frame());
  for (let i = 0; i < 12; i += 1) {
    model.teach('left', frame(0.6, 0.05));
    model.teach('right', frame(-0.6, 0.05));
    model.teach('duck', frame(0, 0.6));
  }
  return model;
}

const settle = (model: DodgeModel, dx = 0, dy = 0) => {
  let out = model.update(frame(dx, dy));
  for (let i = 0; i < 5; i += 1) out = model.update(frame(dx, dy));
  return out;
};

describe('DodgeModel', () => {
  it('answers nothing until it has been taught', () => {
    expect(new DodgeModel().update(frame(0.6))).toEqual({});
  });

  it('recognises each taught move and the return to rest', () => {
    const model = taught();
    expect(settle(model)).toEqual({ zone: 0, duck: false });
    expect(settle(model, 0.55)).toEqual({ zone: -1, duck: false });
    expect(settle(model, -0.55)).toEqual({ zone: 1, duck: false });
    expect(settle(model, 0, 0.55)).toEqual({ zone: 0, duck: true });
    expect(settle(model)).toEqual({ zone: 0, duck: false });
  });

  it('says how close a movement is and records only a clear one', () => {
    const model = new DodgeModel();
    for (let i = 0; i < 20; i += 1) model.teach('neutral', frame());
    expect(model.teach('left', frame(0.08))).toBeLessThan(0.6);
    for (let i = 0; i < 6; i += 1) model.teach('left', frame(0.08));
    expect(model.knows.zone).toBe(false);
    expect(model.teach('left', frame(0.5))).toBe(1);
  });

  it('keeps a learned channel when another was never taught', () => {
    const model = new DodgeModel();
    for (let i = 0; i < 20; i += 1) model.teach('neutral', frame());
    for (let i = 0; i < 6; i += 1) model.teach('duck', frame(0, 0.6));
    expect(model.knows).toEqual({ zone: false, duck: true });
    expect(settle(model, 0, 0.55)).toEqual({ duck: true });
  });

  it('follows a slow shift of the relaxed pose without drifting into a dodge', () => {
    const model = taught();
    let out = model.update(frame());
    for (let i = 0; i < 600; i += 1) out = model.update(frame(Math.min(0.18, i * 0.001)));
    expect(out).toEqual({ zone: 0, duck: false });
    expect(settle(model, 0.75)).toMatchObject({ zone: -1 });
  });
});
