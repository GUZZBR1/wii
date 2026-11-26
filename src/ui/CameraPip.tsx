import { type RefObject, useEffect, useState } from 'react';
import type { Sport } from './GameCanvas';

interface Props {
  hidden?: boolean;
  sport?: Sport;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  tracking: string;
  onStart: () => void;
  onStop: () => void;
}

function guidance(sport: Sport): string {
  return sport !== 'tennis'
    ? 'Enquadre a cabeça e o torso até o quadril'
    : 'Enquadre a cabeça e o torso até o quadril, com as mãos visíveis';
}

export function CameraPip(props: Props) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!props.cameraOn) setExpanded(false);
  }, [props.cameraOn]);

  return <aside
    className={expanded ? 'cam-pip expanded' : 'cam-pip'}
    aria-hidden={props.hidden || undefined}
    hidden={props.hidden}
  >
    <div className="cam-feed">
      <video ref={props.videoRef} autoPlay muted playsInline />
      <canvas ref={props.canvasRef} />
      {!props.cameraOn && <div className="cam-empty"><strong>SEM SINAL</strong><small>processado neste dispositivo</small></div>}
      {props.cameraOn && <span className="tracking-chip">{props.tracking}</span>}
      {props.cameraOn && props.sport && <output className="cam-guide">{guidance(props.sport)}</output>}
    </div>
    <div className="cam-bar">
      {!props.cameraOn ? <button type="button" className="pip-btn primary" onClick={props.onStart}>ATIVAR CÂMERA</button> : <>
        <button type="button" className="pip-btn icon" onClick={props.onStop} title="Desligar câmera">⏻</button>
        <button type="button" className="pip-btn" onClick={() => setExpanded(!expanded)}>{expanded ? 'MINIMIZAR' : 'AMPLIAR'}</button>
      </>}
    </div>
    <div className="cam-status">{props.status}</div>
  </aside>;
}
