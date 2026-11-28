import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { Sport } from './GameCanvas';
import { CarouselController, type CarouselStepResult } from './carouselController';
import type { HandCursorInput } from './handCursorTypes';

const SPORTS: { id: Sport; name: string; hint: string }[] = [
  { id: 'athletics', name: 'Atletismo', hint: 'Corra no lugar e dispute a prova no estádio' },
  { id: 'tennis', name: 'Tênis', hint: 'Balance o braço para rebater' },
  { id: 'boxing', name: 'Boxe', hint: 'Soque para a frente e incline o corpo para esquivar' },
];

const channelSports: Partial<Record<number, (typeof SPORTS)[number]>> = { 1: SPORTS[0], 11: SPORTS[1], 2: SPORTS[2] };

const SLOTS = Array.from({ length: 12 }, (_, i) => `slot-${i}`);
const GRID_MS = 1100; // a grade fica à vista antes de virar roda
const RING_TRANSITION_MS = 900;
const HAND_SAMPLE_STALE_MS = 150;
let introduced = false; // só a primeira visita mostra a grade se desfazendo

type SharedRef<T> = { current: T };

interface HomeMenuProps {
  onPick: (sport: Sport) => void;
  onIronMan: () => void;
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

export function HomeMenu({ onPick, onIronMan, exit, handInputRef, rotationGateRef, carouselDebugRef }: HomeMenuProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [ring, setRing] = useState(() => introduced || reducedMotion);
  const [ringReady, setRingReady] = useState(() => introduced || reducedMotion);
  const [turn, setTurn] = useState(0); // não volta a zero: a roda gira sempre pelo caminho curto
  const ringRef = useRef<HTMLDivElement>(null);
  const channelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mouseControlUntilMsRef = useRef(0);
  const controllerRef = useRef<CarouselController | null>(null);
  controllerRef.current ??= new CarouselController({ slotCount: SLOTS.length, reducedMotion });
  const controller = controllerRef.current;
  // A câmera desligada/sem mão sincronizada estaciona o loop: mouse e CSS continuam independentes dele.
  const handRotationAvailable = handInputRef.current.visible && handInputRef.current.synced;

  useEffect(() => {
    controller.setReducedMotion(reducedMotion);
  }, [controller, reducedMotion]);

  useEffect(() => {
    rotationGateRef.current = ring && ringReady;
    return () => {
      rotationGateRef.current = false;
    };
  }, [ring, ringReady, rotationGateRef]);

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
    if (!ring || !ringReady || !handRotationAvailable) return;
    const ringElement = ringRef.current;
    if (!ringElement) return;
    let rafId: number | undefined;
    let lastMs: number | undefined;
    const idleGesture = { phase: 'IDLE' as const, angularVelocityDegPerSec: 0 };

    const tick = (now: number) => {
      const dtMs = lastMs === undefined ? 0 : now - lastMs;
      lastMs = now;
      const input = handInputRef.current;
      const inputFresh = input.capturedAtMs !== undefined && now - input.capturedAtMs <= HAND_SAMPLE_STALE_MS;
      const mouseOwningTransition = now < mouseControlUntilMsRef.current;
      const rotationInteractive = rotationGateRef.current && input.visible && input.synced && inputFresh && !mouseOwningTransition;
      const result = controller.step(
        dtMs,
        rotationInteractive
          ? { phase: input.rotationPhase, angularVelocityDegPerSec: input.rotationAngularVelocity }
          : idleGesture,
      );
      if (result.controlling || result.frontChanged || result.settled) paintTurn(result.turn);
      ringElement.classList.toggle('is-gesture-controlled', result.controlling);
      if (carouselDebugRef) carouselDebugRef.current = result;
      if (result.settled) {
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
  }, [ring, ringReady, handRotationAvailable, controller, paintTurn, handInputRef, rotationGateRef, carouselDebugRef]);

  useEffect(() => {
    const timer = window.setTimeout(() => { introduced = true; setRing(true); }, ring ? 0 : GRID_MS);
    return () => window.clearTimeout(timer);
  }, [ring]);

  useEffect(() => {
    if (!ring) {
      setRingReady(false);
      return;
    }
    if (ringReady) return;
    const timer = window.setTimeout(() => setRingReady(true), reducedMotion ? 0 : RING_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [ring, ringReady, reducedMotion]);

  const rotateTo = (nextTurn: number) => {
    mouseControlUntilMsRef.current = reducedMotion ? 0 : performance.now() + RING_TRANSITION_MS;
    ringRef.current?.classList.remove('is-gesture-controlled');
    controller.syncTurn(nextTurn);
    setTurn(nextTurn);
  };
  const rotateBy = (delta: number) => rotateTo(Math.round(controller.currentTurn) + delta);
  // Como nos papers: clicar num canal gira a roda, pelo caminho curto, até ele chegar à frente.
  const bring = (index: number) => {
    setRing(true);
    introduced = true;
    rotateTo(controller.currentTurn + shortestTurnDelta(controller.currentTurn, index, SLOTS.length));
  };

  const selectChannel = (index: number) => {
    const frontNow = positiveModulo(Math.round(controller.currentTurn), SLOTS.length);
    if (controller.isControlling || frontNow !== index) { bring(index); return; }
    if (index === 0) {
      onIronMan();
      return;
    }
    const sport = channelSports[index];
    if (!sport) return;
    onPick(sport.id);
  };

  const channelRef = (index: number) => (element: HTMLButtonElement | null) => {
    channelRefs.current[index] = element;
  };

  return <section className="menu channels" aria-label="Menu de canais">
    <div ref={ringRef} className={ring ? 'channel-ring is-ring' : 'channel-ring'}>
      {SLOTS.map((slot, index) => {
        const sport = channelSports[index];
        return <button key={slot} ref={channelRef(index)} type="button"
          className={`channel ${index === 0 ? 'sports' : sport ? `sport-channel ${sport.id}` : 'empty'}`}
          style={placement(index, turn, ring)}
          onClick={() => sport || index === 0 ? selectChannel(index) : bring(index)}
          aria-label={index === 0 ? 'Wii Sports: desafio Iron Man' : sport ? sport.name : `Trazer o canal vazio ${index} para a frente`}>
          {index === 0 ? <Logo /> : sport ? <><span className="channel-scene" /><span className="channel-name">{sport.name}</span></> : 'Wii'}
        </button>;
      })}
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
  </section>;
}
