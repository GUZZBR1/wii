import { type RefObject, useEffect, useState } from 'react';
import { useLang } from '../i18n';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  tracking: string;
  onStart: () => void;
  onStop: () => void;
}

export function CameraPip(props: Props) {
  const { lang, tr } = useLang();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!props.cameraOn) setExpanded(false);
  }, [props.cameraOn]);

  return <aside
    className={expanded ? 'cam-pip expanded' : 'cam-pip'}
  >
    <div className="cam-feed">
      {/* Invariant (PR #40): this <video> is never conditional; replacing it would detach
          videoRef from srcObject and break capture. Keep it mounted. */}
      <video ref={props.videoRef} autoPlay muted playsInline />
      <canvas ref={props.canvasRef} />
      {!props.cameraOn && <div className="cam-empty"><strong>{tr('SEM SINAL', 'NO SIGNAL')}</strong><small>{tr('processado neste dispositivo', 'processed on this device')}</small></div>}
      {props.cameraOn && <span className="tracking-chip">{localizedTracking(props.tracking, lang)}</span>}
    </div>
    <div className="cam-bar">
      {!props.cameraOn ? <button type="button" className="pip-btn primary" onClick={props.onStart}>{tr('ATIVAR CÂMERA', 'TURN ON CAMERA')}</button> : <>
        <button type="button" className="pip-btn icon" onClick={props.onStop} title={tr('Desligar câmera', 'Turn off camera')}>⏻</button>
        <button type="button" className="pip-btn" onClick={() => setExpanded(!expanded)}>{expanded ? tr('MINIMIZAR', 'MINIMIZE') : tr('AMPLIAR', 'EXPAND')}</button>
      </>}
    </div>
    <div className="cam-status">{localizedStatus(props.status, lang)}</div>
  </aside>;
}

const CAMERA_STATUS_TEXT: Readonly<Record<string, { pt: string; en: string }>> = {
  'Permissão da câmera ainda não solicitada': { pt: 'Permissão da câmera ainda não solicitada', en: 'Camera permission has not been requested' },
  'Câmera desligada': { pt: 'Câmera desligada', en: 'Camera off' },
  'Não foi possível salvar a gravação.': { pt: 'Não foi possível salvar a gravação.', en: 'Could not save the recording.' },
  'Não foi possível salvar o trecho.': { pt: 'Não foi possível salvar o trecho.', en: 'Could not save the clip.' },
  'Não foi possível iniciar o modo de mão.': { pt: 'Não foi possível iniciar o modo de mão.', en: 'Could not start hand tracking.' },
  'Não foi possível iniciar o modo de pose.': { pt: 'Não foi possível iniciar o modo de pose.', en: 'Could not start pose tracking.' },
  'Não foi possível iniciar a visão.': { pt: 'Não foi possível iniciar a visão.', en: 'Could not start vision.' },
  'Prévia da câmera não está disponível.': { pt: 'Prévia da câmera não está disponível.', en: 'Camera preview is unavailable.' },
  'Não foi possível iniciar a câmera.': { pt: 'Não foi possível iniciar a câmera.', en: 'Could not start the camera.' },
  'Reinicializando em CPU; frame descartado.': { pt: 'Reinicializando em CPU; frame descartado.', en: 'Switching to CPU; frame dropped.' },
  'GPU falhou; próxima captura será processada em CPU.': { pt: 'GPU falhou; próxima captura será processada em CPU.', en: 'GPU failed; the next capture will use the CPU.' },
  'GPU indisponível; usando CPU.': { pt: 'GPU indisponível; usando CPU.', en: 'GPU unavailable; using the CPU.' },
  'Falha no Worker de visão.': { pt: 'Falha no Worker de visão.', en: 'Vision worker failed.' },
  'Inicialização do MediaPipe excedeu 30 segundos.': { pt: 'Inicialização do MediaPipe excedeu 30 segundos.', en: 'MediaPipe initialization timed out after 30 seconds.' },
  'Inicialização do Hand Landmarker excedeu 30 segundos.': { pt: 'Inicialização do Hand Landmarker excedeu 30 segundos.', en: 'Hand Landmarker initialization timed out after 30 seconds.' },
  'Hand Landmarker foi descartado durante a inicialização.': { pt: 'Hand Landmarker foi descartado durante a inicialização.', en: 'Hand Landmarker was disposed during initialization.' },
  '2D canvas is unavailable': { pt: 'Canvas 2D indisponível', en: '2D canvas is unavailable' },
  'PoseLandmarker is not initialized': { pt: 'PoseLandmarker não foi inicializado', en: 'PoseLandmarker is not initialized' },
  'HandLandmarker is not initialized': { pt: 'HandLandmarker não foi inicializado', en: 'HandLandmarker is not initialized' },
};

