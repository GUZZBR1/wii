import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalibrationProfile, Hand, LatencyTelemetry, PoseSnapshot, SportActionEvent } from './cv/protocol';
import { Calibrator } from './cv/calibrator';
import { LatencyTelemetryStore } from './cv/latencyTelemetry';
import { PoseClient } from './cv/poseClient';
import { ActionPipeline } from './kinematics/actionPipeline';
import { torsoLeanDeltaRad } from './kinematics/postureSignals';
import { OneEuroFilter } from './cv/oneEuroFilter';
import { ProceduralAudio } from './games/audio';
import { ArenaHub } from './ui/ArenaHub';
import { CvLabTest, type StabilityBenchState } from './ui/CvLabTest';
import { CvTelemetryOverlay } from './ui/CvTelemetryOverlay';
import { GameCanvas, type GameEngineHandle, type Sport } from './ui/GameCanvas';
import { drawPose } from './ui/PoseOverlay';
import './styles.css';

const EMPTY_TELEMETRY: LatencyTelemetry = {
  captureToResult: { p50Ms: 0, p95Ms: 0 }, inference: { p50Ms: 0, p95Ms: 0 },
  kinematics: { p50Ms: 0, p95Ms: 0 }, eventToRender: { p50Ms: 0, p95Ms: 0 },
  cameraFps: 0, cvFps: 0, renderFps: 0, droppedFrames: 0, delegate: 'GPU', sampleCount: 0,
};

const IDLE_STABILITY: StabilityBenchState = {
  active: false, remainingMs: 0, counts: { steps: 0, jumps: 0, swings: 0, laneChanges: 0 },
  maxLeanDeg: 0, trackingLost: false,
};

