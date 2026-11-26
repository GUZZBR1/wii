// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CameraPip } from '../src/ui/CameraPip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CameraPip', () => {
  it('keeps the video element mounted while the PiP is hidden', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const videoRef = createRef<HTMLVideoElement>();
    const props = {
      videoRef,
      canvasRef: createRef<HTMLCanvasElement>(),
      status: '',
      tracking: 'TRACKING',
      onStart: () => {},
      onStop: () => {},
    };

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    const video = videoRef.current;
    expect(video).not.toBeNull();
    expect(video!.isConnected).toBe(true);

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn hidden />);
    });
    const pip = container.querySelector('aside')!;
    expect(pip.hidden).toBe(true);
    expect(pip.getAttribute('aria-hidden')).toBe('true');
    expect(videoRef.current).toBe(video);
    expect(video!.isConnected).toBe(true);

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    expect(container.querySelector('aside')!.hidden).toBe(false);
    expect(videoRef.current).toBe(video);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('uses torso framing for running sports and wrist framing for tennis', () => {
    const props = {
      videoRef: createRef<HTMLVideoElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      cameraOn: true,
      status: '',
      tracking: 'TRACKING',
      onStart: () => {},
      onStop: () => {},
    };

    const athletics = renderToStaticMarkup(<CameraPip {...props} sport="athletics" />);
    expect(athletics).toContain('Enquadre a cabeça e o torso até o quadril');
    expect(athletics).not.toContain('mãos visíveis');
    expect(renderToStaticMarkup(<CameraPip {...props} sport="tennis" />)).toContain('mãos visíveis');
  });

  it('collapses when the camera turns off and stays collapsed when it returns', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      videoRef: createRef<HTMLVideoElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      status: '',
      tracking: 'TRACKING',
      onStart: () => {},
      onStop: () => {},
    };

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    const expand = [...container.querySelectorAll('button')].find((button) => button.textContent === 'AMPLIAR');
    expect(expand).toBeDefined();
    await act(async () => {
      expand!.click();
    });
    expect(container.querySelector('aside')!.className).toContain('expanded');

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn={false} />);
    });
    expect(container.querySelector('aside')!.className).not.toContain('expanded');

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    expect(container.querySelector('aside')!.className).not.toContain('expanded');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
