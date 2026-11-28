// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { CameraPip } from '../src/ui/CameraPip';
import { LangProvider, useLang } from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LanguageToggle() {
  const { lang, setLang } = useLang();
  return <button type="button" onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}>{lang}</button>;
}

describe('CameraPip', () => {
  beforeEach(() => localStorage.setItem('nevergear-lang', 'pt'));

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
      root.render(<LangProvider><CameraPip {...props} cameraOn /></LangProvider>);
    });
    const expand = [...container.querySelectorAll('button')].find((button) => button.textContent === 'AMPLIAR');
    expect(expand).toBeDefined();
    await act(async () => {
      expand!.click();
    });
    expect(container.querySelector('aside')!.className).toContain('expanded');

    await act(async () => {
      root.render(<LangProvider><CameraPip {...props} cameraOn={false} /></LangProvider>);
    });
    expect(container.querySelector('aside')!.className).not.toContain('expanded');

    await act(async () => {
      root.render(<LangProvider><CameraPip {...props} cameraOn /></LangProvider>);
    });
    expect(container.querySelector('aside')!.className).not.toContain('expanded');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps the same <video> element mounted while the camera is off', async () => {
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
      root.render(<LangProvider><CameraPip {...props} cameraOn /></LangProvider>);
    });
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(props.videoRef.current).toBe(video);

    // PR #40 invariant: conditional mounting would swap the element and drop its srcObject.
    await act(async () => {
      root.render(<LangProvider><CameraPip {...props} cameraOn={false} /></LangProvider>);
    });
    expect(container.querySelector('video')).toBe(video);
    expect(props.videoRef.current).toBe(video);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('localizes worker fallback errors and updates them when the language changes', async () => {
    localStorage.setItem('nevergear-lang', 'en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      videoRef: createRef<HTMLVideoElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      cameraOn: true,
      status: 'GPU falhou (driver issue); fallback CPU também falhou (init error).',
      tracking: 'TRACKING',
      onStart: () => {},
      onStop: () => {},
    };
    try {
      await act(async () => root.render(<LangProvider><LanguageToggle /><CameraPip {...props} /></LangProvider>));
      expect(container.querySelector('.cam-status')?.textContent).toBe('GPU failed (driver issue); CPU fallback also failed (init error).');
      await act(async () => { container.querySelector('button')?.click(); });
      expect(container.querySelector('.cam-status')?.textContent).toBe('GPU falhou (driver issue); fallback CPU também falhou (init error).');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('localizes tracking labels for display while retaining the canonical tracking input', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      videoRef: createRef<HTMLVideoElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      cameraOn: true,
      status: '',
      tracking: 'TRACKING · CORRIDA',
      onStart: () => {},
      onStop: () => {},
    };

    try {
      await act(async () => root.render(<LangProvider><LanguageToggle /><CameraPip {...props} /></LangProvider>));
      expect(container.querySelector('.tracking-chip')?.textContent).toBe('RASTREANDO · CORRIDA');
      expect(props.tracking).toBe('TRACKING · CORRIDA');

      await act(async () => { container.querySelector('button')?.click(); });
      expect(container.querySelector('.tracking-chip')?.textContent).toBe('TRACKING · RUNNING');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
