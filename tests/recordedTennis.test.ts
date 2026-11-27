import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile, PoseSnapshot } from '../src/cv/protocol';
import { segmentAt, TENNIS_RECORDING_SCRIPT } from '../src/cv/recordingScript';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { pose } from './fixtures/syntheticPose';

function replay(frames: readonly PoseSnapshot[]) {
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const start = frames[0]?.timestampMs ?? 0;
  const rows = TENNIS_RECORDING_SCRIPT.map(({ kind }) => ({ kind, samples: 0, matching: 0, delayMs: [] as number[] }));
  for (const snapshot of frames) {
    profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
    const segment = segmentAt(snapshot.timestampMs - start, TENNIS_RECORDING_SCRIPT);
    if (segment) rows[segment.index]!.samples += 1;
    for (const event of pipeline.update(snapshot, profile).events) {
      if (event.type !== 'swing') continue;
      const peak = event.peakTimestampMs ?? event.timestampMs;
      const at = segmentAt(peak - start, TENNIS_RECORDING_SCRIPT);
      if (!at) continue;
      const row = rows[at.index]!;
      row.delayMs.push(event.timestampMs - peak);
      if (event.side === row.kind) row.matching += 1;
    }
  }
  return rows.filter(({ samples }) => samples > 0).map(({ kind, delayMs, matching }) => {
    const expected = kind === 'forehand' || kind === 'backhand' ? 1 : 0;
    const detected = Math.min(expected, matching);
    const sorted = [...delayMs].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
    return { kind, missed: expected - detected, falsePositives: delayMs.length - detected, p50: percentile(0.5), p95: percentile(0.95) };
  });
}

it('reports no rebatidas for neutral pose samples with irregular timestamps', () => {
  const rows = replay([0, 27, 63, 100, 148, 260, 310].map((time) => pose(time)));
  expect(rows).toEqual([{ kind: 'still', missed: 0, falsePositives: 0, p50: undefined, p95: undefined }]);
});

const recordings = Object.entries(import.meta.glob<string>([
  './recordings/tenis-*.json',
  '!./recordings/tenis-erro-*.json',
], { query: '?raw', import: 'default', eager: true }));

describe.skipIf(recordings.length === 0)('tennis recording diagnostics', () => {
  it.each(recordings)('%s', (_name, raw) => {
    const { frames } = parsePoseRecording(raw);
    expect(frames.length).toBeGreaterThan(0);
    console.table(replay(frames.map(({ snapshot }) => snapshot)));
  });
});
