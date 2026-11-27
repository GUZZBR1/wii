import { describe, expect, it } from 'vitest';
import { COUNTDOWN_S, FRAMED_S, Race, RACE_METRES, WARMUP_S } from '../src/games/sprint/race';

const run = (race: Race, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) { each?.(); race.step(1 / 60); }
};
/** Through framing and warm-up, running flat out at the given camera reading. */
const warmedUp = (best: number) => {
  const race = new Race();
  race.setFraming(undefined);
  run(race, FRAMED_S);
  race.setEffort(best);
  run(race, WARMUP_S);
  race.setEffort(0);
  return race;
};
const started = (best = 0.9) => { const race = warmedUp(best); run(race, COUNTDOWN_S); return race; };
const finish = (effort: number) => {
  const race = started();
  race.setEffort(effort);
  run(race, 90);
  return race;
};

describe('100 m race', () => {
  it('waits for a good picture before anything starts', () => {
    const race = new Race();
    race.setEffort(1);
    run(race, 10);
    race.setFraming('Incline a câmera para cima');
    run(race, 10);
    expect([race.phase, race.distance]).toEqual(['framing', 0]);
    race.setFraming(undefined);
    run(race, FRAMED_S);
    expect(race.phase).toBe('warmup');
  });

  it('holds everyone on the blocks during the countdown', () => {
    const race = warmedUp(0.8);
    race.setEffort(1);
    run(race, COUNTDOWN_S - 0.1);
    expect([race.phase, race.distance, race.rivals[0]!.distance]).toEqual(['countdown', 0, 0]);
  });

  it('measures effort against what this player and camera can show', () => {
    // The same flat-out run read low by a badly placed camera is still full speed.
    for (const best of [0.4, 0.8]) {
      const race = started(best);
      race.setEffort(best);
      expect(race.effort01).toBe(1);
      race.setEffort(best / 2);
      expect(race.effort01).toBeCloseTo(0.5, 5);
    }
  });

  it('does not take a lazy warm-up as the maximum', () => {
    const race = started(0.02);
    race.setEffort(0.2);
    expect(race.effort01).toBeLessThan(0.4);
  });

  it('lets a keyboard player skip straight to the countdown', () => {
    const race = new Race();
    race.tap();
    expect(race.phase).toBe('countdown');
  });

  it('never moves a player who does nothing', () => {
    expect(finish(0).distance).toBe(0);
  });

  it('finishes sooner and places better the harder the player runs', () => {
    const [easy, good, flat] = [finish(0.45), finish(0.65), finish(0.9)];
    expect(easy.finishS!).toBeGreaterThan(good.finishS!);
    expect(good.finishS!).toBeGreaterThan(flat.finishS!);
    expect([easy.place, good.place, flat.place]).toEqual([4, 2, 1]);
    expect(flat.distance).toBeGreaterThanOrEqual(RACE_METRES);
  });

  it('keeps momentum through a short dip in the reading', () => {
    const race = started();
    race.setEffort(0.8);
    run(race, 3);
    const speed = race.speed;
    race.setEffort(0);
    run(race, 0.4);
    expect(race.speed).toBeGreaterThan(speed * 0.7);
  });

  it('can be run on the keyboard by tapping', () => {
    const race = started();
    let frame = 0;
    run(race, 6, () => { if (frame++ % 12 === 0) race.tap(); });
    expect(race.distance).toBeGreaterThan(20);
    expect(race.effort01).toBeLessThanOrEqual(1);
  });
});
