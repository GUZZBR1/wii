import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Hand, SportActionEvent } from '../cv/protocol';
import type { AthleticsHudState } from '../games/athletics/AthleticsGame';
import type { Goal } from '../games/athletics/race';
import type { ProceduralAudio } from '../games/audio';
import type { BoxingScoreboard } from '../games/boxing/BoxingGame';
import { BOXING_MODES, type BoxingMode } from '../games/boxing/boxingModes';
import { type BoxingSetup, DEFAULT_BOXING_SETUP } from '../games/boxing/boxingSetup';
import { OPPONENT_PROFILES, type OpponentProfileId } from '../games/boxing/opponentProfiles';
import type { ArmMotion } from '../kinematics/armMotion';
import type { SwingTracking } from '../kinematics/actionPipeline';
import { type GestureSample, RestartGesture } from '../games/core/restartGesture';
import type { GameHudState as CoreHudState } from '../games/core/hud';
import type { GameHudState as TrackHudState } from '../games/track/TrackGame';

type GameHudState = Omit<TrackHudState, 'feedback'> & {
  tennis?: CoreHudState['tennis'];
  feedback?: TrackHudState['feedback'] | CoreHudState['feedback'];
  finished?: AthleticsHudState['finished'];
  framing?: boolean;
  energy?: AthleticsHudState['energy'];
  runners?: AthleticsHudState['runners'];
  boxing?: BoxingScoreboard;
  learn?: { progress01: number; step: number; steps: number };
};
import { BOXING_TRAINING_CONTROLS, HUD_TEXT } from './hudText';
import { forwardKeyDown } from './keys';
import { useLang, type Lang } from '../i18n';
import { placeLabel } from '../gameText';

const GAME_ERROR_TEXT: Readonly<Record<string, { pt: string; en: string }>> = {
  'Canvas 2D indisponível': { pt: 'Canvas 2D indisponível', en: '2D canvas is unavailable' },
  '2D canvas unavailable': { pt: 'Canvas 2D indisponível', en: '2D canvas is unavailable' },
  'Geometrias incompatíveis no ringue de boxe': { pt: 'Geometrias incompatíveis no ringue de boxe', en: 'Incompatible geometry in the boxing ring' },
  'WebGL indisponível': { pt: 'WebGL indisponível', en: 'WebGL is unavailable' },
  'WebGL is unavailable': { pt: 'WebGL indisponível', en: 'WebGL is unavailable' },
};

function gameErrorMessage(error: unknown, language: Lang): string {
  if (!(error instanceof Error)) return language === 'pt' ? 'WebGL indisponível' : 'WebGL is unavailable';
  return GAME_ERROR_TEXT[error.message]?.[language] ?? error.message;
}

export type Sport = 'track' | 'athletics' | 'tennis' | 'boxing';
export interface GameEngineHandle { onAction(event: SportActionEvent): void; onKey(key: string): void; setLanguage?(lang: Lang): void; setTracking?(tracking: string): void; setPoseTracking?(tracking: string, atMs: number): void; setLaneZone?(zone: -1 | 0 | 1 | undefined): void; setEffort?(effort: number, sampleAtMs?: number | null): void; setHandsRaised?(raised: boolean, atMs: number | null): void; setTossHand?(hand: Hand | undefined, atMs: number): void; setArmMotions?(motions: readonly ArmMotion[]): void; setSwingTracking?(tracking: SwingTracking): void; setFraming?(advice: string | undefined, handsHidden?: boolean): void; resetLaneZone?(): void; setDodgeZone?(zone: -1 | 0 | 1 | undefined, atMs?: number | null): void; setGuard?(guard: boolean | undefined, atMs?: number | null): void; setDuck?(ducked: boolean | undefined, atMs?: number | null): void; setHipsHidden?(hidden: boolean, atMs: number): void; setDepthMove?(move: -1 | 0 | 1 | undefined, atMs?: number | null): void; setDepthSpeed?(speed: number | undefined, atMs?: number | null): void; setLateralDash?(dash: -1 | 0 | 1 | undefined): void; onKeyUp?(key: string): void; dispose(): void }

