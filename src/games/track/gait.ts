export type Gait = 'idle' | 'walk' | 'run';

// On the CadenceTracker scale these are about 138 steps/min to start running and 130 to drop back.
const RUN_ON_SPEED = 0.55;
const RUN_OFF_SPEED = 0.5;

export function gaitFor(speed01: number, previous: Gait): Gait {
  if (speed01 <= 0.02) return 'idle';
  return speed01 >= (previous === 'run' ? RUN_OFF_SPEED : RUN_ON_SPEED) ? 'run' : 'walk';
}

/** Keyboard pace cycle: stopped → walking → running → stopped. */
export function nextPace(speed01: number): number {
  return speed01 === 0 ? 0.3 : speed01 < RUN_ON_SPEED ? 0.8 : 0;
}
