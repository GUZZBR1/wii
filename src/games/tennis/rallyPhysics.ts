import { advanceBall, createBall, type BallState } from './ballistics';

export interface AdvancedPlayerShot {
  readonly ball: BallState;
  readonly netFault: boolean;
}

/** Advances a confirmed shot in fixed substeps and reports a net fault during that latency window. */
export function advancePlayerShotToNow(
  ballAtContact: BallState,
  outgoing: { readonly x: number; readonly y: number; readonly z: number },
  elapsedSeconds: number,
  netHeight: number,
): AdvancedPlayerShot {
  let ball = createBall(ballAtContact.position, outgoing, 'player');
  let remaining = Math.max(0, elapsedSeconds);

  while (remaining > 1e-12) {
    const dt = Math.min(1 / 60, remaining);
    const advanced = advanceBall(ball, dt);
    if (crossesNetBelowCord(ball, advanced, dt, netHeight)) return { ball: advanced, netFault: true };
    ball = advanced;
    remaining -= dt;
  }

  return { ball, netFault: false };
}

export function crossesNetBelowCord(before: BallState, after: BallState, elapsedSeconds: number, netHeight: number): boolean {
  const crossedPlane = before.position.z * after.position.z < 0
    || (before.position.z !== 0 && Math.sign(after.position.z) !== Math.sign(before.position.z));
  if (!crossedPlane) return false;

  const fraction = Math.abs(before.position.z) / (Math.abs(before.position.z) + Math.abs(after.position.z) + 1e-9);
  const ballAtNet = advanceBall(before, elapsedSeconds * fraction);
  return ballAtNet.position.y < netHeight && ballAtNet.position.y > -0.5;
}
