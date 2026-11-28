// @vitest-environment happy-dom
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SportActionEvent } from '../src/cv/protocol';
import type { BoxingGameOptions, BoxingHudState } from '../src/games/boxing/BoxingGame';
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

/** With rng 0 the default opponent guards 675 ms, then winds up for 790 ms and resolves 150 ms later. */
function start(options: BoxingGameOptions = {}) {
  let hud: BoxingHudState | undefined;
  const game = new BoxingGame(document.createElement('canvas'), (state) => { hud = state; }, undefined, () => 0, options);
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
  it('publishes and holds the final fight result for Iron Man', () => {
    const { game, run, read, setMatch } = start({ holdResult: true });
    expect(read().boxing.winner).toBeUndefined();
    setMatch({ winner: 'draw' });
    expect(read().boxing.winner).toBe('draw');
    run(12);
    expect(read().boxing.winner).toBe('draw');
    game.dispose();
  });

  it('hits a player who stays in the targeted zone', () => {
    const { run, read } = start();
    run(1.8);
    expect(read().label).toBe('90 × 100');
  });

  it('lets a body lean dodge the telegraphed punch', () => {
    const { game, run, read } = start();
    run(1); // the windup has aimed at the center
    game.setDodgeZone(1);
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

  it('alternates hands on the punch key and rate-limits each one', () => {
    const { game, run, read } = start();
    run(1);
    game.onKey('e');
    expect(read().label).toBe('100 × 91');
    for (let press = 0; press < 5; press += 1) game.onKey('E'); // the other hand, then both cooling down
    expect(read().label).toBe('100 × 82');
    run(0.3);
    game.onKey('e');
    expect(read().label).toBe('100 × 73');
  });

  it('takes the keyboard for dodging and punching', () => {
    const { game, run, read } = start();
    run(1);
    game.onKey('e');
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
      run(2.1); // wait for both defense grace and the late-confirmation watermark
      expect(read()).toMatchObject({ label: '90 × 100', banner: { title: 'Adversário venceu' } });
    });

    it('waits for the complete defense window when impact precedes the bell', () => {
      const { game, run, read, setMatch } = start();
      setMatch({ round: 3, roundMsLeft: 1583 });
      run(1.59);
      expect(read().label).toBe('100 × 100');
      game.setGuard(true);
      run(0.5);
      expect(read().label).toBe('99 × 100');
      expect(read().feedback?.text).toBe('DEFENDEU');
      run(0.2);
      expect(read().label).toBe('99 × 100');
    });

    it('shows the attack type and target throughout its preparation', () => {
      const { run, read } = start();
      run(1);
      expect(read().banner).toMatchObject({ title: 'RETO · CABEÇA' });
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
  fight.game.setDodgeZone(1);
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
  it.each(['ArrowDown', 'q'])('holds the guard while %s is down and drops it on release', (key) => {
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

  it('walks in with W and back with S while the key is held', () => {
    const fight = start();
    hold(fight, 'w', 0.5);
    expect(gap(fight.game)).toBeLessThan(2.1);
    const close = gap(fight.game);
    hold(fight, 'S', 0.3);
    expect(gap(fight.game)).toBeGreaterThan(close + 0.3);
  });

  it.each([['a', -1], ['d', 1]])('circles with %s', (key, side) => {
    const fight = start();
    hold(fight, key, 0.5);
    expect(Math.sign(spots(fight.game).playerPos.x)).toBe(side);
  });

  it('stays inside the ropes and off the opponent', () => {
    const fight = start();
    for (const key of ['s', 'a', 'd', 'w']) {
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
    const state = fight.game as unknown as { playerPos: Spot; opponentMotion: { position: Spot } };
    state.playerPos = { x: 0, z: 2 };
    state.opponentMotion.position = { x: 0, z: -2 };
    fight.run(0.1);
    expect(gap(fight.game)).toBeGreaterThan(2.95);
    fight.game.onKey('e');
    expect(fight.read()).toMatchObject({ label: '100 × 100', feedback: { text: 'LONGE DEMAIS' } });
    fight.run(2);
    expect(gap(fight.game)).toBeLessThanOrEqual(2.95);
  });

  it('lets the player step out of an opponent punch', () => {
    const fight = start();
    fight.run(0.8); // first windup has begun
    fight.game.onKey('s');
    fight.run(1);
    expect(fight.read()).toMatchObject({ label: '100 × 100', feedback: { text: 'LONGE DEMAIS' } });
  });

  it('circles only on a lean that is held, and stops when the camera loses its opinion', () => {
    const fight = start();
    fight.game.setDodgeZone(1);
    fight.run(0.3);
    expect(spots(fight.game).playerPos.x).toBe(0);
    fight.run(0.5);
    const { x } = spots(fight.game).playerPos;
    expect(x).toBeGreaterThan(0.1);
    fight.game.setDodgeZone(undefined);
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
    hold(fight, 'd', 0.5);
    fight.setMatch({ roundMsLeft: 100 });
    fight.run(3.2); // bell and break
    expect(spots(fight.game)).toMatchObject({ playerPos: { x: 0, z: 1.85 } });
    expect(gap(fight.game)).toBeCloseTo(2.7);
  });
});

describe('BoxingGame body controls and animation', () => {
  type Spot = { x: number; z: number };
  const internals = (game: object) =>
    game as unknown as {
      playerPos: Spot;
      opponentPos: Spot;
      opponentMotion: { position: Spot; velocity: Spot; clockS: number };
      opponentBoxer: { setState(state: string, hand?: string): void };
      camera: { position: Spot };
    };
  const gap = (game: object) => {
    const { playerPos, opponentPos } = internals(game);
    return Math.hypot(playerPos.x - opponentPos.x, playerPos.z - opponentPos.z);
  };
  /** Arc length of the player around the (motionless, in bag mode) opponent. */
  const arc = (game: object) => {
    const { playerPos, opponentPos } = internals(game);
    return Math.atan2(playerPos.x - opponentPos.x, playerPos.z - opponentPos.z) * gap(game);
  };

  it('walks in proportionally to the depth speed, which overrides the depth step', () => {
    const advance = (speed: number) => {
      const fight = start({ mode: 'bag' });
      const before = gap(fight.game);
      fight.game.setDepthMove(-1);
      fight.game.setDepthSpeed(speed);
      fight.run(0.3);
      return before - gap(fight.game);
    };
    expect(advance(0.5)).toBeGreaterThan(0.05);
    expect(advance(1)).toBeCloseTo(2 * advance(0.5), 5);
    expect(advance(0)).toBe(0);
  });

  it('falls back to the depth step once the depth speed has no opinion', () => {
    const fight = start({ mode: 'bag' });
    const before = gap(fight.game);
    fight.game.setDepthSpeed(1);
    fight.game.setDepthSpeed(undefined);
    fight.game.setDepthMove(-1);
    fight.run(0.3);
    expect(gap(fight.game)).toBeGreaterThan(before + 0.1);
  });

  it.each([-1, 1] as const)('sidesteps once per dash rising edge (%s)', (side) => {
    const fight = start({ mode: 'bag' });
    const distance = gap(fight.game);
    const hold = (seconds: number) => {
      for (let step = 0; step < Math.round(seconds / STEP_S); step += 1) {
        fight.game.setLateralDash(side);
        fight.run(STEP_S);
      }
    };
    hold(1);
    expect(arc(fight.game)).toBeCloseTo(side * 0.6, 5);
    expect(gap(fight.game)).toBeCloseTo(distance, 5);

    fight.game.setLateralDash(0);
    hold(0.5);
    expect(arc(fight.game)).toBeCloseTo(side * 1.2, 5);
  });

  it('ignores a second hop inside the refractory', () => {
    const fight = start({ mode: 'bag' });
    fight.game.setLateralDash(1);
    fight.run(0.2);
    fight.game.setLateralDash(0);
    fight.game.setLateralDash(1);
    fight.run(0.5);
    expect(arc(fight.game)).toBeCloseTo(0.6, 5);
  });

  it('winds up and punches with the hand the AI chose', () => {
    const { game, run } = start(); // rng 0 picks the left hand
    const setState = vi.spyOn(internals(game).opponentBoxer, 'setState');
    run(1);
    expect(setState).toHaveBeenLastCalledWith('windup', 'left');
    run(0.4);
    expect(setState).toHaveBeenLastCalledWith('punch', 'left');
  });

  it('shows the recover pose while the AI recovers', () => {
    const { game, run } = start();
    const setState = vi.spyOn(internals(game).opponentBoxer, 'setState');
    run(1.8);
    expect(setState).toHaveBeenLastCalledWith('recover', undefined);
  });

  it('starts the next round with a fresh opponent motion', () => {
    const { game, run, setMatch } = start();
    run(0.3);
    setMatch({ roundMsLeft: 100 });
    run(0.2);
    expect(internals(game).opponentMotion.clockS).toBeGreaterThan(0);
    run(2.89); // stop right as the break ends
    for (let step = 0; step < 20 && internals(game).opponentMotion.clockS > 0; step += 1) run(STEP_S);
    expect(internals(game).opponentMotion).toMatchObject({ position: { x: 0, z: -0.85 }, velocity: { x: 0, z: 0 }, clockS: 0 });
  });

  it('eases the camera after the player instead of snapping to it', () => {
    const { game, run } = start({ mode: 'bag' });
    const before = internals(game).camera.position.z;
    internals(game).playerPos = { x: 0, z: 2.4 };
    run(STEP_S);
    expect(internals(game).camera.position.z).toBeGreaterThan(before);
    expect(internals(game).camera.position.z).toBeLessThan(3.05);
    run(1);
    // aligned with the bag at the origin, the camera converges to 0.65 m behind the eye
    expect(internals(game).camera.position.z).toBeCloseTo(2.4 + 0.65, 3);
  });

  it('freezes the glove at impact without freezing the fight clock', () => {
    const { game, run } = start();
    const state = game as unknown as { fightMs: number; animTimeS: number };
    run(1);
    const { fightMs, animTimeS } = state;
    game.onKey('e'); // lands during the windup
    run(0.2);
    expect(state.fightMs - fightMs).toBeCloseTo(200, 5);
    expect(state.animTimeS - animTimeS).toBeCloseTo(0.2 - 0.045, 5);
  });
});

describe('BoxingGame camera rig', () => {
  type Spot = { x: number; z: number };
  type Rig = {
    playerPos: Spot;
    eye: Spot;
    lookTarget: Spot;
    telegraphOffset: number;
    opponentMotion: { position: Spot };
    opponentBoxer: { root: { position: { x: number; y: number; z: number } } };
    camera: THREE.PerspectiveCamera;
  };
  const rig = (game: object) => game as unknown as Rig;

  it('snaps the eye, camera and look target once at construction', () => {
    const game = new BoxingGame(document.createElement('canvas'), () => {}, undefined, () => 0, { mode: 'bag' });
    const state = rig(game);
    expect(state.eye).toEqual({ x: 0, z: 1.85 });
    // 0.65 m behind the eye along the aligned bag axis, 1.9 m above the 1.05 m canvas
    expect(state.camera.position.z).toBeCloseTo(1.85 + 0.65, 5);
    expect(state.camera.position.y).toBeCloseTo(1.05 + 1.9, 5);
    expect(state.lookTarget).toEqual({ x: 0, z: 0 }); // the bag sits at the origin
    game.dispose();
  });

  it('composes eye height, back offset and lateral dodge on independent axes when aligned', () => {
    const { game, run } = start({ mode: 'bag' });
    rig(game).playerPos = { x: 0, z: 2.4 };
    game.onKey('ArrowLeft'); // lane -1: a pure lateral dodge, no lean and no footwork
    run(2);
    const { position } = rig(game).camera;
    expect(position.x).toBeCloseTo(-0.7, 3); // lane width, perpendicular to the view axis
    expect(position.y).toBeCloseTo(1.05 + 1.9, 5);
    expect(position.z).toBeCloseTo(2.4 + 0.65, 3);
  });

  it('hangs the camera 0.65 m behind the eye along the opponent-to-eye axis when off-center', () => {
    const { game, run } = start({ mode: 'bag' });
    rig(game).playerPos = { x: 0.6, z: 2.4 };
    run(2);
    const { position } = rig(game).camera;
    const back = { x: position.x - 0.6, z: position.z - 2.4 };
    expect(Math.hypot(back.x, back.z)).toBeCloseTo(0.65, 3);
    // pointing away from the bag at the origin, along the player direction
    const length = Math.hypot(0.6, 2.4);
    expect(back.x / 0.65).toBeCloseTo(0.6 / length, 3);
    expect(back.z / 0.65).toBeCloseTo(2.4 / length, 3);
  });

  it('chases the opponent with a smoothed look target and aims the camera at it', () => {
    const { game, run } = start({ mode: 'bag' });
    const state = rig(game);
    expect(state.lookTarget).toEqual({ x: 0, z: 0 });
    state.opponentMotion.position = { x: 1, z: -0.5 }; // bag mode never steps the motion back
    run(STEP_S);
    expect(state.lookTarget.x).toBeGreaterThan(0.02);
    expect(state.lookTarget.x).toBeLessThan(0.5);
    run(2);
    expect(state.lookTarget.x).toBeCloseTo(1, 3);
    expect(state.lookTarget.z).toBeCloseTo(-0.5, 3);
    // the camera forward axis passes through the look target at the 1.05 + 1.35 look height
    const forward = state.camera.getWorldDirection(new THREE.Vector3());
    const expected = new THREE.Vector3(state.lookTarget.x, 2.4, state.lookTarget.z).sub(state.camera.position).normalize();
    expect(forward.dot(expected)).toBeCloseTo(1, 5);
  });

  it('eases the camera identically regardless of the fixed step size', () => {
    const make = () => {
      const game = new BoxingGame(document.createElement('canvas'), () => {}, undefined, () => 0, { mode: 'bag' });
      const update = loopState.update!;
      rig(game).playerPos = { x: 0.3, z: 2.4 };
      return { game, update };
    };
    const fine = make();
    const coarse = make();
    for (let step = 0; step < 60; step += 1) fine.update(1 / 60);
    for (let step = 0; step < 30; step += 1) coarse.update(1 / 30);
    expect(rig(coarse.game).camera.position.x).toBeCloseTo(rig(fine.game).camera.position.x, 10);
    expect(rig(coarse.game).camera.position.z).toBeCloseTo(rig(fine.game).camera.position.z, 10);
    fine.game.dispose();
    coarse.game.dispose();
  });

  it('smooths the dodge telegraph lean into the threatened lane and back out', () => {
    const { game, run } = start({ mode: 'dodge' });
    const state = rig(game);
    expect(state.telegraphOffset).toBe(0); // the first two attacks threaten the center lane
    run(3.25); // inside the third attack's telegraph (lane -1, starting at 3.2 s of training time)
    expect(state.telegraphOffset).toBeLessThan(-0.01);
    expect(state.telegraphOffset).toBeGreaterThan(-0.14);
    run(0.7);
    expect(state.telegraphOffset).toBeCloseTo(-0.14, 3);
    // aligned geometry: the lean is exactly the offset along +x, the opponent itself never moves
    expect(state.opponentBoxer.root.position.x).toBeCloseTo(state.telegraphOffset, 8);
    expect(state.opponentBoxer.root.position.z).toBeCloseTo(-0.85, 5);
    run(0.5); // the blow lands at 4.3 s, the challenge is lost and the lean relaxes
    expect(state.telegraphOffset).toBeLessThan(-0.005);
    expect(state.telegraphOffset).toBeGreaterThan(-0.1);
    run(1);
    expect(state.telegraphOffset).toBeCloseTo(0, 3);
  });

  it('eases the punch reach in and out with a single smooth peak', () => {
    const { game, run } = start();
    const state = game as unknown as {
      playerPos: Spot;
      opponentMotion: { position: Spot };
      gloves: { animate(timeSeconds: number, input: { rightPunch?: number }): void };
    };
    const reaches: (number | undefined)[] = [];
    vi.spyOn(state.gloves, 'animate').mockImplementation((_time, input) => {
      reaches.push(input.rightPunch);
    });
    // out of range, so the whiffed punch animates without hitstop or a landed hit
    state.playerPos = { x: 0, z: 2.55 };
    state.opponentMotion.position = { x: 0, z: -2 };
    game.onKey('e'); // the first key punch is the right hand
    run(0.4); // the whole 0.26 s animation plus rest
    const samples = reaches.map((reach) => reach ?? 0);
    expect(samples.length).toBeGreaterThan(16);
    // zero velocity at the onset: one frame in, the glove has barely moved (the old cubic was at 50%)
    expect(samples[0]).toBeGreaterThan(0);
    expect(samples[0]).toBeLessThan(0.2);
    const peakIndex = samples.indexOf(Math.max(...samples));
    expect(samples[peakIndex]).toBeGreaterThan(0.99);
    // one single peak, strictly rising before it and strictly falling after it — no plateau
    for (let i = 0; i < peakIndex; i += 1) expect(samples[i + 1]!).toBeGreaterThan(samples[i]!);
    for (let i = peakIndex; i + 1 < samples.length && samples[i]! > 0; i += 1) {
      expect(samples[i + 1]!).toBeLessThan(samples[i]!);
    }
    // already essentially at rest before the hard cutoff, then exactly parked
    expect(samples[14]).toBeLessThan(0.01);
    expect(samples[15]).toBe(0);
    expect(samples.at(-1)).toBe(0);
  });
});

describe('BoxingGame opponent profiles', () => {
  it.each([
    ['rookie', 0.25],
    ['aggressive', 0.55],
    ['technical', 0.85],
  ] as const)('uses the %s skill in fight mode', (opponent, skill) => {
    const { game } = start({ opponent });
    expect((game as unknown as { ai: { skill: number } }).ai.skill).toBe(skill);
  });
});

describe('BoxingGame training modes', () => {
  it('scores a punching-bag punch on the rhythm and publishes precision, combo and score', () => {
    const { game, run, read } = start({ mode: 'bag' });
    run(1 - STEP_S); // the countdown's final fixed step is already the first running step

    game.onAction(punch(wallMs));

    const training = read().boxing.training;
    expect(training).toMatchObject({ kind: 'bag', score: 200, combo: 1 });
    expect(training?.precision01).toBeCloseTo(1, 5);
    expect(read().feedback?.text).toBe('100% · +200');
  });

  it('reports missed punching-bag beats while the training clock runs', () => {
    const { run, read } = start({ mode: 'bag' });
    run(2);

    expect(read().boxing.training).toMatchObject({ kind: 'bag', score: 0, combo: 0 });
    expect(read().feedback?.text).toBe('PERDEU O RITMO');
  });

  it('lets ring displacement count as the safe lane in the dodge challenge', () => {
    const fight = start({ mode: 'dodge' });
    fight.game.onKey('a');
    fight.run(0.5);
    fight.game.onKeyUp('a');
    fight.run(0.7);

    expect(fight.read().boxing.training).toMatchObject({
      kind: 'dodge',
      score: 100,
      attacksResolved: 1,
      attacksRemaining: 5,
      hitsTaken: 0,
    });
    expect(fight.read().feedback?.text).toBe('ESQUIVOU!');
  });

  it('counts a hit and the remaining attacks when the player stays in the threatened lane', () => {
    const { run, read } = start({ mode: 'dodge' });
    run(1.2);

    expect(read().boxing.training).toMatchObject({
      kind: 'dodge',
      score: 0,
      attacksResolved: 1,
      attacksRemaining: 5,
      hitsTaken: 1,
      hitsRemaining: 2,
    });
    expect(read().feedback?.text).toBe('LEVOU UM SOCO');
  });
});

describe('BoxingGame review fixes', () => {
  /** Small deterministic generator, so the AI sees a non-constant roll sequence. */
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const attacks = (punching: boolean) => {
    let hud: BoxingHudState | undefined;
    const game = new BoxingGame(document.createElement('canvas'), (state) => { hud = state; }, undefined, seeded(7), {
      opponent: 'technical',
      motionRng: () => 0.999, // always rolls a dash when one is eligible
    });
    game.setTracking('TRACKING');
    const internals = game as unknown as { ai: { phase: { kind: string; hand?: string } } };
    const seen: string[] = [];
    for (let step = 0; step < 60 * 20; step += 1) {
      wallMs += STEP_S * 1000;
      if (punching && step % 40 === 0) {
        game.onAction({ id: step, timestampMs: wallMs, confidence: 1, trackingState: 'tracked', source: 'cv', type: 'punch-start', hand: 'left' });
      }
      loopState.update!(STEP_S);
      const { kind, hand } = internals.ai.phase;
      const label = `${kind}:${hand ?? ''}`;
      if (seen.at(-1) !== label) seen.push(label);
    }
    expect(hud).toBeDefined();
    return seen;
  };

  it('keeps the opponent attack sequence independent of player punches', () => {
    expect(attacks(true)).toEqual(attacks(false));
  });

  it('drops a dash in progress at the bell, so the camera does not stay rolled', () => {
    const fight = start();
    fight.setMatch({ roundMsLeft: 100 });
    fight.game.setLateralDash(1);
    fight.run(0.2);
    expect((fight.game as unknown as { dash?: unknown }).dash).toBeUndefined();
  });
});

describe('BoxingGame tutorial mode', () => {
  const tutorialPunch = (peakTimestampMs: number, kind: 'straight' | 'hook' | 'uppercut' = 'straight', target: 'head' | 'body' = 'head', hand: 'left' | 'right' = 'left'): SportActionEvent => ({
    ...(punch(peakTimestampMs) as Extract<SportActionEvent, { type: 'punch' }>),
    hand,
    punchKind: kind,
    punchTargetZone: target,
    measurement: {
      samples: [],
      origin: { timestampMs: 0, lateral: 0, vertical: 0, forward: 0, elbowCosine: 0, confidence: 1 },
      speedPeak: { timestampMs: 0, lateral: 0, vertical: 0, forward: 0.5, elbowCosine: 0.5, confidence: 1 },
      contact: { timestampMs: 0, lateral: 0, vertical: 0, forward: 0.9, elbowCosine: 0.9, confidence: 1 },
      end: { timestampMs: 0, lateral: 0, vertical: 0, forward: 0.8, elbowCosine: 0.8, confidence: 1 },
      durationMs: 200,
      forwardTravel: 0.9,
      lateralExcursion: 0.05,
      verticalRise: 0.02,
      pathLength: 1,
      netDisplacement: 0.9,
      maxElbowCosine: 0.95,
    },
  });

  it('never attacks the player and starts with the guard instruction', () => {
    const { run, read } = start({ mode: 'tutorial' });
    run(5);
    const hud = read();
    expect(hud.label).toBe('100 × 100');
    expect(hud.status).toContain('guarda');
  });

  it('advances through the steps as the player performs them', () => {
    const { game, run, read } = start({ mode: 'tutorial' });
    game.setGuard(true);
    run(1.2);
    expect(read().status).toContain('jab');
    game.setGuard(false);
    const at = () => performance.now();
    for (let i = 0; i < 3; i += 1) {
      game.onAction(tutorialPunch(at(), 'straight', 'head', 'left'));
      run(0.3);
    }
    expect(read().status).toContain('cruzado');
    for (let i = 0; i < 3; i += 1) {
      game.onAction(tutorialPunch(at(), 'straight', 'head', 'right'));
      run(0.3);
    }
    expect(read().status).toContain('ganchos');
  });

  it('reports the learning floor on entry and the adapted travel once done', () => {
    const travels: number[] = [];
    const { game, run } = start({ mode: 'tutorial', onPunchTravel: (travel) => travels.push(travel) });
    expect(travels).toEqual([0.15]);
    game.setGuard(true);
    run(1.2);
    game.setGuard(false);
    const at = () => performance.now();
    for (let i = 0; i < 3; i += 1) { game.onAction(tutorialPunch(at(), 'straight', 'head', 'left')); run(0.2); }
    for (let i = 0; i < 3; i += 1) { game.onAction(tutorialPunch(at(), 'straight', 'head', 'right')); run(0.2); }
    for (let i = 0; i < 2; i += 1) { game.onAction(tutorialPunch(at(), 'hook', 'head')); run(0.2); }
    for (let i = 0; i < 2; i += 1) { game.onAction(tutorialPunch(at(), 'uppercut', 'head')); run(0.2); }
    for (let i = 0; i < 2; i += 1) { game.onAction(tutorialPunch(at(), 'straight', 'body')); run(0.2); }
    game.setDodgeZone(-1); run(0.3); game.setDodgeZone(0); run(0.3);
    game.setDodgeZone(1); run(0.3); game.setDodgeZone(0); run(0.3);
    game.setDuck(true); run(0.6); game.setDuck(false); run(0.3);
    game.setDuck(true); run(0.6); game.setDuck(false); run(0.3);
    expect(travels.at(-1)).toBeCloseTo(0.25);
  });

  it('unknown-type punches do not advance the tutorial', () => {
    const { game, run, read } = start({ mode: 'tutorial' });
    game.setGuard(true);
    run(1.2);
    game.setGuard(false);
    game.onAction(punch(performance.now()));
    run(0.3);
    expect(read().status).toContain('jab');
  });

  it('finishes with a completion banner once every step is done', () => {
    const { game, run, read } = start({ mode: 'tutorial' });
    game.setGuard(true);
    run(1.2);
    game.setGuard(false);
    const at = () => performance.now();
    for (let i = 0; i < 3; i += 1) { game.onAction(tutorialPunch(at(), 'straight', 'head', 'left')); run(0.2); }
    for (let i = 0; i < 3; i += 1) { game.onAction(tutorialPunch(at(), 'straight', 'head', 'right')); run(0.2); }
    for (let i = 0; i < 2; i += 1) { game.onAction(tutorialPunch(at(), 'hook', 'head')); run(0.2); }
    for (let i = 0; i < 2; i += 1) { game.onAction(tutorialPunch(at(), 'uppercut', 'head')); run(0.2); }
    for (let i = 0; i < 2; i += 1) { game.onAction(tutorialPunch(at(), 'straight', 'body')); run(0.2); }
    game.setDodgeZone(-1); run(0.3); game.setDodgeZone(0); run(0.3);
    game.setDodgeZone(1); run(0.3); game.setDodgeZone(0); run(0.3);
    game.setDuck(true); run(0.6); game.setDuck(false); run(0.3);
    game.setDuck(true); run(0.6); game.setDuck(false); run(0.3);
    const hud = read();
    expect(hud.status).toBe('Tutorial completo!');
    expect(hud.banner?.title).toBe('Tutorial completo!');
  });
});

describe('opponent evasion and perception', () => {
  it('makes the same confirmed punch miss only when the opponent moved off its aimed line', () => {
    const result = (lateral: number) => {
      const fight = start();
      fight.run(1);
      const state = fight.game as unknown as { fightMs: number; zoneHistory: unknown[] };
      const entry = (atMs: number, x: number) => ({
        atMs, zone: 0, guarded: false, ducked: false, inRange: true,
        playerPos: { x: 0, z: 2 }, opponentPos: { x, z: -0.5 }, playerPunching: false,
        guardKnown: true, zoneKnown: true, duckKnown: true,
      });
      state.zoneHistory = [entry(state.fightMs - 100, 0), entry(state.fightMs, lateral)];
      fight.game.onAction(punch(wallMs));
      return fight.read();
    };
    expect(result(0)).toMatchObject({ label: '100 × 88' });
    expect(result(0.3)).toMatchObject({ label: '100 × 100', feedback: { text: 'ADVERSÁRIO ESQUIVOU' } });
  });

  it('does not react to a punch until the observation delay has elapsed', () => {
    let rolls = 0;
    const fight = start({ opponent: 'technical', motionRng: () => { rolls += 1; return 0.999; } });
    fight.run(0.3);
    fight.game.onAction({ id: 1, timestampMs: wallMs, confidence: 1, trackingState: 'tracked', source: 'cv', type: 'punch-start', hand: 'left' });
    fight.run(0.15);
    expect(rolls).toBe(0);
    fight.run(0.12);
    expect(rolls).toBe(1);
  });
});

it('does not accept a pose sample from before tracking was lost after reacquisition', () => {
  const fight = start();
  const capturedAt = wallMs;
  fight.game.setDodgeZone(1, capturedAt);
  fight.game.setTracking('PROCURANDO');
  wallMs += 100;
  fight.game.setTracking('SEM POSE');
  wallMs += 100;
  fight.game.setTracking('TRACKING');
  fight.game.setDodgeZone(-1, capturedAt);
  const state = fight.game as unknown as { cameraZoneValid: boolean; cameraZone: number };
  expect(state.cameraZoneValid).toBe(false);
  fight.game.setDodgeZone(-1, wallMs);
  expect(state.cameraZoneValid).toBe(true);
  expect(state.cameraZone).toBe(-1);
});


it.each([[30, 'player'], [70, 'opponent']] as const)(
  'orders pre-bell knockouts by their impact timestamps when confirmation is late (%i ms)',
  (playerPeakMs, winner) => {
    const fight = start();
    const internal = fight.game as unknown as { fightMs: number; ai: { phase: unknown; phaseStartedMs: number } };
    const begin = internal.fightMs;
    const beginWall = wallMs;
    internal.ai = {
      ...internal.ai,
      phaseStartedMs: begin,
      phase: { kind: 'windup', hand: 'right', targetZone: 0, impactAtMs: begin + 50, attackKind: 'straight', target: 'head' },
    };
    fight.setMatch({ round: 3, roundMsLeft: 100, playerHp: 10, opponentHp: 10 });
    fight.run(0.3); // past the 150 ms defense grace but inside the confirmation watermark
    fight.game.onAction(punch(beginWall + playerPeakMs));
    fight.run(0.3);
    expect(fight.read().banner?.title).toBe(winner === 'player' ? 'VOCÊ VENCEU!' : 'Adversário venceu');
  },
);

it('rejects an old punch onset delivered after a tracking pause', () => {
  const fight = start();
  fight.run(0.1);
  const oldAt = wallMs;
  fight.game.setTracking('SEM POSE');
  fight.run(1.1);
  fight.game.setTracking('TRACKING');
  const state = fight.game as unknown as { punchAnimS: { left: number } };
  const before = state.punchAnimS.left;
  fight.game.onAction({ id: 99, timestampMs: oldAt, confidence: 1, trackingState: 'tracked', source: 'cv', type: 'punch-start', hand: 'left' });
  expect(state.punchAnimS.left).toBe(before);
});

it('does not restore depth movement from a pose captured before loss', () => {
  const fight = start();
  const old = wallMs;
  fight.game.setDepthMove(1, old);
  fight.game.setDepthSpeed(1, old);
  wallMs += 10;
  fight.game.setTracking('SEM POSE');
  wallMs += 10;
  fight.game.setTracking('TRACKING');
  fight.game.setDepthMove(1, old);
  fight.game.setDepthSpeed(1, old);
  const internal = fight.game as unknown as { cameraDepth: number; cameraDepthSpeed?: number };
  expect(internal.cameraDepth).toBe(0);
  expect(internal.cameraDepthSpeed).toBeUndefined();
});

it('does not restart the animation from a duplicate punch onset', () => {
  const fight = start();
  fight.run(0.1);
  const event = { id: 42, timestampMs: wallMs, confidence: 1, trackingState: 'tracked' as const, source: 'cv' as const, type: 'punch-start' as const, hand: 'left' as const };
  fight.game.onAction(event);
  fight.run(0.1);
  const internal = fight.game as unknown as { punchAnimS: { left: number } };
  const progress = internal.punchAnimS.left;
  fight.game.onAction(event);
  expect(internal.punchAnimS.left).toBe(progress);
});

it('resolves a mid-round knockout after an earlier opponent impact in physical order', () => {
  const fight = start();
  const internal = fight.game as unknown as { fightMs: number; ai: { phase: unknown; phaseStartedMs: number } };
  const begin = internal.fightMs;
  const beginWall = wallMs;
  internal.ai = { ...internal.ai, phaseStartedMs: begin, phase: { kind: 'windup', hand: 'right', targetZone: 0, impactAtMs: begin + 50, attackKind: 'straight', target: 'head' } };
  fight.setMatch({ playerHp: 10, opponentHp: 10 });
  fight.run(0.1);
  fight.game.onAction(punch(beginWall + 70));
  fight.run(0.5);
  expect(fight.read().banner?.title).toBe('Adversário venceu');
});
