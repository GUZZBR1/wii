// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '../src/i18n';
import GameplayVideo from '../src/components/GameplayVideo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ObserverTarget = Element;

class MockIntersectionObserver {
  private readonly callback: IntersectionObserverCallback;
  private readonly targets: ObserverTarget[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observerInstances.push(this);
  }

  observe(target: ObserverTarget) {
    this.targets.push(target);
  }

  unobserve(target: ObserverTarget) {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }

  disconnect() {
    this.targets.length = 0;
  }

  trigger(isIntersecting: boolean, intersectionRatio: number) {
    const entries = this.targets.map(
      (target) => ({ target, isIntersecting, intersectionRatio }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

const observerInstances: MockIntersectionObserver[] = [];
let playMock: ReturnType<typeof vi.fn>;
let pauseMock: ReturnType<typeof vi.fn>;

function mockMotionPreference(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

async function renderVideo(sport: 'athletics' | 'tennis' | 'boxing' = 'tennis') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        LangProvider,
        null,
        createElement(GameplayVideo, { sport, name: { pt: 'Tênis', en: 'Tennis' } }),
      ),
    );
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

async function setVisible(isIntersecting: boolean, ratio = isIntersecting ? 1 : 0) {
  await act(async () => {
    for (const observer of observerInstances) observer.trigger(isIntersecting, ratio);
  });
}

async function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function clickControl(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>('.gameplay-video-control');
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
  });
}

describe('GameplayVideo', () => {
  beforeEach(() => {
    observerInstances.length = 0;
    localStorage.clear();
    localStorage.setItem('nevergear-lang', 'en');
    mockMotionPreference(false);
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    playMock = vi.fn().mockResolvedValue(undefined);
    pauseMock = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: playMock });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pauseMock });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.body.innerHTML = '';
  });

  it('renders the poster and sources lazily without playing before entering the viewport', async () => {
    const { container, root } = await renderVideo('tennis');

    const video = container.querySelector<HTMLVideoElement>('video');
    expect(video).toBeTruthy();
    expect(video!.getAttribute('poster')).toBe('/gameplay/tennis.jpg');
    expect(video!.getAttribute('preload')).toBe('none');
    expect(video!.hasAttribute('muted')).toBe(true);
    expect(video!.hasAttribute('loop')).toBe(true);
    const sources = [...video!.querySelectorAll('source')].map((source) => source.getAttribute('src'));
    expect(sources).toEqual(['/gameplay/tennis.webm', '/gameplay/tennis.mp4']);
    expect(playMock).not.toHaveBeenCalled();

    await unmount(root);
  });

  it('plays when the frame enters the viewport and pauses when it leaves', async () => {
    const { root } = await renderVideo();

    await setVisible(true);
    expect(playMock).toHaveBeenCalledTimes(1);

    playMock.mockClear();
    await setVisible(false);
    expect(pauseMock).toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();

    await unmount(root);
  });

  it('does not play when only a sliver of the frame is visible', async () => {
    const { root } = await renderVideo();

    await setVisible(true, 0.05);
    expect(playMock).not.toHaveBeenCalled();

    await unmount(root);
  });

  it('keeps playing through partial scrolls once fully visible (hysteresis)', async () => {
    const { root } = await renderVideo();

    await setVisible(true, 0.6);
    expect(playMock).toHaveBeenCalledTimes(1);

    pauseMock.mockClear();
    // Saiu para 10% visivel: nem entra nem sai — mantem o estado anterior.
    await setVisible(true, 0.1);
    expect(pauseMock).not.toHaveBeenCalled();

    await setVisible(false, 0);
    expect(pauseMock).toHaveBeenCalled();

    await unmount(root);
  });

  it('pauses while the tab is hidden and resumes when it returns', async () => {
    const { root } = await renderVideo();
    await setVisible(true);
    expect(playMock).toHaveBeenCalledTimes(1);

    await setTabHidden(true);
    expect(pauseMock).toHaveBeenCalled();

    pauseMock.mockClear();
    playMock.mockClear();
    await setTabHidden(false);
    expect(playMock).toHaveBeenCalledTimes(1);

    await unmount(root);
  });

  it('stays paused for reduced-motion users until they opt in with the button', async () => {
    mockMotionPreference(true);
    // O estado inicial e lido na montagem: remonta para valer a preferencia.
    const { container, root } = await renderVideo();

    await setVisible(true);
    expect(playMock).not.toHaveBeenCalled();

    await clickControl(container);
    expect(playMock).toHaveBeenCalledTimes(1);

    await unmount(root);
  });

  it('keeps the user pause across viewport re-entries', async () => {
    const { container, root } = await renderVideo();
    await setVisible(true);
    expect(playMock).toHaveBeenCalledTimes(1);

    await clickControl(container);
    expect(pauseMock).toHaveBeenCalled();

    playMock.mockClear();
    pauseMock.mockClear();
    await setVisible(false);
    await setVisible(true);
    expect(playMock).not.toHaveBeenCalled();

    await unmount(root);
  });

  it('falls back to the poster image when the sources fail', async () => {
    const { container, root } = await renderVideo();
    const video = container.querySelector<HTMLVideoElement>('video');
    expect(video).toBeTruthy();

    await act(async () => {
      video!.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(container.querySelector('video')).toBeNull();
    const fallback = container.querySelector<HTMLImageElement>('.gameplay-video-frame img');
    expect(fallback).toBeTruthy();
    expect(fallback!.getAttribute('src')).toBe('/gameplay/tennis.jpg');
    expect(container.querySelector('.gameplay-video-control')).toBeNull();

    await unmount(root);
  });
});
