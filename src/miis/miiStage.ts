import * as THREE from 'three';
import { disposeObjectTree } from '../games/core/GameLoop';

export interface MiiStageOptions {
  /** Camera placement; the default frames a full-body Mii. */
  camera?: {
    position: [number, number, number];
    lookAt: [number, number, number];
    fov?: number;
    near?: number;
    far?: number;
  };
  /** Pointer drag turns the content group. Off for stages driven by their own animation. */
  drag?: boolean;
  /** Draw on every frame (animated scenes) instead of only after a change. Default: true. */
  animate?: boolean;
  /** The default hemisphere/key pair. Owners with their own lighting pass `false` and light the scene. */
  lights?: boolean;
  /** Device pixel ratio ceiling; scenes with many Miis stay lower. */
  maxPixelRatio?: number;
}

export interface MiiStage {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Put the models here: dragging turns this group, not the individual Miis. */
  readonly content: THREE.Group;
  render(): void;
  /** The yaw dragging produced, for owners that animate their content instead. */
  yaw(): number;
  dispose(): void;
}

const BODY_CAMERA: Required<NonNullable<MiiStageOptions['camera']>> = {
  position: [0, 1.5, 5.2],
  lookAt: [0, 1.02, 0],
  fov: 30,
  near: 0.1,
  far: 40,
};
const PITCH_LIMIT = 0.45;

/** Returns `undefined` when the browser cannot create a WebGL context for this host. */
export function createMiiStage(host: HTMLElement, options: MiiStageOptions = {}): MiiStage | undefined {
  const {
    position,
    lookAt,
    fov = BODY_CAMERA.fov,
    near = BODY_CAMERA.near,
    far = BODY_CAMERA.far,
  } = options.camera ?? BODY_CAMERA;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return undefined;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 1.5));
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
  if (options.lights !== false) {
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(1, 2, 3);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.8), sun);
  }
  const content = new THREE.Group();
  scene.add(content);

  const render = () => renderer.render(scene, camera);
  // A restored context is empty until the next draw, which on-demand stages would never do.
  renderer.domElement.addEventListener('webglcontextrestored', render);
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const detach: (() => void)[] = [];
  if (options.drag) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const down = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      host.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!dragging) return;
      content.rotation.y += (event.clientX - lastX) * 0.012;
      content.rotation.x = THREE.MathUtils.clamp(
        content.rotation.x + (event.clientY - lastY) * 0.008,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
      lastX = event.clientX;
      lastY = event.clientY;
      render();
    };
    const up = () => {
      dragging = false;
    };
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    detach.push(
      () => host.removeEventListener('pointerdown', down),
      () => host.removeEventListener('pointermove', move),
      () => host.removeEventListener('pointerup', up),
      () => host.removeEventListener('pointercancel', up),
    );
  }

  let frame = 0;
  if (options.animate !== false) {
    const tick = () => {
      render();
      frame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  return {
    scene,
    camera,
    renderer,
    content,
    render,
    yaw: () => content.rotation.y,
    dispose() {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      for (const remove of detach) remove();
      renderer.domElement.removeEventListener('webglcontextrestored', render);
      disposeObjectTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
