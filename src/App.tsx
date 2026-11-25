import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalibrationProfile, Hand, SportActionEvent } from './cv/protocol';
import { Calibrator } from './cv/calibrator';
import { PoseClient } from './cv/poseClient';
import { ActionPipeline } from './kinematics/actionPipeline';
import { ProceduralAudio } from './games/audio';
import { ArenaHub } from './ui/ArenaHub';
import { CameraPanel } from './ui/CameraPanel';
import { GameCanvas, type GameEngineHandle, type Sport } from './ui/GameCanvas';
import { drawPose } from './ui/PoseOverlay';
import './styles.css';

export default function App() {
  const [sport, setSport] = useState<Sport>('track');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [profile, setProfile] = useState<CalibrationProfile>();
  const [hand, setHand] = useState<Hand>('right');
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<PoseClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const calibratorRef = useRef(new Calibrator());
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const calibratingRef = useRef(false);
  const calibrationStartedRef = useRef(0);
  const audioRef = useRef(new ProceduralAudio());
  const handRef = useRef(hand);
  handRef.current = hand;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!calibratingRef.current) return;
      const progress = Math.min(1, (performance.now() - calibrationStartedRef.current) / 3000);
      setCalibrationProgress(progress);
      if (progress >= 1) {
        const nextProfile = calibratorRef.current.finish(handRef.current);
        calibratingRef.current = false;
        setCalibrating(false);
        if (nextProfile) {
          profileRef.current = nextProfile;
          setProfile(nextProfile);
          setCameraStatus('Calibração aprovada · postura neutra salva');
        } else setCameraStatus('Calibração incompleta · enquadre o corpo inteiro e tente de novo');
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    engineRef.current?.onAction(event);
    if (event.type === 'swing') audioRef.current.hit(event.power01);
    if (event.type === 'jump') audioRef.current.jump();
    if (event.type === 'step') audioRef.current.step(event.side);
  }, []);

  const stopCamera = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setTracking('SEM POSE');
    setCameraStatus('Câmera desligada');
    pipelineRef.current.reset();
    calibratorRef.current.reset();
    calibratingRef.current = false;
    setCalibrating(false);
    drawPose(overlayRef.current, videoRef.current);
  }, []);

  const startCamera = useCallback(async () => {
    try {
      await audioRef.current.unlock();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Prévia da câmera não está disponível.');
      video.srcObject = stream;
      await video.play();
      await new Promise<void>((resolve) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) resolve();
        else video.addEventListener('loadeddata', () => resolve(), { once: true });
      });
      const client = new PoseClient();
      clientRef.current = client;
      setCameraOn(true);
      setCameraStatus('Carregando motor de visão…');
      await client.start(video, {
        onStatus: (status, detail) => {
          setCameraStatus(detail);
          if (status === 'error') { setTracking('SEM POSE'); stopCamera(); setCameraStatus(detail); }
        },
        onPose: (raw) => {
          const result = pipelineRef.current.update(raw, profileRef.current);
          const current = result.snapshot;
          setTracking(current.trackingState === 'tracked' ? 'TRACKING' : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO');
          if (calibratingRef.current) calibratorRef.current.add(current);
          drawPose(overlayRef.current, videoRef.current, current);
          for (const event of result.events) dispatchEvent(event);
        },
      });
    } catch (error) {
      stopCamera();
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar a câmera.');
    }
  }, [stopCamera, dispatchEvent]);

  const startCalibration = useCallback(() => {
    if (!cameraOn) return;
    handRef.current = hand;
    calibratorRef.current.start(performance.now());
    calibrationStartedRef.current = performance.now();
    calibratingRef.current = true;
    setCalibrationProgress(0);
    setCalibrating(true);
    setCameraStatus('Fique em pé, neutro e com o corpo enquadrado por 3 segundos.');
  }, [cameraOn, hand]);

  const changeHand = useCallback((next: Hand) => {
    handRef.current = next; setHand(next); profileRef.current = undefined; setProfile(undefined);
    calibratorRef.current.reset(); calibratingRef.current = false; setCalibrating(false);
  }, []);
  const toggleMute = useCallback(() => {
    void audioRef.current.unlock();
    setMuted((value) => { audioRef.current.setMuted(!value); return !value; });
  }, []);

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Wii Web Sports início"><span className="brand-mark"><i /><i /></span><span>WII<span className="brand-light">WEB</span><small>SPORTS ARENA</small></span></a>
      <div className="topbar-center"><span className="live-indicator" />HACK BRASIL 2026 <b>/</b> PROTÓTIPO INTERATIVO</div>
      <button type="button" className="button button-outline sound-button" onClick={toggleMute}>{muted ? 'ÁUDIO OFF' : 'ÁUDIO ON'} <span>{muted ? '×' : '♫'}</span></button>
    </header>

    <section className="hero-row">
      <div className="hero-copy">
        <span className="eyebrow"><span className="orange-square" /> MOVIMENTO REAL. JOGO DE VERDADE.</span>
        <h1>Seu corpo<br />é o <em>controle.</em></h1>
        <p>Uma arena arcade que transforma movimento em jogo — direto no navegador, sem controles e sem instalação.</p>
        <div className="hero-meta"><span>01 CÂMERA</span><span>02 MODALIDADES</span><span>100% LOCAL</span></div>
      </div>
      <div className="hero-aside">
        <div className="session-card"><span className="eyebrow">SESSÃO ATUAL</span><strong>{profile ? 'PLAYER CALIBRADO' : 'PRONTO PARA COMEÇAR'}</strong><small>{profile ? `MÃO ${profile.dominantHand === 'right' ? 'DIREITA' : 'ESQUERDA'} · BASELINE SALVO` : 'Ative a câmera e faça a calibração inicial.'}</small><div className="session-line"><span>ESTADO DA VISÃO</span><b className={tracking === 'TRACKING' ? 'text-green' : ''}>{tracking}</b></div></div>
        <div className="corner-stamp">NO<br />DOWNLOAD<br /><b>NEEDED</b></div>
      </div>
    </section>

    <div className="section-title"><div><span className="eyebrow">ESCOLHA SUA ARENA</span><h2>Qual vai ser?</h2></div><span className="section-count">02 MODOS DISPONÍVEIS <i>↘</i></span></div>
    <ArenaHub sport={sport} onSport={setSport} />

    <section className="arena-layout">
      <div className="arena-main">
        <GameCanvas key={sport} sport={sport} onEngine={onEngine} tracking={tracking} />
        <div className="below-game"><span><b>COMO JOGAR</b> {sport === 'track' ? 'Corra no lugar para ganhar velocidade. Pule e troque de raia para vencer.' : 'Faça o movimento de raquete. A força e a direção do braço definem a jogada.'}</span></div>
      </div>
      <aside className="arena-side">
        <CameraPanel
          videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
          calibration={profile} hand={hand} calibrating={calibrating} calibrationProgress={calibrationProgress}
          onStart={() => void startCamera()} onStop={stopCamera} onHand={changeHand} onCalibrate={startCalibration}
        />
      </aside>
    </section>

    <footer className="footer"><span>WII WEB SPORTS <b>·</b> HACK BRASIL 2026</span><span>SEU CORPO <b>·</b> SEU CONTROLE</span></footer>
  </main>;
}
