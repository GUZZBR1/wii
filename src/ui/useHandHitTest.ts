import { useEffect, useRef } from 'react';
import { rotationBlocksHandInput, type HandCursorInput } from './handCursorTypes';

const HOVER = 'data-hand-hover';
const INTERACTIVE_TARGET = 'button, [role="button"], a, input[type="range"]';

/** Só o elemento do topo conta: o cursor não atravessa painéis para clicar no que está atrás. */
function targetAt(x: number, y: number): HTMLElement | null {
  const target = document.elementsFromPoint(x, y)[0]?.closest<HTMLElement>(INTERACTIVE_TARGET) ?? null;
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
export function useHandHitTest(input: HandCursorInput, active: boolean, onBack: () => void) {
  const { visible, x, y, pinchRelease, backProgress, rotationPhase } = input;
  const enabled = active && visible && input.synced && !rotationBlocksHandInput(rotationPhase);
  const hovered = useRef<HTMLElement | null>(null);
  const released = useRef(false);
  const backDone = useRef(false);

  useEffect(() => {
    // Clique e voltar valem só na subida do sinal, não a cada frame em que ele segue ligado.
    const click = pinchRelease && !released.current;
    released.current = pinchRelease;
    const target = enabled ? targetAt(x, y) : null;
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
    if (click && target) activate(target, x);
  }, [enabled, x, y, pinchRelease]);

  useEffect(() => {
    const complete = backProgress >= 1;
    if (enabled && complete && !backDone.current) onBack();
    backDone.current = complete;
  }, [enabled, backProgress, onBack]);

  useEffect(() => () => hovered.current?.removeAttribute(HOVER), []);
}