export default function App() {
  const [sport, setSport] = useState<Sport>('track');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [telemetry, setTelemetry] = useState(EMPTY_TELEMETRY);
  const [snapshot, setSnapshot] = useState<PoseSnapshot>();
  const [profile, setProfile] = useState<CalibrationProfile>();
  const [hand, setHand] = useState<Hand>('right');
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [cvOverlay, setCvOverlay] = useState(false);
  const [muted, setMuted] = useState(false);
  const [stability, setStability] = useState(IDLE_STABILITY);
  const [cadenceHistory, setCadenceHistory] = useState<number[]>(Array(32).fill(0));
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
  const telemetryRef = useRef(new LatencyTelemetryStore());
  const audioRef = useRef(new ProceduralAudio());
  const lastUiRef = useRef(0);
  const stabilityRef = useRef(IDLE_STABILITY);
  const stabilityEndRef = useRef<number | undefined>(undefined);
  const stabilityLeanFilterRef = useRef(new OneEuroFilter({ minCutoff: 1, beta: 0.5 }));
  const cadenceHistoryRef = useRef<number[]>(Array(32).fill(0));
  const cadenceRef = useRef(0);
  const lastCadenceSampleRef = useRef(0);
  const handRef = useRef(hand);
  handRef.current = hand;
  const snapshotRef = useRef<PoseSnapshot | undefined>(undefined);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTelemetry(telemetryRef.current.snapshot());
      if (snapshotRef.current) setSnapshot(snapshotRef.current);
      if (performance.now() - lastCadenceSampleRef.current >= 250) {
        lastCadenceSampleRef.current = performance.now();
        cadenceHistoryRef.current = [...cadenceHistoryRef.current.slice(-31), cadenceRef.current];
        setCadenceHistory(cadenceHistoryRef.current);
      }
      if (calibratingRef.current) {
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
      }
      if (stabilityRef.current.active && stabilityEndRef.current !== undefined) {
        const remainingMs = Math.max(0, stabilityEndRef.current - performance.now());
        if (remainingMs === 0) {
          const result = { ...stabilityRef.current, active: false, remainingMs: 0 };
          result.passed = !result.trackingLost && result.maxLeanDeg <= 2 && Object.values(result.counts).every((count) => count === 0);
          stabilityRef.current = result;
          stabilityEndRef.current = undefined;
          setStability(result);
        } else setStability({ ...stabilityRef.current, remainingMs });
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  const onRender = useCallback((timeMs: number) => { telemetryRef.current.recordRender(timeMs); }, []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    telemetryRef.current.markEvent(event.id, event.timestampMs);
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
    stabilityRef.current = IDLE_STABILITY;
    stabilityEndRef.current = undefined;
    setStability(IDLE_STABILITY);
    calibratingRef.current = false;
    setCalibrating(false);
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    cadenceRef.current = 0;
    cadenceHistoryRef.current = Array(32).fill(0);
    setCadenceHistory(cadenceHistoryRef.current);
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
        onDrop: () => telemetryRef.current.dropped(),
        onPose: (raw, capturedAtMs) => {
          const result = pipelineRef.current.update(raw, profileRef.current);
          const current = result.snapshot;
          snapshotRef.current = current;
          setTracking(current.trackingState === 'tracked' ? 'TRACKING' : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO');
          if (calibratingRef.current) calibratorRef.current.add(current);
          drawPose(overlayRef.current, videoRef.current, current);
          telemetryRef.current.recordFrame(capturedAtMs, current.receivedAtMs, current.inferenceMs, result.kinematicsMs, current.delegate);
          const sprint = result.events.find((event) => event.type === 'sprint');
          if (sprint?.type === 'sprint') cadenceRef.current = sprint.cadenceSpm;
          if (stabilityRef.current.active) {
            const next = { ...stabilityRef.current, counts: { ...stabilityRef.current.counts } };
            if (current.trackingState !== 'tracked') next.trackingLost = true;
            else if (profileRef.current) {
              const leanRad = stabilityLeanFilterRef.current.filter(torsoLeanDeltaRad(current, profileRef.current), current.timestampMs);
              next.maxLeanDeg = Math.max(next.maxLeanDeg, Math.abs(leanRad) * 180 / Math.PI);
            }
            for (const event of result.events) {
              if (event.type === 'step') next.counts.steps += 1;
              if (event.type === 'jump') next.counts.jumps += 1;
              if (event.type === 'swing') next.counts.swings += 1;
              if (event.type === 'lane') next.counts.laneChanges += 1;
            }
            stabilityRef.current = next;
          }
          for (const event of result.events) dispatchEvent(event);
          if (performance.now() - lastUiRef.current > 200) {
            lastUiRef.current = performance.now();
            setSnapshot(current);
          }
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

  const startStabilityTest = useCallback(() => {
    if (!cameraOn || !profileRef.current || tracking !== 'TRACKING') return;
    stabilityLeanFilterRef.current.reset();
    stabilityEndRef.current = performance.now() + 15_000;
    const next = { ...IDLE_STABILITY, active: true, remainingMs: 15_000 };
    stabilityRef.current = next;
    setStability(next);
  }, [cameraOn, tracking]);

  const changeHand = useCallback((next: Hand) => {
    handRef.current = next; setHand(next); profileRef.current = undefined; setProfile(undefined);
    calibratorRef.current.reset(); calibratingRef.current = false; setCalibrating(false);
  }, []);
  const toggleMute = useCallback(() => {
    void audioRef.current.unlock();
    setMuted((value) => { audioRef.current.setMuted(!value); return !value; });
  }, []);

  const delegateLabel = telemetry.delegate === 'GPU' ? 'GPU DELEGATE' : 'CPU FALLBACK';

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
        <div className="session-card"><span className="eyebrow">SESSÃO ATUAL</span><strong>{profile ? 'PLAYER CALIBRADO' : 'PRONTO PARA COMEÇAR'}</strong><small>{profile ? `MÃO ${profile.dominantHand === 'right' ? 'DIREITA' : 'ESQUERDA'} · BASELINE SALVO` : 'Ative a câmera e faça a calibração inicial.'}</small><div className="session-line"><span>ESTADO DA VISÃO</span><b className={tracking === 'TRACKING' ? 'text-green' : ''}>{tracking}</b></div><div className="session-line"><span>PROCESSAMENTO</span><b>{delegateLabel}</b></div></div>
        <div className="corner-stamp">NO<br />DOWNLOAD<br /><b>NEEDED</b></div>
      </div>
    </section>

    <div className="section-title"><div><span className="eyebrow">ESCOLHA SUA ARENA</span><h2>Qual vai ser?</h2></div><span className="section-count">02 MODOS DISPONÍVEIS <i>↘</i></span></div>
    <ArenaHub sport={sport} onSport={setSport} />

    <section className="arena-layout">
      <div className="arena-main">
        <GameCanvas key={sport} sport={sport} onEngine={onEngine} onRender={onRender} telemetry={telemetry} tracking={tracking} />
        {cvOverlay && <CvTelemetryOverlay telemetry={telemetry} />}
        <div className="below-game"><span><b>COMO JOGAR</b> {sport === 'track' ? 'Corra no lugar para ganhar velocidade. Pule e troque de raia para vencer.' : 'Faça o movimento de raquete. A força e a direção do braço definem a jogada.'}</span><button type="button" className={`telemetry-toggle ${cvOverlay ? 'active' : ''}`} onClick={() => setCvOverlay((v) => !v)}><span className="target-icon">◎</span> CV TELEMETRY {cvOverlay ? 'ON' : 'OFF'}</button></div>
      </div>
      <aside className="arena-side">
        <CvLabTest
          videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
          snapshot={snapshot} calibration={profile} hand={hand} telemetry={telemetry} calibrating={calibrating}
          calibrationProgress={calibrationProgress} stability={stability} cadenceHistory={cadenceHistory} onStart={() => void startCamera()} onStop={stopCamera}
          onHand={changeHand} onCalibrate={startCalibration}
          onStartStability={startStabilityTest}
        />
      </aside>
    </section>

    <footer className="footer"><span>WII WEB SPORTS <b>·</b> HACK BRASIL 2026</span><span>CV {telemetry.cvFps.toFixed(0)} FPS <b>·</b> RENDER {telemetry.renderFps.toFixed(0)} FPS <b>·</b> P95 {telemetry.captureToResult.p95Ms.toFixed(1)} MS</span></footer>
  </main>;
}
