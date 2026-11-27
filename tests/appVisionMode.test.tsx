// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '../src/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captures = vi.hoisted(() => ({
  gameProps: undefined as { onExit?: () => void } | undefined,
  handBegins: 0,
  handPauses: 0,
  poseBegins: 0,
  posePauses: 0,
}));

vi.mock('../src/ui/WiiSplash', () => ({ WiiSplash: () => null }));

vi.mock('../src/ui/GameCanvas', async () => {
  const React = await import('react');
  return {
    GameCanvas: (props: { onExit?: () => void }) => {
      captures.gameProps = props;
      return React.createElement('div');
    },
  };
});

vi.mock('../src/cv/poseClient', () => ({
  PoseClient: class {
    static warmVisionAssets(): void {}
    readonly delegate = 'GPU';
    isReady = true;
    init(): Promise<void> { return Promise.resolve(); }
    beginCapture(): void { captures.poseBegins += 1; }
    pauseCapture(): void { captures.posePauses += 1; }
    dispose(): void {}
  },
}));

vi.mock('../src/cv/handClient', () => ({
  HandClient: class {
    static warmVisionAssets(): void {}
    isReady = true;
    init(): Promise<void> { return Promise.resolve(); }
    beginCapture(): void { captures.handBegins += 1; }
    pauseCapture(): void { captures.handPauses += 1; }
    dispose(): void {}
  },
}));

it('switches the camera back to hand tracking when play exits to the games menu', async () => {
  const stream = new MediaStream();
  Object.assign(stream, { getTracks: () => [] });
  const getUserMedia = vi.fn(async () => stream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 2, configurable: true });
  Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', { value: 2, configurable: true });
  window.matchMedia = (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => { button!.click(); });
  };

  try {
    await act(async () => { root.render(<App />); });
    await click('ATIVAR CÂMERA');
    await act(flush);
    expect(captures.handBegins).toBe(1);

    await act(async () => { container.querySelector<HTMLButtonElement>('.channel.sports')!.click(); });
    await click('Tênis'); // brings the card to the front
    await click('Tênis');
    await act(flush);
    expect(captures.gameProps).toBeDefined();
    expect(captures.poseBegins).toBe(1);
    expect(captures.handPauses).toBe(1);

    await act(async () => { captures.gameProps?.onExit?.(); });
    await act(flush);
    expect(captures.posePauses).toBe(1);
    expect(captures.handBegins).toBe(2);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
