import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import { GOALS, type Goal } from '../games/athletics/race';
import type { Sport } from './GameCanvas';

const SPORTS: { id: Sport; name: string; hint: string }[] = [
  { id: 'athletics', name: 'Atletismo', hint: 'Corra no lugar e dispute a prova no estádio' },
  { id: 'tennis', name: 'Tênis', hint: 'Balance o braço para rebater' },
];

const SLOTS = Array.from({ length: 12 }, (_, i) => `slot-${i}`);
const GRID_MS = 1100; // a grade fica à vista antes de virar roda
let introduced = false; // só a primeira visita mostra a grade se desfazendo

/** Grade 4 x 3, ou roda em elipse com o canal da vez grande e à frente. */
function placement(index: number, turn: number, ring: boolean): CSSProperties {
  if (!ring) return { left: `${14 + 24 * (index % 4)}%`, top: `${18 + 32 * Math.floor(index / 4)}%`, transform: 'translate(-50%, -50%) scale(1)' };
  const angle = ((index - turn) / SLOTS.length) * Math.PI * 2;
  const depth = (Math.cos(angle) + 1) / 2; // 1 = frente
  return {
    left: `${50 + Math.sin(angle) * 37}%`,
    top: `${24 + depth * 34}%`,
    transform: `translate(-50%, -50%) scale(${(.4 + .4 * depth ** 2 + .8 * depth ** 24).toFixed(3)})`,
    opacity: .45 + .55 * depth,
    zIndex: Math.round(depth * 20),
  };
}

function Logo() {
  return <span className="logo"><b>Wii</b> <i>Sports</i></span>;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="wii-clock">
    <strong>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
    <span>{now.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'numeric' })}</span>
  </div>;
}

export function HomeMenu({ onGames, exit }: { onGames: () => void; exit: ReactNode }) {
  const [zoom, setZoom] = useState<CSSProperties>();
  const [ring, setRing] = useState(() => introduced || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [turn, setTurn] = useState(0); // não volta a zero: a roda gira sempre pelo caminho curto
  const front = ((turn % SLOTS.length) + SLOTS.length) % SLOTS.length;

  useEffect(() => {
    if (zoom) return;
    const timer = window.setTimeout(() => { introduced = true; setRing(true); }, ring ? 0 : GRID_MS);
    return () => window.clearTimeout(timer);
  }, [ring, zoom]);

  // Como nos papers: clicar num canal gira a roda, pelo caminho curto, até ele chegar à frente.
  const bring = (index: number) => {
    setRing(true);
    introduced = true;
    const n = SLOTS.length;
    setTurn(turn + ((((index - front) % n) + n + n / 2) % n) - n / 2);
  };

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    if (front !== 0) { bring(0); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onGames(); return; }
    introduced = true;
    // O foco da aproximação é o centro do canal, medido dentro da roda (que é quem escala).
    const tile = event.currentTarget.getBoundingClientRect();
    const wheel = event.currentTarget.closest('.channel-ring')?.getBoundingClientRect();
    setZoom({ '--zx': `${tile.left + tile.width / 2 - (wheel?.left ?? 0)}px`, '--zy': `${tile.top + tile.height / 2 - (wheel?.top ?? 0)}px` } as CSSProperties);
  };

  return <section className={zoom ? 'menu channels is-opening' : 'menu channels'} style={zoom} aria-label="Menu de canais">
    <div className={ring ? 'channel-ring is-ring' : 'channel-ring'} inert={!!zoom}>
      {SLOTS.map((slot, index) => index === 0
        ? <button key={slot} type="button" className="channel sports" style={placement(index, turn, ring)} onClick={open}><Logo /></button>
        : <button key={slot} type="button" className="channel empty" style={placement(index, turn, ring)} onClick={() => bring(index)} aria-label={`Trazer o canal vazio ${index} para a frente`}>Wii</button>)}
      <button type="button" className="ring-arrow left" onClick={() => setTurn(turn - 1)} aria-label="Girar para a esquerda">◀</button>
      <button type="button" className="ring-arrow right" onClick={() => setTurn(turn + 1)} aria-label="Girar para a direita">▶</button>
    </div>
    <footer className="wii-bar" inert={!!zoom}>
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 20H150C250 20 270 120 380 120H620C730 120 750 20 850 20H1000V200H0Z" />
      </svg>
      <span className="wii-title">Wii Menu</span>
      <Clock />
      {exit}
    </footer>
    {zoom && <div className="channel-whiteout" onAnimationEnd={onGames} aria-hidden="true" />}
  </section>;
}

