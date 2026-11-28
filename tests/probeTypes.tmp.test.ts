import { describe, expect, it } from 'vitest';
import { loadUtdFrames, replayClip } from './utdMhadReplay';

const recordings = Object.entries(import.meta.glob<string>('./recordings/utd-mhad/a13_s*_t*.json', { query: '?raw', import: 'default', eager: true }));

describe.skipIf(recordings.length === 0)('type distribution probe', () => {
  it('reports the classified kinds across confirmed punches', () => {
    const kinds: Record<string, number> = {};
    const rows: string[] = [];
    for (const [path, raw] of recordings) {
      const result = replayClip(loadUtdFrames(raw));
      for (const event of result.confirmed) {
        if (event.type !== 'punch') continue;
        const k = `${event.punchKind ?? '?'}/${event.punchTargetZone ?? '?'}`;
        kinds[k] = (kinds[k] ?? 0) + 1;
        const m = event.measurement;
        if (m) rows.push(`${path.split('/').pop()} ${event.hand} ${k} fwd=${m.forwardTravel.toFixed(2)} lat=${m.lateralExcursion.toFixed(2)} rise=${m.verticalRise.toFixed(2)} path=${m.pathLength.toFixed(2)} maxCos=${m.maxElbowCosine.toFixed(2)} n=${m.samples.length}`);
      }
    }
    console.log('KINDS', JSON.stringify(kinds));
    for (const row of rows.slice(0, 29)) console.log(row);
    expect(Object.keys(kinds).length).toBeGreaterThan(0);
  });
});
