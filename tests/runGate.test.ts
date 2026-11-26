import { describe, expect, it } from 'vitest';
import { RunGate } from '../src/games/track/runGate';

const run = (gate: RunGate, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) gate.advance(1 / 60);
};

describe('run gate', () => {
  it('counts 3-2-1 before running', () => {
    const gate = new RunGate();
    expect([gate.phase, gate.count]).toEqual(['countdown', 3]);
    run(gate, 1.5);
    expect(gate.count).toBe(2);
    run(gate, 1.5);
    expect(gate.phase).toBe('running');
  });

  it('never pauses a player the camera has not seen', () => {
    const gate = new RunGate();
    run(gate, 3);
    gate.setTracking('SEM POSE');
    expect(gate.phase).toBe('running');
  });

  it('pauses on lost tracking and counts down again when it returns', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING');
    run(gate, 3);
    gate.setTracking('PROCURANDO');
    expect(gate.phase).toBe('running');
    gate.setTracking('SEM POSE');
    run(gate, 10);
    expect(gate.phase).toBe('paused');
    gate.setTracking('PROCURANDO');
    expect(gate.phase).toBe('paused');
    gate.setTracking('TRACKING');
    expect([gate.phase, gate.count]).toEqual(['countdown', 3]);
    run(gate, 3);
    expect(gate.phase).toBe('running');
  });

  it('pauses a countdown interrupted by tracking loss', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING');
    run(gate, 1);
    gate.setTracking('SEM POSE');
    run(gate, 5);
    expect(gate.phase).toBe('paused');
  });

  it('lets a key leave the pause and stops waiting for the camera', () => {
    const gate = new RunGate();
    expect(gate.resumeByKey()).toBe(false);
    gate.setTracking('TRACKING');
    gate.setTracking('SEM POSE');
    expect(gate.resumeByKey()).toBe(true);
    run(gate, 3);
    gate.setTracking('SEM POSE');
    expect(gate.phase).toBe('running');
  });
});
