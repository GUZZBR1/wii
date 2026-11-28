// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteMiiPlaza from '../src/components/SiteMiiPlaza';
import { LangProvider } from '../src/i18n';
import { pickMiiAt } from '../src/miis/miiPick';

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

// O Mii do jogador sempre começa no centro da largura, a 75% da janela: posição determinística.
// Os CPUs ficam empilhados longe daí pelo Math.random fixo, então só o jogador cobre o ponto.
const playerSpot = () => ({
  x: document.documentElement.clientWidth * 0.5,
  y: window.scrollY + window.innerHeight * 0.75,
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  // Sem o loop de render, os walkers não saem do lugar e o pick fica determinístico.
  vi.stubGlobal('requestAnimationFrame', () => 1);
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
  it('abre o cartão do Mii quando a pinça cai sobre ele fora de controles', async () => {
    await renderPlaza();
    const { x, y } = playerSpot();
    act(() => pickMiiAt(x, y, document.body));
    const card = document.querySelector('.mii-card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Your Mii');
  });

  it('não abre cartão quando a pinça cai longe de qualquer Mii', async () => {
    await renderPlaza();
    act(() => pickMiiAt(-100, -100, document.body));
    expect(document.querySelector('.mii-card')).toBeNull();
  });

  it('mantém as exclusões da praça à frente do pick: canvas no topo fecha o cartão', async () => {
    await renderPlaza();
    const { x, y } = playerSpot();
    act(() => pickMiiAt(x, y, document.body));
    expect(document.querySelector('.mii-card')).not.toBeNull();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    act(() => pickMiiAt(x, y, canvas));
    expect(document.querySelector('.mii-card')).toBeNull();
  });

  it('pinça dentro do cartão aberto não o fecha', async () => {
    await renderPlaza();
    const { x, y } = playerSpot();
    act(() => pickMiiAt(x, y, document.body));
    const card = document.querySelector('.mii-card');
    expect(card).not.toBeNull();
    act(() => pickMiiAt(x, y, card as Element));
    expect(document.querySelector('.mii-card')).not.toBeNull();
  });

  it('clique de mouse continua abrindo o cartão pelas mesmas coordenadas', async () => {
    await renderPlaza();
    const { x, y } = playerSpot();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    });
    expect(document.querySelector('.mii-card')).not.toBeNull();
  });
});
