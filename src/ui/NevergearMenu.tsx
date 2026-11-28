import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { Sport } from './GameCanvas';
import { CarouselController, type CarouselStepResult } from './carouselController';
import type { HandInputStore } from './handInputStore';
import { useLang, type Bilingual } from '../i18n';

const SPORTS: { id: Sport; name: Bilingual; hint: Bilingual }[] = [
  { id: 'athletics', name: { pt: 'Atletismo', en: 'Athletics' }, hint: { pt: 'Corra no lugar e dispute a prova no estádio', en: 'Run in place and race at the stadium' } },
  { id: 'tennis', name: { pt: 'Tênis', en: 'Tennis' }, hint: { pt: 'Balance o braço para rebater', en: 'Swing your arm to hit the ball' } },
  { id: 'boxing', name: { pt: 'Boxe', en: 'Boxing' }, hint: { pt: 'Soque para a frente e incline o corpo para esquivar', en: 'Punch forward and lean to dodge' } },
];

// Only channels that open a game: the challenge in front, athletics on the right, boxing behind, and tennis on the left.
const channelSports: Partial<Record<number, (typeof SPORTS)[number]>> = { 1: SPORTS[0], 2: SPORTS[2], 3: SPORTS[1] };

const SLOTS = ['iron-man', 'right', 'back', 'left'];
const GRID_MS = 1100; // The grid stays visible before it becomes a wheel.
const RING_TRANSITION_MS = 900;
const HAND_SAMPLE_STALE_MS = 150;
let introduced = false; // Only the first visit shows the channels unfolding.

type SharedRef<T> = { current: T };

interface HomeMenuProps {
  onPick: (sport: Sport) => void;
  onIronMan: () => void;
  onMii?: () => void;
  exit: ReactNode;
  handStore: HandInputStore;
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


/** An opening row, followed by an elliptical wheel with the selected channel enlarged at the front. */
function placement(index: number, turn: number, ring: boolean): CSSProperties {
  if (!ring) return { left: `${14 + 24 * index}%`, top: '50%', transform: 'translate(-50%, -50%) scale(1)' };
  const angle = ((index - turn) / SLOTS.length) * Math.PI * 2;
  const depth = (Math.cos(angle) + 1) / 2; // 1 = front
  return {
    left: `${50 + Math.sin(angle) * 37}%`,
    top: `${27 + depth * 34}%`,
    transform: `translate(-50%, -50%) scale(${(.6 + .2 * depth ** 2 + .8 * depth ** 24).toFixed(3)})`,
    opacity: .6 + .4 * depth,
    zIndex: Math.round(depth * 20),
  };
}

function Logo() {
  return <span className="logo"><img className="brand-logo" src="/images/nevergear-logo.png" alt="Nevergear" width={1200} height={234} /> <i>Sports</i></span>;
}

function Clock({ locale }: { locale: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="nevergear-clock">
    <strong>{now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</strong>
    <span>{now.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'numeric' })}</span>
  </div>;
}

export function HomeMenu({ onPick, onIronMan, onMii, exit, handStore, rotationGateRef, carouselDebugRef }: HomeMenuProps) {
  const { lang, locale, tr } = useLang();
  const reducedMotion = usePrefersReducedMotion();
  const [ring, setRing] = useState(() => introduced || reducedMotion);
  const [ringReady, setRingReady] = useState(() => introduced || reducedMotion);
  const [turn, setTurn] = useState(0); // Keep the accumulated turn so the wheel always takes the shortest path.
  const ringRef = useRef<HTMLDivElement>(null);
  const channelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const mouseControlUntilMsRef = useRef(0);
  const controllerRef = useRef<CarouselController | null>(null);
  controllerRef.current ??= new CarouselController({ slotCount: SLOTS.length, reducedMotion });
  const controller = controllerRef.current;

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
    // Keep one loop while the wheel is ready. It samples hand input every frame, so brief hand
    // loss does not remount it, and mouse input stays independent while the hand is idle.
    if (!ring || !ringReady) return;
    const ringElement = ringRef.current;
    if (!ringElement) return;
    let rafId: number | undefined;
    let lastMs: number | undefined;
    const idleGesture = { phase: 'IDLE' as const, angularVelocityDegPerSec: 0 };

    const tick = (now: number) => {
      const dtMs = lastMs === undefined ? 0 : now - lastMs;
      lastMs = now;
      const input = handStore.current;
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
  }, [ring, ringReady, controller, paintTurn, handStore, rotationGateRef, carouselDebugRef]);

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

  const rotateTo = useCallback((nextTurn: number) => {
    mouseControlUntilMsRef.current = reducedMotion ? 0 : performance.now() + RING_TRANSITION_MS;
    ringRef.current?.classList.remove('is-gesture-controlled');
    controller.syncTurn(nextTurn);
    setTurn(nextTurn);
    // A gesture may have painted past React's last render, which alone would then skip the write.
    paintTurn(nextTurn);
  }, [controller, paintTurn, reducedMotion]);
  const rotateBy = useCallback(
    (delta: number) => rotateTo(Math.round(controller.currentTurn) + delta),
    [controller, rotateTo],
  );
  // A swipe is a one-sample pulse, so it is taken as published, not polled from the loop.
  useEffect(
    () =>
      handStore.subscribe(() => {
        const input = handStore.current;
        if (input.swipeDirection === 0 || !rotationGateRef.current || !input.visible || !input.synced) return;
        rotateBy(input.swipeDirection);
      }),
    [handStore, rotationGateRef, rotateBy],
  );
  // Clicking a channel rotates the wheel along the shortest path until it reaches the front.
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

  return <section className="menu channels" aria-label={tr('Menu de canais', 'Channel menu')}>
    <div ref={ringRef} className={ring ? 'channel-ring is-ring' : 'channel-ring'}>
      {SLOTS.map((slot, index) => {
        const sport = channelSports[index];
        return <button key={slot} ref={channelRef(index)} type="button"
          className={`channel ${index === 0 ? 'sports' : `sport-channel ${sport?.id}`}`}
          style={placement(index, turn, ring)}
          onClick={() => selectChannel(index)}
          title={sport?.hint[lang]}
          aria-label={index === 0 ? tr('Nevergear Sports: desafio Iron Man', 'Nevergear Sports: Iron Man challenge') : sport?.name[lang]}>
          {index === 0 ? <Logo /> : <><span className="channel-scene" /><span className="channel-name">{sport?.name[lang]}</span></>}
        </button>;
      })}
      <button type="button" className="ring-arrow left" onClick={() => rotateBy(-1)} aria-label={tr('Girar para a esquerda', 'Rotate left')}>◀</button>
      <button type="button" className="ring-arrow right" onClick={() => rotateBy(1)} aria-label={tr('Girar para a direita', 'Rotate right')}>▶</button>
    </div>
    <footer className="nevergear-bar">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 20H150C250 20 270 120 380 120H620C730 120 750 20 850 20H1000V200H0Z" />
      </svg>
      <span className="nevergear-title">{tr('Menu Nevergear', 'Nevergear Menu')}</span>
      <Clock locale={locale} />
      {onMii && <button type="button" className="nevergear-btn nevergear-mii-button" onClick={onMii}>Mii</button>}
      {exit}
    </footer>
  </section>;
}
