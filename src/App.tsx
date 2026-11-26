import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CalibrationProfile, SportActionEvent } from './cv/protocol';
import { AutoCalibrator, type CalibrationPhase } from './cv/autoCalibrator';
import { HandClient } from './cv/handClient';
import { observeEarlyRejection } from './cv/observeEarlyRejection';
import { PoseClient, type PoseClientCallbacks } from './cv/poseClient';
import { ActionPipeline } from './kinematics/actionPipeline';
import { ContextClassifier, type ActivityKind } from './kinematics/contextClassifier';
import { HandCursorDetector } from './kinematics/handCursor';
import { ProceduralAudio } from './games/audio';
import { CameraPip } from './ui/CameraPip';
import { GameCanvas, type GameEngineHandle, type Sport } from './ui/GameCanvas';
import { HandCursor } from './ui/HandCursor';
import { HandPanel } from './ui/HandPanel';
import { HAND_IDLE } from './ui/handCursorTypes';
import { drawPose } from './ui/PoseOverlay';
import { GamesMenu, HomeMenu, TitleMenu } from './ui/WiiMenu';
import { WiiSplash } from './ui/WiiSplash';
import './arena.css';

type Screen = 'calibration' | 'home' | 'title' | 'games' | 'play';
type VisionMode = 'hand' | 'pose';

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  idle: 'PARADO',
  running: 'CORRIDA',
  swinging: 'RAQUETE',
  striking: 'LUTA',
};
const MUTE_STORAGE_KEY = 'wii-web-sports.muted.v1';

const inHandMenu = (screen: Screen) => screen === 'home' || screen === 'title' || screen === 'games';
const modeForScreen = (screen: Screen): VisionMode => (inHandMenu(screen) ? 'hand' : 'pose');

function readMutedPreference(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMutedPreference(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    void 0;
  }
}

