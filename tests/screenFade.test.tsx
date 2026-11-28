// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScreenFade } from '../src/ui/useScreenFade';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let go: (to: string) => void = () => undefined;

function Probe({ show }: { show: (to: string) => void }) {
  const fade = useScreenFade(show);
  go = fade.go;
  return createElement(Fragment, null, fade.veil);
}

function start(reducedMotion: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })));
  const container = document.createElement('div');
  const root = createRoot(container);
  const show = vi.fn();
  act(() => root.render(createElement(Probe, { show })));
  act(() => go('games'));
  const end = () => act(() => {
    container.querySelector('.screen-fade')?.dispatchEvent(new Event('animationend', { bubbles: true }));
  });
  return { container, root, show, end };
}

afterEach(() => vi.unstubAllGlobals());

describe('useScreenFade', () => {
  it('swaps the screen at full white and then removes the veil', () => {
    const { container, root, show, end } = start(false);
    expect(show).not.toHaveBeenCalled();
    end();
    expect(show).toHaveBeenCalledWith('games');
    expect(container.querySelector('.screen-fade.in')).not.toBeNull();
    end();
    expect(container.querySelector('.screen-fade')).toBeNull();
    expect(show).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('swaps at once with reduced motion', () => {
    const { container, root, show } = start(true);
    expect(show).toHaveBeenCalledWith('games');
    expect(container.querySelector('.screen-fade')).toBeNull();
    act(() => root.unmount());
  });
});