/** Roda de jogos: o da vez fica grande e à frente, os outros recuam para os lados. */
function gamePlacement(index: number, turn: number): CSSProperties {
  const n = SPORTS.length;
  const offset = ((((index - turn) % n) + n + n / 2) % n) - n / 2; // posição na roda, de -n/2 a n/2
  const angle = (offset / Math.max(n, 3)) * Math.PI * 2; // com 2 jogos a roda ainda abre para os lados
  const depth = (Math.cos(angle) + 1) / 2; // 1 = frente
  return {
    left: `${50 + Math.sin(angle) * 31}%`,
    top: `${46 + (1 - depth) * -6}%`,
    transform: `translate(-50%, -50%) scale(${(.62 + .38 * depth ** 2).toFixed(3)})`,
    opacity: .55 + .45 * depth,
    zIndex: Math.round(depth * 20),
  };
}

export function GamesMenu({ onPick, onHome }: { onPick: (sport: Sport, goal?: Goal) => void; onHome: () => void }) {
  const [turn, setTurn] = useState(0); // Atletismo começa à frente, como na seleção anterior.
  const [choosingGoal, setChoosingGoal] = useState(false);
  const n = SPORTS.length;
  const front = ((turn % n) + n) % n;
  const selected = SPORTS[front]!;
  const hint = choosingGoal ? 'Escolha a distância da prova' : selected.hint;

  // Clicar num jogo de trás gira a roda pelo caminho curto; clicar no da frente seleciona.
  const bring = (index: number) => setTurn(turn + ((((index - front) % n) + n + n / 2) % n) - n / 2);

  return <section className="menu sports-menu" aria-label="Escolha a modalidade">
    <header className="menu-header">
      <h1>Menu Principal</h1>
      <button type="button" className="logo-btn" onClick={onHome} aria-label="Wii Sports: voltar ao Wii Menu"><Logo /></button>
    </header>
    <div className="menu-body games-body">
      <div className="games-ring">
        {choosingGoal
          ? <div className="games-goal-panel">
              <h2>Escolha a distância</h2>
              <div className="games-goals">
                {GOALS.map((goal) => <button key={goal} type="button" className="wii-btn games-goal" onClick={() => onPick('athletics', goal)} aria-label={`Iniciar corrida de ${goal} metros`}>
                  {goal} metros
                </button>)}
              </div>
            </div>
          : <>
              {SPORTS.map((sport, index) => <button key={sport.id} type="button" className={`game-card ${sport.id}${index === front ? ' is-front' : ''}`}
                style={gamePlacement(index, turn)} onClick={() => {
                  if (index !== front) { bring(index); return; }
                  if (sport.id === 'athletics') setChoosingGoal(true);
                  else onPick(sport.id);
                }}
                aria-label={index !== front ? `Trazer ${sport.name} para a frente` : sport.id === 'athletics' ? 'Escolher distância da corrida' : `Jogar ${sport.name}`}>
                <span className="scene" />
                <span className="game-name">{sport.name}</span>
              </button>)}
              <button type="button" className="ring-arrow left" onClick={() => setTurn(turn - 1)} aria-label="Girar para a esquerda">◀</button>
              <button type="button" className="ring-arrow right" onClick={() => setTurn(turn + 1)} aria-label="Girar para a direita">▶</button>
            </>}
      </div>
      <div className="games-footer">
        <button type="button" className="wii-btn games-back" onClick={() => (choosingGoal ? setChoosingGoal(false) : onHome())}>
          {choosingGoal ? '‹ Modalidades' : 'Voltar'}
        </button>
        <p className="games-hint" aria-live="polite">{hint}</p>
      </div>
    </div>
  </section>;
}
