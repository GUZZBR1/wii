import type { Point3, PoseSnapshot } from '../cv/protocol';
import { midpoint } from './math';

const EPSILON = 1e-6;

function subtract(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector: Point3): Point3 | undefined {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude < EPSILON) return undefined;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function cross(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function bodyLocalPoint(
  point: Point3,
  shoulder: Point3,
  leftShoulder: Point3,
  rightShoulder: Point3,
  leftHip: Point3,
  rightHip: Point3,
  scale: number,
): Point3 | undefined {
  if (!Number.isFinite(scale) || scale <= EPSILON) return undefined;
  const side = normalize(subtract(rightShoulder, leftShoulder));
  if (!side) return undefined;

  const shoulders = midpoint(leftShoulder, rightShoulder);
  const hips = midpoint(leftHip, rightHip);
  const torso = subtract(shoulders, hips);
  const torsoProjection = dot(torso, side);
  const up = normalize({
    x: torso.x - side.x * torsoProjection,
    y: torso.y - side.y * torsoProjection,
    z: torso.z - side.z * torsoProjection,
  });
  if (!up) return undefined;
  const depth = normalize(cross(side, up));
  if (!depth) return undefined;

  const relative = subtract(point, shoulder);
  return {
    x: dot(relative, side) / scale,
    y: dot(relative, up) / scale,
    z: dot(relative, depth) / scale,
  };
}

export function torsoLeanRad(snapshot: PoseSnapshot): number | undefined {
  const leftShoulder = snapshot.worldLandmarks[11];
  const rightShoulder = snapshot.worldLandmarks[12];
  const leftHip = snapshot.worldLandmarks[23];
  const rightHip = snapshot.worldLandmarks[24];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
  const side = normalize(subtract(rightShoulder, leftShoulder));
  if (!side) return undefined;

  const torso = subtract(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip));
  return Math.atan2(dot(torso, side), torso.y);
}
