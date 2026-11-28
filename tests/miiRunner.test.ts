import { describe, expect, it } from 'vitest';
import { createMiiCapBandGeometry } from '../src/games/athletics/miiRunner';
import { MII_HEAD_RADIUS, miiHeadScale } from '../src/mii/miiHead';
import { DEFAULT_MII_FACE_SPEC } from '../src/mii/miiSpec';

function horizontalExtents(geometry: ReturnType<typeof createMiiCapBandGeometry>) {
  const positions = geometry.getAttribute('position');
  let maxX = 0;
  let maxZ = 0;
  for (let index = 0; index < positions.count; index += 1) {
    maxX = Math.max(maxX, Math.abs(positions.getX(index)));
    maxZ = Math.max(maxZ, Math.abs(positions.getZ(index)));
  }
  return { maxX, maxZ };
}

describe('createMiiCapBandGeometry', () => {
  it('scales the hat band beyond the horizontal head radius for every head shape', () => {
    for (let head = 0; head < 8; head += 1) {
      const spec = { ...DEFAULT_MII_FACE_SPEC, head };
      const [sx, , sz] = miiHeadScale(spec);
      const geometry = createMiiCapBandGeometry(spec);
      const { maxX, maxZ } = horizontalExtents(geometry);
      expect(maxX).toBeGreaterThan(MII_HEAD_RADIUS * sx);
      expect(maxZ).toBeGreaterThan(MII_HEAD_RADIUS * sz);
      expect(maxX / (MII_HEAD_RADIUS * sx)).toBeCloseTo(1.025, 5);
      expect(maxZ / (MII_HEAD_RADIUS * sz)).toBeCloseTo(1.025, 5);
      geometry.dispose();
    }
  });
});
