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
    impulse.trigger('ko', 'player');
    impulse.step(0.01);
    expect(impulse.zoomDeg).toBe(0);
    expect(impulse.shake).toEqual({ x: 0, y: 0 });
    expect(impulse.recoilM).toBeGreaterThan(0);
  });
});
