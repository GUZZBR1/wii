import { describe, expect, it, vi } from 'vitest';
import { HandIntentEngine, SpatialInputBus } from '@wii/spatial-core';
import { handSnapshot } from './fixtures/syntheticHand';

describe('spatial input bus', () => {
  it('publishes typed events synchronously and unsubscribes idempotently', () => {
    const bus = new SpatialInputBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    const event = { type: 'button', source: 'hand', timestampMs: 12, action: 'grab', pressed: true } as const;

    bus.publish(event);
    unsubscribe();
    unsubscribe();
    bus.publish(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('uses a subscriber snapshot so mutations during dispatch affect the next event', () => {
    const bus = new SpatialInputBus();
    const delivered: string[] = [];
    let unsubscribeSecond = () => {};
    bus.subscribe(() => {
      delivered.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.subscribe(() => delivered.push('second'));

    bus.publish({ type: 'tracking', source: 'replay', timestampMs: 0, state: 'tracked' });
    bus.publish({ type: 'tracking', source: 'replay', timestampMs: 1, state: 'tracked' });

    expect(delivered).toEqual(['first', 'second', 'first']);
  });
});

describe('hand intent engine', () => {
  it('filters pointer motion, emits grab only on hysteresis transitions, and fails neutral when tracking is lost', () => {
    const engine = new HandIntentEngine();
    const start = engine.update(handSnapshot(0));
    expect(start).toMatchObject([
      { type: 'tracking', state: 'tracked' },
      { type: 'pointer', position: { x: 0.5, y: 0.5 } },
    ]);

    const closed = engine.update(handSnapshot(33, { pinchRatio: 0.2, screenX: 0.9 }));
    expect(closed.find((event) => event.type === 'button')).toMatchObject({ action: 'grab', pressed: true });
    const pointer = closed.find((event) => event.type === 'pointer');
    expect(pointer?.type === 'pointer' && pointer.position.x).toBeGreaterThan(0.5);
    expect(pointer?.type === 'pointer' && pointer.position.x).toBeLessThan(0.9);

    expect(engine.update(handSnapshot(66, { pinchRatio: 0.35 })).some((event) => event.type === 'button')).toBe(false);
    expect(engine.update(handSnapshot(99, { pinchRatio: 0.4 }))).toContainEqual({
      type: 'button',
      source: 'hand',
      timestampMs: 99,
      action: 'grab',
      pressed: false,
    });

    expect(engine.update({ timestampMs: 132, hands: [] })).toContainEqual({
      type: 'tracking',
      source: 'hand',
      timestampMs: 132,
      state: 'neutral',
    });
    expect(engine.update({ timestampMs: 165, hands: [] })).toEqual([]);
  });

  it('releases an active grab and reanchors filters when switching the selected hand', () => {
    const engine = new HandIntentEngine({ preferredHand: 'right' });
    engine.update(handSnapshot(0, { pinchRatio: 0.2, handedness: 'right' }));
    const switched = engine.update(handSnapshot(33, { pinchRatio: 0.8, handedness: 'left' }));

    expect(switched).toContainEqual({
      type: 'button',
      source: 'hand',
      timestampMs: 33,
      action: 'grab',
      pressed: false,
    });
    expect(switched).toContainEqual({
      type: 'tracking',
      source: 'hand',
      timestampMs: 33,
      state: 'neutral',
    });
  });
});
