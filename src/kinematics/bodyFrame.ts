import type { Point3, PoseSnapshot } from '../cv/protocol';
import { landmarkConfidence, midpoint } from './math';

const EPSILON = 1e-6;
const KNEE_CONFIDENCE_MIN = 0.55;
const MIN_LEG_SPAN = 0.1;

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

/** Unit direction from the hip midpoint to the shoulder midpoint in world space — the trunk's vertical axis. */
export function torsoUpDirection(snapshot: PoseSnapshot): Point3 | undefined {
  const leftShoulder = snapshot.worldLandmarks[11];
  const rightShoulder = snapshot.worldLandmarks[12];
  const leftHip = snapshot.worldLandmarks[23];
  const rightHip = snapshot.worldLandmarks[24];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
  return normalize(subtract(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip)));
}

/**
 * Standing vertical estimated from the legs: hip midpoint minus knee midpoint points up along
 * gravity regardless of trunk posture, so it stays correct under a forward slouch, camera tilt
 * and body yaw. Undefined when the knees are hidden or tucked.
 */
function legsVertical(snapshot: PoseSnapshot): Point3 | undefined {
  const leftHip = snapshot.worldLandmarks[23];
  const rightHip = snapshot.worldLandmarks[24];
  const leftKnee = snapshot.worldLandmarks[25];
  const rightKnee = snapshot.worldLandmarks[26];
  if (!leftHip || !rightHip || !leftKnee || !rightKnee) return undefined;
  if (landmarkConfidence(leftKnee, rightKnee) < KNEE_CONFIDENCE_MIN) return undefined;
  const span = subtract(midpoint(leftHip, rightHip), midpoint(leftKnee, rightKnee));
  if (Math.hypot(span.x, span.y, span.z) < MIN_LEG_SPAN) return undefined;
  return normalize(span);
}

/**
 * Lateral trunk lean, positive toward the player's right, measured against a standing-vertical
 * estimated from the legs when the knees are visible — so trunk posture, camera tilt and an
 * upright body turn do not read as lean — falling back to the calibrated trunk direction `up`
 * otherwise. The shoulder axis is projected onto the plane perpendicular to that vertical so
 * that rolling it together with the torso does not cancel the lean.
 */
export function torsoLeanRad(snapshot: PoseSnapshot, up: Point3): number | undefined {
  const leftShoulder = snapshot.worldLandmarks[11];
  const rightShoulder = snapshot.worldLandmarks[12];
  const leftHip = snapshot.worldLandmarks[23];
  const rightHip = snapshot.worldLandmarks[24];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
  const upDirection = legsVertical(snapshot) ?? normalize(up);
  if (!upDirection) return undefined;
  const across = subtract(rightShoulder, leftShoulder);
  const acrossUp = dot(across, upDirection);
  const side = normalize({
    x: across.x - upDirection.x * acrossUp,
    y: across.y - upDirection.y * acrossUp,
    z: across.z - upDirection.z * acrossUp,
  });
  if (!side) return undefined;

  const torso = subtract(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip));
  return Math.atan2(dot(torso, side), dot(torso, upDirection));
}
