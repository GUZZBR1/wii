import { useEffect, useRef, useState } from 'react';
import type { Hand, SportActionEvent } from '../cv/protocol';
import type { AthleticsHudState } from '../games/athletics/AthleticsGame';
import type { Goal } from '../games/athletics/race';
import type { ProceduralAudio } from '../games/audio';
import { RestartGesture } from '../games/core/restartGesture';
import type { GameHudState as CoreHudState } from '../games/core/hud';
import type { GameHudState as TrackHudState } from '../games/track/TrackGame';

type GameHudState = Omit<TrackHudState, 'feedback'> & {
  tennis?: CoreHudState['tennis'];
  feedback?: TrackHudState['feedback'] | CoreHudState['feedback'];
  finished?: AthleticsHudState['finished'];
  framing?: boolean;
  energy?: AthleticsHudState['energy'];
  runners?: AthleticsHudState['runners'];
};
import { forwardKeyDown } from './keys';

export type Sport = 'track' | 'athletics' | 'tennis';
const HUD_TEXT: Record<Sport, { score: string; speed: string; controls: string }> = {
  track: { score: 'SCORE', speed: 'RITMO', controls: '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar' },
  athletics: { score: 'TEMPO', speed: 'INTENSIDADE', controls: 'corra no lugar, mexendo os braços' },
  tennis: { score: 'PONTOS', speed: 'MIRA', controls: 'raquetada no tempo da bola: cedo cruza, tarde vai reto' },
};
export interface GameEngineHandle { onAction(event: SportActionEvent): void; onKey(key: string): void; setTracking?(tracking: string): void; setLaneZone?(zone: -1 | 0 | 1 | undefined): void; setEffort?(effort01: number, sampleAtMs?: number | null): void; setHandsRaised?(raised: boolean): void; setTossHand?(hand: Hand | undefined): void; setFraming?(advice: string | undefined, handsHidden?: boolean): void; resetLaneZone?(): void; dispose(): void }

interface Props {
  sport: Sport;
  onEngine: (engine: GameEngineHandle | null) => void;
  tracking: string;
  audio?: ProceduralAudio;
  /** Race distance for athletics, picked in the menu. */
  goal?: Goal;
  /** The player is holding their arms crossed; on a result screen that leads back to the menu. */
  armsCrossed?: boolean;
  onExit?: () => void;
  /** Receives the stroke length the tennis warm-up settles on. */
  onStrokeTravel?: (travel: number) => void;
}

/** Restarting remounts the whole run, so a new game starts from a clean engine and canvas. */
export function GameCanvas(props: Props) {
  const [run, setRun] = useState(0);
  // The warm-up opens the first match only; playing again goes straight to the court.
  return <GameRun key={run} {...props} tutorial={run === 0} onRestart={() => setRun((value) => value + 1)} />;
}

