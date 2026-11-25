import type { LatencyTelemetry } from '../cv/protocol';

export function CvTelemetryOverlay({ telemetry }: { telemetry: LatencyTelemetry }) {
  return <div className="cv-overlay-strip">
    <span>CV PIPELINE</span>
    <b>CAPTURA → RESULTADO · p50 {telemetry.captureToResult.p50Ms.toFixed(1)} / p95 {telemetry.captureToResult.p95Ms.toFixed(1)} ms</b>
    <b>POSE · p50 {telemetry.inference.p50Ms.toFixed(1)} / p95 {telemetry.inference.p95Ms.toFixed(1)} ms</b>
    <b>CINEMÁTICA · p50 {telemetry.kinematics.p50Ms.toFixed(1)} / p95 {telemetry.kinematics.p95Ms.toFixed(1)} ms</b>
    <b>EVENTO → RENDER · p50 {telemetry.eventToRender.p50Ms.toFixed(1)} / p95 {telemetry.eventToRender.p95Ms.toFixed(1)} ms</b>
    <b>{telemetry.delegate}</b>
  </div>;
}
