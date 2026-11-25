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

export function CameraPip(props: Props) {
  return <aside className="cam-pip">
    <div className="cam-feed">
      <video ref={props.videoRef} autoPlay muted playsInline />
      <canvas ref={props.canvasRef} />
      {!props.cameraOn && <div className="cam-empty"><strong>SEM SINAL</strong><small>processado neste dispositivo</small></div>}
      {props.cameraOn && <span className="tracking-chip">{props.tracking}</span>}
    </div>
    <div className="cam-bar">
      {!props.cameraOn ? <button type="button" className="pip-btn primary" onClick={props.onStart}>ATIVAR CÂMERA</button> : <>
        <button type="button" className="pip-btn icon" onClick={props.onStop} title="Desligar câmera">⏻</button>
        <div className="hand-select">
          <button type="button" className={props.hand === 'left' ? 'selected' : ''} onClick={() => props.onHand('left')} title="Canhoto">L</button>
          <button type="button" className={props.hand === 'right' ? 'selected' : ''} onClick={() => props.onHand('right')} title="Destro">R</button>
        </div>
        <button type="button" className="pip-btn" disabled={props.tracking !== 'TRACKING' || props.calibrating} onClick={props.onCalibrate} title="Calibrar postura neutra">
          {props.calibrating ? `${Math.round(props.calibrationProgress * 100)}%` : props.calibration ? '✓ CAL' : 'CALIBRAR'}
        </button>
      </>}
    </div>
    <div className="cam-status">{props.status}</div>
  </aside>;
}
