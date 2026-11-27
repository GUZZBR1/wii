import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CalibrationProfile, PoseSnapshot, SportActionEvent } from './cv/protocol';
import { HandClient } from './cv/handClient';
import { AdaptiveCalibrator } from './cv/adaptiveCalibrator';
import { observeEarlyRejection } from './cv/observeEarlyRejection';
import { PoseClient, type PoseClientCallbacks } from './cv/poseClient';
import { diagnosticsEnabled } from './cv/diagnostics/flags';
import { PhotoTrail } from './cv/diagnostics/photoTrail';
import { TENNIS_RECORDING_SCRIPT } from './cv/diagnostics/recordingScript';
import { downloadRecording, noteArrival, PoseRecorder, rememberFrame } from './cv/diagnostics/poseRecorder';
import { ActionPipeline } from './kinematics/actionPipeline';
import { framingAdvice, handsHidden, armsCrossed, handsRaised, raisedTossHand, HeadWarning } from './kinematics/framing';
import { ContextClassifier, type ActivityKind } from './kinematics/contextClassifier';
import { HandCursorDetector } from './kinematics/handCursor';
import { visibleImagePoint } from './kinematics/math';
import type { GestureSample } from './games/core/restartGesture';
import { ProceduralAudio } from './games/audio';
import { CameraPip } from './ui/CameraPip';
import { GameCanvas, type GameEngineHandle, type Sport } from './ui/GameCanvas';
import type { Goal } from './games/athletics/race';
import { HandCursor } from './ui/HandCursor';
import { PerfMeter } from './ui/PerfMeter';
import { HAND_IDLE } from './ui/handCursorTypes';
import { drawPose } from './ui/PoseOverlay';
import { GamesMenu, HomeMenu } from './ui/WiiMenu';
import { WiiSplash } from './ui/WiiSplash';
import './arena.css';

type Screen = 'home' | 'games' | 'play';
type VisionMode = 'hand' | 'pose';

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  idle: 'PARADO',
  running: 'CORRIDA',
  swinging: 'RAQUETE',
  striking: 'LUTA',
};
const MUTE_STORAGE_KEY = 'wii-web-sports.muted.v1';

