import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CameraPip } from '../src/ui/CameraPip';

describe('CameraPip visibility', () => {
  it('keeps the capture video mounted while the panel hides the PiP', () => {
    const markup = renderToStaticMarkup(
      createElement(CameraPip, {
        hidden: true,
        videoRef: createRef<HTMLVideoElement>(),
        canvasRef: createRef<HTMLCanvasElement>(),
        cameraOn: false,
        status: 'Câmera desligada',
        tracking: 'SEM POSE',
        onStart: vi.fn(),
        onStop: vi.fn(),
      }),
    );

    expect(markup).toContain('<aside');
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('<video');
  });
});
