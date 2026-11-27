import { describe, expect, it, vi } from 'vitest';
import { drawHand } from '../src/ui/PoseOverlay';
import { syntheticHand } from './fixtures/syntheticHand';

function makeCanvas() {
  const context = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, context };
}

const video = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;

describe('drawHand', () => {
  it('draws 21 landmarks and 21 connections in video coordinates', () => {
    const { canvas, context } = makeCanvas();
    const landmarks = syntheticHand().landmarks;

    drawHand(canvas, video, landmarks);

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 640, 480);
    expect(context.stroke).toHaveBeenCalledTimes(21);
    expect(context.arc).toHaveBeenCalledTimes(21);
    expect(context.fill).toHaveBeenCalledTimes(21);
    expect(context.moveTo).toHaveBeenNthCalledWith(1, landmarks[0]!.x * 640, landmarks[0]!.y * 480);
    expect(context.lineTo).toHaveBeenNthCalledWith(1, landmarks[1]!.x * 640, landmarks[1]!.y * 480);
  });

  it('clears the overlay when the hand is missing', () => {
    const { canvas, context } = makeCanvas();

    drawHand(canvas, video, syntheticHand().landmarks);
    vi.clearAllMocks();
    drawHand(canvas, video);

    expect(context.clearRect).toHaveBeenCalledOnce();
    expect(context.stroke).not.toHaveBeenCalled();
    expect(context.arc).not.toHaveBeenCalled();
  });
});
