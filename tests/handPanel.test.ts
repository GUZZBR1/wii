// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandPanel } from '../src/ui/HandPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('HandPanel preview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the hand overlay canvas above the reused camera preview', () => {
    const markup = renderToStaticMarkup(
      createElement(HandPanel, {
        sourceRef: createRef<HTMLVideoElement>(),
        canvasRef: createRef<HTMLCanvasElement>(),
        cameraOn: false,
        status: 'Câmera desligada',
        synced: false,
        onStart: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(markup).toContain('<video');
    expect(markup).toContain('<canvas');
    expect(markup.indexOf('<video')).toBeLessThan(markup.indexOf('<canvas'));
  });

  it('copies the source stream into the preview and plays it', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const source = document.createElement('video');
    const stream = new MediaStream();
    source.srcObject = stream;

    await act(async () => {
      root.render(createElement(HandPanel, {
        sourceRef: { current: source },
        canvasRef: createRef<HTMLCanvasElement>(),
        cameraOn: true,
        status: 'Câmera ligada',
        synced: false,
        onStart: vi.fn(),
        onClose: vi.fn(),
      }));
    });

    expect(container.querySelector('video')!.srcObject).toBe(stream);
    expect(play).toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
