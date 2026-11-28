// @vitest-environment happy-dom
import { act, createElement, useRef, useState, type ChangeEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandCursor } from '../src/ui/HandCursor';
import { HAND_IDLE, type HandCursorInput } from '../src/ui/handCursorTypes';
import { createHandInputStore, type HandInputStore, useHandInput } from '../src/ui/handInputStore';
import { useHandHitTest } from '../src/ui/useHandHitTest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tracked: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true, x: 20, y: 20 };

function SyncProbe({ store, onRender }: { store: HandInputStore; onRender: () => void }) {
  useHandInput(store, (hand) => hand.current.synced);
  onRender();
  return null;
}

describe('hand cursor DOM driver', () => {
  let frames: FrameRequestCallback[];
  let button: HTMLButtonElement;
  let hitTest: ReturnType<typeof vi.fn>;
  let unmount: () => void;

  const frame = (now: number) =>
    act(() => {
      for (const callback of frames.splice(0)) callback(now);
    });
  const publish = (store: HandInputStore, next: Partial<HandCursorInput>) =>
    act(() => store.publish({ ...tracked, ...next }));

  function render(onBack = vi.fn()) {
    const store = createHandInputStore();
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    act(() => root.render(createElement(HandCursor, { store, active: true, onBack })));
    unmount = () => act(() => root.unmount());
    return { store, onBack, cursor: container.querySelector<HTMLElement>('.hand-cursor')! };
  }

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      frames.length = 0;
    });
    button = document.body.appendChild(document.createElement('button'));
    hitTest = vi.fn(() => button);
    document.elementFromPoint = hitTest as unknown as typeof document.elementFromPoint;
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('glides between camera samples and snaps when the hand reappears', () => {
    const { store, cursor } = render();
    publish(store, { x: 100, y: 0 });
    frame(1000);
    expect(cursor.style.transform).toBe('translate3d(100px, 0px, 0)');

    publish(store, { x: 200, y: 0 });
    frame(1016);
    const x = Number(/translate3d\(([\d.]+)px/.exec(cursor.style.transform)![1]);
    expect(x).toBeGreaterThan(130);
    expect(x).toBeLessThan(200);

    publish(store, { visible: false, synced: false });
    frame(1032);
    expect(cursor.className).toContain('off');
    publish(store, { x: 500, y: 40 });
    frame(1048);
    expect(cursor.style.transform).toBe('translate3d(500px, 40px, 0)');
  });

  it('keeps gliding through a CPU camera interval instead of arriving in one display frame', () => {
    const { store, cursor } = render();
    publish(store, { x: 100, y: 0 });
    frame(1000);
    publish(store, { x: 200, y: 0 });
    frame(1016);
    frame(1032);
    const x = Number(/translate3d\(([\d.]+)px/.exec(cursor.style.transform)![1]);
    expect(x).toBeGreaterThan(140);
    expect(x).toBeLessThan(165);
  });

  it('hit-tests on movement or periodically, not on every display frame', () => {
    const { store } = render();
    publish(store, {});
    frame(1000);
    frame(1016);
    publish(store, { x: 21 });
    frame(1032);
    expect(hitTest).toHaveBeenCalledTimes(1);
    publish(store, { x: 60 });
    frame(1048);
    expect(hitTest).toHaveBeenCalledTimes(2);
    publish(store, { x: 60 });
    frame(2000);
    frame(2200);
    expect(hitTest).toHaveBeenCalledTimes(4);
  });

  it('clicks once per pinch pulse even when no display frame runs in between', () => {
    const click = vi.spyOn(button, 'click');
    const { store } = render();
    publish(store, { pinchRelease: true });
    publish(store, { pinchRelease: true });
    publish(store, {});
    publish(store, { pinchRelease: true });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('blocks hover and click while a rotation is committed, with no late click afterwards', () => {
    const click = vi.spyOn(button, 'click');
    const { store } = render();
    publish(store, { pinchRelease: true, rotationPhase: 'ROTATING' });
    frame(1000);
    expect(button.hasAttribute('data-hand-hover')).toBe(false);

    publish(store, { pinchRelease: true });
    frame(1016);
    expect(button.getAttribute('data-hand-hover')).toBe('true');
    expect(click).not.toHaveBeenCalled();
  });

  it('keeps hover during a mere rotation candidate', () => {
    const { store } = render();
    publish(store, { rotationPhase: 'ROTATION_CANDIDATE' });
    frame(1000);
    expect(button.getAttribute('data-hand-hover')).toBe('true');
  });

  it('goes back once per completed gesture and never during braking or snap', () => {
    const { store, onBack } = render();
    publish(store, { backProgress: 1, rotationPhase: 'BRAKING' });
    publish(store, { backProgress: 1, rotationPhase: 'SNAP_TO_CARD' });
    expect(onBack).not.toHaveBeenCalled();
    publish(store, {});
    publish(store, { backProgress: 1 });
    publish(store, { backProgress: 1 });
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('re-renders a subscriber only when its selected value changes, not per sample', () => {
    const store = createHandInputStore();
    const onRender = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => root.render(createElement(SyncProbe, { store, onRender })));
    publish(store, {});
    const renders = onRender.mock.calls.length;
    for (let x = 0; x < 30; x++) publish(store, { x });
    expect(onRender).toHaveBeenCalledTimes(renders);
  });
});

function ControlledSliderProbe({ store }: { store: HandInputStore }) {
  const [value, setValue] = useState(52);
  useHandHitTest(store, true, () => undefined, useRef(null));
  return createElement(
    'div',
    null,
    createElement('input', {
      type: 'range',
      min: 42,
      max: 62,
      step: 1,
      value,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(Number(event.target.value)),
    }),
    createElement('output', null, value),
  );
}

describe('useHandHitTest range sliders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('sets a React range slider from the horizontal pinch position', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const store = createHandInputStore();
    const idleInput: HandCursorInput = {
      ...HAND_IDLE,
      visible: true,
      synced: true,
      x: 150,
      y: 20,
      rotationPhase: 'IDLE',
    };
    store.publish(idleInput);
    act(() => {
      root.render(createElement(ControlledSliderProbe, { store }));
    });
    const slider = container.querySelector('input');
    expect(slider).not.toBeNull();
    if (!slider) return;
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 100, right: 300, width: 200, top: 0, bottom: 20, height: 20, x: 100, y: 0 }) as DOMRect,
    });
    document.elementFromPoint = vi.fn(() => slider as Element);

    act(() => {
      store.publish({ ...idleInput, pinchRelease: true });
    });

    expect(slider.value).toBe('47');
    expect(container.querySelector('output')?.textContent).toBe('47');
    act(() => {
      root.unmount();
    });
  });
});