function GameRun({ sport, onEngine, tracking, audio, goal = 100, armsCrossed = false, onExit, onStrokeTravel, tutorial, onRestart }: Props & { onRestart: () => void; tutorial: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<GameHudState>({ score: 0, label: '00000', speed01: 0, status: 'Pronto para jogar' });
  const hudRef = useRef(setHud);
  hudRef.current = setHud;
  const engineRef = useRef<GameEngineHandle | null>(null);
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;

  useEffect(() => { engineRef.current?.setTracking?.(tracking); }, [tracking]);

  // The 100 m asks for a new run with the body: both hands held up.
  const restartByBody = Math.max(hud.finished?.restart01 ?? 0, hud.tennis?.winner ? hud.tennis.restart01 : 0) >= 1;
  const restartRef = useRef(onRestart);
  restartRef.current = onRestart;
  useEffect(() => { if (restartByBody) restartRef.current(); }, [restartByBody]);

  // Same rules as playing again: only after the result has been seen, and from arms that were down.
  const over = Boolean(hud.finished || hud.tennis?.winner);
  const crossedRef = useRef(armsCrossed);
  crossedRef.current = armsCrossed;
  const travelRef = useRef(onStrokeTravel);
  travelRef.current = onStrokeTravel;
  const tutorialRef = useRef(tutorial);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [leave01, setLeave01] = useState(0);
  useEffect(() => {
    if (!over) { setLeave01(0); return; }
    const gesture = new RestartGesture();
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      gesture.setHandsRaised(crossedRef.current);
      gesture.step((now - last) / 1000);
      last = now;
      setLeave01(gesture.progress01);
      if (gesture.progress01 >= 1) {
        window.clearInterval(timer);
        exitRef.current?.();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [over]);
  const leaveBar = <div className="restart-gesture"><b style={{ width: `${leave01 * 100}%` }} /><span>Cruze os braços em X para voltar ao menu</span></div>;

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
    window.addEventListener('keydown', keydown);
    const mount = async () => {
      try {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const updateHud = (state: GameHudState) => hudRef.current(state);
        const engine: GameEngineHandle = sport === 'track'
          ? new (await import('../games/track/TrackGame')).TrackGame(canvas, updateHud)
          : sport === 'athletics'
            ? new (await import('../games/athletics/AthleticsGame')).AthleticsGame(canvas, updateHud, audio, goal)
            : new (await import('../games/tennis/TennisGame')).TennisGame(canvas, updateHud, audio, { tutorial: tutorialRef.current, onStrokeTravel: (travel) => travelRef.current?.(travel) });
        if (disposed) { engine.dispose(); return; }
        game = engine;
        engineRef.current = engine;
        engine.setTracking?.(trackingRef.current);
        onEngine(engine);
      } catch (error) {
        if (!disposed) hudRef.current({ score: 0, label: '—', speed01: 0, status: error instanceof Error ? error.message : 'WebGL indisponível' });
      }
    };
    void mount();
    return () => {
      disposed = true;
      window.removeEventListener('keydown', keydown);
      game?.dispose();
      engineRef.current = null;
      onEngine(null);
    };
  }, [sport, onEngine, audio, goal]);

  return <div className={`game-viewport ${sport}${hud.framing ? ' is-framing' : ''}`}>
    <canvas ref={canvasRef} />
    {hud.tennis ? <table className="tennis-score" aria-label="Placar do tênis">
      <thead><tr><th scope="col">Tênis</th><th scope="col">Games</th><th scope="col">Pontos</th></tr></thead>
      <tbody>{(['player', 'opponent'] as const).map((side) => (
        <tr key={side}>
          <th scope="row">{side === 'player' ? 'Você' : 'Adversário'}{hud.tennis?.server === side && <span className="tennis-server" role="img" aria-label={hud.tennis.secondServe ? 'Segundo saque' : 'Sacando'}>●</span>}</th>
          <td>{hud.tennis?.games[side]}</td>
          <td>{hud.tennis?.points[side]}</td>
        </tr>
      ))}</tbody>
    </table> : sport !== 'tennis' && <div className="game-hud"><div><span>{HUD_TEXT[sport].score}</span><strong>{hud.label}</strong>{(hud.combo ?? 0) > 1 && <em>COMBO {hud.combo}</em>}</div><div className="game-speed"><span>{HUD_TEXT[sport].speed}</span><strong>{Math.round(hud.speed01 * 100)}%</strong></div></div>}
    {hud.tennis?.winner && <section className="game-over tennis-result" aria-label="Resultado da partida">
      <h2>{hud.tennis.winner === 'player' ? 'Você venceu!' : 'Adversário venceu'}</h2>
      <p>{hud.tennis.games.player} × {hud.tennis.games.opponent} games</p>
      <div className="restart-gesture"><b style={{ width: `${hud.tennis.restart01 * 100}%` }} /><span>Levante as duas mãos para jogar de novo</span></div>
      {leaveBar}
      <button type="button" onClick={onRestart}>Jogar de novo</button>
    </section>}
    {hud.feedback && <div key={hud.feedback.id} className={`game-feedback ${('kind' in hud.feedback ? hud.feedback.kind : hud.feedback.tone)}`}>
      <span>{hud.feedback.text}</span>
    </div>}
    {hud.banner && <div className="game-banner" role="status"><strong>{hud.banner.title}</strong>{hud.banner.detail && <span>{hud.banner.detail}</span>}</div>}
    {hud.runners && <div className="race-progress">{hud.runners.map((runner) => (
      <div key={runner.name} className={runner.you ? 'you' : ''}><span>{runner.name}</span><i><b style={{ width: `${runner.progress01 * 100}%` }} /></i></div>
    ))}</div>}
    {hud.energy && <div className="energy">
      {hud.energy.coaching && <strong role="status">{hud.energy.coaching}</strong>}
      <span>{hud.energy.label}</span>
      <i><b style={{ width: `${hud.energy.value01 * 100}%` }} /></i>
    </div>}
    {hud.finished && <div className="game-over" role="dialog" aria-label="Fim da prova">
      <h2>{hud.finished.title}</h2>
      <p><strong>{hud.finished.detail}</strong></p>
      <ol>{hud.finished.standings.map((runner, index) => (
        <li key={runner.name} className={runner.you ? 'current' : ''}><span>{index + 1}º {runner.name}</span><span>{runner.time}</span></li>
      ))}</ol>
      <div className="restart-gesture"><b style={{ width: `${hud.finished.restart01 * 100}%` }} /><span>Levante as duas mãos para correr de novo</span></div>
      {leaveBar}
      <button type="button" onClick={onRestart}>Correr de novo</button>
    </div>}
    {hud.result && <div className="game-over" role="dialog" aria-label="Fim de corrida">
      <h2>Você perdeu!</h2>
      <p>Sua melhor marca nesta corrida: <strong>{hud.result.points}</strong> pontos</p>
      <h3>Seu ranking</h3>
      <ol>{hud.result.ranking.map((points, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the place is the row's identity and scores may repeat
        <li key={index} className={hud.result?.position === index + 1 ? 'current' : ''}><span>{index + 1}º</span><span>{points}</span></li>
      ))}</ol>
      <button type="button" ref={(button) => button?.focus()} onClick={onRestart}>Jogar de novo</button>
    </div>}
    <div className="game-ready"><i className={tracking.startsWith('TRACKING') ? 'ready' : ''} />{hud.status}</div>
    <div className="game-controls">{HUD_TEXT[sport].controls}</div>
  </div>;
}
