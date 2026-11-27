import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Soft studio reflections for standard materials. The scene-wide disposal does not reach
 * `scene.environment`, so the caller must run the returned cleanup in its own dispose.
 */
export function addRoomEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, intensity = 0.4): () => void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  scene.environment = target.texture;
  scene.environmentIntensity = intensity;
  return () => {
    scene.environment = null;
    target.dispose();
  };
}
