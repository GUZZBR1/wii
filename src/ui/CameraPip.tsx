import { type RefObject, useEffect, useState } from 'react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  tracking: string;
  calibrationPhase: 'framing' | 'settling' | 'collecting' | 'done';
  calibrationProgress: number;
  onStart: () => void;
  onStop: () => void;
  onRecalibrate: () => void;
}

function guidance(phase: Props['calibrationPhase'], progress: number): string {
  if (phase === 'framing') return 'Afaste-se até aparecer dos ombros aos joelhos, com as mãos visíveis';
  if (phase === 'settling') return 'Isso! Fique parado, em pé';
  if (phase === 'collecting') return `Calibrando… ${Math.round(progress * 100)}%`;
  return 'Calibrado ✓';
}

export function CameraPip(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const calibrated = props.calibrationPhase === 'done';

  useEffect(() => { setExpanded(props.cameraOn); }, [props.cameraOn]);
  // Deixa o "Calibrado" visível por um instante antes de voltar para o canto.
  useEffect(() => {
    if (!calibrated) return;
    const timer = window.setTimeout(() => setExpanded(false), 1500);
    return () => window.clearTimeout(timer);
  }, [calibrated]);

  return <aside className={expanded ? 'cam-pip expanded' : 'cam-pip'}>
    <div className="cam-feed">
      <video ref={props.videoRef} autoPlay muted playsInline />
      <canvas ref={props.canvasRef} />
      {!props.cameraOn && <div className="cam-empty"><strong>SEM SINAL</strong><small>processado neste dispositivo</small></div>}
      {props.cameraOn && <span className="tracking-chip">{props.tracking}</span>}
      {props.cameraOn && <output className={calibrated ? 'cam-guide ok' : 'cam-guide'}>{guidance(props.calibrationPhase, props.calibrationProgress)}</output>}
    </div>
    <div className="cam-bar">
      {!props.cameraOn ? <button type="button" className="pip-btn primary" onClick={props.onStart}>ATIVAR CÂMERA</button> : <>
        <button type="button" className="pip-btn icon" onClick={props.onStop} title="Desligar câmera">⏻</button>
        <button type="button" className="pip-btn" onClick={() => setExpanded(!expanded)}>{expanded ? 'MINIMIZAR' : 'AMPLIAR'}</button>
        <button type="button" className="pip-btn" onClick={() => { props.onRecalibrate(); setExpanded(true); }}>RECALIBRAR</button>
      </>}
    </div>
    <div className="cam-status">{props.status}</div>
  </aside>;
}
