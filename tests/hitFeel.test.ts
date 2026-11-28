import { describe, expect, it } from 'vitest';
import { HIT_FEEL, HitImpulse, playerHitKind, SLOW_MOTION_RATE } from '../src/games/boxing/hitFeel';

describe('hit feel', () => {
  it('grades a contact by damage, power, counter and knockout', () => {
    expect(playerHitKind(0, 1, true, false)).toBe('blocked');
    expect(playerHitKind(5, 0.4, false, false)).toBe('hit');
    expect(playerHitKind(9, 0.9, false, false)).toBe('heavy');
    expect(playerHitKind(9, 0.4, true, false)).toBe('counter');
    expect(playerHitKind(9, 0.9, true, true)).toBe('ko');
  });

  it('keeps harder contacts stronger', () => {
    for (const key of ['stopS', 'shakeM', 'zoomDeg', 'recoilM'] as const) {
      expect(HIT_FEEL.blocked[key]).toBeLessThan(HIT_FEEL.hit[key]);
      expect(HIT_FEEL.hit[key]).toBeLessThan(HIT_FEEL.heavy[key]);
      expect(HIT_FEEL.heavy[key]).toBeLessThan(HIT_FEEL.ko[key]);
    }
  });

  it('settles back to nothing, and plays only a knockout slowed', () => {
    const impulse = new HitImpulse();
    expect(impulse.recoilM).toBe(0);
    impulse.trigger('heavy', 'opponent');
    expect(impulse.recoilM).toBeCloseTo(HIT_FEEL.heavy.recoilM);
    expect(impulse.animationRate).toBe(1);
    impulse.step(1);
    expect([impulse.recoilM, impulse.zoomDeg, Math.abs(impulse.shake.x)]).toEqual([0, 0, 0]);
    impulse.trigger('ko', 'player');
    expect(impulse.animationRate).toBe(SLOW_MOTION_RATE);
    impulse.step(HIT_FEEL.ko.slowS);
    expect(impulse.animationRate).toBe(1);
  });

  it('keeps the view still with reduced motion but still recoils the body', () => {
    const impulse = new HitImpulse(true);
    impulse.trigger('ko', 'player', -1);
    impulse.step(0.01);
    expect(impulse.zoomDeg).toBe(0);
    expect(impulse.shake).toEqual({ x: 0, y: 0 });
    expect(impulse.rollRad).toBe(0);
    expect(impulse.pitchRad).toBe(0);
    expect(impulse.recoilM).toBeGreaterThan(0);
  });

  it('starts shaking immediately at contact, jolts roll/pitch, and emits a decaying flash', () => {
    const impulse = new HitImpulse();
    impulse.trigger('heavy', 'opponent', 1);
    expect(Math.hypot(impulse.shake.x, impulse.shake.y)).toBeGreaterThan(0);
    expect(impulse.rollRad).toBeGreaterThan(0);
    expect(impulse.flashTone).toBe('heavy');
    expect(impulse.flash01).toBeGreaterThan(0.5);

    impulse.trigger('taken', 'player', -1);
    expect(impulse.pitchRad).toBeGreaterThan(0);
    expect(impulse.rollRad).toBeLessThan(0);
    expect(impulse.flashTone).toBe('taken');
    impulse.step(1);
    expect(impulse.flash01).toBe(0);
    expect(impulse.rollRad).toBe(0);
    expect(impulse.pitchRad).toBe(0);
  });
});

describe('HitImpulse punch shape', () => {
  const jolt = (shape: 'straight' | 'hook' | 'uppercut') => {
    const impulse = new HitImpulse();
    impulse.trigger('heavy', 'opponent', 1, shape);
    return { x: impulse.shake.x, y: impulse.shake.y, roll: impulse.rollRad, pitch: impulse.pitchRad };
  };

  it('jolts a hook sideways and leaves the vertical alone', () => {
    const straight = jolt('straight');
    const hook = jolt('hook');
    expect(hook.x).toBeCloseTo(straight.x * 1.35, 10);
    expect(hook.roll).toBeCloseTo(straight.roll * 1.35, 10);
    expect(hook.y).toBe(straight.y);
    expect(hook.pitch).toBe(straight.pitch);
  });

  it('jolts an uppercut vertically and leaves the side alone', () => {
    const straight = jolt('straight');
    const uppercut = jolt('uppercut');
    expect(uppercut.y).toBeCloseTo(straight.y * 1.4, 10);
    expect(uppercut.pitch).toBeCloseTo(straight.pitch * 1.4, 10);
    expect(uppercut.x).toBe(straight.x);
    expect(uppercut.roll).toBe(straight.roll);
  });
});
