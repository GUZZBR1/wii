// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteAsciiHand from '../src/components/SiteAsciiHand';
import { HAND_IDLE, type HandCursorInput } from '../src/ui/handCursorTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({ input: undefined as unknown }));

vi.mock('../src/app/SiteHandContext', () => ({
  useSiteHand: () => ({ camera: 'on', subscribe: () => () => undefined }),
  useSiteHandInput: () => harness.input,
}));
// No WebGL here: the pointer must keep working without the drawing.
vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    constructor() {
      throw new Error('no WebGL');
    }
  },
}));

let root: Root;
let container: HTMLDivElement;
const tracked: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true, x: 40, y: 50 };

const render = (onProduct: boolean, input: HandCursorInput, onBack: () => void) => {
  harness.input = input;
  return act(async () => {
    root.render(<SiteAsciiHand onProduct={onProduct} onBack={onBack} />);
  });
};

beforeEach(() => {
  document.elementsFromPoint = () => [];
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('SiteAsciiHand', () => {
  it('ignores the fist back gesture on /product only', async () => {
    const onBack = vi.fn();
    await render(true, { ...tracked, backProgress: 1 }, onBack);
    expect(onBack).not.toHaveBeenCalled();
    expect(container.querySelector('.site-tip-ring')).toBeNull();
    await render(false, tracked, onBack);
    await render(false, { ...tracked, backProgress: 1 }, onBack);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('draws no second hand: only feedback around the fingertip', async () => {
    await render(false, tracked, () => undefined);
    expect(container.querySelector('.site-tip')?.childElementCount).toBe(0);
    await render(false, { ...tracked, pinching: true }, () => undefined);
    expect(container.querySelector('.site-tip-pulse')).not.toBeNull();
    await render(false, { ...tracked, pinching: true, pinchRelease: true }, () => undefined);
    expect(container.querySelector('.site-tip-flash')).not.toBeNull();
  });
});
