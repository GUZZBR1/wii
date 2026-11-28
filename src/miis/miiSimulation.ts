/** Mii movement in page coordinates (px; y increases downward). Pure logic with no DOM or Three.js. */
export interface Walker {
  x: number;
  y: number;
  /** Current direction in radians (0 = right, π/2 = down). */
  heading: number;
  /** Seconds until the next decision. */
  timer: number;
  walking: boolean;
  /** Seconds until arrival; do not draw the Mii while this is greater than 0. */
  delay: number;
  /** Pixels left to travel into the page; greater than 0 while entering from an edge. */
  entering: number;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

export const WALK_SPEED = 34;
export const SIDE_MARGIN = 28;
export const TOP_MARGIN = 120;
export const BOTTOM_MARGIN = 12;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Movement perspective: Miis near the top of the viewport appear farther away (smaller); those near the bottom appear closer (larger). */
export const depthScale = (screenY: number, viewHeight: number) => 0.7 + 0.5 * clamp(screenY / viewHeight, 0, 1);

export function createWalkers(count: number, bounds: Bounds, rng: () => number = Math.random): Walker[] {
  return Array.from({ length: count }, () => ({
    x: SIDE_MARGIN + rng() * Math.max(0, bounds.width - SIDE_MARGIN * 2),
    y: TOP_MARGIN + rng() * Math.max(0, bounds.height - TOP_MARGIN - BOTTOM_MARGIN),
    heading: rng() * Math.PI * 2,
    timer: rng() * 4,
    walking: rng() > 0.3,
    delay: 0,
    entering: 0,
  }));
}

/** Distance beyond the edge where a Mii starts. */
export const OFFSTAGE = 40;
/** Minimum interval between arrivals; the maximum is almost twice as long. */
export const ARRIVAL_GAP = 1;

/** Rotating entry points: an edge and a position (0..1) along it. */
const ENTRIES = [
  ['left', 0.1],
  ['right', 0.9],
  ['bottom', 0.2],
  ['right', 0.15],
  ['left', 0.85],
  ['bottom', 0.8],
  ['left', 0.5],
  ['bottom', 0.5],
  ['right', 0.55],
] as const;

/**
 * Place the Mii just outside the visible window (`viewTop`..`viewTop + viewHeight`), along an edge,
 * at a corner, or below it so it can walk into view.
 */
export function enterFromEdge(
  walker: Walker,
  index: number,
  bounds: Bounds,
  viewTop: number,
  viewHeight: number,
  rng: () => number = Math.random,
): void {
  const [edge, spot] = ENTRIES[index % ENTRIES.length];
  const along = clamp(spot + (rng() - 0.5) * 0.15, 0.02, 0.98);
  // Head toward the middle of the viewport with some margin.
  const wobble = (rng() - 0.5) * 0.4;
  if (edge === 'bottom') {
    walker.x = clamp(along * bounds.width, SIDE_MARGIN, bounds.width - SIDE_MARGIN);
    walker.y = viewTop + viewHeight + OFFSTAGE + 30;
    walker.heading = -Math.PI / 2 + (0.5 - along) + wobble;
  } else {
    const slope = (0.5 - along) * 1.2 + wobble;
    walker.x = edge === 'left' ? -OFFSTAGE : bounds.width + OFFSTAGE;
    walker.y = clamp(viewTop + along * viewHeight, TOP_MARGIN, bounds.height - BOTTOM_MARGIN);
    walker.heading = edge === 'left' ? slope : Math.PI - slope;
  }
  walker.walking = true;
  walker.delay = index === 0 ? 0 : index * ARRIVAL_GAP + rng() * ARRIVAL_GAP * 0.8;
  walker.entering = OFFSTAGE + 90 + rng() * 220;
}

/** Duration of the startled expression, in seconds. */
export const GRUMP_SECONDS = 1.1;

/** Startled pose after `t` seconds: jump (px, upward), body tilt, and a head shake (radians). */
export function grumpPose(t: number) {
  const left = clamp(1 - t / GRUMP_SECONDS, 0, 1);
  return {
    hop: Math.abs(Math.sin(t * 12)) * 12 * left,
    tilt: Math.sin(t * 30) * 0.22 * left,
    yaw: Math.sin(t * 18) * 0.9 * left,
  };
}

export function stepWalker(walker: Walker, dt: number, bounds: Bounds, rng: () => number = Math.random): void {
  if (walker.delay > 0) {
    walker.delay -= dt;
    return;
  }
  if (walker.entering > 0) {
    // While entering, move straight until inside the page without reflecting off edges.
    walker.entering -= WALK_SPEED * 2 * dt;
    walker.x += Math.cos(walker.heading) * WALK_SPEED * 2 * dt;
    walker.y += Math.sin(walker.heading) * WALK_SPEED * 2 * dt;
    return;
  }
  walker.timer -= dt;
  if (walker.timer <= 0) {
    walker.walking = rng() > 0.3;
    walker.heading = rng() * Math.PI * 2;
    walker.timer = 1.5 + rng() * 4;
  }
  if (walker.walking) {
    walker.x += Math.cos(walker.heading) * WALK_SPEED * dt;
    walker.y += Math.sin(walker.heading) * WALK_SPEED * dt;
  }
  const x = clamp(walker.x, SIDE_MARGIN, bounds.width - SIDE_MARGIN);
  const y = clamp(walker.y, TOP_MARGIN, bounds.height - BOTTOM_MARGIN);
  // At an edge, reflect the direction instead of pushing against the boundary.
  if (x !== walker.x) walker.heading = Math.PI - walker.heading;
  if (y !== walker.y) walker.heading = -walker.heading;
  walker.x = x;
  walker.y = y;
}
