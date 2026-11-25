import type { RefObject } from 'react';
import type { CalibrationProfile, Hand, LatencyTelemetry, PoseSnapshot } from '../cv/protocol';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  tracking: string;
  snapshot?: PoseSnapshot;
  calibration?: CalibrationProfile;
  hand: Hand;
  telemetry: LatencyTelemetry;
  calibrating: boolean;
  calibrationProgress: number;
  stability: StabilityBenchState;
  cadenceHistory: readonly number[];
  onStart: () => void;
  onStop: () => void;
  onHand: (hand: Hand) => void;
  onCalibrate: () => void;
  onStartStability: () => void;
}

export interface StabilityBenchState {
  active: boolean;
  remainingMs: number;
  counts: { steps: number; jumps: number; swings: number; laneChanges: number };
  maxLeanDeg: number;
  trackingLost: boolean;
  passed?: boolean;
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

export function CvLabTest(props: Props) {
  return <section className="camera-panel">
    <div className="panel-heading">
      <div><span className="eyebrow">BANCADA DE VISÃO</span><h2>CV telemetry</h2></div>
      <span className={`live-pill ${props.cameraOn ? 'is-live' : ''}`}><i />{props.cameraOn ? 'AO VIVO' : 'OFFLINE'}</span>
    </div>
    <div className="camera-feed">
      <video ref={props.videoRef} autoPlay muted playsInline />
      <canvas ref={props.canvasRef} />
      {!props.cameraOn && <div className="camera-placeholder"><span className="camera-icon">◉</span><strong>Sem sinal de câmera</strong><small>A captura só começa quando você autorizar.</small></div>}
      {props.cameraOn && <span className="tracking-chip">{props.tracking}</span>}
    </div>
    <div className="camera-status"><span className={`status-dot ${props.cameraOn ? 'green' : ''}`} />{props.status}</div>
    <div className="camera-actions">
      {!props.cameraOn ? <button type="button" className="button button-dark button-small" onClick={props.onStart}>Ativar câmera <span>↗</span></button> : <button type="button" className="button button-outline button-small" onClick={props.onStop}>Desligar</button>}
      <div className="hand-select">
        <button type="button" className={props.hand === 'left' ? 'selected' : ''} onClick={() => props.onHand('left')}>Canhoto</button>
        <button type="button" className={props.hand === 'right' ? 'selected' : ''} onClick={() => props.onHand('right')}>Destro</button>
      </div>
    </div>
    <button type="button" className="calibration-button" disabled={!props.cameraOn || props.tracking !== 'TRACKING' || props.calibrating} onClick={props.onCalibrate}>
      <span>{props.calibrating ? `Fique neutro · ${Math.round(props.calibrationProgress * 100)}%` : props.calibration ? '✓ Calibração concluída · recalibrar' : '01 / Calibrar postura · 3 s'}</span><span>→</span>
    </button>
    <div className="stability-bench">
      <div className="stability-heading"><span>02 / ESTABILIDADE · 15 S</span><b>{props.stability.active ? `${Math.ceil(props.stability.remainingMs / 1000)}s` : props.stability.passed === undefined ? '—' : props.stability.passed ? 'APROVADO' : 'REPETIR'}</b></div>
      <p>{props.stability.active ? 'Fique parado, com o corpo visível.' : props.stability.trackingLost ? 'Pose perdida durante a medição.' : props.stability.passed === undefined ? 'Em pé e imóvel: mede sinais falsos e oscilação do tronco.' : props.stability.passed ? 'Nenhuma ação falsa · tronco dentro de ±2°.' : 'Sinal falso ou oscilação acima de ±2°.'}</p>
      <div className="stability-counts"><span>PASSOS <b>{props.stability.counts.steps}</b></span><span>PULOS <b>{props.stability.counts.jumps}</b></span><span>SWINGS <b>{props.stability.counts.swings}</b></span><span>RAIAS <b>{props.stability.counts.laneChanges}</b></span><span>TRONCO <b>±{props.stability.maxLeanDeg.toFixed(1)}°</b></span></div>
      <button type="button" className="stability-button" disabled={!props.cameraOn || !props.calibration || props.tracking !== 'TRACKING' || props.calibrating || props.stability.active} onClick={props.onStartStability}>
        {props.stability.active ? 'Medição em andamento…' : 'Iniciar teste parado'}
      </button>
    </div>
    <div className="telemetry-grid">
      <Metric label="CAPTURA" value={`${props.telemetry.cameraFps.toFixed(0)} fps`} />
      <Metric label="INFERÊNCIA" value={`${props.telemetry.cvFps.toFixed(0)} fps`} />
      <Metric label="P95 CV" value={ms(props.telemetry.captureToResult.p95Ms)} />
      <Metric label="DELEGATE" value={props.telemetry.delegate} />
    </div>
    <div className="latency-list">
      <Latency label="Round trip" value={props.telemetry.captureToResult} />
      <Latency label="PoseLandmarker" value={props.telemetry.inference} />
      <Latency label="Cinemática" value={props.telemetry.kinematics} />
      <Latency label="Frame perdido" value={{ p50Ms: props.telemetry.droppedFrames, p95Ms: props.telemetry.droppedFrames }} count />
    </div>
    <div className="cadence-chart">
      <div><span>CADÊNCIA · SPM</span><strong>{Math.round(props.cadenceHistory.at(-1) ?? 0)}</strong></div>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Histórico de cadência">
        <polyline points={props.cadenceHistory.map((value, index) => `${index * 100 / Math.max(1, props.cadenceHistory.length - 1)},${29 - Math.min(1, value / 180) * 27}`).join(' ')} />
      </svg>
    </div>
    <p className="privacy-note">O vídeo é processado neste dispositivo. O MediaPipe pode enviar métricas de desempenho e uso da API ao Google.</p>
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Latency({ label, value, count = false }: { label: string; value: { p50Ms: number; p95Ms: number }; count?: boolean }) {
  return <div className="latency-row"><span>{label}</span><span>{count ? `${value.p95Ms} frames` : `p50 ${value.p50Ms.toFixed(1)} · p95 ${value.p95Ms.toFixed(1)} ms`}</span></div>;
}
