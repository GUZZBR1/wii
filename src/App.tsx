import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PoseSnapshot, SportActionEvent } from './cv/protocol';
import { HandClient } from './cv/handClient';
import { PoseClient, type PoseClientCallbacks } from './cv/poseClient';
import { diagnosticsEnabled } from './cv/diagnostics/flags';
import { PhotoTrail } from './cv/diagnostics/photoTrail';
import { BOXING_RECORDING_SCRIPT, TENNIS_RECORDING_SCRIPT } from './cv/diagnostics/recordingScript';
import { downloadRecording, noteArrival, PoseRecorder, rememberFrame, serializeRecording } from './cv/diagnostics/poseRecorder';
import { PUNCH_THRESHOLDS } from './kinematics/punchDetector';
import { HandCursorDetector } from './kinematics/handCursor';
import type { GestureSample } from './games/core/restartGesture';
import { Perception, type PoseIntake } from './perception';
import { ProceduralAudio } from './games/audio';
import { CameraPip } from './ui/CameraPip';
import { GameCanvas, type GameEngineHandle, type IronManResult, type Sport } from './ui/GameCanvas';
import { type BoxingSetup, DEFAULT_BOXING_SETUP } from './games/boxing/boxingSetup';
import { GameLobby, IronManLobby } from './ui/GameLobby';
import { useScreenFade } from './ui/useScreenFade';
import type { Goal } from './games/athletics/race';
import { HandCursor } from './ui/HandCursor';
import { HandDebugOverlay } from './ui/HandDebugOverlay';
import { PerfMeter } from './ui/PerfMeter';
import { HAND_IDLE } from './ui/handCursorTypes';
import { createHandInputStore } from './ui/handInputStore';
import type { CarouselStepResult } from './ui/carouselController';
import { drawPose } from './ui/PoseOverlay';
import { HomeMenu } from './ui/NevergearMenu';
import { MiiCreator } from './ui/MiiCreator';
import { NevergearSplash } from './ui/NevergearSplash';
import { readStored, writeStored } from './lib/storage';
import { useLang } from './i18n';
import './arena.css';

type Screen = 'home' | 'lobby' | 'ironman' | 'play' | 'summary' | 'mii';
type VisionMode = 'hand' | 'pose';

const MUTE_STORAGE_KEY = 'nevergear-web-sports.muted.v1';

const inHandMenu = (screen: Screen) => screen !== 'play';
const modeForScreen = (screen: Screen): VisionMode => (inHandMenu(screen) ? 'hand' : 'pose');

const readMutedPreference = () => readStored(MUTE_STORAGE_KEY) === '1';
const writeMutedPreference = (muted: boolean) => void writeStored(MUTE_STORAGE_KEY, muted ? '1' : '0');

