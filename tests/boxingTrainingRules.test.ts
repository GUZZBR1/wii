import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DODGE_SEQUENCE,
  DodgeChallenge,
  type DodgeChallengeConfig,
  type DodgeChallengeEvent,
  type LaneZone,
  PunchingBagTrainer,
  type PunchingBagEvent,
} from '../src/games/boxing/trainingRules';

const hitFrom = (events: readonly PunchingBagEvent[]) => {
  const hit = events.find((event) => event.kind === 'hit');
  if (hit?.kind !== 'hit') throw new Error('expected a hit event');
  return hit;
};

const resolvedFrom = (events: readonly DodgeChallengeEvent[]) => {
  const resolved = events.find((event) => event.kind === 'attack-resolved');
  if (resolved?.kind !== 'attack-resolved') throw new Error('expected an attack-resolved event');
  return resolved;
};

describe('punching bag training rules', () => {
  it('scores an on-beat punch and starts the combo', () => {
    const bag = new PunchingBagTrainer();

    const events = bag.punch({ timeSeconds: 1, strength01: 1 });

    expect(events).toHaveLength(1);
    const hit = hitFrom(events);
    expect(hit).toMatchObject({
      beatIndex: 0,
      beatTimeSeconds: 1,
      timingErrorSeconds: 0,
      precision01: 1,
      points: 200,
      combo: 1,
      score: 200,
    });
    expect(bag.snapshot).toMatchObject({
      timeSeconds: 1,
      status: 'active',
      score: 200,
      combo: 1,
      bestCombo: 1,
      hits: 1,
      averagePrecision01: 1,
    });
  });

  it('makes timing precision and strength change the score deterministically', () => {
    const exact = new PunchingBagTrainer();
    const looseTiming = new PunchingBagTrainer();
    const weakCentered = new PunchingBagTrainer();

    const exactHit = hitFrom(exact.punch({ timeSeconds: 1, strength01: 1 }));
    const looseHit = hitFrom(looseTiming.punch({ timeSeconds: 1.12, strength01: 1 }));
    const strengthHit = hitFrom(weakCentered.punch({ timeSeconds: 1, strength01: 0.5 }));

    expect(exactHit.points).toBe(200);
    expect(looseHit.precision01).toBeCloseTo(0.44, 10);
    expect(looseHit.points).toBe(144);
    expect(strengthHit.precision01).toBeCloseTo(0.85, 10);
    expect(strengthHit.points).toBe(185);
    expect(looseHit.points).toBeLessThan(exactHit.points);
    expect(strengthHit.points).toBeLessThan(exactHit.points);
  });

  it('raises the combo multiplier on consecutive on-beat hits', () => {
    const bag = new PunchingBagTrainer();

    bag.punch({ timeSeconds: 1, strength01: 1 });
    const second = hitFrom(bag.punch({ timeSeconds: 1.8, strength01: 1 }));

    expect(second.points).toBe(220);
    expect(second.combo).toBe(2);
    expect(bag.snapshot.score).toBe(420);
    expect(bag.snapshot.bestCombo).toBe(2);
  });

  it('breaks the combo on a timing error', () => {
    const bag = new PunchingBagTrainer();
    bag.punch({ timeSeconds: 1, strength01: 1 });

    const events = bag.punch({ timeSeconds: 1.5, strength01: 1 });

    const error = events.at(-1);
    if (error?.kind !== 'punch-error') throw new Error('expected a punch-error event');
    expect(error.reason).toBe('timing');
    expect(error.beatIndex).toBe(1);
    expect(bag.snapshot.combo).toBe(0);
    expect(bag.snapshot.errors).toBe(1);
    expect(bag.snapshot.score).toBe(200);
  });

  it('breaks the combo when a beat passes without a punch', () => {
    const bag = new PunchingBagTrainer();
    bag.punch({ timeSeconds: 1, strength01: 1 });

    const events = bag.advanceTo(1.951);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'beat-missed', beatIndex: 1, beatTimeSeconds: 1.8, timeSeconds: 1.95 });
    expect(bag.snapshot.combo).toBe(0);
    expect(bag.snapshot.misses).toBe(1);
  });

  it('keeps the hit window inclusive at its exact edge', () => {
    const bag = new PunchingBagTrainer();

    expect(bag.advanceTo(1.15)).toEqual([]);
    const hit = hitFrom(bag.punch({ timeSeconds: 1.15, strength01: 1 }));

    expect(hit.timingErrorSeconds).toBeCloseTo(0.15, 10);
    expect(hit.points).toBe(130);
    expect(bag.snapshot.hits).toBe(1);
  });

  it('lets a weak on-beat punch claim the beat without scoring or becoming a miss', () => {
    const bag = new PunchingBagTrainer();
    bag.punch({ timeSeconds: 1, strength01: 1 });

    const weakEvents = bag.punch({ timeSeconds: 1.8, strength01: 0.1 });
    const error = weakEvents.at(-1);
    if (error?.kind !== 'punch-error') throw new Error('expected a weak punch-error event');
    expect(error.reason).toBe('weak');
    expect(bag.snapshot.combo).toBe(0);

    expect(bag.advanceTo(2)).toEqual([]);
    expect(bag.snapshot.misses).toBe(0);
    expect(bag.snapshot.errors).toBe(1);
  });

  it('rejects a duplicate punch in the same beat window and breaks the combo', () => {
    const bag = new PunchingBagTrainer();
    bag.punch({ timeSeconds: 1, strength01: 1 });

    const events = bag.punch({ timeSeconds: 1.05, strength01: 1 });

    const duplicate = events.at(-1);
    if (duplicate?.kind !== 'punch-error') throw new Error('expected a duplicate punch-error event');
    expect(duplicate.reason).toBe('duplicate');
    expect(bag.snapshot.combo).toBe(0);
    expect(bag.snapshot.hits).toBe(1);
    expect(bag.snapshot.errors).toBe(1);
  });

  it('makes the default punching-bag targets reachable with seven perfect punches', () => {
    const bag = new PunchingBagTrainer();

    for (let beatIndex = 0; beatIndex < 7; beatIndex += 1) {
      bag.punch({ timeSeconds: 1 + beatIndex * 0.8, strength01: 1 });
    }

    expect(bag.snapshot).toMatchObject({ status: 'won', score: 1800, bestCombo: 7, averagePrecision01: 1 });
  });

  it('wins exactly when the score, combo and precision targets are all satisfied', () => {
    const bag = new PunchingBagTrainer({ targetScore: 420, targetCombo: 2 });

    const first = bag.punch({ timeSeconds: 1, strength01: 1 });
    expect(first.map((event) => event.kind)).toEqual(['hit']);
    expect(bag.snapshot.status).toBe('active');

    const second = bag.punch({ timeSeconds: 1.8, strength01: 1 });
    expect(second.map((event) => event.kind)).toEqual(['hit', 'won']);
    expect(second.at(-1)).toMatchObject({ kind: 'won', score: 420, bestCombo: 2, averagePrecision01: 1 });
    expect(bag.snapshot).toMatchObject({ status: 'won', score: 420, bestCombo: 2, wonAtSeconds: 1.8 });
  });

  it('withholds victory until average hit precision also reaches its target', () => {
    const bag = new PunchingBagTrainer({ targetScore: 130, targetCombo: 1, targetAveragePrecision01: 0.45 });

    const first = bag.punch({ timeSeconds: 1.15, strength01: 1 });
    expect(first.map((event) => event.kind)).toEqual(['hit']);
    expect(bag.snapshot).toMatchObject({ status: 'active', score: 130, bestCombo: 1 });
    expect(bag.snapshot.averagePrecision01).toBeCloseTo(0.3, 10);

    const second = bag.punch({ timeSeconds: 1.8, strength01: 1 });
    expect(second.map((event) => event.kind)).toEqual(['hit', 'won']);
    expect(bag.snapshot.averagePrecision01).toBeCloseTo(0.65, 10);
    expect(bag.snapshot.status).toBe('won');
  });

  it('freezes the terminal punching-bag state after victory', () => {
    const bag = new PunchingBagTrainer({ targetScore: 420, targetCombo: 2 });
    bag.punch({ timeSeconds: 1, strength01: 1 });
    bag.punch({ timeSeconds: 1.8, strength01: 1 });

    expect(bag.advanceTo(3)).toEqual([]);
    expect(bag.punch({ timeSeconds: 3, strength01: 1 })).toEqual([]);
    expect(bag.snapshot.timeSeconds).toBe(1.8);
    expect(bag.snapshot.score).toBe(420);
  });

  it('rejects backwards timestamps', () => {
    const bag = new PunchingBagTrainer();
    bag.advanceTo(1);

    expect(() => bag.advanceTo(0.99)).toThrow(RangeError);
    expect(() => bag.punch({ timeSeconds: 0.99 })).toThrow(RangeError);
  });
});

