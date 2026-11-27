// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SportActionEvent } from '../src/cv/protocol';
import type { BoxingHudState } from '../src/games/boxing/BoxingGame';
import type { BoxingState } from '../src/games/boxing/boxingRules';

type UpdateFn = (dt: number) => void;
const loopState = vi.hoisted(() => ({ update: undefined as UpdateFn | undefined }));

vi.mock('../src/games/core/GameLoop', () => ({
  GameLoop: class {
    constructor(...args: unknown[]) {
      loopState.update = args[3] as UpdateFn;
    }
    dispose(): void {}
  },
}));

const { BoxingGame } = await import('../src/games/boxing/BoxingGame');

const STEP_S = 1 / 60;
let wallMs = 0;

beforeEach(() => {
  wallMs = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => wallMs);
});
afterEach(() => vi.restoreAllMocks());

/** With rng 0 the opponent guards 700 ms, then winds up for 800 ms and resolves 150 ms later. */
function start() {
  let hud: BoxingHudState | undefined;
  const game = new BoxingGame(document.createElement('canvas'), (state) => { hud = state; }, undefined, () => 0);
  const run = (seconds: number) => {
    for (let step = 0; step < Math.round(seconds / STEP_S); step += 1) {
      wallMs += STEP_S * 1000;
      loopState.update!(STEP_S);
    }
  };
  /** setTracking republishes the HUD, so it doubles as the read. */
  const read = (tracking = 'TRACKING') => {
    game.setTracking(tracking);
    return hud!;
  };
  read();
  run(3); // countdown
  const internals = game as unknown as { match: BoxingState };
  /** Fast-forwards the match instead of simulating minutes of fighting. */
  const setMatch = (patch: Partial<BoxingState>) => {
    internals.match = { ...internals.match, ...patch };
  };
  return { game, run, read, setMatch };
}

function punch(peakTimestampMs: number): SportActionEvent {
  return {
    id: 1, timestampMs: peakTimestampMs, confidence: 1, trackingState: 'tracked', source: 'cv',
    type: 'punch', hand: 'right', power01: 1, peakTimestampMs, onsetTimestampMs: peakTimestampMs - 100,
  };
}