export default function App({ exit }: { exit?: ReactNode }) {
  const { lang, tr } = useLang();
  const [splash, setSplash] = useState(true);
  const [screen, setScreen] = useState<Screen>('home');
  const [boxingSetup, setBoxingSetup] = useState<BoxingSetup>({ ...DEFAULT_BOXING_SETUP, mode: 'tutorial' });
  const [sport, setSport] = useState<Sport>('athletics');
  const [ironResults, setIronResults] = useState<IronManResult[] | null>(null);
  const [goal, setGoal] = useState<Goal>(100);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [muted, setMuted] = useState(readMutedPreference);
  // Hand samples stay out of React state, so the camera rate never re-renders App.
  const [handStore] = useState(createHandInputStore);
  const homeRotationGateRef = useRef(false);
  const carouselDebugRef = useRef<CarouselStepResult | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const poseClientRef = useRef<PoseClient | undefined>(undefined);
  const handClientRef = useRef<HandClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  /** Owns calibration, detectors and the per-frame engine setters; `App` owns the camera and screens. */
  const perceptionRef = useRef(new Perception());
  const handDetectorRef = useRef(new HandCursorDetector());
  const lastHandDeliveryAtRef = useRef<number | undefined>(undefined);
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const activeVisionModeRef = useRef<VisionMode>('pose');
  const visionActivationRef = useRef(0);
  const captureStartedRef = useRef<{ cameraAttempt: number; visionActivation: number } | undefined>(undefined);
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
  const [showPerf] = useState(() => new URLSearchParams(window.location.search).has('fps'));
  /** Diagnostic recording: owned here, fed by onPose, ended by the script, G or the camera stopping. */
  const recorderRef = useRef<PoseRecorder | undefined>(undefined);
  const [recordingPrompt, setRecordingPrompt] = useState<string>();
  // Only `npm run auto-upgrade` offers it, and the player still has to turn it on.
  const autoUpgradeOffered = import.meta.env.DEV && import.meta.env.VITE_AUTO_UPGRADE === '1';
  const [autoUpgrade, setAutoUpgrade] = useState(false);
  const autoUpgradeRef = useRef(autoUpgrade);
  autoUpgradeRef.current = autoUpgrade;
  const segmentRef = useRef({ frames: [] as PoseSnapshot[], events: [] as SportActionEvent[] });
  const takeSegment = useCallback(() => { const segment = segmentRef.current; segmentRef.current = { frames: [], events: [] }; return segment; }, []);

  useEffect(() => {
    audioRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    audioRef.current.setLanguage(lang);
  }, [lang]);

  useEffect(() => {
    void navigator.permissions?.query({ name: 'camera' as PermissionName }).then((permission) => {
      if (permission.state !== 'granted') return;
      // The app opens on the hand-driven menu; both models share the same WASM.
      HandClient.warmVisionAssets();
      PoseClient.warmVisionAssets();
    }).catch(() => undefined);
    return () => {
      cameraAttemptRef.current += 1;
      captureStartedRef.current = undefined;
      poseClientRef.current?.dispose();
      handClientRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => { track.stop(); });
      streamRef.current = undefined;
      audioRef.current.dispose();
    };
  }, []);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  // The perception owns the frame; it only asks back for the engine it drives and the canvas it draws on.
  const intakeRef = useRef<PoseIntake>({
    engine: () => engineRef.current,
    overlay: () => ({ canvas: overlayRef.current, video: videoRef.current }),
  });
  const perceive = useCallback((raw: PoseSnapshot) => perceptionRef.current.update(raw, sportRef.current, intakeRef.current), []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    engineRef.current?.onAction(event);
    if (sportRef.current === 'track' || sportRef.current === 'athletics') {
      // Only the track has jumps; athletics still hears its steps.
      if (event.type === 'jump' && sportRef.current === 'track') audioRef.current.jump();
      if (event.type === 'step') audioRef.current.step(event.side);
    }
  }, []);
  const resetPerception = useCallback(() => {
    for (const event of perceptionRef.current.reset(intakeRef.current)) dispatchEvent(event);
  }, [dispatchEvent]);

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current += 1;
    captureStartedRef.current = undefined;
    recorderRef.current = undefined;
    setRecordingPrompt(undefined);
    setHeadCut(false);
    crossedPoseRef.current = null;
    engineRef.current?.setHandsRaised?.(false, null);
    recentFramesRef.current = [];
    photoTrailRef.current.clear();
    poseClientRef.current?.pauseCapture();
    handClientRef.current?.pauseCapture();
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setTracking('SEM POSE');
    engineRef.current?.setTracking?.('SEM POSE');
    setCameraStatus('Câmera desligada');
    handStore.publish(HAND_IDLE);
    handDetectorRef.current.reset();
    lastHandDeliveryAtRef.current = undefined;
    resetPerception();
    engineRef.current?.resetLaneZone?.();
    engineRef.current?.setGuard?.(undefined, null);
    engineRef.current?.setDuck?.(undefined, null);
    engineRef.current?.setDepthMove?.(undefined, null);
    engineRef.current?.setDepthSpeed?.(undefined, null);
    engineRef.current?.setLateralDash?.(undefined);
  }, [handStore, resetPerception]);

  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    setRecordingPrompt(undefined);
    const delegate = poseClientRef.current?.delegate;
    if (!recorder?.frameCount || !delegate) return;
    void downloadRecording(recorder, delegate, sport === 'tennis' ? 'tenis' : sport === 'boxing' ? 'boxe' : 'corrida').catch((error: unknown) => {
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível salvar a gravação.');
    });
  }, [sport]);

  useEffect(() => {
    if (screen === 'play') perceptionRef.current.recenterLane();
  }, [screen]);

  // A segment left unfinished, or recorded before the button was turned off, is never sent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these changes are what discard the segment.
  useEffect(() => { takeSegment(); }, [screen, sport, autoUpgrade]);

  const sendSegment = useCallback(() => {
    const { frames, events } = takeSegment();
    const delegate = poseClientRef.current?.delegate;
    if (!frames.length || !delegate) return;
    void serializeRecording(new PoseRecorder(frames), delegate)
      .then(async (text) => {
        const body = JSON.stringify({ ...JSON.parse(text), autoUpgrade: { sport: sportRef.current, events } });
        const response = await fetch('/__auto-upgrade', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!response.ok) throw new Error(String(response.status));
      })
      .catch(() => setCameraStatus('Auto-upgrade: the segment could not be sent.'));
  }, [takeSegment]);

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
      resetPerception();
      recorderRef.current = new PoseRecorder([], sport === 'tennis' ? TENNIS_RECORDING_SCRIPT : sport === 'boxing' ? BOXING_RECORDING_SCRIPT : undefined);
      setRecordingPrompt('Gravando…');
    };
    window.addEventListener('keydown', toggle);
    return () => {
      window.removeEventListener('keydown', toggle);
      recorderRef.current = undefined;
      setRecordingPrompt(undefined);
    };
  }, [screen, sport, cameraOn, resetPerception, finishRecording]);

  const activateVisionMode = useCallback((next: VisionMode): VisionMode | undefined => {
    const previous = activeVisionModeRef.current;
    if (previous === next) return undefined;
    activeVisionModeRef.current = next;
    visionActivationRef.current += 1;
    captureStartedRef.current = undefined;
    return previous;
  }, []);

  const isCurrentVisionActivation = useCallback((attempt: number, activation: number, mode: VisionMode) =>
    cameraAttemptRef.current === attempt &&
    visionActivationRef.current === activation &&
    activeVisionModeRef.current === mode &&
    modeForScreen(screenRef.current) === mode,
  []);

  const failVisionActivation = useCallback((
    attempt: number,
    activation: number,
    mode: VisionMode,
    error: unknown,
    fallback: string,
  ) => {
    if (!isCurrentVisionActivation(attempt, activation, mode)) return;
    stopCamera();
    setCameraStatus(error instanceof Error ? error.message : fallback);
  }, [isCurrentVisionActivation, stopCamera]);

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
      // The rolling buffer only feeds the diagnostic clip save; keeping it otherwise is GC pressure.
      if (diagnosticsEnabled()) rememberFrame(recentFramesRef.current, raw);
      if (keepPhotos) photoTrailRef.current.add(raw.timestampMs, videoRef.current);
      if (recorderRef.current) {
        const current = recorderRef.current.push(raw);
      if (current) setRecordingPrompt(`${current.segment.prompt[lang]} · ${Math.ceil(current.remainingMs / 1000)}`);
        else finishRecording();
      }
      const frame = perceive(raw);
      setHeadCut(frame.headCut);
      setTracking(frame.trackingLabel);
      crossedPoseRef.current = frame.crossedPose;
      for (const event of frame.events) dispatchEvent(event);
      if (autoUpgradeRef.current && screenRef.current === 'play') {
        const { frames, events } = segmentRef.current;
        // Training modes never end: keep about ten minutes.
        if (frames.push(raw) > 12_000) frames.shift();
        events.push(...frame.events);
      }
    },
  };

  const startHandCapture = useCallback(async (video: HTMLVideoElement, attempt: number, activation: number) => {
    const stale = () => !isCurrentVisionActivation(attempt, activation, 'hand');
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
    if (stale() || !handClient.isReady || !streamRef.current || activeVisionModeRef.current !== 'hand') return;
    handClient.beginCapture(video, (snapshot, aspectY) => {
      if (stale()) return;
      const deliveredAtMs = performance.now();
      const previousDeliveryAtMs = lastHandDeliveryAtRef.current;
      lastHandDeliveryAtRef.current = deliveredAtMs;
      const handInferenceMs = Math.max(0, deliveredAtMs - snapshot.timestampMs);
      const workerFps =
        previousDeliveryAtMs === undefined ? undefined : 1000 / Math.max(deliveredAtMs - previousDeliveryAtMs, 0.01);
      const primary = snapshot.hands[0];
      const state = handDetectorRef.current.update({
        timestampMs: snapshot.timestampMs,
        landmarks: primary?.landmarks ?? [],
        worldLandmarks: primary?.worldLandmarks,
        handedness: primary?.handedness,
        aspectY,
        rotationEnabled: screenRef.current === 'home' && homeRotationGateRef.current,
        handInferenceMs,
        workerFps,
      });
      handStore.publish({
        visible: state.visible,
        x: state.x * window.innerWidth,
        y: state.y * window.innerHeight,
        syncProgress: state.syncProgress,
        synced: state.synced,
        pinching: state.pinching,
        pinchState: state.pinchState,
        freezeReason: state.freezeReason,
        pinchRelease: state.pinchRelease,
        backProgress: state.backProgress,
        swipeDirection: state.swipeDirection,
        swipeMoving: state.swipeMoving,
        handInferenceMs: state.handInferenceMs,
        workerFps: state.workerFps,
        capturedAtMs: snapshot.timestampMs,
        rotationPhase: state.rotationPhase,
        rotationAngularVelocity: state.rotationAngularVelocity,
        rotationDirection: state.rotationDirection,
        rotationFilteredAngularVelocity: state.rotationFilteredAngularVelocity,
        rotationRawAngularVelocity: state.rotationRawAngularVelocity,
        rotationCurvature: state.rotationCurvature,
        rotationHandShape: state.rotationHandShape,
        rotationRejectReason: state.rotationRejectReason,
        rotationDtMs: state.rotationDtMs,
        rotationOrientation: state.rotationOrientation,
      });
    }, (error) => {
      if (!stale()) setCameraStatus(error.message);
    });
  }, [isCurrentVisionActivation, handStore, stopCamera]);

  const startPoseCapture = useCallback(async (video: HTMLVideoElement, attempt: number, activation: number) => {
    const stale = () => !isCurrentVisionActivation(attempt, activation, 'pose');
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
    if (stale() || !poseClient.isReady || !streamRef.current || activeVisionModeRef.current !== 'pose') return;
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
  }, [isCurrentVisionActivation]);

  // Menus use hand tracking; adaptive body calibration runs continuously during play.
  useEffect(() => {
    const next = modeForScreen(screen);
    const previous = activateVisionMode(next);
    if (previous !== undefined) {
      handDetectorRef.current.reset();
      lastHandDeliveryAtRef.current = undefined;
      handStore.publish(HAND_IDLE);
      if (next === 'hand') {
        poseClientRef.current?.pauseCapture();
        drawPose(overlayRef.current, videoRef.current);
      } else {
        handClientRef.current?.pauseCapture();
      }
    }

    const video = videoRef.current;
    if (!cameraOn || !video || !streamRef.current) return;

    const attempt = cameraAttemptRef.current;
    const activation = visionActivationRef.current;
    if (
      captureStartedRef.current?.cameraAttempt === attempt &&
      captureStartedRef.current.visionActivation === activation
    ) return;
    captureStartedRef.current = { cameraAttempt: attempt, visionActivation: activation };

    if (next === 'hand') {
      void startHandCapture(video, attempt, activation).catch((error: unknown) => {
        failVisionActivation(attempt, activation, 'hand', error, 'Não foi possível iniciar o modo de mão.');
      });
    } else {
      void startPoseCapture(video, attempt, activation).catch((error: unknown) => {
        failVisionActivation(attempt, activation, 'pose', error, 'Não foi possível iniciar o modo de pose.');
      });
    }
  }, [screen, cameraOn, activateVisionMode, failVisionActivation, startHandCapture, startPoseCapture, handStore]);

  const startCamera = useCallback(async () => {
    stopCamera();
    const attempt = ++cameraAttemptRef.current;
    const stale = () => cameraAttemptRef.current !== attempt;
    try {
      void audioRef.current.unlock();
      const desiredMode = modeForScreen(screenRef.current);
      activateVisionMode(desiredMode);
      const activation = visionActivationRef.current;

      let visionReady: Promise<void>;
      if (desiredMode === 'hand') {
        handClientRef.current ??= new HandClient();
        visionReady = handClientRef.current.init({
          onStatus: (status, detail) => {
            if (!isCurrentVisionActivation(attempt, activation, 'hand')) return;
            setCameraStatus(detail);
            if (status === 'error') { stopCamera(); setCameraStatus(detail); }
          },
        });
      } else {
        poseClientRef.current ??= new PoseClient();
        visionReady = poseClientRef.current.init({
          onStatus: (status, detail) => {
            if (!isCurrentVisionActivation(attempt, activation, 'pose')) return;
            poseCallbacksRef.current?.onStatus(status, detail);
          },
          onPose: (raw) => {
            if (!isCurrentVisionActivation(attempt, activation, 'pose')) return;
            poseCallbacksRef.current?.onPose(raw);
          },
        });
      }
      void visionReady.catch((error: unknown) => {
        failVisionActivation(attempt, activation, desiredMode, error, 'Não foi possível iniciar a visão.');
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // Pose inference runs below 20 poses a second, so frames past 30 are only decoded to be dropped.
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
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
    } catch (error) {
      if (stale()) return;
      stopCamera();
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar a câmera.');
    }
  }, [activateVisionMode, failVisionActivation, isCurrentVisionActivation, stopCamera]);

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

  const onStrokeTravel = useCallback((travel: number) => { perceptionRef.current.setStrokeTravel(travel); }, []);
  const onPunchTravel = useCallback((travel: number) => { perceptionRef.current.setPunchTravel(travel); }, []);

  const play = (next: Sport, distance: Goal = 100, show = true) => {
    setGoal(distance);
    void audioRef.current.unlock();
    // The warm-up tutorials set their own stroke length; every game starts from the default.
    perceptionRef.current.setStrokeTravel(1.9);
    perceptionRef.current.setPunchTravel(PUNCH_THRESHOLDS.confirmForwardTravel);
    perceptionRef.current.resetSwings();
    setSport(next);
    sportRef.current = next;
    if (show) setScreen('play');
  };

  // The Iron Man run is only dropped once the menu is on screen, so the match behind the fade stays as it is.
  const showScreen = useCallback((next: Screen) => {
    if (next === 'home') setIronResults(null);
    setScreen(next);
  }, []);
  const { go, veil } = useScreenFade(showScreen);
  const exitGame = () => go('home');
  const openGame = (next: Sport) => {
    setIronResults(null);
    setSport(next);
    sportRef.current = next;
    void audioRef.current.unlock();
    go('lobby');
  };
  const startIronMan = () => {
    setIronResults([]);
    play('athletics', 100, false);
    go('play');
  };
  const finishIronStage = (result: IronManResult) => {
    if (!ironResults) return;
    const results = [...ironResults, result];
    setIronResults(results);
    if (result.sport === 'athletics') play('tennis');
    else if (result.sport === 'tennis') play('boxing');
    else setScreen('summary');
  };

  const handBack = useCallback(() => {
    if (screenRef.current === 'lobby' || screenRef.current === 'ironman') go('home');
    else if (screenRef.current === 'mii') setScreen('home');
  }, [go]);

  const menu = inHandMenu(screen);

  return <div className="stage">
    {screen === 'play' && <GameCanvas key={`${sport}-${goal}`} sport={sport} goal={goal} onEngine={onEngine} tracking={tracking} audio={audioRef.current} boxingSetup={boxingSetup} onBoxingSetup={setBoxingSetup} crossedPose={crossedPoseRef} onExit={exitGame} ironMan={ironResults ? { onComplete: finishIronStage } : undefined} onStrokeTravel={onStrokeTravel} onPunchTravel={onPunchTravel} onCheckpoint={sendSegment} />}
    {screen === 'home' && (
      <HomeMenu
        exit={exit}
        onPick={openGame}
        onIronMan={() => { void audioRef.current.unlock(); go('ironman'); }}
        handStore={handStore}
        rotationGateRef={homeRotationGateRef}
        carouselDebugRef={carouselDebugRef}
        onMii={() => setScreen('mii')}
      />
    )}

    {screen === 'mii' && <MiiCreator onClose={() => setScreen('home')} />}
    {screen === 'lobby' && <GameLobby sport={sport} goal={goal} onGoal={setGoal} boxingSetup={boxingSetup} onBoxingSetup={setBoxingSetup} onPlay={() => { play(sport, goal, false); go('play'); }} onBack={() => go('home')} />}

    {screen === 'ironman' && <IronManLobby onPlay={startIronMan} onBack={() => go('home')} />}

    {screen === 'summary' && ironResults && <section className="menu iron-summary" aria-label={tr('Resumo do Iron Man', 'Iron Man summary')}>
      <div className="iron-summary-card">
        <span className="iron-eyebrow">Nevergear Sports</span>
        <h1>{tr('Iron Man concluído!', 'Iron Man complete!')}</h1>
        <p>{tr('Você completou as três modalidades.', 'You completed all three events.')}</p>
        <ol>{ironResults.map((result) => <li key={result.sport}>
          <strong>{result.sport === 'athletics' ? tr('Atletismo · 100 m', 'Athletics · 100 m') : result.sport === 'tennis' ? tr('Tênis', 'Tennis') : tr('Boxe', 'Boxing')}</strong>
          <span>{result.detail}</span>
        </li>)}</ol>
        <button type="button" className="nevergear-btn" onClick={exitGame}>{tr('Voltar ao menu', 'Return to menu')}</button>
      </div>
    </section>}
    {screen === 'play' && ironResults && <div className="iron-progress">{tr('IRON MAN · ETAPA', 'IRON MAN · STAGE')} {ironResults.length + 1} {tr('DE', 'OF')} 3</div>}
    {screen === 'play' && headCut && <div className="framing-hint" role="alert">{tr('Sua cabeça saiu do quadro · incline a câmera para cima ou afaste-se', 'Your head is out of frame · tilt the camera up or move farther away')}</div>}
    {screen === 'play' && keepPhotos && <div className="photo-notice">{tr('● guardando fotos dos últimos 20 s · E salva', '● keeping photos from the last 20 s · press E to save')}</div>}
    {recordingPrompt && <div className="recording-prompt" role="status">● {recordingPrompt}</div>}

    {screen === 'play' && <div className="hud-dock">
      <button type="button" className="dock-btn" onClick={exitGame}>{ironResults ? tr('‹ Sair do Iron Man', '‹ Leave Iron Man') : tr('‹ Menu', '‹ Menu')}</button>
      <button type="button" className="dock-btn round" onClick={toggleMute} title={muted ? tr('Áudio desligado', 'Audio off') : tr('Áudio ligado', 'Audio on')}>{muted ? '×' : '♫'}</button>
      {autoUpgradeOffered && <button type="button" className="dock-btn" aria-pressed={autoUpgrade} onClick={() => setAutoUpgrade((on) => !on)} title={tr('Envia os pontos do corpo de cada rodada ou ponto para a IA do terminal', "Sends each round's or point's body points to the terminal AI")}>{autoUpgrade ? tr('● Auto aprimoramento', '● Auto improve') : tr('○ Auto aprimoramento', '○ Auto improve')}</button>}
    </div>}

    <HandCursor store={handStore} active={menu && cameraOn} onBack={handBack} />
    {menu && cameraOn && <HandDebugOverlay store={handStore} carouselRef={carouselDebugRef} />}

    <CameraPip
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      onStart={() => void startCamera()} onStop={stopCamera}
    />
    {showPerf && <PerfMeter videoRef={videoRef} poseFrames={poseFramesRef} poseDelay={poseDelayRef} />}
    {veil}
    {splash && <NevergearSplash onDone={endSplash} />}
  </div>;
}
