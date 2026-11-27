import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { segmentAt, TRACK_RECORDING_SCRIPT } from '../src/cv/recordingScript';
import { PoseRecorder } from '../src/cv/poseRecorder';
import { replayTrack, summarize } from './fixtures/replayTrack';
import { pose } from './fixtures/syntheticPose';

const SCRIPT_MS = TRACK_RECORDING_SCRIPT.reduce((total, segment) => total + segment.seconds * 1000, 0);
// Local, gitignored recordings: the scoreboard prints only when there is something to measure.
// The one `corrida-GPU-…` scores low on running (26%) because of framing, not thresholds: the nose was
// above the picture in 189 of its 297 running frames and the tracker lost the body (37 empty, 54 upside down).
const recordings = import.meta.glob('./recordings/*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * Floors per recording, a little under what the detector scored when they were set: percent of frames
 * with the runner moving where it should (run, runJump) and where it should not. Raise them when the
 * detector improves; lowering one is accepting a regression. The recordings are personal and local, so
 * these only guard on a machine that has them.
 */
interface Floor { run: number; arms: number; side: number; stop: number; runJump?: number; walk?: number }
const FLOORS: Record<string, Floor> = {
  'corrida-CPU-1795731825430': { run: 85, arms: 3, side: 20, stop: 12 },
  'corrida-CPU-1795734053676': { run: 95, arms: 3, side: 5, stop: 5 },
  'corrida-CPU-1795735134733': { run: 95, arms: 3, side: 5, stop: 5 },
  'corrida-CPU-1795736477645': { run: 95, arms: 3, side: 5, stop: 5, runJump: 90, walk: 75 },
  'corrida-CPU-1795738782805': { run: 95, arms: 3, side: 5, stop: 5, runJump: 90, walk: 75 },
  // Badly framed (see above): kept to notice changes, not as a target.
  'corrida-GPU-1795733551309': { run: 20, arms: 3, side: 5, stop: 5 },
};

describe('recording script and replay', () => {
  it('records every scripted frame, then reports the end', () => {
    const recorder = new PoseRecorder();
    for (let time = 5000; time < 5000 + SCRIPT_MS; time += 100) expect(recorder.push(pose(time))).toBeDefined();
    expect(recorder.push(pose(5000 + SCRIPT_MS))).toBeUndefined();
    expect(recorder.frameCount).toBe(SCRIPT_MS / 100);
    expect(segmentAt(0)?.segment.kind).toBe('warmup');
  });

  it('scores a motionless player as motionless in every segment', () => {
    const frames = Array.from({ length: SCRIPT_MS / 100 }, (_, index) => pose(index * 100));
    const scores = replayTrack(frames);
    expect(scores).toHaveLength(TRACK_RECORDING_SCRIPT.length);
    expect(scores.every((score) => score.steps === 0 && score.jumps === 0 && score.moving01 === 0)).toBe(true);
  });
});

describe.skipIf(Object.keys(recordings).length === 0)('scoreboard for real recordings', () => {
  it.each(Object.entries(recordings))('%s', (name, raw) => {
    const recording = parsePoseRecording(raw);
    const frames = recording.frames.map((frame) => frame.snapshot);
    const seconds = (recording.lastTimestampMs - recording.firstTimestampMs) / 1000;
    console.log(`${name} · ${recording.source.delegate} · ${(frames.length / seconds).toFixed(1)} fps`);
    console.table(replayTrack(frames));
    const summary = summarize(frames);
    console.log('SUMMARY', JSON.stringify(summary));
    expect(frames.length).toBeGreaterThan(0);
    // A new recording has no floor yet: it is printed, then judged by whoever adds it.
    const floor = FLOORS[name.split('/').at(-1)!.replace('.json', '')];
    if (!floor) return;
    expect(summary.still, 'standing still moved the runner').toBeLessThanOrEqual(2);
    expect(summary.arms, 'arms alone moved the runner').toBeLessThanOrEqual(floor.arms);
    expect(summary.side, 'changing lanes moved the runner').toBeLessThanOrEqual(floor.side);
    expect(summary.stop, 'the runner kept going after the stop').toBeLessThanOrEqual(floor.stop);
    expect(summary.run, 'running was missed').toBeGreaterThanOrEqual(floor.run);
    if (floor.walk !== undefined) expect(summary.walk, 'walking was missed').toBeGreaterThanOrEqual(floor.walk);
    if (floor.runJump !== undefined) expect(summary.runJump, 'running was lost around jumps').toBeGreaterThanOrEqual(floor.runJump);
  });
});