describe('dodge challenge training rules', () => {
  const timing: DodgeChallengeConfig = {
    telegraphSeconds: 0.5,
    activeSeconds: 0.4,
    resolvedSeconds: 0.2,
    correctDodgePoints: 100,
    earlyDodgePoints: 40,
    targetScore: 100,
    requiredDodges: 1,
    maxHits: 1,
  };
  const oneAttack = [{ attackLane: 0, safeLane: -1 }] as const;

  it('advances telegraph, active and resolved phases through explicit time', () => {
    const challenge = new DodgeChallenge(oneAttack, timing);
    expect(challenge.snapshot).toMatchObject({ phase: 'telegraph', attackIndex: 0, laneZone: 0 });

    const activeEvents = challenge.advance(0.5, 0);
    expect(activeEvents.map((event) => event.kind)).toEqual(['attack-active']);
    expect(activeEvents[0]).toMatchObject({ timeSeconds: 0.5, attackIndex: 0 });
    expect(challenge.snapshot).toMatchObject({ phase: 'active', timeSeconds: 0.5, phaseEndsAtSeconds: 0.9 });

    const resolvedEvents = challenge.advance(0.4, 0);
    const resolved = resolvedFrom(resolvedEvents);
    expect(resolved).toMatchObject({ timeSeconds: 0.9, outcome: 'hit', points: 0, hits: 1 });
    expect(challenge.snapshot.phase).toBe('resolved');
    expect(challenge.snapshot.phaseEndsAtSeconds).toBeCloseTo(1.1, 10);

    const finalEvents = challenge.advance(0.2, 0);
    expect(finalEvents.map((event) => event.kind)).toEqual(['lost']);
    expect(finalEvents[0]).toMatchObject({ reason: 'requirements', timeSeconds: 1.1 });
    expect(challenge.snapshot).toMatchObject({ phase: 'complete', status: 'lost', attackIndex: 1 });
  });

  it('crosses phase boundaries without a one-step delay under fixed-step accumulation', () => {
    const challenge = new DodgeChallenge(oneAttack, timing);

    for (let i = 0; i < 30; i += 1) challenge.advance(1 / 60, 0);
    expect(challenge.snapshot.phase).toBe('active');
    expect(challenge.snapshot.timeSeconds).toBeCloseTo(0.5, 10);

    for (let i = 0; i < 24; i += 1) challenge.advance(1 / 60, 0);
    expect(challenge.snapshot).toMatchObject({ phase: 'resolved', resolvedAttacks: 1 });
    expect(challenge.snapshot.timeSeconds).toBeCloseTo(0.9, 10);
  });

  it('avoids the blow with a correct lane entered during the telegraph', () => {
    const challenge = new DodgeChallenge(oneAttack, { ...timing, maxHits: 0 });

    challenge.advance(0.2, 0);
    challenge.advance(0, -1);
    const crossingEvents = challenge.advance(0.7, -1);

    expect(crossingEvents.map((event) => event.kind)).toEqual(['attack-active', 'attack-resolved']);
    const resolved = resolvedFrom(crossingEvents);
    expect(resolved).toMatchObject({ outcome: 'correct', reactionSeconds: 0.2, points: 100, dodges: 1, hits: 0 });
    expect(challenge.snapshot).toMatchObject({
      score: 100,
      dodges: 1,
      correctDodges: 1,
      earlyDodges: 0,
      hits: 0,
      status: 'active',
    });
  });

  it('counts occupation of the safe lane at the telegraph start as an early dodge', () => {
    const centerSafeAttack = [{ attackLane: -1, safeLane: 0 }] as const;
    const challenge = new DodgeChallenge(centerSafeAttack, { ...timing, targetScore: 40, maxHits: 0 });

    challenge.advance(0.5, 0);
    const events = challenge.advance(0.4, 0);

    const resolved = resolvedFrom(events);
    expect(resolved).toMatchObject({ outcome: 'early', reactionSeconds: 0, points: 40, dodges: 1, hits: 0 });
    expect(challenge.snapshot).toMatchObject({ correctDodges: 0, earlyDodges: 1, score: 40 });
  });

  it('treats entering the safe lane exactly at the active start as correct', () => {
    const challenge = new DodgeChallenge(oneAttack, { ...timing, maxHits: 0 });

    challenge.advance(0.5, 0);
    challenge.advance(0, -1);
    const events = challenge.advance(0.4, -1);

    expect(resolvedFrom(events)).toMatchObject({ outcome: 'correct', reactionSeconds: 0.5, points: 100 });
  });

  it('distinguishes a late reaction from never leaving the threatened lane', () => {
    const late = new DodgeChallenge(oneAttack, timing);
    late.advance(0.5, 0);
    late.advance(0.1, 0);
    late.advance(0, -1);
    const lateEvents = late.advance(0.3, -1);

    const lateResolved = resolvedFrom(lateEvents);
    expect(lateResolved).toMatchObject({ outcome: 'late', reactionSeconds: 0.6, points: 0, dodges: 0, hits: 1 });
    expect(late.snapshot).toMatchObject({ hits: 1, lateHits: 1, correctDodges: 0, score: 0 });

    const cleanHit = new DodgeChallenge(oneAttack, timing);
    cleanHit.advance(0.5, 0);
    const hitEvents = cleanHit.advance(0.4, 0);
    expect(resolvedFrom(hitEvents)).toMatchObject({ outcome: 'hit', reactionSeconds: undefined, hits: 1 });
    expect(cleanHit.snapshot.lateHits).toBe(0);
  });

  it('loses immediately when the hit limit is exceeded and then freezes', () => {
    const challenge = new DodgeChallenge(oneAttack, { ...timing, maxHits: 0 });

    challenge.advance(0.5, 0);
    const events = challenge.advance(0.4, 0);

    expect(events.map((event) => event.kind)).toEqual(['attack-resolved', 'lost']);
    expect(events.at(-1)).toMatchObject({ reason: 'hit-limit', timeSeconds: 0.9, hits: 1 });
    expect(challenge.snapshot).toMatchObject({ status: 'lost', phase: 'complete', timeSeconds: 0.9 });
    expect(challenge.advance(1, -1)).toEqual([]);
    expect(challenge.snapshot.timeSeconds).toBe(0.9);
  });

  it('telegraphs the next configured attack after the resolved phase', () => {
    const twoAttacks = [
      { attackLane: 0, safeLane: -1 },
      { attackLane: -1, safeLane: 1 },
    ] as const;
    const challenge = new DodgeChallenge(twoAttacks, { ...timing, requiredDodges: 2, targetScore: 200, maxHits: 0 });

    challenge.advance(0.2, 0);
    challenge.advance(0, -1);
    challenge.advance(0.7, -1);
    const nextTelegraph = challenge.advance(0.2, 0);

    expect(nextTelegraph).toEqual([
      { kind: 'attack-telegraph', timeSeconds: 1.1, attackIndex: 1, attackLane: -1, safeLane: 1 },
    ]);
    expect(challenge.snapshot).toMatchObject({ phase: 'telegraph', attackIndex: 1, timeSeconds: 1.1 });
  });

  it('wins only when the sequence completes with enough score, dodges and survival', () => {
    const twoAttacks = [
      { attackLane: 0, safeLane: -1 },
      { attackLane: -1, safeLane: 1 },
    ] as const;
    const challenge = new DodgeChallenge(twoAttacks, { ...timing, requiredDodges: 2, targetScore: 200, maxHits: 0 });

    challenge.advance(0.2, 0);
    challenge.advance(0, -1);
    const firstResolution = challenge.advance(0.7, -1);
    expect(resolvedFrom(firstResolution)).toMatchObject({ outcome: 'correct', reactionSeconds: 0.2 });

    challenge.advance(0.2, 0); // first resolved phase ends at 1.1; attack 1 starts there
    challenge.advance(0.2, 0); // stay outside the safe lane until 1.3
    challenge.advance(0, 1); // enter it at 1.3, after the second telegraph started
    const secondResolution = challenge.advance(0.7, 1);
    const secondResolved = resolvedFrom(secondResolution);
    expect(secondResolved.outcome).toBe('correct');
    expect(secondResolved.reactionSeconds).toBeCloseTo(0.2, 10);
    expect(challenge.snapshot.status).toBe('active');

    const finalEvents = challenge.advance(0.2, 1);
    expect(finalEvents.map((event) => event.kind)).toEqual(['won']);
    expect(finalEvents[0]).toMatchObject({ timeSeconds: 2.2, score: 200, dodges: 2, correctDodges: 2, hits: 0 });
    expect(challenge.snapshot).toMatchObject({ status: 'won', phase: 'complete', attackIndex: 2, timeSeconds: 2.2 });
  });

  it('loses at sequence completion when the score requirement is not met', () => {
    const centerSafeAttack = [{ attackLane: -1, safeLane: 0 }] as const;
    const challenge = new DodgeChallenge(centerSafeAttack, { ...timing, targetScore: 100, maxHits: 0 });

    challenge.advance(0.5, 0);
    const resolvedEvents = challenge.advance(0.4, 0);
    expect(resolvedFrom(resolvedEvents).outcome).toBe('early');
    expect(challenge.snapshot.score).toBe(40);

    const finalEvents = challenge.advance(0.2, 0);
    expect(finalEvents.map((event) => event.kind)).toEqual(['lost']);
    expect(finalEvents[0]).toMatchObject({ reason: 'requirements', score: 40, dodges: 1, hits: 0 });
  });

  it('rejects invalid lanes and impossible dodge requirements deterministically', () => {
    expect(() => new DodgeChallenge([{ attackLane: 0, safeLane: 0 }], timing)).toThrow(RangeError);
    expect(() => new DodgeChallenge(oneAttack, { ...timing, requiredDodges: 2 })).toThrow(RangeError);

    const challenge = new DodgeChallenge(oneAttack, timing);
    expect(() => challenge.advance(-0.1, 0)).toThrow(RangeError);
    expect(() => challenge.advance(0.1, 2 as LaneZone)).toThrow(RangeError);
  });

  it('uses a non-empty default telegraphed sequence', () => {
    const challenge = new DodgeChallenge();

    expect(DEFAULT_DODGE_SEQUENCE.length).toBeGreaterThan(0);
    expect(challenge.snapshot).toMatchObject({ status: 'active', phase: 'telegraph', attackIndex: 0 });
    expect(challenge.snapshot.currentAttack).toEqual(DEFAULT_DODGE_SEQUENCE[0]);
  });
});
