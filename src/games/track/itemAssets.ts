import * as THREE from 'three';
import type { ItemKind } from './hurdleFlow';

/**
 * Owns the geometry and materials every track item shares. Instances only reference them, so
 * despawning is a plain `scene.remove`; `dispose` frees them once, after the items left the scene
 * (otherwise the scene-wide disposal would free them a second time).
 */
export class ItemAssets {
  private readonly stripeGeometry = new THREE.CylinderGeometry(0.09, 0.09, 0.26, 12).rotateZ(Math.PI / 2);
  private readonly postGeometry = new THREE.CapsuleGeometry(0.09, 0.84, 4, 12);
  private readonly coinGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.09, 16);
  private readonly orangeMaterial = new THREE.MeshLambertMaterial({ color: 0xff7a1a, flatShading: true });
  private readonly whiteMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private readonly coinMaterial = new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0x8a6d00, emissiveIntensity: 0.7, flatShading: true });

  create(kind: ItemKind): THREE.Group {
    const group = new THREE.Group();
    if (kind === 'coin') {
      const coin = new THREE.Mesh(this.coinGeometry, this.coinMaterial);
      coin.rotation.x = Math.PI / 2; coin.position.y = 1; group.add(coin);
      return group;
    }
    // Five stripes keep the bar (1.3) inside one 1.5 lane, orange at both ends.
    for (let i = -2; i <= 2; i += 1) { const stripe = new THREE.Mesh(this.stripeGeometry, i % 2 ? this.whiteMaterial : this.orangeMaterial); stripe.position.set(i * 0.26, 0.9, 0); group.add(stripe); }
    for (const side of [-1, 1]) { const post = new THREE.Mesh(this.postGeometry, this.whiteMaterial); post.position.set(side * 0.6, 0.51, 0); group.add(post); }
    return group;
  }

  dispose(): void {
    for (const resource of [this.stripeGeometry, this.postGeometry, this.coinGeometry, this.orangeMaterial, this.whiteMaterial, this.coinMaterial]) resource.dispose();
  }
}
