import { type CSSProperties, type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { Sport } from './GameCanvas';
import { CarouselController, type CarouselStepResult } from './carouselController';
import type { HandCursorInput } from './handCursorTypes';

const SPORTS: { id: Sport; name: string; hint: string }[] = [
  { id: 'track', name: 'Corrida', hint: 'Corra no lugar, salte e troque de raia' },
  { id: 'tennis', name: 'Tênis', hint: 'Balance o braço para rebater' },
];

const SLOTS = Array.from({ length: 12 }, (_, i) => `slot-${i}`);
const GRID_MS = 1100; // a grade fica à vista antes de virar roda
let introduced = false; // só a primeira visita mostra a grade se desfazendo

type SharedRef<T> = { current: T };

interface HomeMenuProps {
  onGames: () => void;
  exit: ReactNode;
  handInputRef: SharedRef<HandCursorInput>;
  rotationGateRef: SharedRef<boolean>;
  carouselDebugRef?: SharedRef<CarouselStepResult | undefined>;
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

function shortestTurnDelta(fromTurn: number, toIndex: number, slotCount: number): number {
  return ((((toIndex - fromTurn) % slotCount) + slotCount + slotCount / 2) % slotCount) - slotCount / 2;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const query = REDUCED_MOTION_QUERY;
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}


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

export function HomeMenu({ onGames, exit, handInputRef, rotationGateRef, carouselDebugRef }: HomeMenuProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [zoom, setZoom] = useState<CSSProperties>();
  const [ring, setRing] = useState(() => introduced || reducedMotion);
  const [turn, setTurn] = useState(0); // não volta a zero: a roda gira sempre pelo caminho curto
  const ringRef = useRef<HTMLDivElement>(null);
  const channelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const controllerRef = useRef<CarouselController | null>(null);
  controllerRef.current ??= new CarouselController({ slotCount: SLOTS.length, reducedMotion });
  const controller = controllerRef.current;
  const front = positiveModulo(Math.round(turn), SLOTS.length);

  useEffect(() => {
    controller.setReducedMotion(reducedMotion);
  }, [controller, reducedMotion]);

  useEffect(() => {
    rotationGateRef.current = ring && zoom === undefined;
    return () => {
      rotationGateRef.current = false;
    };
  }, [ring, zoom, rotationGateRef]);

  const paintTurn = useCallback((nextTurn: number) => {
    for (let index = 0; index < SLOTS.length; index += 1) {
      const element = channelRefs.current[index];
      if (!element) continue;
      const style = placement(index, nextTurn, true);
      element.style.left = String(style.left ?? '');
      element.style.top = String(style.top ?? '');
      element.style.transform = String(style.transform ?? '');
      element.style.opacity = style.opacity === undefined ? '' : String(style.opacity);
      element.style.zIndex = style.zIndex === undefined ? '' : String(style.zIndex);
    }
  }, []);

  useEffect(() => {
    if (!ring || zoom !== undefined) return;
    const ringElement = ringRef.current;
    if (!ringElement) return;
    let rafId: number | undefined;
    let lastMs: number | undefined;
    const idleGesture = { phase: 'IDLE' as const, angularVelocityDegPerSec: 0 };

    const tick = (now: number) => {
      const dtMs = lastMs === undefined ? 0 : now - lastMs;
      lastMs = now;
      const input = handInputRef.current;
      const rotationInteractive = rotationGateRef.current && input.visible && input.synced;
      const result = controller.step(
        dtMs,
        rotationInteractive
          ? { phase: input.rotationPhase, angularVelocityDegPerSec: input.rotationAngularVelocity }
          : idleGesture,
      );
      if (result.controlling || result.frontChanged || result.settled) paintTurn(result.turn);
      ringElement.classList.toggle('is-gesture-controlled', result.controlling);
      if (carouselDebugRef) carouselDebugRef.current = result;
      if (result.frontChanged || result.settled) {
        setTurn((current) => (Object.is(current, result.turn) ? current : result.turn));
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      ringElement.classList.remove('is-gesture-controlled');
      if (carouselDebugRef) carouselDebugRef.current = undefined;
    };
  }, [ring, zoom, controller, paintTurn, handInputRef, rotationGateRef, carouselDebugRef]);

  useEffect(() => {
    const timer = window.setTimeout(() => { introduced = true; setRing(true); }, ring ? 0 : GRID_MS);
    return () => window.clearTimeout(timer);
  }, [ring]);

  const rotateTo = (nextTurn: number) => {
    ringRef.current?.classList.remove('is-gesture-controlled');
    controller.syncTurn(nextTurn);
    setTurn(nextTurn);
  };
  const rotateBy = (delta: number) => rotateTo(controller.currentTurn + delta);
  // A câmera avança sobre o canal, o branco nasce no meio da tela e só então troca de tela.
  // Como nos papers: clicar num canal gira a roda, pelo caminho curto, até ele chegar à frente.
  const bring = (index: number) => {
    setRing(true);
    introduced = true;
    rotateTo(controller.currentTurn + shortestTurnDelta(controller.currentTurn, index, SLOTS.length));
  };
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    if (front !== 0) { bring(0); return; }
    if (reducedMotion) { onGames(); return; }
    const tile = event.currentTarget.getBoundingClientRect();
    const screen = event.currentTarget.closest('section')?.getBoundingClientRect();
    setZoom({ left: tile.left - (screen?.left ?? 0), top: tile.top - (screen?.top ?? 0), width: tile.width, height: tile.height });
  };

  const channelRef = (index: number) => (element: HTMLButtonElement | null) => {
    channelRefs.current[index] = element;
  };

  return <section className={zoom ? 'menu channels is-opening' : 'menu channels'} aria-label="Menu de canais">
    <div ref={ringRef} className={ring ? 'channel-ring is-ring' : 'channel-ring'}>
      {SLOTS.map((slot, index) => index === 0
        ? <button key={slot} ref={channelRef(index)} type="button" className="channel sports" style={placement(index, turn, ring)} onClick={open} disabled={zoom !== undefined}><Logo /></button>
        : <button key={slot} ref={channelRef(index)} type="button" className="channel empty" style={placement(index, turn, ring)} onClick={() => bring(index)} aria-label={`Trazer o canal vazio ${index} para a frente`}>Wii</button>)}
      <button type="button" className="ring-arrow left" onClick={() => rotateBy(-1)} aria-label="Girar para a esquerda">◀</button>
      <button type="button" className="ring-arrow right" onClick={() => rotateBy(1)} aria-label="Girar para a direita">▶</button>
    </div>
    <footer className="wii-bar">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 20H150C250 20 270 120 380 120H620C730 120 750 20 850 20H1000V200H0Z" />
      </svg>
      <span className="wii-title">Wii Menu</span>
      <Clock />
      {exit}
    </footer>
    {zoom && <div className="channel-zoom" style={zoom} onAnimationEnd={onGames} aria-hidden="true" />}
  </section>;
}

export function TitleMenu({ onStart, onBack }: { onStart: () => void; onBack: () => void }) {
  return <section className="menu title" aria-label="Wii Sports">
    <div className="title-card">
      <Logo />
      <div className="stripes" />
    </div>
    <div className="title-actions">
      <button type="button" className="wii-btn pill" onClick={onBack}>Wii Menu</button>
      <button type="button" className="wii-btn pill" onClick={onStart}>Start</button>
    </div>
  </section>;
}

export function GamesMenu({ onPick, onBack, onHome }: { onPick: (sport: Sport) => void; onBack: () => void; onHome: () => void }) {
  const [preview, setPreview] = useState<Sport>('tennis');
  const hint = SPORTS.find((s) => s.id === preview)?.hint;

  return <section className="menu sports-menu" aria-label="Escolha a modalidade">
    <header className="menu-header">
      <h1>Menu Principal</h1>
      <button type="button" className="logo-btn" onClick={onHome} aria-label="Wii Sports: voltar ao Wii Menu"><Logo /></button>
    </header>
    <div className="menu-body">
      <div className="sport-list">
        {SPORTS.map((s) => <button key={s.id} type="button" className={preview === s.id ? 'wii-btn selected' : 'wii-btn'}
          onPointerEnter={() => setPreview(s.id)} onFocus={() => setPreview(s.id)} onClick={() => onPick(s.id)}>{s.name}</button>)}
        <button type="button" className="wii-btn back" onClick={onBack}>Voltar</button>
      </div>
      <figure className={`preview ${preview}`}>
        <div className="scene" />
        <figcaption>{hint}</figcaption>
      </figure>
    </div>
  </section>;
}
