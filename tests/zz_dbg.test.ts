import { readFileSync } from 'node:fs';
import { parsePoseRecording } from '@wii/spatial-core';
import { it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
it('dbg', () => {
  const { frames } = parsePoseRecording(readFileSync('tests/recordings/errors/tenis-erro-CPU-1795794444389.json', 'utf8'));
  const p = new ActionPipeline(); const c = new AdaptiveCalibrator(); let prof: any; const t0 = frames[0]!.snapshot.timestampMs; const out: string[] = [];
  for (const { snapshot: s } of frames) {
    prof = c.update(s, p.laneZone) ?? prof;
    for (const e of p.update(s, prof).events) if (e.type === 'swing') out.push(`${((s.timestampMs - t0) / 1000).toFixed(1)}${e.side[0]}${e.hand[0]}`);
  }
  process.stdout.write(`\nRESULT ${out.join(' ')}\n`);
});
