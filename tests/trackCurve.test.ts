import { describe, expect, it } from 'vitest';
import { LANE_WIDTH, lapLength, R_RUN, STRAIGHT, sampleTrack, type TrackSample } from '../src/games/athletics/trackCurve';

const LANES = [0, 5];
const half = STRAIGHT / 2;
const radius = (lane: number) => R_RUN + lane * LANE_WIDTH;

function boundaries(lane: number): number[] {
  const bend = Math.PI * radius(lane);
  return [0, bend, bend + STRAIGHT, 2 * bend + STRAIGHT, lapLength(lane)];
}

function distances(lane: number): number[] {
  return Array.from({ length: 97 }, (_, i) => (i / 97) * lapLength(lane) + 0.01);
}

function expectSame(actual: TrackSample, expected: TrackSample, digits: number): void {
  for (const key of Object.keys(expected) as (keyof TrackSample)[]) {
    expect(actual[key]).toBeCloseTo(expected[key], digits);
  }
}

describe('trackCurve', () => {
  it('measures 400 m on the inner lane and longer outside', () => {
    expect(lapLength()).toBeCloseTo(400, 1);
    expect(lapLength(5) - lapLength(0)).toBeCloseTo(2 * Math.PI * 5 * LANE_WIDTH, 9);
  });

  it.each(LANES)('hits the segment boundary points in order on lane %i', (lane) => {
    const r = radius(lane);
    const expected = [
      [half, r, 1],
      [half, -r, -1],
      [-half, -r, -1],
      [-half, r, 1],
      [half, r, 1],
    ];
    boundaries(lane).forEach((d, i) => {
      const [x, z, tangentX] = expected[i];
      expectSame(sampleTrack(d, lane), { x, z, tangentX, tangentZ: 0, normalX: 0, normalZ: tangentX }, 9);
    });
  });

  it('reaches the outermost points halfway round each bend', () => {
    const bend = Math.PI * R_RUN;
    expect(sampleTrack(bend / 2).x).toBeCloseTo(half + R_RUN, 9);
    expect(sampleTrack(bend / 2).tangentZ).toBeCloseTo(-1, 9);
    expect(sampleTrack(1.5 * bend + STRAIGHT).x).toBeCloseTo(-half - R_RUN, 9);
    expect(sampleTrack(1.5 * bend + STRAIGHT).tangentZ).toBeCloseTo(1, 9);
  });

  it.each(LANES)('is continuous across every boundary and the wrap on lane %i', (lane) => {
    for (const d of boundaries(lane)) {
      expectSame(sampleTrack(d - 1e-7, lane), sampleTrack(d + 1e-7, lane), 5);
    }
  });

  it.each(LANES)('wraps negative and multi-lap distances on lane %i', (lane) => {
    const lap = lapLength(lane);
    for (const d of [10, 150, 250, 350]) {
      for (const offset of [-3 * lap, -lap, lap, 2 * lap]) {
        expectSame(sampleTrack(d + offset, lane), sampleTrack(d, lane), 8);
      }
    }
  });

  it.each(LANES)('has unit tangent and outward unit normal on lane %i', (lane) => {
    for (const d of distances(lane)) {
      const s = sampleTrack(d, lane);
      expect(Math.hypot(s.tangentX, s.tangentZ)).toBeCloseTo(1, 12);
      expect(Math.hypot(s.normalX, s.normalZ)).toBeCloseTo(1, 12);
      expect(s.normalX).toBe(-s.tangentZ);
      expect(s.normalZ).toBe(s.tangentX);
      // Outward: away from the nearest point of the infield's centre segment.
      const coreX = Math.max(-half, Math.min(half, s.x));
      expect((s.x - coreX) * s.normalX + s.z * s.normalZ).toBeCloseTo(radius(lane), 9);
    }
  });

  it.each(LANES)('has a tangent equal to the derivative of position on lane %i', (lane) => {
    const h = 1e-5;
    for (const d of distances(lane)) {
      const a = sampleTrack(d - h, lane);
      const b = sampleTrack(d + h, lane);
      const s = sampleTrack(d, lane);
      expect((b.x - a.x) / (2 * h)).toBeCloseTo(s.tangentX, 5);
      expect((b.z - a.z) / (2 * h)).toBeCloseTo(s.tangentZ, 5);
    }
  });
});