function SiteProbe({ store, onEmptyClick }: { store: HandInputStore; onEmptyClick: () => void }) {
  const cursor = useRef<HTMLElement | null>(null);
  useHandHitTest(store, true, () => undefined, cursor, onEmptyClick);
  return null;
}

describe('hit test for the site hand', () => {
  let hit: Element;
  let store: HandInputStore;
  let frames: FrameRequestCallback[];
  let unmount: () => void;

  function mount(onEmptyClick = vi.fn()) {
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    act(() => root.render(createElement(SiteProbe, { store, onEmptyClick })));
    unmount = () => act(() => root.unmount());
    return onEmptyClick;
  }
  /** One camera sample followed by one display frame, late enough to hit-test again. */
  let now = 0;
  const sample = (next: Partial<HandCursorInput> = {}) => act(() => {
    store.publish({ ...tracked, ...next });
    now += 200;
    for (const callback of frames.splice(0)) callback(now);
  });

  beforeEach(() => {
    frames = [];
    store = createHandInputStore();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames.length = 0; });
    document.elementFromPoint = (() => hit) as typeof document.elementFromPoint;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it.each(['lang-anchor', 'article-explainer'])('keeps a %s marked across its padding, without clicking', (name) => {
    const panel = document.body.appendChild(document.createElement('span'));
    panel.className = name;
    const button = panel.appendChild(document.createElement('button'));
    const padding = panel.appendChild(document.createElement('span'));
    const click = vi.spyOn(button, 'click');
    hit = button;
    mount();
    sample();
    expect(panel.getAttribute('data-hand-within')).toBe('true');
    expect(button.getAttribute('data-hand-hover')).toBe('true');
    hit = padding;
    sample({ x: 40 });
    expect(button.hasAttribute('data-hand-hover')).toBe(false);
    expect(panel.getAttribute('data-hand-within')).toBe('true');
    sample({ x: 41, pinchRelease: true });
    expect(click).not.toHaveBeenCalled();
    unmount();
    expect(panel.hasAttribute('data-hand-within')).toBe(false);
  });

  it('forwards only pinches with nothing clickable under them', () => {
    const plain = document.body.appendChild(document.createElement('div'));
    const button = document.body.appendChild(document.createElement('button'));
    const click = vi.spyOn(button, 'click');
    hit = plain;
    const onEmptyClick = mount();
    sample({ y: 30, pinchRelease: true });
    expect(onEmptyClick).toHaveBeenCalledExactlyOnceWith(20, 30, plain);
    hit = button;
    sample();
    sample({ pinchRelease: true });
    expect(click).toHaveBeenCalledTimes(1);
    hit = plain;
    sample();
    sample({ visible: false, pinchRelease: true });
    expect(onEmptyClick).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('toggles details when the pinch target is a summary', () => {
    const details = document.body.appendChild(document.createElement('details'));
    const summary = details.appendChild(document.createElement('summary'));
    hit = summary;
    mount();
    sample({ pinchRelease: true });
    expect(details.open).toBe(true);
    sample();
    sample({ pinchRelease: true });
    expect(details.open).toBe(false);
    unmount();
  });
});
