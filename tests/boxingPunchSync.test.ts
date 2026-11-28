import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PLAYER_PUNCH_SPEED } from '../src/games/boxing/BoxingGame';
import { createMiiBoxer } from '../src/games/boxing/miiBoxer';

const STEP_S = 1 / 60;

/** Glove travel toward the opponent, frame by frame, for a punch thrown from the ready stance. */
function travel(punchSpeed: number): number[] {
  const boxer = createMiiBoxer({ punchSpeed });
  let time = 0;
  boxer.animate(time);
  boxer.setState('ready');
  const tick = () => {
    time += STEP_S;
    boxer.animate(time);
  };
  for (let i = 0; i < 40; i += 1) tick();
  const elbow = boxer.root.getObjectByName('mii-boxer-right-elbow')!;
  const z = () => {
    boxer.root.updateMatrixWorld(true);
    return new THREE.Vector3(0, -0.34, 0).applyMatrix4(elbow.matrixWorld).z;
  };
  const rest = z();
  boxer.setState('punch');
  return Array.from({ length: 24 }, () => {
    tick();
    return rest - z();
  });
}

describe('punch timing against the impact', () => {
  it("has the player's glove nearly extended when the impact shows, 80 ms in", () => {
    const player = travel(PLAYER_PUNCH_SPEED);
    expect(player[4]! / Math.max(...player)).toBeGreaterThan(0.85);
  });

  it('leaves the default boxer to crest later, at the opponent impact', () => {
    const opponent = travel(1);
    expect(opponent[4]! / Math.max(...opponent)).toBeLessThan(0.6);
    expect(opponent.indexOf(Math.max(...opponent))).toBeGreaterThanOrEqual(10);
  });
});
