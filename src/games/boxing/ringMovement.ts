/**
 * Pure ring geometry — no DOM, no Three.js, no clocks. Positions are on the canvas plane (x, z)
 * and movement is relative to the line from the mover to the other fighter, so "forward" always
 * closes the distance and "strafe" always circles.
 */

export interface RingPosition {
  readonly x: number;
  readonly z: number;
}

/** Fighter centers stay this far from the middle, inside the ropes of `ringScene.ts`. */
export const RING_LIMIT = 2.55;
export const MIN_FIGHTER_DISTANCE = 1.45;
/** Center-to-center distance up to which a punch, from either side, can land. */
export const PUNCH_RANGE = 2.95;
export const PLAYER_START: RingPosition = Object.freeze({ x: 0, z: 1.85 });
export const OPPONENT_START: RingPosition = Object.freeze({ x: 0, z: -0.85 });
/** The opponent walks in once the player is farther than this. */
const OPPONENT_APPROACH_DISTANCE = 2.75;
const OPPONENT_APPROACH_SPEED = 0.6;
const OPPONENT_CIRCLE_SPEED = 0.25;
const EPSILON = 1e-9;

const clampAxis = (value: number): number => Math.max(-RING_LIMIT, Math.min(RING_LIMIT, value));

export const clampToRing = ({ x, z }: RingPosition): RingPosition => ({ x: clampAxis(x), z: clampAxis(z) });

export const fighterDistance = (a: RingPosition, b: RingPosition): number => Math.hypot(a.x - b.x, a.z - b.z);

export const inPunchRange = (a: RingPosition, b: RingPosition): boolean => fighterDistance(a, b) <= PUNCH_RANGE + EPSILON;

/** Unit vector to the right of a fighter at `from` facing `to`. */
export function rightOf(from: RingPosition, to: RingPosition): RingPosition {
  const distance = fighterDistance(from, to) || 1;
  return { x: -(to.z - from.z) / distance, z: (to.x - from.x) / distance };
}

/** Keeps a move inside the ropes and off the other fighter; a move that cannot do both is refused. */
function settle(from: RingPosition, to: RingPosition, other: RingPosition): RingPosition {
  const inside = clampToRing(to);
  const distance = fighterDistance(inside, other);
  if (distance >= MIN_FIGHTER_DISTANCE - EPSILON) return inside;
  // Dead center on the other fighter has no direction of its own: back out the way we came.
  const away = distance > EPSILON ? inside : from;
  const scale = MIN_FIGHTER_DISTANCE / (fighterDistance(away, other) || 1);
  const pushed = clampToRing({ x: other.x + (away.x - other.x) * scale, z: other.z + (away.z - other.z) * scale });
  return fighterDistance(pushed, other) >= MIN_FIGHTER_DISTANCE - EPSILON ? pushed : from;
}

/**
 * Moves `self` by `forward` meters toward `other` and `strafe` meters to its own right, the
 * latter along the arc around `other` so circling alone never changes the distance.
 */
export function moveAround(self: RingPosition, other: RingPosition, forward: number, strafe: number): RingPosition {
  const distance = fighterDistance(self, other);
  if (distance <= EPSILON || (forward === 0 && strafe === 0)) return self;
  const right = rightOf(self, other);
  const back = { x: (self.x - other.x) / distance, z: (self.z - other.z) / distance };
  const angle = strafe / distance;
  // Walking in stops at the minimum distance instead of stepping through the other fighter.
  const radius = Math.max(MIN_FIGHTER_DISTANCE, distance - forward);
  return settle(self, {
    x: other.x + radius * (back.x * Math.cos(angle) + right.x * Math.sin(angle)),
    z: other.z + radius * (back.z * Math.cos(angle) + right.z * Math.sin(angle)),
  }, other);
}

export interface OpponentMove {
  readonly position: RingPosition;
  /** Circling direction to pass back in; it flips at the ropes. */
  readonly direction: -1 | 1;
}

/**
 * While guarding or recovering the opponent closes in when out of range and otherwise circles
 * lightly. It plants its feet to wind up, so stepping back is a way out of the punch.
 */
export function stepOpponentPosition(
  opponent: RingPosition,
  player: RingPosition,
  phase: 'guard' | 'windup' | 'recover',
  direction: -1 | 1,
  dtS: number,
): OpponentMove {
  if (phase === 'windup') return { position: opponent, direction };
  const excess = fighterDistance(opponent, player) - OPPONENT_APPROACH_DISTANCE;
  if (excess > EPSILON) {
    const forward = Math.min(excess, OPPONENT_APPROACH_SPEED * dtS);
    return { position: moveAround(opponent, player, forward, 0), direction };
  }
  const strafe = direction * OPPONENT_CIRCLE_SPEED * dtS;
  const position = moveAround(opponent, player, 0, strafe);
  // Hitting a rope bends the arc, which shows up as a changed distance: turn around instead.
  const blocked = Math.abs(fighterDistance(position, player) - fighterDistance(opponent, player)) > 1e-6;
  return blocked ? { position: opponent, direction: direction === 1 ? -1 : 1 } : { position, direction };
}
