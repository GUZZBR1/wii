import { describe, expect, it } from 'vitest';
import { COUNTDOWN_S, Race, RACE_METRES } from '../src/games/sprint/race';

const run = (race: Race, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) { each?.(); race.step(1 / 60); }
};
const started = () => { const race = new Race(); run(race, COUNTDOWN_S); return race; };
const finish = (effort: number) => {
  const race = started();
  race.setEffort(effort);
  run(race, 90);
  return race;
};

describe('100 m race', () => {
  it('holds everyone on the blocks during the countdown', () => {
    const race = new Race();
    race.setEffort(1);
    race.tap();
    run(race, COUNTDOWN_S - 0.1);
    expect([race.phase, race.distance, race.rivals[0]!.distance]).toEqual(['countdown', 0, 0]);
  });

  it('never moves a player who does nothing', () => {
    expect(finish(0).distance).toBe(0);
  });

  it('finishes sooner and places better the harder the player runs', () => {
    const [easy, good, flat] = [finish(0.4), finish(0.7), finish(0.9)];
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
