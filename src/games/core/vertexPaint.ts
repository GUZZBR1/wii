import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Bakes a color into the vertices, so differently colored parts can share one draw call. Consumes `source`:
 * the returned geometry replaces it, so callers never dispose the argument.
 */
export function paint(source: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const { r, g, b } = new THREE.Color(color);
  const colors = new Float32Array(geometry.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([r, g, b], i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Merges and frees the parts. They must agree on attributes and on being indexed or not. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Geometrias incompatíveis: os atributos das partes não batem.');
  return merged;
}
