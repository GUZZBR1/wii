import { useEffect, useRef, useState } from 'react';
import type { SportActionEvent } from '../cv/protocol';
import type { ProceduralAudio } from '../games/audio';
import type { GameHudState as CoreHudState } from '../games/core/hud';
import type { GameHudState as TrackHudState } from '../games/track/TrackGame';

type GameHudState = Omit<TrackHudState, 'feedback'> & { feedback?: TrackHudState['feedback'] | CoreHudState['feedback']; finished?: { title: string; detail: string }; framing?: boolean };

const HUD_TEXT: Record<Sport, { score: string; speed: string; controls: string }> = {
  sprint: { score: 'DISTÂNCIA', speed: 'INTENSIDADE', controls: 'corra no lugar, mexendo os braços' },
  track: { score: 'SCORE', speed: 'RITMO', controls: '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar' },
  tennis: { score: 'PONTOS', speed: 'MIRA', controls: 'espaço bater  ·  timing define a direção' },
};
import { forwardKeyDown } from './keys';

export type Sport = 'sprint' | 'track' | 'tennis';
export interface GameEngineHandle { onAction(event: SportActionEvent): void; onKey(key: string): void; setTracking?(tracking: string): void; setLaneZone?(zone: -1 | 0 | 1 | undefined): void; setEffort?(effort01: number): void; setFraming?(advice: string | undefined): void; resetLaneZone?(): void; dispose(): void }

interface Props {
  sport: Sport;
  onEngine: (engine: GameEngineHandle | null) => void;
  tracking: string;
  audio?: ProceduralAudio;
}

/** Restarting remounts the whole run, so a new game starts from a clean engine and canvas. */
export function GameCanvas(props: Props) {
  const [run, setRun] = useState(0);
  return <GameRun key={run} {...props} onRestart={() => setRun((value) => value + 1)} />;
}

function GameRun({ sport, onEngine, tracking, audio, onRestart }: Props & { onRestart: () => void }) {
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
    window.addEventListener('keydown', keydown);
    const mount = async () => {
      try {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const updateHud = (state: GameHudState) => hudRef.current(state);
        const engine: GameEngineHandle = sport === 'sprint'
          ? new (await import('../games/sprint/SprintGame')).SprintGame(canvas, updateHud)
          : sport === 'track'
          ? new (await import('../games/track/TrackGame')).TrackGame(canvas, updateHud)
          : new (await import('../games/tennis/TennisGame')).TennisGame(canvas, updateHud, audio);
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
  }, [sport, onEngine, audio]);

  return <div className={hud.framing ? 'game-viewport is-framing' : 'game-viewport'}>
    <canvas ref={canvasRef} />
    <div className="game-hud"><div><span>{HUD_TEXT[sport].score}</span><strong>{hud.label}</strong>{(hud.combo ?? 0) > 1 && <em>COMBO {hud.combo}</em>}</div><div className="game-speed"><span>{HUD_TEXT[sport].speed}</span><strong>{sport === 'tennis' ? hud.status.split(' · ').at(-1) : `${Math.round(hud.speed01 * 100)}%`}</strong></div></div>
    {hud.feedback && <div key={hud.feedback.id} className={`game-feedback ${('kind' in hud.feedback ? hud.feedback.kind : hud.feedback.tone)}`}>
      <span>{hud.feedback.text}</span>
    </div>}
    {hud.banner && <div className="game-banner" role="status"><strong>{hud.banner.title}</strong>{hud.banner.detail && <span>{hud.banner.detail}</span>}</div>}
    {hud.finished && <div className="game-over" role="dialog" aria-label="Fim da prova">
      <h2>{hud.finished.title}</h2>
      <p><strong>{hud.finished.detail}</strong></p>
      <button type="button" ref={(button) => button?.focus()} onClick={onRestart}>Correr de novo</button>
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
