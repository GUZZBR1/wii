import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FaceCache, type FaceTextureUploader } from '../src/mii/faceCache';
import { FaceVisibilityController } from '../src/mii/faceVisibility';
import { generateMiiFromSeed, type MiiFaceSpec } from '../src/mii/miiSpec';

function fakeTexture(): THREE.CanvasTexture {
  return new THREE.Texture() as THREE.CanvasTexture;
}

function cameraAtOrigin(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  return camera;
}

function setup(
  options: { enterDistance?: number; exitDistance?: number; graceMs?: number; buildsPerFrame?: number } = {},
) {
  const factory = vi.fn((_spec: MiiFaceSpec, _size: number) => fakeTexture());
  const cache = new FaceCache({ capacity: 8, textureFactory: (spec, size) => factory(spec, size) });
  const renderer: FaceTextureUploader = { initTexture: vi.fn() };
  const controller = new FaceVisibilityController({ cache, renderer, ...options });
  return { cache, controller, factory, renderer };
}

function target(spec: MiiFaceSpec, x: number, y: number, z: number) {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  const setTexture = vi.fn();
  return { object, setTexture, target: { spec, object, radius: 0.5, setTexture } };
}

describe('FaceVisibilityController', () => {
  it('does not generate a face outside the camera frustum or beyond the enter distance', () => {
    const { controller, factory } = setup({ enterDistance: 4, exitDistance: 6 });
    const camera = cameraAtOrigin();
    const behind = target(generateMiiFromSeed('behind'), 0, 0, 2);
    const distant = target(generateMiiFromSeed('distant'), 0, 0, -5);
    controller.register(behind.target);
    controller.register(distant.target);
    controller.update(camera, 0);
    expect(factory).not.toHaveBeenCalled();
    expect(behind.setTexture).not.toHaveBeenCalled();
    expect(distant.setTexture).not.toHaveBeenCalled();
  });

  it('builds and applies a texture for a visible near character', () => {
    const { controller, factory, renderer } = setup({ enterDistance: 10, exitDistance: 12 });
    const visible = target(generateMiiFromSeed('visible'), 0, 0, -4);
    controller.register(visible.target);
    controller.update(cameraAtOrigin(), 0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(renderer.initTexture).toHaveBeenCalledTimes(1);
    expect(visible.setTexture).toHaveBeenCalledTimes(1);
    expect(visible.setTexture.mock.calls[0]![0]).toBeInstanceOf(THREE.Texture);
  });

  it('uses distance hysteresis and a grace period instead of oscillating at the boundary', () => {
    const { controller, factory } = setup({ enterDistance: 5, exitDistance: 8, graceMs: 500 });
    const camera = cameraAtOrigin();
    const actor = target(generateMiiFromSeed('boundary'), 0, 0, -6);
    controller.register(actor.target);

    controller.update(camera, 0);
    expect(factory).not.toHaveBeenCalled(); // outside the tighter entry distance

    actor.object.position.z = -4;
    controller.update(camera, 100);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(actor.setTexture).toHaveBeenLastCalledWith(expect.any(THREE.Texture));

    actor.object.position.z = -6;
    controller.update(camera, 200);
    expect(actor.setTexture).not.toHaveBeenLastCalledWith(undefined); // inside the wider exit distance

    actor.object.position.z = -9;
    controller.update(camera, 300);
    controller.update(camera, 700);
    expect(actor.setTexture).not.toHaveBeenLastCalledWith(undefined); // still inside the grace period

    controller.update(camera, 801);
    expect(actor.setTexture).toHaveBeenLastCalledWith(undefined);
  });

  it('honours the per-frame build budget in nearest-first order', () => {
    const { controller, factory } = setup({ enterDistance: 12, exitDistance: 14, buildsPerFrame: 1 });
    const far = target(generateMiiFromSeed('far'), 0, 0, -7);
    const near = target(generateMiiFromSeed('near'), 0, 0, -3);
    const middle = target(generateMiiFromSeed('middle'), 0, 0, -5);
    controller.register(far.target);
    controller.register(near.target);
    controller.register(middle.target);

    controller.update(cameraAtOrigin(), 0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0]).toEqual(near.target.spec);
    expect(near.setTexture).toHaveBeenCalledTimes(1);
    expect(middle.setTexture).not.toHaveBeenCalled();
    expect(far.setTexture).not.toHaveBeenCalled();

    controller.update(cameraAtOrigin(), 16);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]![0]).toEqual(middle.target.spec);
  });
});
