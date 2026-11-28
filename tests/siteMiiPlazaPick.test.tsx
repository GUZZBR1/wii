// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteMiiPlaza from '../src/components/SiteMiiPlaza';
import { LangProvider } from '../src/i18n';
import { pickMiiAt } from '../src/miis/miiPick';
import { BOTTOM_MARGIN, SIDE_MARGIN, TOP_MARGIN } from '../src/miis/miiSimulation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
  },
}));

// A cara do Mii é rasterizada em canvas 2D, que o happy-dom não implementa; a geometria segue real.
vi.mock('../src/mii/faceRenderer', async (original) => {
  const THREE = await import('three');
  return {
    ...(await original<typeof import('../src/mii/faceRenderer')>()),
    createMiiFaceTexture: () => new THREE.CanvasTexture(),
  };
});

let container: HTMLDivElement;
let root: Root;

const renderPlaza = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <LangProvider>
          <SiteMiiPlaza />
        </LangProvider>
      </MemoryRouter>,
    );
  });
};

// Com o Math.random fixo e sem movimento, todos começam no mesmo ponto, já na página.
const spot = () => {
  const height = Math.max(document.body.scrollHeight, window.innerHeight);
  return {
    x: SIDE_MARGIN + 0.05 * (1000 - SIDE_MARGIN * 2),
    y: TOP_MARGIN + 0.05 * (height - TOP_MARGIN - BOTTOM_MARGIN),
  };
};
const bubbleHidden = () => document.querySelector<HTMLElement>('.mii-grump')!.hidden;
let frames: FrameRequestCallback[] = [];
const paint = () => act(() => frames.splice(0).forEach((frame) => frame(performance.now())));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Os quadros só rodam quando o teste pede; sem movimento, os walkers não saem do lugar.
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    query.includes('prefers-reduced-motion') ? ({ matches: true } as MediaQueryList) : matchMedia(query),
  );
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(Math, 'random').mockReturnValue(0.05);
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SiteMiiPlaza pick pela mão', () => {
  it('incomoda o Mii quando a pinça cai sobre ele, sem abrir cartão', async () => {
    await renderPlaza();
    const { x, y } = spot();
    act(() => pickMiiAt(x, y, document.body));
    paint();
    expect(bubbleHidden()).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('não reage quando a pinça cai longe de qualquer Mii', async () => {
    await renderPlaza();
    act(() => pickMiiAt(-100, -100, document.body));
    paint();
    expect(bubbleHidden()).toBe(true);
  });

  it('não reage quando há conteúdo da página na frente', async () => {
    await renderPlaza();
    const { x, y } = spot();
    const button = document.createElement('button');
    document.body.appendChild(button);
    act(() => pickMiiAt(x, y, button));
    paint();
    expect(bubbleHidden()).toBe(true);
  });

  it('o clique do mouse incomoda pelas mesmas coordenadas', async () => {
    await renderPlaza();
    const { x, y } = spot();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    });
    paint();
    expect(bubbleHidden()).toBe(false);
  });
});