describe('BoxingGame', () => {
  it('hits a player who stays in the targeted zone', () => {
    const { run, read } = start();
    run(1.8);
    expect(read().label).toBe('90 × 100');
  });

  it('lets a body lean dodge the telegraphed punch', () => {
    const { game, run, read } = start();
    run(1); // the windup has aimed at the center
    game.setLaneZone(1);
    run(0.8);
    expect(read().label).toBe('100 × 100');
    expect(read().feedback?.text).toBe('ESQUIVOU!');
  });

  it('blocks a punch into the guard and lands one during the windup', () => {
    const { game, run, read } = start();
    run(0.3);
    game.onAction(punch(wallMs));
    expect(read().label).toBe('100 × 100');
    run(0.7);
    game.onAction(punch(wallMs));
    expect(read().label).toBe('100 × 88');
  });

  it('judges the punch at its peak, not at its arrival', () => {
    const { game, run, read } = start();
    run(0.9); // 200 ms into the windup
    game.onAction(punch(wallMs - 350)); // peaked while the guard was still up
    expect(read().label).toBe('100 × 100');
  });

  it('never damages on the unconfirmed onset', () => {
    const { game, run, read } = start();
    run(1);
    game.onAction({
      id: 1, timestampMs: wallMs, confidence: 1, trackingState: 'tracked', source: 'cv', type: 'punch-start', hand: 'left',
    });
    expect(read().label).toBe('100 × 100');
  });

  it('freezes the fight on lost pose and drops punches thrown meanwhile', () => {
    const { game, run, read } = start();
    run(0.1); // RunGate's 1 s grace still runs, so lose the pose before the first impact
    game.setTracking('SEM POSE');
    run(1.1);
    expect(read('SEM POSE').banner?.title).toBe('PAUSA');
    const frozen = read('SEM POSE').boxing;
    const thrownWhilePaused = wallMs;
    game.onAction(punch(thrownWhilePaused));
    run(10);
    expect(read('SEM POSE')).toMatchObject({ label: '100 × 100', boxing: frozen });
    wallMs += STEP_S * 1000;
    read(); // the player is back
    game.onAction(punch(thrownWhilePaused));
    expect(read().label).toBe('100 × 100');
  });

  it('rate-limits each keyboard hand, so a held key cannot machine-gun an opening', () => {
    const { game, run, read } = start();
    run(1);
    for (let repeat = 0; repeat < 5; repeat += 1) game.onKey('d');
    expect(read().label).toBe('100 × 91');
    game.onKey('a'); // the other hand is free
    expect(read().label).toBe('100 × 82');
    run(0.3);
    game.onKey('d');
    expect(read().label).toBe('100 × 73');
  });

  it('takes the keyboard for dodging and punching', () => {
    const { game, run, read } = start();
    run(1);
    game.onKey('d');
    expect(read().label).toBe('100 × 91');
    game.onKey('ArrowLeft');
    run(0.8);
    expect(read().label).toBe('100 × 91');
  });

  describe('at the bell', () => {
    it('judges a punch that peaked before the bell and arrives during the break', () => {
      const { game, run, read, setMatch } = start();
      setMatch({ roundMsLeft: 1000 }); // the bell falls inside the windup
      run(1.05);
      expect(read().banner?.detail).toBe('Intervalo');
      game.onAction(punch(wallMs - 100));
      expect(read().label).toBe('100 × 88');
    });

    it('ignores a punch thrown after the bell, or too long before it', () => {
      const { game, run, read, setMatch } = start();
      setMatch({ roundMsLeft: 1000 });
      run(1.2);
      game.onAction(punch(wallMs));
      game.onAction(punch(wallMs - 800));
      expect(read().label).toBe('100 × 100');
    });

    it('lets a late punch overturn the decision of the final bell', () => {
      const { game, run, read, setMatch } = start();
      setMatch({ round: 3, roundMsLeft: 1000, playerHp: 90 });
      run(1.05);
      expect(read().banner?.title).toBe('Adversário venceu');
      game.onAction(punch(wallMs - 100));
      expect(read()).toMatchObject({ label: '90 × 88', banner: { title: 'VOCÊ VENCEU!' } });
    });

    it('lets a late punch knock out after the final bell', () => {
      const { game, run, read, setMatch } = start();
      setMatch({ round: 3, roundMsLeft: 1000, opponentHp: 5 });
      run(1.05);
      game.onAction(punch(wallMs - 100));
      expect(read().label).toBe('100 × 0');
      expect(read().feedback?.text).toBe('NOCAUTE!');
    });

    it('lands an opponent punch whose impact preceded the bell', () => {
      const { run, read, setMatch } = start();
      setMatch({ round: 3, roundMsLeft: 1583 }); // impact ~1500 ms, resolution ~1650 ms
      run(1.7);
      expect(read()).toMatchObject({ label: '90 × 100', banner: { title: 'Adversário venceu' } });
    });

    it('saves the player when the bell precedes the impact', () => {
      const { run, read, setMatch } = start();
      setMatch({ roundMsLeft: 1400 });
      run(2);
      expect(read().label).toBe('100 × 100');
    });
  });
});

/** Dodges the first punch (impact ~1500 ms, resolved ~1650 ms) and leaves the fight just after it. */
function dodgeFirst() {
  const fight = start();
  fight.run(1);
  fight.game.setLaneZone(1);
  fight.run(0.7);
  return fight;
}

describe('BoxingGame counter window', () => {
  it('boosts the first punch after a dodge, once', () => {
    const { game, read } = dodgeFirst();
    game.onAction(punch(wallMs));
    expect(read()).toMatchObject({ label: '100 × 82', feedback: { text: 'CONTRA-ATAQUE!' } });
    game.onAction(punch(wallMs));
    expect(read()).toMatchObject({ label: '100 × 70', feedback: { text: 'ACERTOU!' } });
  });

  it('goes through the guard while the window lasts, and not after it', () => {
    const inside = dodgeFirst();
    inside.run(0.8); // the opponent has recovered and covered up again
    inside.game.onAction(punch(wallMs));
    expect(inside.read().label).toBe('100 × 82');

    const outside = dodgeFirst();
    outside.run(1.2);
    outside.game.onAction(punch(wallMs));
    expect(outside.read().label).toBe('100 × 100');
  });
});

