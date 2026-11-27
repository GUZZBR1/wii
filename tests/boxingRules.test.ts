import { describe, expect, it } from 'vitest';
import {
  applyLatePunch,
  applyOpponentPunch,
  applyPlayerPunch,
  type BoxingState,
  createBoxing,
  MAX_HP,
  OPPONENT_DAMAGE,
  PLAYER_MAX_DAMAGE,
  PLAYER_MIN_DAMAGE,
  ROUND_COUNT,
  ROUND_MS,
  tickRound,
} from '../src/games/boxing/boxingRules';

const lastRound = (hp: Partial<BoxingState> = {}): BoxingState => ({
  ...createBoxing(),
  round: ROUND_COUNT,
  roundMsLeft: 10,
  ...hp,
});

describe('boxing rules', () => {
  it('starts at full HP in round 1 with no winner', () => {
    expect(createBoxing()).toEqual({ playerHp: 100, opponentHp: 100, round: 1, roundMsLeft: 60_000 });
    expect(createBoxing().winner).toBeUndefined();
    expect(ROUND_COUNT).toBe(3);
  });

  it('scales open punches with power and leaves the input untouched', () => {
    const state = createBoxing();
    const weak = applyPlayerPunch(state, 0, 'open');
    const strong = applyPlayerPunch(state, 1, 'open');
    expect(weak.damage).toBe(PLAYER_MIN_DAMAGE);
    expect(strong.damage).toBe(PLAYER_MAX_DAMAGE);
    expect(strong.state.opponentHp).toBe(MAX_HP - PLAYER_MAX_DAMAGE);
    expect(strong.state.playerHp).toBe(MAX_HP);
    expect(strong.ko).toBe(false);
    expect(state).toEqual(createBoxing());
    expect(Object.isFrozen(strong.state)).toBe(true);
  });

  it('clamps power and treats non-finite power as the weakest punch', () => {
    const damage = (power: number) => applyPlayerPunch(createBoxing(), power, 'open').damage;
    expect(damage(-3)).toBe(PLAYER_MIN_DAMAGE);
    expect(damage(7)).toBe(PLAYER_MAX_DAMAGE);
    expect(damage(Number.NaN)).toBe(PLAYER_MIN_DAMAGE);
    expect(damage(Number.POSITIVE_INFINITY)).toBe(PLAYER_MIN_DAMAGE);
  });

  it('blocks guarded punches and dodged opponent punches', () => {
    const state = createBoxing();
    expect(applyPlayerPunch(state, 1, 'guard')).toEqual({ state, damage: 0, ko: false });
    expect(applyOpponentPunch(state, { dodged: true })).toEqual({ state, damage: 0, ko: false });
    const hit = applyOpponentPunch(state, { dodged: false });
    expect(hit.damage).toBe(OPPONENT_DAMAGE);
    expect(hit.state.playerHp).toBe(MAX_HP - OPPONENT_DAMAGE);
    expect(hit.state.opponentHp).toBe(MAX_HP);
  });

  it('ends the match on a KO by either side, reporting only the HP removed', () => {
    const player = applyPlayerPunch({ ...createBoxing(), opponentHp: 3 }, 1, 'open');
    expect(player).toMatchObject({ damage: 3, ko: true, state: { opponentHp: 0, winner: 'player' } });
    const opponent = applyOpponentPunch({ ...createBoxing(), playerHp: OPPONENT_DAMAGE }, { dodged: false });
    expect(opponent).toMatchObject({ ko: true, state: { playerHp: 0, winner: 'opponent' } });
  });

  it('ignores everything once there is a winner', () => {
    const over = applyPlayerPunch({ ...createBoxing(), opponentHp: 1 }, 1, 'open').state;
    expect(applyPlayerPunch(over, 1, 'open')).toEqual({ state: over, damage: 0, ko: false });
    expect(applyOpponentPunch(over, { dodged: false })).toEqual({ state: over, damage: 0, ko: false });
    expect(tickRound(over, ROUND_MS)).toEqual({ state: over, roundEnded: false, matchEnded: false });
  });

  it('counts the round clock down and ignores invalid deltas', () => {
    const state = createBoxing();
    expect(tickRound(state, 1_000).state.roundMsLeft).toBe(ROUND_MS - 1_000);
    for (const dt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tickRound(state, dt).state).toBe(state);
    }
  });

  it('moves to the next round carrying HP and dropping overshoot', () => {
    const hurt = applyOpponentPunch(createBoxing(), { dodged: false }).state;
    const result = tickRound(hurt, ROUND_MS * 2);
    expect(result).toMatchObject({ roundEnded: true, matchEnded: false });
    expect(result.state).toEqual({ ...hurt, round: 2, roundMsLeft: ROUND_MS });
  });

  it('decides on HP when the last round expires', () => {
    const finish = (hp: Partial<BoxingState>) => tickRound(lastRound(hp), 10);
    expect(finish({ opponentHp: 40 })).toMatchObject({
      roundEnded: true,
      matchEnded: true,
      state: { winner: 'player', round: ROUND_COUNT, roundMsLeft: 0 },
    });
    expect(finish({ playerHp: 40 }).state.winner).toBe('opponent');
    expect(finish({}).state.winner).toBe('draw');
  });
});

describe('applyLatePunch', () => {
  const decided = { playerHp: 90, opponentHp: 100, round: 3, roundMsLeft: 0, winner: 'opponent' } as const;

  it('re-decides a match the clock had decided', () => {
    expect(applyLatePunch(decided, 1, 'open').state).toMatchObject({ opponentHp: 88, winner: 'player' });
    expect(applyLatePunch({ ...decided, playerHp: 88 }, 1, 'open').state.winner).toBe('draw');
    expect(applyLatePunch(decided, 1, 'guard').state.winner).toBe('opponent');
  });

  it('never reopens a knockout, even one landed as the clock ran out', () => {
    const knockout = { ...decided, playerHp: 0 };
    expect(applyLatePunch(knockout, 1, 'open')).toMatchObject({ damage: 0, state: knockout });
  });
});

describe('counter and guard', () => {
  it('multiplies a counter by 1.5 and takes it through the guard', () => {
    expect(applyPlayerPunch(createBoxing(), 1, 'open', true).damage).toBe(18);
    expect(applyPlayerPunch(createBoxing(), 1, 'guard', true).damage).toBe(18);
    expect(applyPlayerPunch(createBoxing(), 0, 'guard', true).damage).toBe(6);
  });

  it('keeps the counter on a punch confirmed after the bell', () => {
    const decided = { playerHp: 90, opponentHp: 100, round: 3, roundMsLeft: 0, winner: 'opponent' } as const;
    expect(applyLatePunch(decided, 1, 'guard', true).damage).toBe(18);
  });

  it('lets a tenth of a guarded punch through, and nothing of a dodged one', () => {
    expect(applyOpponentPunch(createBoxing(), { dodged: false, guarded: true }).damage).toBe(1);
    expect(applyOpponentPunch(createBoxing(), { dodged: true, guarded: true }).damage).toBe(0);
    expect(applyOpponentPunch(createBoxing(), { dodged: false }).damage).toBe(10);
  });
});