export interface IronManResult {
  sport: 'athletics' | 'tennis' | 'boxing';
  detail: string;
}

interface Props {
  /** Boxing choice made before the match; the in-game selector reports its changes back. */
  boxingSetup?: BoxingSetup;
  onBoxingSetup?: (setup: BoxingSetup) => void;
  sport: Sport;
  ironMan?: { onComplete: (result: IronManResult) => void };
  onEngine: (engine: GameEngineHandle | null) => void;
  tracking: string;
  audio?: ProceduralAudio;
  /** Race distance for athletics, picked in the menu. */
  goal?: Goal;
  /** The player is holding their arms crossed; on a result screen that leads back to the menu. */
  crossedPose?: RefObject<GestureSample | null>;
  onExit?: () => void;
  /** Receives the stroke length the tennis warm-up settles on. */
  onStrokeTravel?: (travel: number) => void;
  onPunchTravel?: (travel: number) => void;
  initialRacketHand?: Hand;
  onRacketHand?: (hand: Hand) => void;
}

/** Restarting remounts the whole run, so a new game starts from a clean engine and canvas. */
export function GameCanvas(props: Props) {
  const [run, setRun] = useState(0);
  const racketHandRef = useRef<Hand>('right');
  const rememberRacketHand = useCallback((hand: Hand) => { racketHandRef.current = hand; }, []);
  const [boxing, setBoxing] = useState(props.boxingSetup ?? DEFAULT_BOXING_SETUP);
  const { mode: boxingMode, opponent: boxingOpponent } = boxing;
  const changeBoxing = (next: BoxingSetup) => { setBoxing(next); props.onBoxingSetup?.(next); };
  // The warm-up opens the first match only; playing again goes straight to the court.
  return <GameRun
    key={`${run}-${boxingMode}-${boxingOpponent}`}
    {...props}
    onBoxingMode={(mode) => changeBoxing({ ...boxing, mode })}
    boxingMode={props.ironMan ? 'fight' : boxingMode}
    boxingOpponent={boxingOpponent}
    onBoxingOpponent={(opponent) => changeBoxing({ mode: 'fight', opponent })}
    tutorial={run === 0}
    initialRacketHand={racketHandRef.current}
    onRacketHand={rememberRacketHand}
    onRestart={() => setRun((value) => value + 1)}
  />;
}

