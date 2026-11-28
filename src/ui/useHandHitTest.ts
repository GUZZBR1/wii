import { useEffect, useRef } from 'react';
import { rotationBlocksHandInput, type HandCursorInput } from './handCursorTypes';

const HOVER = 'data-hand-hover';
const WITHIN = 'data-hand-within';
const CLICKABLE = 'button, [role="button"], a, summary, input[type="range"]';
const HAND_CONTAINER = '.lang-anchor, .article-explainer';

/** Só o elemento do topo conta: o cursor não atravessa painéis para clicar no que está atrás. */
function targetAt(hit: Element | undefined): HTMLElement | null {
  const target = hit?.closest<HTMLElement>(CLICKABLE) ?? null;
  return target?.matches(':disabled') ? null : target;
}

function setRangeValueAt(input: HTMLInputElement, x: number): void {
  const rect = input.getBoundingClientRect();
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  if (rect.width <= 0 || !(max > min)) return;
  const ratio = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
  const raw = min + ratio * (max - min);
  const step = Number(input.step || 1);
  const stepped = Number.isFinite(step) && step > 0 ? min + Math.round((raw - min) / step) * step : raw;
  const value = String(Math.round(Math.min(max, Math.max(min, stepped)) * 1e6) / 1e6);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setValue) setValue.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function activate(target: HTMLElement, x: number): void {
  if (target.matches('input[type="range"]')) setRangeValueAt(target as HTMLInputElement, x);
  else target.click();
}

/** Traduz o cursor de mão em hover, clique e voltar no DOM. */
export function useHandHitTest(
  input: HandCursorInput,
  active: boolean,
  onBack: () => void,
  /** Pinça sem alvo clicável: coordenadas e o elemento do topo, para quem escolhe por posição (Miis). */
  onEmptyClick?: (x: number, y: number, hit: Element | undefined) => void,
) {
  const { visible, x, y, pinchRelease, backProgress, rotationPhase } = input;
  const enabled = active && visible && input.synced && !rotationBlocksHandInput(rotationPhase);
  const hovered = useRef<HTMLElement | null>(null);
  const within = useRef<HTMLElement | null>(null);
  const released = useRef(false);
  const backDone = useRef(false);

  useEffect(() => {
    // Clique e voltar valem só na subida do sinal, não a cada frame em que ele segue ligado.
    const click = pinchRelease && !released.current;
    released.current = pinchRelease;
    const hit = enabled ? document.elementsFromPoint(x, y)[0] : undefined;
    const target = targetAt(hit);
    const container = hit?.closest<HTMLElement>(HAND_CONTAINER) ?? null;
    if (target !== hovered.current) {
      hovered.current?.removeAttribute(HOVER);
      hovered.current = target;
      if (target) {
        target.setAttribute(HOVER, 'true');
        target.dispatchEvent(new PointerEvent('pointerenter'));
        // O onPointerEnter do React é derivado de pointerover, não do pointerenter nativo.
        target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      }
    }
    if (container !== within.current) {
      within.current?.removeAttribute(WITHIN);
      within.current = container;
      container?.setAttribute(WITHIN, 'true');
    }
    if (click && enabled) {
      if (target) activate(target, x);
      else onEmptyClick?.(x, y, hit);
    }
  }, [enabled, x, y, pinchRelease, onEmptyClick]);

  useEffect(() => {
    const complete = backProgress >= 1;
    if (enabled && complete && !backDone.current) onBack();
    backDone.current = complete;
  }, [enabled, backProgress, onBack]);

  useEffect(
    () => () => {
      hovered.current?.removeAttribute(HOVER);
      within.current?.removeAttribute(WITHIN);
    },
    [],
  );
}
