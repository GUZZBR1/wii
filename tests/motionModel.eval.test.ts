/**
 * Offline gate for personal motion learning: does teaching on a player's own examples beat the
 * geometric detectors on the real boxing recordings? Prints a table; skipped without recordings.
 * "same" teaches on part of a session and judges the rest of it; "cross" teaches on one whole
 * session and judges another.
 */
import { DtwGestureRecognizer, parsePoseRecording } from '@wii/spatial-core';
import { describe, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import { BOXING_RECORDING_SCRIPT, segmentAt } from '../src/cv/diagnostics/recordingScript';
import type { CalibrationProfile, PoseSnapshot } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { DodgeModel } from '../src/kinematics/personal/dodgeModel';

const PUNCHES = ['jab', 'cross', 'hook', 'uppercut', 'bodyshot'];
const PUNCH_NEGATIVES = ['still', 'guard', 'prepare', 'occlusion', 'slip', 'duck'];
const ARMS = [[11, 13, 15], [12, 14, 16]] as const;
const WINDOW = 7;
const REFRACTORY_MS = 600;

interface Frame {
  t: number;
  segment: number;
  kind: string;
  /** Fraction of the way through its script window. */
  at: number;
  arms: (number[] | undefined)[];
  pose?: { noseX: number; noseY: number; midX: number; midY: number; width: number; wrists: number[] };
  snapshot: PoseSnapshot;
  current: { punch: boolean; guard: boolean; duck: boolean; slip: boolean };
}

function armFeatures(s: PoseSnapshot, [shoulder, elbow, wrist]: readonly number[]): number[] | undefined {
  const w = s.worldLandmarks;
  const [a, b, c, left, right] = [w[shoulder!], w[elbow!], w[wrist!], w[11], w[12]];
  if (!a || !b || !c || !left || !right) return undefined;
  const scale = Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
  if (!(scale > 0.05)) return undefined;
  const upper = [a.x - b.x, a.y - b.y, a.z - b.z];
  const lower = [c.x - b.x, c.y - b.y, c.z - b.z];
  const cosine = upper.reduce((sum, v, i) => sum + v * lower[i]!, 0) / (Math.hypot(...upper) * Math.hypot(...lower) || 1);
  return [(c.x - a.x) / scale, (c.y - a.y) / scale, (c.z - a.z) / scale, cosine];
}

function load(raw: string): Frame[] {
  const snapshots = parsePoseRecording(JSON.parse(raw)).frames.map((frame) => frame.snapshot);
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const start = snapshots[0]?.timestampMs ?? 0;
  return snapshots.flatMap((s) => {
    profile = calibrator.update(s, pipeline.dodgeZone) ?? profile;
    const out = pipeline.update(s, profile);
    const elapsed = s.timestampMs - start;
    const found = segmentAt(elapsed, BOXING_RECORDING_SCRIPT);
    if (!found) return [];
    const [nose, l, r, lw, rw] = [0, 11, 12, 15, 16].map((i) => s.landmarks[i]);
    const width = l && r ? Math.hypot(l.x - r.x, l.y - r.y) : 0;
    return [{
      t: s.timestampMs,
      segment: found.index,
      kind: found.segment.kind,
      at: 1 - found.remainingMs / (found.segment.seconds * 1000),
      arms: ARMS.map((arm) => armFeatures(s, arm)),
      pose: nose && l && r && lw && rw && width > 0.03
        ? { noseX: nose.x, noseY: nose.y, midX: (l.x + r.x) / 2, midY: (l.y + r.y) / 2, width, wrists: [lw, rw].flatMap((p) => [(p.x - nose.x) / width, (p.y - nose.y) / width]) }
        : undefined,
      snapshot: s,
      current: {
        punch: out.events.some((event) => event.type === 'punch'),
        guard: out.controls.guard === true,
        duck: out.controls.duck === true,
        slip: (out.controls.dodgeZone ?? 0) !== 0,
      },
    }];
  });
}

/** Frame-to-frame motion of one arm: position plus its change, so a held pose is not a punch. */
function sequence(frames: Frame[], end: number, arm: number): number[][] | undefined {
  const out: number[][] = [];
  for (let i = end - WINDOW + 1; i <= end; i += 1) {
    const now = frames[i]?.arms[arm];
    const before = frames[i - 1]?.arms[arm];
    if (!now || !before) return undefined;
    out.push([...now.map((v) => v * 0.5), ...now.map((v, k) => v - before[k]!)]);
  }
  return out;
}

/** The demonstrated punch of a segment: the window around its fastest arm movement. */
function demonstration(frames: Frame[], segment: number): { arm: number; end: number } {
  let best = { arm: 0, end: -1, speed: 0 };
  frames.forEach((frame, i) => {
    if (frame.segment !== segment) return;
    for (const arm of [0, 1]) {
      const now = frame.arms[arm];
      const before = frames[i - 1]?.arms[arm];
      if (!now || !before) continue;
      const speed = Math.hypot(now[0]! - before[0]!, now[1]! - before[1]!, now[2]! - before[2]!) / Math.max(1, frame.t - frames[i - 1]!.t);
      if (speed > best.speed) best = { arm, end: Math.min(frames.length - 1, i + 3), speed };
    }
  });
  return best;
}

const segmentsOf = (frames: Frame[], kinds: string[]) => [...new Set(frames.filter((f) => kinds.includes(f.kind)).map((f) => f.segment))];

function dtwDetections(teach: Frame[], test: Frame[], teachPunches: number[], teachNegative: (f: Frame) => boolean, ratio: number): { t: number; segment: number; kind: string }[] {
  const recognizer = new DtwGestureRecognizer({ targetFrames: WINDOW, bandWidth: 2, maxDistance: 10, nullSeparationRatio: ratio, maxExamplesPerLabel: 60 });
  for (const segment of teachPunches) {
    const demo = demonstration(teach, segment);
    const example = sequence(teach, demo.end, demo.arm);
    if (example) recognizer.addExample('punch', example);
  }
  for (let i = 0; i < teach.length; i += 3) {
    if (!teachNegative(teach[i]!)) continue;
    for (const arm of [0, 1]) {
      const example = sequence(teach, i, arm);
      if (example) recognizer.addNullExample(example);
    }
  }
  const detections: { t: number; segment: number; kind: string }[] = [];
  let last = Number.NEGATIVE_INFINITY;
  test.forEach((frame, i) => {
    if (frame.t - last < REFRACTORY_MS) return;
    for (const arm of [0, 1]) {
      const recent = sequence(test, i, arm);
      if (recent && recognizer.recognize(recent)) {
        detections.push({ t: frame.t, segment: frame.segment, kind: frame.kind });
        last = frame.t;
        return;
      }
    }
  });
  return detections;
}

/** `delayMs` runs from the fastest arm movement of the window to the first detection in it. */
function punchScore(name: string, detections: { t: number; segment: number; kind: string }[], judged: number[], negativeSeconds: number, test: Frame[]) {
  // A hit has to sit next to the movement itself, not merely somewhere in its 4 s window.
  const delays = judged.flatMap((segment) => {
    const peak = test[demonstration(test, segment).end - 3];
    const near = peak && detections.find((d) => d.t - peak.t >= -300 && d.t - peak.t <= 700);
    return near && peak ? [Math.round(near.t - peak.t)] : [];
  }).sort((a, b) => a - b);
  const hit = delays.length;
  const falses = detections.filter((d) => PUNCH_NEGATIVES.includes(d.kind)).length;
  return `${name}: hit ${hit}/${judged.length}, false ${falses} in ${negativeSeconds}s, delay p50 ${delays[delays.length >> 1] ?? '-'}ms max ${delays.at(-1) ?? '-'}ms`;
}

/** Nearest-example classification of a static pose against the player's relaxed neutral. */
function poseScores(teach: Frame[], test: Frame[], isTeach: (f: Frame) => boolean, isTest: (f: Frame) => boolean) {
  const neutralOf = (frames: Frame[]) => {
    const still = frames.filter((f) => f.kind === 'still' && f.pose).map((f) => f.pose!);
    const mean = (key: 'noseX' | 'noseY' | 'midX' | 'midY' | 'width') => still.reduce((sum, p) => sum + p[key], 0) / still.length;
    return { noseX: mean('noseX'), noseY: mean('noseY'), midX: mean('midX'), midY: mean('midY'), width: mean('width') };
  };
  const channels = {
    guard: (f: Frame) => f.pose!.wrists,
    duck: (f: Frame, n: ReturnType<typeof neutralOf>) => [(f.pose!.noseY - n.noseY) / n.width, (f.pose!.midY - n.midY) / n.width, f.pose!.width / n.width - 1],
    slip: (f: Frame, n: ReturnType<typeof neutralOf>) => [Math.abs(f.pose!.noseX - n.noseX) / n.width, Math.abs(f.pose!.midX - n.midX) / n.width],
  };
  const nearest = (vector: number[], set: number[][]) => {
    const distances = set.map((other) => Math.hypot(...vector.map((v, i) => v - other[i]!))).sort((a, b) => a - b);
    return distances.slice(0, 3).reduce((sum, d) => sum + d, 0) / Math.min(3, distances.length);
  };
  const [teachNeutral, testNeutral] = [neutralOf(teach), neutralOf(test)];
  return (Object.keys(channels) as (keyof typeof channels)[]).map((channel) => {
    const features = channels[channel];
    // The middle of a window is when the movement is being held.
    const positives = teach.filter((f) => f.pose && isTeach(f) && f.kind === channel && f.at > 0.3 && f.at < 0.8).map((f) => features(f, teachNeutral));
    const negatives = teach.filter((f) => f.pose && isTeach(f) && ['still', 'prepare'].includes(f.kind)).map((f) => features(f, teachNeutral));
    const judged = test.filter((f) => f.pose && isTest(f) && f.kind === channel && f.at > 0.3 && f.at < 0.8);
    const quiet = test.filter((f) => f.pose && isTest(f) && (channel === 'guard' ? ['still', 'prepare'] : ['still', 'guard', 'prepare']).includes(f.kind));
    const personal = (f: Frame) => nearest(features(f, testNeutral), positives) < nearest(features(f, testNeutral), negatives);
    const share = (frames: Frame[], fn: (f: Frame) => boolean) => (frames.length ? `${Math.round((100 * frames.filter(fn).length) / frames.length)}%` : '-');
    if (!positives.length || !negatives.length) return `${channel}: no examples`;
    return `${channel}: personal ${share(judged, personal)} on / ${share(quiet, personal)} false | current ${share(judged, (f) => f.current[channel])} on / ${share(quiet, (f) => f.current[channel])} false`;
  });
}

/** The shipped model itself: taught on one whole session as the tutorial would, judged on another. */
function modelScore(teach: Frame[], test: Frame[]) {
  const model = new DodgeModel();
  const held = (f: Frame) => f.at > 0.3 && f.at < 0.8;
  const neutral = (frames: Frame[]) => { for (const f of frames) if (f.kind === 'still') model.teach('neutral', f.snapshot); };
  neutral(teach);
  const still = teach.filter((f) => f.kind === 'still' && f.pose);
  const centre = still.reduce((sum, f) => sum + f.pose!.noseX, 0) / still.length;
  // The script's two slips go to opposite sides; the head says which one each was.
  for (const segment of segmentsOf(teach, ['slip'])) {
    const frames = teach.filter((f) => f.segment === segment && held(f) && f.pose);
    const side = frames.reduce((sum, f) => sum + f.pose!.noseX, 0) / frames.length > centre ? 'left' : 'right';
    for (const f of frames) model.teach(side, f.snapshot);
  }
  for (const f of teach) if (f.kind === 'duck' && held(f)) model.teach('duck', f.snapshot);
  const outputs = test.map((f) => ({ f, out: model.update(f.snapshot) }));
  const share = (keep: (f: Frame) => boolean, on: (o: { zone?: number; duck?: boolean }) => boolean) => {
    const rows = outputs.filter(({ f }) => keep(f));
    return rows.length ? `${Math.round((100 * rows.filter(({ out }) => on(out)).length) / rows.length)}%` : '-';
  };
  const quiet = (f: Frame) => ['still', 'guard', 'prepare'].includes(f.kind);
  /** What the game feels: did each requested dodge register at all? */
  const registered = (kind: string, on: (f: Frame, o: { zone?: number; duck?: boolean }) => boolean) => {
    const segments = [...new Set(outputs.filter(({ f }) => f.kind === kind).map(({ f }) => f.segment))];
    return `${segments.filter((segment) => outputs.some(({ f, out }) => f.segment === segment && on(f, out))).length}/${segments.length}`;
  };
  return `registered slips ${registered('slip', (_, o) => !!o.zone)} (current ${registered('slip', (f) => f.current.slip)}), ducks ${registered('duck', (_, o) => !!o.duck)} (current ${registered('duck', (f) => f.current.duck)}) | model slip ${share((f) => f.kind === 'slip' && held(f), (o) => !!o.zone)} on / ${share(quiet, (o) => !!o.zone)} false | duck ${share((f) => f.kind === 'duck' && held(f), (o) => !!o.duck)} on / ${share(quiet, (o) => !!o.duck)} false | knows ${JSON.stringify(model.knows)}`;
}

const recordings = Object.entries(import.meta.glob<string>('./recordings/boxe-*.json', { query: '?raw', import: 'default', eager: true }));

describe.skipIf(recordings.length === 0)('personal motion model against the current detectors', () => {
  it('prints the comparison', () => {
    const sessions = recordings.map(([path, raw]) => ({ name: path.replace('./recordings/', ''), frames: load(raw) }));
    const lines: string[] = [];
    const seconds = (frames: Frame[], keep: (f: Frame) => boolean) => Math.round(frames.filter((f, i) => keep(f) && PUNCH_NEGATIVES.includes(f.kind) && frames[i + 1]).length / 11);

    for (const { name, frames } of sessions) {
      const punches = segmentsOf(frames, PUNCHES);
      const teachPunches = punches.filter((_, i) => i % 2 === 0);
      const judged = punches.filter((_, i) => i % 2 === 1);
      // Within a session: first half of each quiet window teaches, the second is judged.
      const firstHalf = (f: Frame) => f.at < 0.5;
      const secondHalf = (f: Frame) => f.at >= 0.5;
      lines.push(`\n== same session ${name} (${frames.length} frames)`);
      const current = frames.filter((f) => f.current.punch && (judged.includes(f.segment) || (PUNCH_NEGATIVES.includes(f.kind) && secondHalf(f))));
      lines.push(punchScore('punch current', current, judged, seconds(frames, secondHalf), frames));
      for (const ratio of [0.6, 0.75, 0.9]) {
        const found = dtwDetections(frames, frames, teachPunches, (f) => PUNCH_NEGATIVES.includes(f.kind) && firstHalf(f), ratio)
          .filter((d) => judged.includes(d.segment) || (PUNCH_NEGATIVES.includes(d.kind) && frames.some((f) => f.t === d.t && secondHalf(f))));
        lines.push(punchScore(`punch dtw ${ratio}`, found, judged, seconds(frames, secondHalf), frames));
      }
      // Poses: guard and duck/slip windows taught on one half, judged on the other.
      lines.push(...poseScores(frames, frames, (f) => f.kind === 'still' || f.kind === 'prepare' ? firstHalf(f) : f.at < 0.55, (f) => f.kind === 'still' || f.kind === 'prepare' ? secondHalf(f) : f.at >= 0.55));
    }

    for (const teach of sessions) {
      for (const test of sessions) {
        if (teach === test) continue;
        const judged = segmentsOf(test.frames, PUNCHES);
        lines.push(`\n== cross teach ${teach.name} -> test ${test.name}`);
        lines.push(punchScore('punch current', test.frames.filter((f) => f.current.punch), judged, seconds(test.frames, () => true), test.frames));
        for (const ratio of [0.6, 0.75, 0.9]) {
          const found = dtwDetections(teach.frames, test.frames, segmentsOf(teach.frames, PUNCHES), (f) => PUNCH_NEGATIVES.includes(f.kind), ratio);
          lines.push(punchScore(`punch dtw ${ratio}`, found, judged, seconds(test.frames, () => true), test.frames));
        }
        lines.push(...poseScores(teach.frames, test.frames, () => true, () => true));
      }
    }
    for (const { name, frames } of sessions) { const still = (f: Frame) => f.kind === 'still' || f.kind === 'prepare' || f.kind === 'guard'; lines.push(`\n== shipped model, same ${name}`, modelScore(frames.filter((f) => f.at < (still(f) ? 0.5 : 0.55)), frames.filter((f) => f.at >= (still(f) ? 0.5 : 0.55)))); }
    for (const teach of sessions) for (const test of sessions) if (teach !== test) lines.push(`\n== shipped model ${teach.name} -> ${test.name}`, modelScore(teach.frames, test.frames));
    process.stdout.write(`${lines.join('\n')}\n`);
  }, 120_000);
});