function GameRun({ sport, ironMan, onEngine, tracking, audio, goal = 100, crossedPose, onExit, onStrokeTravel, onPunchTravel, initialRacketHand, onRacketHand, tutorial, onRestart, boxingMode, onBoxingMode, boxingOpponent, onBoxingOpponent }: Props & {
  onRestart: () => void;
  tutorial: boolean;
  boxingMode: BoxingMode;
  onBoxingMode: (mode: BoxingMode) => void;
  boxingOpponent: OpponentProfileId;
  onBoxingOpponent: (opponent: OpponentProfileId) => void;
}) {
  const { lang, tr } = useLang();
  const languageRef = useRef(lang);
  languageRef.current = lang;
  const ironActive = Boolean(ironMan);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<GameHudState>(() => ({ score: 0, label: '00000', speed01: 0, status: tr('Pronto para jogar', 'Ready to play') }));
  const hudRef = useRef(setHud);
  hudRef.current = setHud;
  const engineRef = useRef<GameEngineHandle | null>(null);
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine?.setPoseTracking) engine?.setTracking?.(tracking);
  }, [tracking]);

  // The 100 m asks for a new run with the body: both hands held up.
  const restartByBody = Math.max(hud.finished?.restart01 ?? 0, hud.tennis?.winner ? hud.tennis.restart01 : 0) >= 1;
  const restartRef = useRef(onRestart);
  restartRef.current = onRestart;
  useEffect(() => { if (restartByBody && !ironMan) restartRef.current(); }, [restartByBody, ironMan]);

  // Same rules as playing again: only after the result has been seen, and from arms that were down.
  const over = Boolean(hud.finished || hud.tennis?.winner);
  const travelRef = useRef(onStrokeTravel);
  travelRef.current = onStrokeTravel;
  const punchTravelRef = useRef(onPunchTravel);
  punchTravelRef.current = onPunchTravel;
  const boxingModeRef = useRef(onBoxingMode);
  boxingModeRef.current = onBoxingMode;
  const racketHandRef = useRef(initialRacketHand);
  racketHandRef.current = initialRacketHand;
  const racketHandCallbackRef = useRef(onRacketHand);
  racketHandCallbackRef.current = onRacketHand;
  const tutorialRef = useRef(tutorial);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [leave01, setLeave01] = useState(0);
  useEffect(() => {
    if (!over || ironMan) { setLeave01(0); return; }
    const gesture = new RestartGesture();
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const pose = crossedPose?.current;
      gesture.setHandsRaised(pose?.active ?? false, pose?.atMs ?? null);
      gesture.step((now - last) / 1000, now);
      last = now;
      setLeave01(gesture.progress01);
      if (gesture.progress01 >= 1) {
        window.clearInterval(timer);
        exitRef.current?.();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [over, crossedPose, ironMan]);
  const [countdown, setCountdown] = useState(10);
  const completedRef = useRef(ironMan?.onComplete);
  completedRef.current = ironMan?.onComplete;
  const ironResult: IronManResult | undefined = !ironMan ? undefined
    : sport === 'athletics' && hud.finished ? {
      sport: 'athletics',
      detail: `${hud.finished.detail} · ${placeLabel(hud.finished.standings.findIndex((runner) => runner.you) + 1, lang)}`,
    } : sport === 'tennis' && hud.tennis?.winner ? {
      sport: 'tennis',
      detail: `${hud.tennis.winner === 'player' ? tr('Vitória', 'Win') : tr('Derrota', 'Loss')} · ${hud.tennis.games.player} × ${hud.tennis.games.opponent} ${tr('games', 'games')}`,
    } : sport === 'boxing' && hud.boxing?.winner ? {
      sport: 'boxing',
      detail: hud.boxing.winner === 'player' ? tr('Vitória', 'Win') : hud.boxing.winner === 'draw' ? tr('Empate', 'Draw') : tr('Derrota', 'Loss'),
    } : undefined;
  // Capture the first terminal result, then clean up both timers if the player exits.
  const resultRef = useRef<IronManResult | undefined>(undefined);
  if (ironResult && !resultRef.current) resultRef.current = ironResult;
  const displayedResult = resultRef.current;
  const hasIronResult = Boolean(displayedResult);
  useEffect(() => {
    if (!hasIronResult) return;
    setCountdown(10);
    const interval = window.setInterval(() => setCountdown((seconds) => Math.max(0, seconds - 1)), 1000);
    const timeout = window.setTimeout(() => {
      if (resultRef.current) completedRef.current?.(resultRef.current);
    }, 10_000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [hasIronResult]);
  const leaveBar = <div className="restart-gesture"><b style={{ width: `${leave01 * 100}%` }} /><span>{tr('Cruze os braços em X para voltar ao menu', 'Cross your arms into an X to return to the menu')}</span></div>;

  useEffect(() => { engineRef.current?.setLanguage?.(lang); }, [lang]);

  useEffect(() => {
    if (!canvasRef.current) return;
    let game: GameEngineHandle | undefined;
    let disposed = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea, a'))) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) event.preventDefault();
      if (!forwardKeyDown(event.key, event.repeat)) return;
      void audio?.unlock();
      game?.onKey(event.key);
    };
    const keyup = (event: KeyboardEvent) => game?.onKeyUp?.(event.key);
    // A key released while the window is unfocused never reports it.
    const blur = () => { for (const key of ['ArrowDown', 'q', 'w', 'a', 's', 'd']) game?.onKeyUp?.(key); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    const mount = async () => {
      try {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const updateHud = (state: GameHudState) => hudRef.current(state);
        const language = languageRef.current;
        const engine: GameEngineHandle = sport === 'track'
          ? new (await import('../games/track/TrackGame')).TrackGame(canvas, updateHud, language)
          : sport === 'athletics'
            ? new (await import('../games/athletics/AthleticsGame')).AthleticsGame(canvas, updateHud, audio, goal, language)
            : sport === 'tennis'
              ? new (await import('../games/tennis/TennisGame')).TennisGame(canvas, updateHud, audio, {
                tutorial: tutorialRef.current,
                language,
                initialRacketHand: racketHandRef.current,
                onRacketHand: (hand) => racketHandCallbackRef.current?.(hand),
                onStrokeTravel: (travel) => travelRef.current?.(travel),
              })
              : new (await import('../games/boxing/BoxingGame')).BoxingGame(canvas, updateHud, audio, undefined, {
                mode: boxingMode,
                language,
                holdResult: ironActive,
                opponent: boxingOpponent,
                motionRng: Math.random,
                onPunchTravel: (travel) => punchTravelRef.current?.(travel),
                onTutorialDone: () => boxingModeRef.current('fight'),
              });
        engine.setLanguage?.(languageRef.current);
        if (disposed) { engine.dispose(); return; }
        game = engine;
        engineRef.current = engine;
        engine.setTracking?.(trackingRef.current);
        onEngine(engine);
      } catch (error) {
        if (!disposed) hudRef.current({ score: 0, label: '—', speed01: 0, status: gameErrorMessage(error, languageRef.current) });
      }
    };
    void mount();
    return () => {
      disposed = true;
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      game?.dispose();
      engineRef.current = null;
      onEngine(null);
    };
  }, [sport, onEngine, audio, goal, boxingMode, boxingOpponent, ironActive]);

  const boxingControls = hud.boxing?.training ? BOXING_TRAINING_CONTROLS[hud.boxing.training.kind][lang] : HUD_TEXT.boxing.controls[lang];

  return <div className={`game-viewport ${sport}${hud.framing ? ' is-framing' : ''}`}>
    <canvas ref={canvasRef} />
    {hud.tennis ? <table className="tennis-score" aria-label={tr('Placar do tênis', 'Tennis score')}>
      <thead><tr><th scope="col">{tr('Tênis', 'Tennis')}</th><th scope="col">Games</th><th scope="col">{tr('Pontos', 'Points')}</th></tr></thead>
      <tbody>{(['player', 'opponent'] as const).map((side) => (
        <tr key={side}>
          <th scope="row">{side === 'player' ? tr('Você', 'You') : tr('Adversário', 'Opponent')}{hud.tennis?.server === side && <span className="tennis-server" role="img" aria-label={hud.tennis.secondServe ? tr('Segundo saque', 'Second serve') : tr('Sacando', 'Serving')}>●</span>}</th>
          <td>{hud.tennis?.games[side]}</td>
          <td>{hud.tennis?.points[side]}</td>
        </tr>
      ))}</tbody>
    </table> : sport === 'boxing' ? hud.boxing && <BoxingHud {...hud.boxing} /> : sport !== 'tennis' && <div className="game-hud"><div><span>{HUD_TEXT[sport].score[lang]}</span><strong>{hud.label}</strong>{(hud.combo ?? 0) > 1 && <em>COMBO {hud.combo}</em>}</div><div className="game-speed"><span>{HUD_TEXT[sport].speed[lang]}</span><strong>{Math.round(hud.speed01 * 100)}%</strong></div></div>}
    {hud.tennis?.winner && !ironMan && <section className="game-over tennis-result" aria-label={tr('Resultado da partida', 'Match result')}>
      <h2>{hud.tennis.winner === 'player' ? tr('Você venceu!', 'You win!') : tr('Adversário venceu', 'Opponent wins')}</h2>
      <p>{hud.tennis.games.player} × {hud.tennis.games.opponent} {tr('games', 'games')}</p>
      <div className="restart-gesture"><b style={{ width: `${hud.tennis.restart01 * 100}%` }} /><span>{tr('Levante as duas mãos para jogar de novo', 'Raise both hands to play again')}</span></div>
      {leaveBar}
      <button type="button" onClick={onRestart}>{tr('Jogar de novo', 'Play again')}</button>
    </section>}
    {sport === 'boxing' && !ironMan && hud.boxing?.selectionOpen && <fieldset className="game-goals boxing-setup" aria-label={tr('Configuração do boxe', 'Boxing settings')}>
      <div className="boxing-select-row">
        <span>{tr('MODO', 'MODE')}</span>
        {BOXING_MODES.map((mode) => <button key={mode.id} type="button" className="dock-btn" aria-pressed={mode.id === boxingMode} onClick={() => onBoxingMode(mode.id)}>{lang === 'pt' ? mode.label : mode.labelEn}</button>)}
      </div>
      {boxingMode === 'fight' && <div className="boxing-select-row">
        <span>{tr('ADVERSÁRIO', 'OPPONENT')}</span>
        {OPPONENT_PROFILES.map((profile) => <button key={profile.id} type="button" className="dock-btn" aria-pressed={profile.id === boxingOpponent} onClick={() => onBoxingOpponent(profile.id)}>{lang === 'pt' ? profile.label : profile.labelEn}</button>)}
      </div>}
    </fieldset>}
    {hud.feedback && <div key={hud.feedback.id} className={`game-feedback ${hud.feedback.kind}`}>
      <span>{hud.feedback.text}</span>
    </div>}
    {hud.banner && <div className="game-banner" role="status"><strong>{hud.banner.title}</strong>{hud.banner.detail && <span>{hud.banner.detail}</span>}</div>}
    {hud.learn && <div className="learn-ring" role="progressbar" aria-label={tr(`Etapa ${hud.learn.step} de ${hud.learn.steps}`, `Step ${hud.learn.step} of ${hud.learn.steps}`)} aria-valuenow={Math.round(hud.learn.progress01 * 100)} aria-valuemin={0} aria-valuemax={100} style={{ background: `conic-gradient(#7be595 ${hud.learn.progress01 * 360}deg, #ffffff40 0deg)` }}>
      <span>{hud.learn.step}/{hud.learn.steps}</span>
    </div>}
    {hud.runners && <div className="race-progress">{hud.runners.map((runner) => (
      <div key={runner.name} className={runner.you ? 'you' : ''}><span>{runner.name}</span><i><b style={{ width: `${runner.progress01 * 100}%` }} /></i></div>
    ))}</div>}
    {hud.energy && <div className="energy">
      {hud.energy.coaching && <strong role="status">{hud.energy.coaching}</strong>}
      <span>{hud.energy.label}</span>
      <i><b style={{ width: `${hud.energy.value01 * 100}%` }} /></i>
    </div>}
    {hud.finished && !ironMan && <div className="game-over" role="dialog" aria-label={tr('Fim da prova', 'Race complete')}>
      <h2>{hud.finished.title}</h2>
      <p><strong>{hud.finished.detail}</strong></p>
      {!hud.finished.standingsFinal && <p>{tr('Classificação em andamento · tempos estimados podem mudar', 'The race is still in progress · estimated times may change')}</p>}
      <ol>{hud.finished.standings.map((runner) => (
        <li key={runner.name} className={runner.you ? 'current' : ''}><span>{placeLabel(runner.place, lang)} {runner.name}</span><span>{runner.time}{runner.status === 'estimated' ? tr(' (estimado)', ' (estimated)') : ''}</span></li>
      ))}</ol>
      <div className="restart-gesture"><b style={{ width: `${hud.finished.restart01 * 100}%` }} /><span>{tr('Levante as duas mãos para correr de novo', 'Raise both hands to race again')}</span></div>
      {leaveBar}
      <button type="button" onClick={onRestart}>{tr('Correr de novo', 'Race again')}</button>
    </div>}
    {displayedResult && <section className="game-over iron-result" role="status">
      <h2>{tr('Etapa concluída!', 'Stage complete!')}</h2>
      <p>{displayedResult.detail}</p>
      <p>{sport === 'boxing' ? tr('Resumo', 'Summary') : tr('Próxima modalidade', 'Next sport')} {tr('em', 'in')} {countdown} s</p>
    </section>}
    {hud.result && <div className="game-over" role="dialog" aria-label={tr('Fim de corrida', 'Run over')}>
      <h2>{tr('Você perdeu!', 'You lost!')}</h2>
      <p>{tr('Sua melhor marca nesta corrida:', 'Your best score this run:')} <strong>{hud.result.points}</strong> {tr('pontos', 'points')}</p>
      <h3>{tr('Seu ranking', 'Your ranking')}</h3>
      <ol>{hud.result.ranking.map((points, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the place is the row's identity and scores may repeat
        <li key={index} className={hud.result?.position === index + 1 ? 'current' : ''}><span>{placeLabel(index + 1, lang)}</span><span>{points}</span></li>
      ))}</ol>
      <button type="button" ref={(button) => button?.focus()} onClick={onRestart}>{tr('Jogar de novo', 'Play again')}</button>
    </div>}
    <div className="game-ready"><i className={tracking.startsWith('TRACKING') ? 'ready' : ''} />{hud.status}</div>
    <div className="game-controls">{sport === 'boxing' ? boxingControls : HUD_TEXT[sport].controls[lang]}</div>
  </div>;
}

function BoxingHud({ playerHp, opponentHp, maxHp, round, rounds, secondsLeft, training, streak = 0 }: BoxingScoreboard) {
  const { tr } = useLang();
  if (training) {
    const card = (label: string, value: string | number) => <div className="boxing-card boxing-training-card">
      <span className="boxing-label">{label}</span>
      <strong className="boxing-value">{value}</strong>
    </div>;
    if (training.kind === 'bag') {
      return <div className="boxing-hud training">
        {card(tr('PRECISÃO', 'ACCURACY'), `${Math.round((training.precision01 ?? 0) * 100)}%`)}
        {card('COMBO', `${training.combo ?? 0}x`)}
        {card(tr('PONTOS', 'POINTS'), training.score)}
      </div>;
    }
    return <div className="boxing-hud training">
      {card(tr('GOLPES RESTANTES', 'PUNCHES LEFT'), training.attacksRemaining ?? 0)}
      {card(tr('ERROS RESTANTES', 'HITS LEFT'), training.hitsRemaining ?? 0)}
      {card(tr('PONTOS', 'POINTS'), training.score)}
    </div>;
  }

  const fighter = (name: string, hp: number, side: 'player' | 'opponent') => <div className={`boxing-card boxing-fighter ${side}`}>
    <p className="boxing-name"><span className="boxing-label">{name}</span><strong className="boxing-value">{hp}</strong></p>
    <div className="boxing-bar" aria-hidden="true"><div className="boxing-fill" style={{ width: `${(100 * hp) / maxHp}%` }} /></div>
  </div>;
  return <div className="boxing-hud">
    {fighter(tr('VOCÊ', 'YOU'), playerHp, 'player')}
    <div className="boxing-card boxing-clock">
      <span className="boxing-label">{tr('ROUND', 'ROUND')} {round}/{rounds}</span>
      <strong className="boxing-value">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong>
    </div>
    {fighter('CPU', opponentHp, 'opponent')}
    {streak > 1 && <strong className="boxing-streak" role="status">COMBO {streak}</strong>}
  </div>;
}
