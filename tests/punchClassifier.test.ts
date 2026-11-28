import { describe, expect, it } from 'vitest';
import type { PunchMeasurement, PunchTrajectorySample } from '../src/cv/protocol';
import { classifyPunch } from '../src/kinematics/punchClassifier';

function sample(timestampMs: number, lateral: number, vertical: number, forward: number, elbowCosine = 0.8): PunchTrajectorySample {
  return { timestampMs, lateral, vertical, forward, elbowCosine, confidence: 1 };
}

function measurement(points: readonly [number, number, number, number][], elbowCosine = 0.8): PunchMeasurement {
  const samples = points.map(([time, lateral, vertical, forward]) => sample(time, lateral, vertical, forward, elbowCosine));
  const origin = samples[0]!;
  const contact = samples.reduce((best, point) => (point.forward > best.forward ? point : best), origin);
  const end = samples.at(-1)!;
  let pathLength = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]!;
    const b = samples[index]!;
    pathLength += Math.hypot(b.lateral - a.lateral, b.vertical - a.vertical, b.forward - a.forward);
  }
  return {
    samples,
    origin,
    speedPeak: samples[1] ?? origin,
    contact,
    end,
    durationMs: end.timestampMs - origin.timestampMs,
    forwardTravel: contact.forward - origin.forward,
    lateralExcursion: Math.max(...samples.map((point) => point.lateral)) - Math.min(...samples.map((point) => point.lateral)),
    verticalRise: Math.max(...samples.map((point) => point.vertical)) - origin.vertical,
    pathLength,
    netDisplacement: Math.hypot(contact.lateral - origin.lateral, contact.vertical - origin.vertical, contact.forward - origin.forward),
    maxElbowCosine: Math.max(...samples.map((point) => point.elbowCosine)),
  };
}

describe('classifyPunch', () => {
  it('classifies a straight head punch', () => {
    const result = classifyPunch(measurement([[0, 0, 0.1, 0.2], [80, 0.01, 0.08, 0.45], [150, 0, 0.05, 0.7]], 0.85));
    expect(result).toMatchObject({ punchKind: 'straight', targetZone: 'head' });
  });

  it('classifies a straight body punch', () => {
    const result = classifyPunch(measurement([[0, 0, -0.2, 0.15], [80, 0, -0.35, 0.4], [150, 0, -0.42, 0.65]], 0.8));
    expect(result).toMatchObject({ punchKind: 'straight', targetZone: 'body' });
  });

  it('classifies a lateral hook', () => {
    const result = classifyPunch(measurement([[0, -0.2, 0.05, 0.2], [80, 0, 0.08, 0.35], [150, 0.28, 0.05, 0.42]], 0.55));
    expect(result.punchKind).toBe('hook');
  });

  it('classifies a rising uppercut', () => {
    const result = classifyPunch(measurement([[0, 0, -0.35, 0.15], [80, 0.02, -0.05, 0.28], [150, 0.03, 0.18, 0.38]], 0.65));
    expect(result).toMatchObject({ punchKind: 'uppercut', targetZone: 'head' });
  });

  it('keeps weak or contradictory evidence unknown', () => {
    const result = classifyPunch(measurement([[0, 0, -0.1, 0.1], [100, 0.02, -0.05, 0.2]], 0.3));
    expect(result.punchKind).toBe('unknown');
  });
});
