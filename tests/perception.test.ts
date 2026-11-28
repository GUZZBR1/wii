import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import * as flags from '../src/cv/diagnostics/flags';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { EXIT_DODGE_SW } from '../src/kinematics/postureSignals';
import { Perception, type PoseIntake } from '../src/perception';
import type { GameEngineHandle } from '../src/ui/GameCanvas';
import { pose } from './fixtures/syntheticPose';

const emptyIntake: PoseIntake = {
  engine: () => null,
  overlay: () => ({ canvas: null, video: null }),
};

afterEach(() => vi.restoreAllMocks());

describe('Perception', () => {
  it('forgets the calibrated profile on reset before processing new frames', () => {
    const pipelineUpdate = vi.spyOn(ActionPipeline.prototype, 'update');
    const perception = new Perception();
    for (let time = 0; time <= 700; time += 35) perception.update(pose(time), 'athletics', emptyIntake);
    expect(pipelineUpdate.mock.lastCall?.[1]).toBeDefined();

    perception.reset(emptyIntake);
    perception.update(pose(735), 'athletics', emptyIntake);
    expect(pipelineUpdate.mock.lastCall?.[1]).toBeUndefined();
  });

  it('uses the boxing dodge threshold when calibrating', () => {
    const update = vi.spyOn(AdaptiveCalibrator.prototype, 'update');
    new Perception().update(pose(0), 'boxing', emptyIntake);
    expect(update.mock.lastCall?.[2]).toBe(EXIT_DODGE_SW);
  });

  it('reports hidden hips to the engine and preserves the diagnostic pose rate', () => {
    vi.spyOn(flags, 'diagnosticsEnabled').mockReturnValue(true);
    const setHipsHidden = vi.fn();
    const setPoseTracking = vi.fn();
    const engine = { setHipsHidden, setPoseTracking } as unknown as GameEngineHandle;
    const intake: PoseIntake = { ...emptyIntake, engine: () => engine };
    const perception = new Perception();
    for (let time = 0; time < 700; time += 35) perception.update(pose(time), 'boxing', intake);
    const frame = perception.update(pose(700, { hiddenLandmarks: [23, 24] }), 'boxing', intake);
    expect(setHipsHidden).toHaveBeenCalledWith(true, 700);
    expect(frame.trackingLabel).toMatch(/\d+ q\/s CPU/);
    expect(setPoseTracking).toHaveBeenCalledWith(frame.trackingLabel, 700);
  });
});
