import type { RefObject } from 'react';
import type { CalibrationProfile, Hand } from '../cv/protocol';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  tracking: string;
  calibration?: CalibrationProfile;
  hand: Hand;
  calibrating: boolean;
  calibrationProgress: number;
  onStart: () => void;
  onStop: () => void;
  onHand: (hand: Hand) => void;
  onCalibrate: () => void;
}

export function CameraPanel(props: Props) {
  return <section className="camera-panel">
    <div className="panel-heading">
      <div><span className="eyebrow">CÂMERA</span><h2>Preview</h2></div>
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
      <span>{props.calibrating ? `Fique neutro · ${Math.round(props.calibrationProgress * 100)}%` : props.calibration ? '✓ Calibração concluída · recalibrar' : 'Calibrar postura · 3 s'}</span><span>→</span>
    </button>
    <p className="privacy-note">O vídeo é processado neste dispositivo. O MediaPipe pode enviar métricas de desempenho e uso da API ao Google.</p>
  </section>;
}