function localizedStatus(value: string, lang: 'pt' | 'en'): string {
  const exact = CAMERA_STATUS_TEXT[value];
  if (exact) return exact[lang];

  const portugueseFallback = value.match(/^GPU falhou \((.*)\); fallback CPU também falhou \((.*)\)\.$/);
  if (portugueseFallback && lang === 'en') return `GPU failed (${portugueseFallback[1]}); CPU fallback also failed (${portugueseFallback[2]}).`;

  const englishFallback = value.match(/^GPU failed \((.*)\); CPU fallback also failed \((.*)\)\.$/);
  if (englishFallback && lang === 'pt') return `GPU falhou (${englishFallback[1]}); fallback CPU também falhou (${englishFallback[2]}).`;

  const portugueseSlowGpu = value.match(/^GPU lento \(mediana (.+) ms\/frame — provável GL de software\)$/);
  if (portugueseSlowGpu && lang === 'en') return `GPU is slow (median ${portugueseSlowGpu[1]} ms/frame — software GL is likely).`;

  const englishSlowGpu = value.match(/^GPU is slow \(median (.+) ms\/frame — software GL is likely\)$/);
  if (englishSlowGpu && lang === 'pt') return `GPU lento (mediana ${englishSlowGpu[1]} ms/frame — provável GL de software)`;

  const missingModel = value.match(/^Model (.+) is missing from SHA256SUMS\.$/);
  if (missingModel) return lang === 'pt' ? `Modelo ${missingModel[1]} não está no SHA256SUMS.` : `Model ${missingModel[1]} is missing from SHA256SUMS.`;

  return value;
}

function localizedTracking(value: string, lang: 'pt' | 'en'): string {
  if (value === 'SEM POSE' || value === 'NO POSE') return lang === 'pt' ? 'SEM POSE' : 'NO POSE';
  if (value === 'PROCURANDO' || value === 'SEARCHING') return lang === 'pt' ? 'PROCURANDO' : 'SEARCHING';

  const activity = value.match(/^(?:TRACKING|RASTREANDO)(?: · (.+))?$/)?.[1];
  if (value === 'TRACKING' || value === 'RASTREANDO' || activity !== undefined) {
    const labels: Record<string, { pt: string; en: string }> = {
      PARADO: { pt: 'PARADO', en: 'IDLE' },
      IDLE: { pt: 'PARADO', en: 'IDLE' },
      CORRIDA: { pt: 'CORRIDA', en: 'RUNNING' },
      RUNNING: { pt: 'CORRIDA', en: 'RUNNING' },
      RAQUETE: { pt: 'RAQUETE', en: 'SWINGING' },
      SWINGING: { pt: 'RAQUETE', en: 'SWINGING' },
      LUTA: { pt: 'LUTA', en: 'FIGHTING' },
      FIGHTING: { pt: 'LUTA', en: 'FIGHTING' },
    };
    const prefix = lang === 'pt' ? 'RASTREANDO' : 'TRACKING';
    const translated = activity ? labels[activity]?.[lang] ?? activity : undefined;
    return translated ? `${prefix} · ${translated}` : prefix;
  }

  return value;
}
