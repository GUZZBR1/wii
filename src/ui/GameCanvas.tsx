import { useEffect, useRef, useState } from 'react';
import type { SportActionEvent } from '../cv/protocol';
import type { AthleticsHudState } from '../games/athletics/AthleticsGame';
import { GOALS, type Goal } from '../games/athletics/race';
import type { ProceduralAudio } from '../games/audio';
import type { BoxingScoreboard } from '../games/boxing/BoxingGame';
import type { GameHudState as CoreHudState } from '../games/core/hud';
import type { GameHudState as TrackHudState } from '../games/track/TrackGame';

type GameHudState = Omit<TrackHudState, 'feedback'> & {
  feedback?: TrackHudState['feedback'] | CoreHudState['feedback'];
  finish?: AthleticsHudState['finish'];
  boxing?: BoxingScoreboard;
};
import { forwardKeyDown } from './keys';

export type Sport = 'track' | 'athletics' | 'tennis' | 'boxing';
const HUD_TEXT: Record<Sport, { score: string; controls: string }> = {
  track: { score: 'SCORE', controls: '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar' },
  athletics: { score: 'TEMPO', controls: '↑ / espaço acelerar  ·  ↓ desacelerar' },
  tennis: { score: 'PONTOS', controls: 'espaço bater  ·  timing define a direção' },
  boxing: { score: 'HP', controls: '← → esquivar  ·  A / D socar  ·  segure ↓ ou S para defender' },
};
export interface GameEngineHandle { onAction(event: SportActionEvent): void; onKey(key: string): void; setTracking?(tracking: string): void; setLaneZone?(zone: -1 | 0 | 1 | undefined): void; resetLaneZone?(): void; setGuard?(guard: boolean | undefined): void; onKeyUp?(key: string): void; dispose(): void }

interface Props {
  sport: Sport;
  onEngine: (engine: GameEngineHandle | null) => void;
  tracking: string;
  audio?: ProceduralAudio;
}

/** Restarting remounts the whole run, so a new game starts from a clean engine and canvas. */
export function GameCanvas(props: Props) {
  const [run, setRun] = useState(0);
  const [goal, setGoal] = useState<Goal>(400);
  return (
    <GameRun
      key={`${run}-${goal}`}
      {...props}
      goal={goal}
      onGoal={setGoal}
      onRestart={() => setRun((value) => value + 1)}
    />
  );
}

type RunProps = Props & { goal: Goal; onGoal: (goal: Goal) => void; onRestart: () => void };

function GameRun({ sport, onEngine, tracking, audio, goal, onGoal, onRestart }: RunProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<GameHudState>({ score: 0, label: '00000', speed01: 0, status: 'Pronto para jogar' });
  const hudRef = useRef(setHud);
  hudRef.current = setHud;
  const engineRef = useRef<GameEngineHandle | null>(null);
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;

  useEffect(() => { engineRef.current?.setTracking?.(tracking); }, [tracking]);

  useEffect(() => {
    if (!canvasRef.current) return;
    let game: GameEngineHandle | undefined;
    let disposed = false;
    const keydown = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) event.preventDefault();
      if (!forwardKeyDown(event.key, event.repeat)) return;
      void audio?.unlock();
      game?.onKey(event.key);
    };
    const keyup = (event: KeyboardEvent) => game?.onKeyUp?.(event.key);
    // A key released while the window is unfocused never reports it.
    const blur = () => { for (const key of ['ArrowDown', 's']) game?.onKeyUp?.(key); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    const mount = async () => {
      try {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const updateHud = (state: GameHudState) => hudRef.current(state);
        const engine: GameEngineHandle = sport === 'track'
          ? new (await import('../games/track/TrackGame')).TrackGame(canvas, updateHud)
          : sport === 'athletics'
            ? new (await import('../games/athletics/AthleticsGame')).AthleticsGame(canvas, updateHud, audio, goal)
            : sport === 'tennis'
              ? new (await import('../games/tennis/TennisGame')).TennisGame(canvas, updateHud, audio)
              : new (await import('../games/boxing/BoxingGame')).BoxingGame(canvas, updateHud, audio);
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
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      game?.dispose();
      engineRef.current = null;
      onEngine(null);
    };
  }, [sport, onEngine, audio, goal]);

  return <div className="game-viewport">
    <canvas ref={canvasRef} />
    {sport === 'boxing'
      ? hud.boxing && <BoxingHud {...hud.boxing} />
      : <div className="game-hud"><div><span>{HUD_TEXT[sport].score}</span><strong>{hud.label}</strong>{(hud.combo ?? 0) > 1 && <em>COMBO {hud.combo}</em>}</div><div className="game-speed"><span>{sport !== 'tennis' ? 'RITMO' : 'MIRA'}</span><strong>{sport !== 'tennis' ? `${Math.round(hud.speed01 * 100)}%` : hud.status.split(' · ').at(-1)}</strong></div></div>}
    {sport === 'athletics' && (hud.score === 0 || hud.finish) && <fieldset className="game-goals" aria-label="Distância da prova">
      {GOALS.map((meters) => <button key={meters} type="button" className="dock-btn" aria-pressed={meters === goal} onClick={() => onGoal(meters)}>{meters} m</button>)}
    </fieldset>}
    {hud.feedback && <div key={hud.feedback.id} className={`game-feedback ${('kind' in hud.feedback ? hud.feedback.kind : hud.feedback.tone)}`}>
      <span>{hud.feedback.text}</span>
    </div>}
    {hud.banner && <div className="game-banner" role="status"><strong>{hud.banner.title}</strong>{hud.banner.detail && <span>{hud.banner.detail}</span>}</div>}
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
    {hud.finish && <div className="game-over finish" role="dialog" aria-label="Fim de prova">
      <h2>{hud.finish.title}</h2>
      <p>{hud.finish.detail}</p>
      <button type="button" ref={(button) => button?.focus()} onClick={onRestart}>Correr de novo</button>
    </div>}
    <div className="game-ready"><i className={tracking.startsWith('TRACKING') ? 'ready' : ''} />{hud.status}</div>
    <div className="game-controls">{HUD_TEXT[sport].controls}</div>
  </div>;
}

function BoxingHud({ playerHp, opponentHp, maxHp, round, rounds, secondsLeft }: BoxingScoreboard) {
  const fighter = (name: string, hp: number, side: 'player' | 'opponent') => <div className={`boxing-card boxing-fighter ${side}`}>
    <p className="boxing-name"><span className="boxing-label">{name}</span><strong className="boxing-value">{hp}</strong></p>
    <div className="boxing-bar" aria-hidden="true"><div className="boxing-fill" style={{ width: `${(100 * hp) / maxHp}%` }} /></div>
  </div>;
  return <div className="boxing-hud">
    {fighter('VOCÊ', playerHp, 'player')}
    <div className="boxing-card boxing-clock">
      <span className="boxing-label">ROUND {round}/{rounds}</span>
      <strong className="boxing-value">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong>
    </div>
    {fighter('CPU', opponentHp, 'opponent')}
  </div>;
}
