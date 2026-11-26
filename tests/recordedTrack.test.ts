import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { segmentAt, TRACK_RECORDING_SCRIPT } from '../src/cv/recordingScript';
import { PoseRecorder } from '../src/cv/poseRecorder';
import { replayTrack } from './fixtures/replayTrack';
import { pose } from './fixtures/syntheticPose';

const SCRIPT_MS = TRACK_RECORDING_SCRIPT.reduce((total, segment) => total + segment.seconds * 1000, 0);
// Local, gitignored recordings: the scoreboard prints only when there is something to measure.
const recordings = import.meta.glob('./recordings/*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

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
    expect(frames.length).toBeGreaterThan(0);
  });
});
