import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MII_HEAD_RADIUS, createMiiNoseGeometry, miiHeadScale } from '../src/mii/miiHead';
import { DEFAULT_MII_FACE_SPEC, type MiiFaceSpec } from '../src/mii/miiSpec';

function specFor(head: number, nose: number, noseY: number): MiiFaceSpec {
  return { ...DEFAULT_MII_FACE_SPEC, head, nose, noseY };
}

function* combinations(): Generator<{ head: number; nose: number; noseY: number }> {
  for (let head = 0; head < 8; head += 1) {
    for (let nose = 0; nose < 8; nose += 1) {
      for (let noseY = 30; noseY <= 50; noseY += 1) {
        yield { head, nose, noseY };
      }
    }
  }
}

interface NoseEvidence {
  zMin: number;
  zMax: number;
  /** Smallest ellipsoid quadratic form across all vertices; q < 1 means that vertex is strictly inside the head volume. */
  minQ: number;
  /** Largest distance a vertex stands in front of the exact front ellipsoid surface along -Z. */
  maxProtrusion: number;
  vertexCount: number;
}

/**
 * Vertex-exact geometric evidence in head-local coordinates: the ellipsoid is the sphere of
 * radius MII_HEAD_RADIUS scaled by (sx, sy, sz), centred at the origin, with the face at -Z.
 * Protrusion compares each vertex against the exact front surface z at that vertex's own (x, y),
 * so it stays sound even where the surface curves away across the primitive.
 */
function measureNose(geometry: THREE.BufferGeometry, sx: number, sy: number, sz: number): NoseEvidence {
  const rx = MII_HEAD_RADIUS * sx;
  const ry = MII_HEAD_RADIUS * sy;
  const rz = MII_HEAD_RADIUS * sz;
  const position = geometry.getAttribute('position');
  let zMin = Infinity;
  let zMax = -Infinity;
  let minQ = Infinity;
  let maxProtrusion = -Infinity;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    minQ = Math.min(minQ, (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2);
    const planar = (x / rx) ** 2 + (y / ry) ** 2;
    if (planar < 1) {
      const surfaceZ = -rz * Math.sqrt(1 - planar);
      maxProtrusion = Math.max(maxProtrusion, surfaceZ - z);
    }
  }
  return { zMin, zMax, minQ, maxProtrusion, vertexCount: position.count };
}

function collectFailures(check: (evidence: NoseEvidence) => string | undefined): string[] {
  const failures: string[] = [];
  let total = 0;
  for (const { head, nose, noseY } of combinations()) {
    total += 1;
    const spec = specFor(head, nose, noseY);
    const [sx, sy, sz] = miiHeadScale(spec);
    const geometry = createMiiNoseGeometry(spec);
    const evidence = measureNose(geometry, sx, sy, sz);
    geometry.dispose();
    const failure = check(evidence);
    if (failure && failures.length < 20) {
      failures.push(`head=${head} nose=${nose} noseY=${noseY}: ${failure}`);
    }
  }
  expect(total).toBe(8 * 8 * 21);
  return failures;
}

describe('createMiiNoseGeometry seating on the head ellipsoid', () => {
  it('produces non-degenerate finite z bounds for every combination', () => {
    const failures = collectFailures((evidence) => {
      if (evidence.vertexCount === 0) return 'no vertices';
      if (!Number.isFinite(evidence.zMin) || !Number.isFinite(evidence.zMax)) return 'non-finite z bounds';
      if (!(evidence.zMax > evidence.zMin)) return `degenerate z bounds [${evidence.zMin}, ${evidence.zMax}]`;
      return undefined;
    });
    expect(failures).toEqual([]);
  });

  it('intersects the ellipsoid volume (some vertex with q < 1) instead of floating outside', () => {
    // Conservative: a vertex with q strictly below 1 is mathematically inside the head volume,
    // so intersection is certain; the 0.95 margin keeps the check clear of the surface itself.
    const failures = collectFailures((evidence) =>
      evidence.minQ < 0.95 ? undefined : `minQ=${evidence.minQ.toFixed(4)} is not inside the volume`,
    );
    expect(failures).toEqual([]);
  });

  it('protrudes visibly in front of the exact front surface in -Z for every combination', () => {
    // The seating protrusion is 0.02 head-local units; vertex quantization on curved primitives
    // shaves off at most a couple of thousandths, so 0.012 is conservative evidence of visibility.
    // Note a z-bounds-only check against the deepest surface point would be unsound here: the front
    // surface is shallower at the lower nose band heights, so only the per-vertex exact comparison
    // above the surface at each vertex's own (x, y) is a valid protrusion test.
    const failures = collectFailures((evidence) =>
      evidence.maxProtrusion > 0.012
        ? undefined
        : `maxProtrusion=${evidence.maxProtrusion.toFixed(4)} is not visibly in front of the surface`,
    );
    expect(failures).toEqual([]);
  });

  it('keeps the nose z bounds in the front half of the head-local frame', () => {
    // Loose outer sanity on the z bounds: the front surface never goes deeper than -MII_HEAD_RADIUS * sz
    // (>= -0.432 for sz <= 1.08) and the protrusion is small, so a correctly seated nose tip stays well
    // ahead of z = -0.5, while the back end must never cross the head centre plane z = 0 — that would
    // mean the primitive was pushed straight through the face.
    const failures = collectFailures((evidence) => {
      if (!(evidence.zMin > -0.5)) return `zMin=${evidence.zMin.toFixed(4)} floats implausibly far ahead of the head`;
      if (!(evidence.zMax < 0)) return `zMax=${evidence.zMax.toFixed(4)} reaches behind the head centre plane`;
      return undefined;
    });
    expect(failures).toEqual([]);
  });
});