export default function App({ exit }: { exit?: ReactNode }) {
  const [splash, setSplash] = useState(true);
  const [screen, setScreen] = useState<Screen>('calibration');
  const [sport, setSport] = useState<Sport>('track');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [calibrationPhase, setCalibrationPhase] = useState<CalibrationPhase>('framing');
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [muted, setMuted] = useState(readMutedPreference);
  const [handPanelOpen, setHandPanelOpen] = useState(false);
  const [handInput, setHandInput] = useState(HAND_IDLE);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const poseClientRef = useRef<PoseClient | undefined>(undefined);
  const handClientRef = useRef<HandClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const contextRef = useRef(new ContextClassifier());
  const calibratorRef = useRef(new AutoCalibrator());
  const handDetectorRef = useRef(new HandCursorDetector());
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const visionModeRef = useRef<VisionMode>('pose');
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const audioRef = useRef(new ProceduralAudio());
  const cameraAttemptRef = useRef(0);

  useEffect(() => {
    audioRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    void navigator.permissions?.query({ name: 'camera' as PermissionName }).then((permission) => {
      if (permission.state === 'granted') PoseClient.warmVisionAssets();
    }).catch(() => undefined);
    return () => {
      cameraAttemptRef.current += 1;
      poseClientRef.current?.dispose();
      handClientRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => { track.stop(); });
      streamRef.current = undefined;
      audioRef.current.dispose();
    };
  }, []);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    if (!engineRef.current) return;
    engineRef.current.onAction(event);
    if (event.type === 'jump') audioRef.current.jump();
    if (event.type === 'step') audioRef.current.step(event.side);
  }, []);

  const recalibrate = useCallback(() => {
    profileRef.current = undefined;
    calibratorRef.current.reset();
    setCalibrationPhase('framing');
    setCalibrationProgress(0);
  }, []);

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current += 1;
    poseClientRef.current?.pauseCapture();
    handClientRef.current?.pauseCapture();
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setTracking('SEM POSE');
    setCameraStatus('Câmera desligada');
    setHandInput(HAND_IDLE);
    handDetectorRef.current.reset();
    for (const event of pipelineRef.current.reset()) dispatchEvent(event);
    contextRef.current.reset();
    recalibrate();
    drawPose(overlayRef.current, videoRef.current);
  }, [dispatchEvent, recalibrate]);

  const poseCallbacksRef = useRef<PoseClientCallbacks | undefined>(undefined);
  poseCallbacksRef.current = {
    onStatus: (status, detail) => {
      setCameraStatus(detail);
      if (status === 'error') {
        setTracking('SEM POSE');
        stopCamera();
        setCameraStatus(detail);
      }
    },
    onPose: (raw) => {
      const result = pipelineRef.current.update(raw, profileRef.current);
      const current = result.snapshot;
      if (!profileRef.current) {
        const step = calibratorRef.current.update(current, { needsWrists: sportRef.current === 'tennis' });
        profileRef.current = step.profile;
        setCalibrationPhase(step.phase);
        setCalibrationProgress(step.progress);
        if (step.profile) setCameraStatus('Calibração aprovada · postura neutra salva');
      }
      const decision = contextRef.current.update(current, profileRef.current);
      const activity = decision.confidence01 > 0.4 ? ` · ${ACTIVITY_LABEL[decision.activity]}` : '';
      setTracking(current.trackingState === 'tracked' ? `TRACKING${activity}` : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO');
      drawPose(overlayRef.current, videoRef.current, current);
      for (const event of result.events) dispatchEvent(event);
    },
  };

  const startHandCapture = useCallback(async (video: HTMLVideoElement, attempt: number) => {
    const stale = () => cameraAttemptRef.current !== attempt;
    handClientRef.current ??= new HandClient();
    const handClient = handClientRef.current;
    await handClient.init({
      onStatus: (status, detail) => {
        if (stale()) return;
        setCameraStatus(detail);
        if (status === 'error') {
          stopCamera();
          setCameraStatus(detail);
        }
      },
    });
    if (stale() || !handClient.isReady || !streamRef.current) return;
    handClient.beginCapture(video, (snapshot, aspectY) => {
      if (stale()) return;
      const primary = snapshot.hands[0];
      const state = handDetectorRef.current.update({
        timestampMs: snapshot.timestampMs,
        landmarks: primary?.landmarks ?? [],
        handedness: primary?.handedness,
        aspectY,
      });
      setHandInput({
        visible: state.visible,
        x: state.x * window.innerWidth,
        y: state.y * window.innerHeight,
        syncProgress: state.syncProgress,
        synced: state.synced,
        pinching: state.pinching,
        pinchRelease: state.pinchRelease,
        backProgress: state.backProgress,
      });
    });
  }, [stopCamera]);

  const startPoseCapture = useCallback(async (video: HTMLVideoElement, attempt: number) => {
    const stale = () => cameraAttemptRef.current !== attempt;
    poseClientRef.current ??= new PoseClient();
    const poseClient = poseClientRef.current;
    await poseClient.init({
      onStatus: (status, detail) => {
        if (stale()) return;
        poseCallbacksRef.current?.onStatus(status, detail);
      },
      onPose: (raw) => {
        if (stale()) return;
        poseCallbacksRef.current?.onPose(raw);
      },
    });
    if (stale() || !poseClient.isReady || !streamRef.current) return;
    poseClient.beginCapture(video, {
      onStatus: (status, detail) => {
        if (stale()) return;
        poseCallbacksRef.current?.onStatus(status, detail);
      },
      onPose: (raw) => {
        if (stale()) return;
        poseCallbacksRef.current?.onPose(raw);
      },
    });
  }, []);

  // A tela dona do modo: menus são controlados pela mão; calibração e jogo usam o corpo.
  useEffect(() => {
    const next = modeForScreen(screen);
    if (visionModeRef.current === next) return;
    visionModeRef.current = next;
    handDetectorRef.current.reset();
    setHandInput(HAND_IDLE);
    const video = videoRef.current;
    if (!cameraOn || !video || !streamRef.current) return;

    const attempt = cameraAttemptRef.current;
    if (next === 'hand') {
      poseClientRef.current?.pauseCapture();
      void startHandCapture(video, attempt).catch((error: unknown) => {
        if (cameraAttemptRef.current === attempt) {
          setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar o modo de mão.');
        }
      });
    } else {
      handClientRef.current?.pauseCapture();
      void startPoseCapture(video, attempt).catch((error: unknown) => {
        if (cameraAttemptRef.current === attempt) {
          setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar o modo de pose.');
        }
      });
    }
  }, [screen, cameraOn, startHandCapture, startPoseCapture]);

  const startCamera = useCallback(async () => {
    stopCamera();
    const attempt = ++cameraAttemptRef.current;
    const stale = () => cameraAttemptRef.current !== attempt;
    try {
      void audioRef.current.unlock();
      const desiredMode = modeForScreen(screenRef.current);
      visionModeRef.current = desiredMode;

      if (desiredMode === 'hand') {
        handClientRef.current ??= new HandClient();
      } else {
        poseClientRef.current ??= new PoseClient();
      }
      const visionReady = observeEarlyRejection(
        desiredMode === 'hand'
          ? handClientRef.current!.init({
              onStatus: (status, detail) => {
                if (stale()) return;
                setCameraStatus(detail);
                if (status === 'error') { stopCamera(); setCameraStatus(detail); }
              },
            })
          : poseClientRef.current!.init({
              onStatus: (status, detail) => {
                if (stale()) return;
                poseCallbacksRef.current?.onStatus(status, detail);
              },
              onPose: (raw) => {
                if (stale()) return;
                poseCallbacksRef.current?.onPose(raw);
              },
            }),
      );

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      });
      if (stale()) { stream.getTracks().forEach((track) => { track.stop(); }); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Prévia da câmera não está disponível.');
      video.srcObject = stream;
      await video.play();
      if (stale()) return;
      await new Promise<void>((resolve) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) resolve();
        else {
          video.addEventListener('loadeddata', () => resolve(), { once: true });
          video.addEventListener('emptied', () => resolve(), { once: true });
        }
      });
      if (stale()) return;
      setCameraOn(true);
      await visionReady;
      if (stale() || streamRef.current !== stream) return;
      if (visionModeRef.current === 'hand') {
        await startHandCapture(video, attempt);
      } else {
        await startPoseCapture(video, attempt);
      }
    } catch (error) {
      if (stale()) return;
      stopCamera();
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar a câmera.');
    }
  }, [stopCamera, startHandCapture, startPoseCapture]);

  const toggleMute = useCallback(() => {
    void audioRef.current.unlock();
    setMuted((value) => {
      const next = !value;
      writeMutedPreference(next);
      return next;
    });
  }, []);

  const endSplash = useCallback(() => {
    setSplash(false);
    void startCamera();
  }, [startCamera]);

  // Calibrou: deixa o "Calibrado" aparecer e segue para o menu em modo de mão.
  useEffect(() => {
    if (screen !== 'calibration' || calibrationPhase !== 'done') return;
    const timer = window.setTimeout(() => setScreen('home'), 1500);
    return () => window.clearTimeout(timer);
  }, [screen, calibrationPhase]);

  const skipCalibration = () => {
    stopCamera();
    setScreen('home');
  };

  const play = (next: Sport) => {
    void audioRef.current.unlock();
    setSport(next);
    sportRef.current = next;
    // Um perfil vindo da corrida pode não ter referência de punhos — e sem ela o swing
    // não dispara: o tênis refaz a calibração pedindo as mãos visíveis.
    if (next === 'tennis' && profileRef.current && !profileRef.current.world.readyWristLocal) recalibrate();
    setHandPanelOpen(false);
    setScreen('play');
  };

  const closeHandPanel = useCallback(() => {
    stopCamera();
    setHandPanelOpen(false);
  }, [stopCamera]);

  const openHandPanel = useCallback(() => {
    HandClient.warmVisionAssets();
    setHandPanelOpen(true);
  }, []);

  const handBack = useCallback(() => {
    if (screenRef.current === 'games') setScreen('title');
    else if (screenRef.current === 'title') setScreen('home');
    else if (handPanelOpen) closeHandPanel();
  }, [closeHandPanel, handPanelOpen]);

  const menu = inHandMenu(screen);

  return <div className="stage">
    {screen === 'play' && <GameCanvas key={sport} sport={sport} onEngine={onEngine} tracking={tracking} audio={audioRef.current} />}
    {screen === 'calibration' && <section className="wii-screen">
      <h1>Calibração do corpo</h1>
      <p>Permita a câmera, enquadre cabeça e torso até o quadril e fique parado.</p>
      <button type="button" className="wii-skip" onClick={skipCalibration}>Pular</button>
    </section>}
    {screen === 'home' && <HomeMenu exit={exit} onGames={() => setScreen('title')} />}
    {screen === 'title' && <TitleMenu onStart={() => setScreen('games')} onBack={() => setScreen('home')} />}
    {screen === 'games' && <GamesMenu onHome={() => setScreen('home')} onPick={play} onBack={() => setScreen('title')} />}

    {screen === 'play' && <div className="hud-dock">
      <button type="button" className="dock-btn" onClick={() => setScreen('games')}>‹ Jogos</button>
      <button type="button" className="dock-btn round" onClick={toggleMute} title={muted ? 'Áudio desligado' : 'Áudio ligado'}>{muted ? '×' : '♫'}</button>
    </div>}

    {menu && !handPanelOpen && <div className="hud-dock">
      <button type="button" className="dock-btn" onClick={openHandPanel}>MÃO</button>
    </div>}
    {menu && handPanelOpen && <HandPanel
      sourceRef={videoRef} cameraOn={cameraOn} status={cameraStatus} synced={handInput.synced}
      onStart={() => void startCamera()} onClose={closeHandPanel}
    />}
    <HandCursor input={handInput} active={menu && cameraOn} onBack={handBack} />

    <CameraPip
      hidden={menu && handPanelOpen}
      sport={sport}
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      calibrationPhase={calibrationPhase} calibrationProgress={calibrationProgress}
      onStart={() => void startCamera()} onStop={stopCamera} onRecalibrate={recalibrate}
    />
    {splash && <WiiSplash onDone={endSplash} />}
  </div>;
}
