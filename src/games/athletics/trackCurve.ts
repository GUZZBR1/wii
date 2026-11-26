// Analytic 400 m athletics track on the XZ plane, centred at the origin.
// Distance zero is the start of the home straight; the first bend begins at 84.39 m.

export const STRAIGHT = 84.39;
export const R_KERB = 36.5;
export const R_RUN = 36.8;
export const LANE_WIDTH = 1.22;

export interface TrackSample {
  x: number;
  z: number;
  tangentX: number;
  tangentZ: number;
  normalX: number;
  normalZ: number;
}

const radius = (laneIndex: number): number => R_RUN + laneIndex * LANE_WIDTH;

export function lapLength(laneIndex = 0): number {
  return 2 * STRAIGHT + 2 * Math.PI * radius(laneIndex);
}

// The normal points away from the infield: (-tangentZ, tangentX).
function sample(x: number, z: number, tangentX: number, tangentZ: number): TrackSample {
  return { x, z, tangentX, tangentZ, normalX: -tangentZ, normalZ: tangentX };
}

/** Distance is measured along the given lane (0 = inner) and wraps per lap. */
export function sampleTrack(distanceMeters: number, laneIndex = 0): TrackSample {
  const r = radius(laneIndex);
  const lap = lapLength(laneIndex);
  const bend = Math.PI * r;
  const half = STRAIGHT / 2;
  let d = ((distanceMeters % lap) + lap) % lap;

  if (d < STRAIGHT) return sample(-half + d, r, 1, 0);
  d -= STRAIGHT;
  if (d < bend) {
    const a = d / r;
    return sample(half + r * Math.sin(a), r * Math.cos(a), Math.cos(a), -Math.sin(a));
  }
  d -= bend;
  if (d < STRAIGHT) return sample(half - d, -r, -1, 0);
  d -= STRAIGHT;
  if (d < bend) {
    const a = d / r;
    return sample(-half - r * Math.sin(a), -r * Math.cos(a), -Math.cos(a), Math.sin(a));
  }
  return sample(-half + (d - bend), r, 1, 0);
}