const inHandMenu = (screen: Screen) => screen === 'home' || screen === 'games';
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
  const [screen, setScreen] = useState<Screen>('home');
  const [sport, setSport] = useState<Sport>('athletics');
  const [goal, setGoal] = useState<Goal>(100);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [muted, setMuted] = useState(readMutedPreference);
  const [handInput, setHandInput] = useState(HAND_IDLE);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const poseClientRef = useRef<PoseClient | undefined>(undefined);
  const handClientRef = useRef<HandClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const contextRef = useRef(new ContextClassifier());
  const calibratorRef = useRef(new AdaptiveCalibrator());
  const handDetectorRef = useRef(new HandCursorDetector());
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const visionModeRef = useRef<VisionMode>('pose');
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const audioRef = useRef(new ProceduralAudio());
  const cameraAttemptRef = useRef(0);
  const poseFramesRef = useRef(0);
  /** Capture-to-game delay of the last pose, shown by `?fps`. */
  const poseDelayRef = useRef(0);
  const [headCut, setHeadCut] = useState(false);
  const crossedPoseRef = useRef<GestureSample | null>(null);
  const recentFramesRef = useRef<PoseSnapshot[]>([]);
  const photoTrailRef = useRef(new PhotoTrail());
  const [keepPhotos] = useState(() => new URLSearchParams(window.location.search).has('fotos'));
  const headWarningRef = useRef(new HeadWarning());
  const [showPerf] = useState(() => new URLSearchParams(window.location.search).has('fps'));
  /** Diagnostic recording: owned here, fed by onPose, ended by the script, G or the camera stopping. */
  const recorderRef = useRef<PoseRecorder | undefined>(undefined);
  const [recordingPrompt, setRecordingPrompt] = useState<string>();

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
    engineRef.current?.onAction(event);
    if (sportRef.current !== 'tennis') {
      // Only the track has jumps; athletics still hears its steps.
      if (event.type === 'jump' && sportRef.current === 'track') audioRef.current.jump();
      if (event.type === 'step') audioRef.current.step(event.side);
    }
  }, []);

  const resetCalibration = useCallback(() => {
    profileRef.current = undefined;
    calibratorRef.current.reset();
  }, []);

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current += 1;
    recorderRef.current = undefined;
    setRecordingPrompt(undefined);
    setHeadCut(false);
    crossedPoseRef.current = null;
    engineRef.current?.setHandsRaised?.(false, null);
    headWarningRef.current.reset();
    recentFramesRef.current = [];
    photoTrailRef.current.clear();
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
    engineRef.current?.resetLaneZone?.();
    contextRef.current.reset();
    resetCalibration();
    drawPose(overlayRef.current, videoRef.current);
  }, [dispatchEvent, resetCalibration]);

  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    setRecordingPrompt(undefined);
    const delegate = poseClientRef.current?.delegate;
    if (!recorder?.frameCount || !delegate) return;
    void downloadRecording(recorder, delegate, sport === 'tennis' ? 'tenis' : 'corrida').catch((error: unknown) => {
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível salvar a gravação.');
    });
  }, [sport]);

  useEffect(() => {
    if (screen === 'play') pipelineRef.current.recenterLane();
  }, [screen]);

  // G starts/stops a recording during a camera run. Detectors and calibration restart with it,
  // so replaying the file from a cold start reproduces what happened live.
  useEffect(() => {
    if (screen !== 'play' || !cameraOn || !diagnosticsEnabled()) return;
    const toggle = (event: KeyboardEvent) => {
      const delegate = poseClientRef.current?.delegate;
      if (event.key.toLowerCase() === 'e' && !event.repeat && delegate && recentFramesRef.current.length) {
        void downloadRecording(new PoseRecorder(recentFramesRef.current), delegate, sport === 'tennis' ? 'tenis-erro' : 'erro', photoTrailRef.current.all).catch(() => setCameraStatus('Não foi possível salvar o trecho.'));
        return;
      }
      if (event.key.toLowerCase() !== 'g' || event.repeat) return;
      if (recorderRef.current) { finishRecording(); return; }
      for (const stop of pipelineRef.current.reset()) dispatchEvent(stop);
      resetCalibration();
      recorderRef.current = new PoseRecorder([], sport === 'tennis' ? TENNIS_RECORDING_SCRIPT : undefined);
      setRecordingPrompt('Gravando…');
    };
    window.addEventListener('keydown', toggle);
    return () => {
      window.removeEventListener('keydown', toggle);
      recorderRef.current = undefined;
      setRecordingPrompt(undefined);
    };
  }, [screen, sport, cameraOn, dispatchEvent, resetCalibration, finishRecording]);

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
      poseFramesRef.current += 1;
      poseDelayRef.current = performance.now() - raw.timestampMs;
      noteArrival(raw, performance.now());
      rememberFrame(recentFramesRef.current, raw);
      if (keepPhotos) photoTrailRef.current.add(raw.timestampMs, videoRef.current);
      if (recorderRef.current) {
        const current = recorderRef.current.push(raw);
        if (current) setRecordingPrompt(`${current.segment.prompt} · ${Math.ceil(current.remainingMs / 1000)}`);
        else finishRecording();
      }
      setHeadCut(headWarningRef.current.update(raw));
      // Implicit calibration: every observed frame is evidence. The current profile is a
      // continuously improving estimate, never a mode the player has to enter or watch.
      profileRef.current = calibratorRef.current.update(raw, pipelineRef.current.laneZone) ?? profileRef.current;
      const result = pipelineRef.current.update(raw, profileRef.current);
      const current = result.snapshot;
      const decision = contextRef.current.update(current, profileRef.current);
      const activity = decision.confidence01 > 0.4 ? ` · ${ACTIVITY_LABEL[decision.activity]}` : '';
      setTracking(current.trackingState === 'tracked' ? `TRACKING${activity}` : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO');
      drawPose(overlayRef.current, videoRef.current, current);
      engineRef.current?.setLaneZone?.(result.controls.laneZone);
      engineRef.current?.setEffort?.(result.rawEffort, result.effortSampleAtMs);
      engineRef.current?.setFraming?.(framingAdvice(raw), handsHidden(raw));
      const gestureAtMs = current.trackingState === 'tracked'
        && [11, 12].every((index) => visibleImagePoint(current.landmarks[index], 0.5))
        ? raw.timestampMs : null;
      const wristsVisible = [15, 16].every((index) => visibleImagePoint(current.landmarks[index], 0.5));
      crossedPoseRef.current = gestureAtMs === null ? null : { active: wristsVisible && armsCrossed(current), atMs: gestureAtMs };
      engineRef.current?.setHandsRaised?.(gestureAtMs !== null && wristsVisible && handsRaised(current), gestureAtMs);
      engineRef.current?.setTossHand?.(raisedTossHand(current), raw.timestampMs);
      engineRef.current?.setArmMotions?.(result.armMotions);
      engineRef.current?.setSwingTracking?.(result.swingTracking);
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
    if (stale() || !handClient.isReady || !streamRef.current || visionModeRef.current !== 'hand') return;
    handClient.beginCapture(video, (snapshot, aspectY) => {
      if (stale()) return;
      const primary = snapshot.hands[0];
      const state = handDetectorRef.current.update({
        timestampMs: snapshot.timestampMs,
        landmarks: primary?.landmarks ?? [],
        handedness: primary?.handedness,
        handednessScore: primary?.handednessScore,
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
    }, (error) => {
      if (!stale()) setCameraStatus(error.message);
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
    if (stale() || !poseClient.isReady || !streamRef.current || visionModeRef.current !== 'pose') return;
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

  // Menus use hand tracking; adaptive body calibration runs continuously during play.
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
      drawPose(overlayRef.current, videoRef.current);
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

  const onStrokeTravel = useCallback((travel: number) => { pipelineRef.current.setStrokeTravel(travel); }, []);

  const play = (next: Sport, distance: Goal = 100) => {
    setGoal(distance);
    void audioRef.current.unlock();
    // The tennis warm-up sets its own stroke length; every game starts from the default.
    pipelineRef.current.setStrokeTravel(1.9);
    pipelineRef.current.resetSwings();
    setSport(next);
    sportRef.current = next;
    setScreen('play');
  };

  const handBack = useCallback(() => {
    if (screenRef.current === 'games') setScreen('home');
  }, []);

  const menu = inHandMenu(screen);

  return <div className="stage">
    {screen === 'play' && <GameCanvas key={`${sport}-${goal}`} sport={sport} goal={goal} onEngine={onEngine} tracking={tracking} audio={audioRef.current} crossedPose={crossedPoseRef} onExit={() => setScreen('games')} onStrokeTravel={onStrokeTravel} />}
    {screen === 'home' && <HomeMenu exit={exit} onGames={() => setScreen('games')} />}
    {screen === 'games' && <GamesMenu onHome={() => setScreen('home')} onPick={play} />}

    {screen === 'play' && headCut && <div className="framing-hint" role="alert">Sua cabeça saiu do quadro · incline a câmera para cima ou afaste-se</div>}
    {screen === 'play' && keepPhotos && <div className="photo-notice">● guardando fotos dos últimos 20 s · E salva</div>}
    {recordingPrompt && <div className="recording-prompt" role="status">● {recordingPrompt}</div>}

    {screen === 'play' && <div className="hud-dock">
      <button type="button" className="dock-btn" onClick={() => setScreen('games')}>‹ Jogos</button>
      <button type="button" className="dock-btn round" onClick={toggleMute} title={muted ? 'Áudio desligado' : 'Áudio ligado'}>{muted ? '×' : '♫'}</button>
    </div>}

    <HandCursor input={handInput} active={menu && cameraOn} onBack={handBack} />

    <CameraPip
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      onStart={() => void startCamera()} onStop={stopCamera}
    />
    {showPerf && <PerfMeter videoRef={videoRef} poseFrames={poseFramesRef} poseDelay={poseDelayRef} />}
    {splash && <WiiSplash onDone={endSplash} />}
  </div>;
}
