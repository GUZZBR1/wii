import * as THREE from 'three';
import type { FaceCache, FaceLease, FaceTextureUploader } from './faceCache';
import type { MiiFaceSpec } from './miiSpec';

export interface FaceVisibilityTarget {
  spec: MiiFaceSpec;
  /** Usually the curved face patch; its world position is the sampled head centre. */
  object: THREE.Object3D;
  /** Conservative world-space radius of the head before object scale. */
  radius: number;
  textureSize?: number;
  setTexture(texture: THREE.CanvasTexture | undefined): void;
}

interface TargetState {
  target: FaceVisibilityTarget;
  active: boolean;
  outSinceMs?: number;
  lease?: FaceLease;
  texture?: THREE.CanvasTexture;
  distanceSq: number;
}

export interface FaceVisibilityOptions {
  cache: FaceCache;
  renderer?: FaceTextureUploader;
  enterDistance?: number;
  exitDistance?: number;
  graceMs?: number;
  buildsPerFrame?: number;
}

const ENTER_RADIUS_SCALE = 0.86;
const EXIT_RADIUS_SCALE = 1.18;
const byDistance = (a: TargetState, b: TargetState) => a.distanceSq - b.distanceSq;

/**
 * Turns face texture ownership on and off from camera visibility. Entering uses the tighter
 * distance/frustum test, leaving the wider one, and only a failure sustained for `graceMs`
 * releases the lease; borderline camera movement therefore cannot oscillate texture ownership.
 */
export class FaceVisibilityController {
  private readonly cache: FaceCache;
  private readonly renderer?: FaceTextureUploader;
  private readonly enterDistanceSq: number;
  private readonly exitDistanceSq: number;
  private readonly graceMs: number;
  private readonly buildsPerFrame: number;
  private readonly states: TargetState[] = [];
  private readonly candidates: TargetState[] = [];
  /** Frame the build budget was last reset for; NaN never equals a timestamp, so the first update resets. */
  private lastFrameMs = Number.NaN;
  private frameBuilds = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projectionView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly position = new THREE.Vector3();

  constructor(options: FaceVisibilityOptions) {
    this.cache = options.cache;
    this.renderer = options.renderer;
    const enterDistance = options.enterDistance ?? 28;
    const exitDistance = options.exitDistance ?? 34;
    this.enterDistanceSq = enterDistance * enterDistance;
    this.exitDistanceSq = Math.max(exitDistance, enterDistance) ** 2;
    this.graceMs = options.graceMs ?? 500;
    this.buildsPerFrame = options.buildsPerFrame ?? 2;
  }

  register(target: FaceVisibilityTarget): void {
    this.states.push({ target, active: false, distanceSq: Number.POSITIVE_INFINITY });
  }

  private activate(state: TargetState, nowMs: number): void {
    state.active = true;
    state.outSinceMs = undefined;
    state.lease = this.cache.acquire(state.target.spec, state.target.textureSize ?? 128, nowMs);
  }

  private deactivate(state: TargetState, nowMs: number): void {
    state.active = false;
    state.outSinceMs = undefined;
    state.lease?.release(nowMs);
    state.lease = undefined;
    state.texture = undefined;
    state.target.setTexture(undefined);
  }

  update(camera: THREE.PerspectiveCamera, nowMs: number): void {
    // The budget is per rendered frame, not per call: a caller running inside fixed-step
    // sub-steps repeats the same wall timestamp, and those repeats share one budget.
    if (nowMs !== this.lastFrameMs) {
      this.lastFrameMs = nowMs;
      this.frameBuilds = 0;
    }
    camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView);

    let candidateCount = 0;
    for (const state of this.states) {
      state.target.object.getWorldPosition(this.position);
      state.distanceSq = this.position.distanceToSquared(camera.position);
      this.sphere.center.copy(this.position);
      this.sphere.radius = state.target.radius * (state.active ? EXIT_RADIUS_SCALE : ENTER_RADIUS_SCALE);
      // The cheap distance gate always runs before the plane-by-plane sphere/frustum test.
      const distanceLimitSq = state.active ? this.exitDistanceSq : this.enterDistanceSq;
      const visible = state.distanceSq <= distanceLimitSq && this.frustum.intersectsSphere(this.sphere);

      if (!state.active && visible) this.activate(state, nowMs);
      if (state.active) {
        if (visible) state.outSinceMs = undefined;
        else {
          state.outSinceMs ??= nowMs;
          if (nowMs - state.outSinceMs >= this.graceMs) this.deactivate(state, nowMs);
        }
      }
      if (state.active && candidateCount < this.candidates.length) this.candidates[candidateCount++] = state;
      else if (state.active) {
        this.candidates.push(state);
        candidateCount += 1;
      }
    }
    this.candidates.length = candidateCount;
    this.candidates.sort(byDistance);

    for (const state of this.candidates) {
      const { lease } = state;
      if (!lease) continue;
      this.cache.touch(lease, nowMs);
      if (!lease.texture && this.frameBuilds < this.buildsPerFrame) {
        if (this.cache.build(lease, this.renderer, nowMs)) this.frameBuilds += 1;
      }
      const texture = lease.texture;
      if (texture !== state.texture) {
        state.texture = texture;
        state.target.setTexture(texture);
      }
    }
  }

  dispose(nowMs = 0): void {
    for (const state of this.states) {
      if (state.active) this.deactivate(state, nowMs);
    }
    this.states.length = 0;
    this.candidates.length = 0;
  }
}