describe('BoxingGame guard', () => {
  it.each(['ArrowDown', 's'])('holds the guard while %s is down and drops it on release', (key) => {
    const { game, run, read } = start();
    run(1);
    game.onKey(key);
    run(0.8);
    expect(read()).toMatchObject({ label: '99 × 100', feedback: { text: 'DEFENDEU' } });
    game.onKeyUp(key);
    run(2.3);
    expect(read().label).toBe('89 × 100');
  });

  it('takes the camera guard and forgets it when the camera has no opinion', () => {
    const { game, run, read } = start();
    game.setGuard(true);
    run(1.8);
    expect(read().label).toBe('99 × 100');
    game.setGuard(undefined);
    run(2.3);
    expect(read().label).toBe('89 × 100');
  });

  it('opens no counter window for a guarded punch', () => {
    const { game, run, read } = start();
    game.setGuard(true);
    run(2.5); // blocked, then the opponent is back in guard
    game.onAction(punch(wallMs));
    expect(read().label).toBe('99 × 100');
  });

  it('publishes the scoreboard', () => {
    const { run, read } = start();
    run(1.8);
    expect(read().boxing).toEqual({ playerHp: 90, opponentHp: 100, maxHp: 100, round: 1, rounds: 3, secondsLeft: 59 });
  });
});

describe('BoxingGame footwork', () => {
  type Spot = { x: number; z: number };
  const spots = (game: object) => game as unknown as { playerPos: Spot; opponentPos: Spot };
  const gap = (game: object) => {
    const { playerPos, opponentPos } = spots(game);
    return Math.hypot(playerPos.x - opponentPos.x, playerPos.z - opponentPos.z);
  };
  const hold = (fight: ReturnType<typeof start>, key: string, seconds: number) => {
    fight.game.onKey(key);
    fight.run(seconds);
    fight.game.onKeyUp(key);
  };

  it('walks in with W and back with X while the key is held', () => {
    const fight = start();
    hold(fight, 'w', 0.5);
    expect(gap(fight.game)).toBeLessThan(2.1);
    const close = gap(fight.game);
    hold(fight, 'X', 0.3);
    expect(gap(fight.game)).toBeGreaterThan(close + 0.3);
  });

  it.each([['q', -1], ['e', 1]])('circles with %s', (key, side) => {
    const fight = start();
    hold(fight, key, 0.5);
    expect(Math.sign(spots(fight.game).playerPos.x)).toBe(side);
  });

  it('stays inside the ropes and off the opponent', () => {
    const fight = start();
    for (const key of ['x', 'q', 'e', 'w']) {
      hold(fight, key, 4);
      const { playerPos, opponentPos } = spots(fight.game);
      for (const value of [playerPos.x, playerPos.z, opponentPos.x, opponentPos.z]) {
        expect(Math.abs(value)).toBeLessThanOrEqual(2.55);
      }
      expect(gap(fight.game)).toBeGreaterThanOrEqual(1.45 - 1e-6);
    }
  });

  it('misses from out of range, until the opponent walks in', () => {
    const fight = start();
    fight.game.onKey('x');
    fight.run(1); // 200 ms into the windup, backing away the whole time
    expect(gap(fight.game)).toBeGreaterThan(2.95);
    fight.game.onKey('d');
    expect(fight.read()).toMatchObject({ label: '100 × 100', feedback: { text: 'LONGE DEMAIS' } });
    fight.game.onKeyUp('x');
    fight.run(2);
    expect(gap(fight.game)).toBeLessThanOrEqual(2.95);
  });

  it('lets the player step out of an opponent punch', () => {
    const fight = start();
    hold(fight, 'x', 0.8);
    fight.game.onKey('x');
    fight.run(1);
    expect(fight.read()).toMatchObject({ label: '100 × 100', feedback: { text: 'LONGE DEMAIS' } });
  });

  it('circles only on a lean that is held, and stops when the camera loses its opinion', () => {
    const fight = start();
    fight.game.setLaneZone(1);
    fight.run(0.3);
    expect(spots(fight.game).playerPos.x).toBe(0);
    fight.run(0.5);
    const { x } = spots(fight.game).playerPos;
    expect(x).toBeGreaterThan(0.1);
    fight.game.setLaneZone(undefined);
    fight.run(0.5);
    expect(spots(fight.game).playerPos.x).toBe(x);
  });

  it('follows the camera depth step', () => {
    const fight = start();
    fight.game.setDepthMove(1);
    fight.run(0.5);
    expect(gap(fight.game)).toBeLessThan(2.5);
  });

  it('recenters both fighters for the next round', () => {
    const fight = start();
    hold(fight, 'e', 0.5);
    fight.setMatch({ roundMsLeft: 100 });
    fight.run(3.2); // bell and break
    expect(spots(fight.game)).toMatchObject({ playerPos: { x: 0, z: 1.85 } });
    expect(gap(fight.game)).toBeCloseTo(2.7);
  });
});
