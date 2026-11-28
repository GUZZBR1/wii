/**
 * The ruler for boxing tracking, over the scripted recordings: per attempt, was the move
 * registered; per second of other activity, how often did one appear unasked; and the same after
 * the player is displaced, farther away or sampled at half the rate. Skipped without recordings.
 */
import { parsePoseRecording } from '@wii/spatial-core';
import { describe, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import { BOXING_RECORDING_SCRIPT, segmentAt } from '../src/cv/diagnostics/recordingScript';
import type { CalibrationProfile, PoseSnapshot } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';

const PUNCHES = ['jab', 'cross', 'hook', 'uppercut', 'bodyshot'];

function evaluate(frames: PoseSnapshot[], perturb: (s: PoseSnapshot, elapsedMs: number, width: number) => PoseSnapshot, keepEvery = 1) {
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const start = frames[0]!.timestampMs;
  const width = Math.abs(frames[0]!.landmarks[11]!.x - frames[0]!.landmarks[12]!.x);
  const rows = new Map<number, { kind: string; slip: boolean; duck: boolean; punches: number }>();
  const alarms = { quiet: 0, punching: 0, quietS: 0, punchingS: 0 };
  let was = false;
  let previousMs = start;
  frames.forEach((original, index) => {
    if (index % keepEvery) return;
    const elapsed = original.timestampMs - start;
    const snapshot = perturb(original, elapsed, width);
    profile = calibrator.update(snapshot, pipeline.dodgeZone) ?? profile;
    const out = pipeline.update(snapshot, profile);
    const at = segmentAt(elapsed, BOXING_RECORDING_SCRIPT);
    const seconds = (original.timestampMs - previousMs) / 1000;
    previousMs = original.timestampMs;
    if (!at) return;
    const row = rows.get(at.index) ?? { kind: at.segment.kind, slip: false, duck: false, punches: 0 };
    rows.set(at.index, row);
    const slip = (out.controls.dodgeZone ?? 0) !== 0;
    const duck = out.controls.duck === true;
    row.slip ||= slip;
    row.duck ||= duck;
    row.punches += out.events.filter((event) => event.type === 'punch').length;
    const kind = at.segment.kind;
    const dodging = slip || duck;
    if (['still', 'guard', 'prepare'].includes(kind)) {
      alarms.quietS += seconds;
      if (dodging && !was) alarms.quiet += 1;
    } else if (PUNCHES.includes(kind)) {
      alarms.punchingS += seconds;
      if (dodging && !was) alarms.punching += 1;
    }
    was = dodging;
  });
  const all = [...rows.values()];
  const registered = (kinds: string[], hit: (row: (typeof all)[number]) => boolean) => {
    const asked = all.filter((row) => kinds.includes(row.kind));
    return [asked.filter(hit).length, asked.length] as const;
  };
  return {
    slips: registered(['slip'], (row) => row.slip),
    ducks: registered(['duck'], (row) => row.duck),
    punches: registered(PUNCHES, (row) => row.punches > 0),
    extraPunches: all.filter((row) => PUNCHES.includes(row.kind)).reduce((sum, row) => sum + Math.max(0, row.punches - 1), 0),
    falsePunches: all.filter((row) => !PUNCHES.includes(row.kind)).reduce((sum, row) => sum + row.punches, 0),
    alarms,
  };
}

const recordings = Object.values(import.meta.glob<string>('./recordings/boxe-*.json', { query: '?raw', import: 'default', eager: true }));
const shift = (s: PoseSnapshot, dx: number): PoseSnapshot => ({ ...s, landmarks: s.landmarks.map((p) => ({ ...p, x: p.x + dx })) });

const CASES = [
  ['as recorded', (s: PoseSnapshot) => s, 1],
  // From a quarter of the way in, the player stands somewhere else.
  ['stepped aside', (s: PoseSnapshot, t: number, w: number) => (t > 20_000 ? shift(s, 0.6 * w) : s), 1],
  ['farther away', (s: PoseSnapshot, t: number) => (t > 20_000 ? { ...s, landmarks: s.landmarks.map((p) => ({ ...p, x: 0.5 + (p.x - 0.5) * 0.75, y: 0.5 + (p.y - 0.5) * 0.75 })) } : s), 1],
  ['hips cropped', (s: PoseSnapshot) => ({ ...s, landmarks: s.landmarks.map((p, i) => (i === 23 || i === 24 ? { ...p, visibility: 0.1, presence: 0.1 } : p)), worldLandmarks: s.worldLandmarks.map((p, i) => (i === 23 || i === 24 ? { ...p, visibility: 0.1, presence: 0.1 } : p)) }), 1],
  ['half the frames', (s: PoseSnapshot) => s, 2],
] as const;

describe.skipIf(recordings.length === 0)('boxing tracking ruler', () => {
  it('prints the scoreboard', () => {
    const sessions = recordings.map((raw) => parsePoseRecording(JSON.parse(raw)).frames.map((frame) => frame.snapshot));
    for (const [name, perturb, keepEvery] of CASES) {
      const total = { slips: [0, 0], ducks: [0, 0], punches: [0, 0], extra: 0, falsePunches: 0, quiet: 0, quietS: 0, punching: 0, punchingS: 0 };
      for (const frames of sessions) {
        const r = evaluate(frames, perturb, keepEvery);
        for (const key of ['slips', 'ducks', 'punches'] as const) for (const i of [0, 1]) total[key][i]! += r[key][i]!;
        total.extra += r.extraPunches;
        total.falsePunches += r.falsePunches;
        for (const key of ['quiet', 'quietS', 'punching', 'punchingS'] as const) total[key] += r.alarms[key];
      }
      const perMinute = (n: number, s: number) => ((60 * n) / s).toFixed(1);
      process.stdout.write(`${name}: slips ${total.slips.join('/')}, ducks ${total.ducks.join('/')}, false dodges/min quiet ${perMinute(total.quiet, total.quietS)} punching ${perMinute(total.punching, total.punchingS)}; punches ${total.punches.join('/')}, extra ${total.extra}, outside ${total.falsePunches}\n`);
    }
  }, 120_000);
});
