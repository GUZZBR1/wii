import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang, type Bilingual } from '../i18n';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(readReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return reduced;
}

type GameplayVideoProps = {
  sport: 'athletics' | 'tennis' | 'boxing';
  name: Bilingual;
};

// Looping gameplay clip inside a showcase card. Owns its playback state:
// the observer writes inView, the tab writes pageVisible, and the button and motion preference write pausedByUser.
// One effect commits play/pause to the element. Clips have a frame-exact loop seam,
// so the loop attribute is enough; there is no rotation or crossfade.
export default function GameplayVideo({ sport, name }: GameplayVideoProps) {
  const { tr } = useLang();
  const reducedMotion = useReducedMotion();
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [pausedByUser, setPausedByUser] = useState(reducedMotion);
  const [failed, setFailed] = useState(false);

  const sources = {
    webm: `/gameplay/${sport}.webm`,
    mp4: `/gameplay/${sport}.mp4`,
    poster: `/gameplay/${sport}.jpg`,
  };

  const requestPlay = useCallback((video: HTMLVideoElement) => {
    try {
      const playing = video.play();
      playing?.catch((error: unknown) => {
        // If the browser blocks autoplay, keep the card paused until the visitor uses the button.
        if (error instanceof DOMException && error.name === 'NotAllowedError') setPausedByUser(true);
      });
    } catch {
      setPausedByUser(true);
    }
  }, []);

  // Reduced motion pauses the clip when it appears. Turning the preference off does not resume it
  // because the pause has become an explicit user choice.
  useEffect(() => {
    if (reducedMotion) setPausedByUser(true);
  }, [reducedMotion]);

  useEffect(() => {
    const syncVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    if (typeof window.IntersectionObserver !== 'function') {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // isIntersecting is true from the first visible pixel; the threshold does not filter it.
          // Enter at 20% and exit only when fully hidden, like the card reveal: between those bounds,
          // keep the current state to avoid flicker at the edge.
          if (entry.target !== frame) continue;
          if (entry.intersectionRatio >= 0.2) setInView(true);
          else if (!entry.isIntersecting) setInView(false);
        }
      },
      { threshold: [0, 0.2] },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;
    // preload="none" delays the download until this point: play() on the first viewport entry
    // is what starts loading the clip.
    if (inView && pageVisible && !pausedByUser) requestPlay(video);
    else video.pause();
  }, [failed, inView, pageVisible, pausedByUser, requestPlay]);

  // The button records the choice; the effect above is the only place that commits
  // play/pause to the element, respecting the viewport and tab visibility.
  const togglePlayback = () => setPausedByUser((current) => !current);

  const title = tr(name.pt, name.en);

  return (
    <div ref={frameRef} className="gameplay-video-frame">
      {failed ? (
        <img
          src={sources.poster}
          alt={tr(`Cena do jogo: ${name.pt}`, `Game scene: ${name.en}`)}
          width={1280}
          height={720}
          loading="lazy"
        />
      ) : (
        <>
          <video
            aria-label={tr(`Vídeo de gameplay de ${name.pt}`, `${name.en} gameplay video`)}
            disablePictureInPicture
            loop
            muted
            playsInline
            poster={sources.poster}
            preload="none"
            ref={(element) => {
              // React writes muted as an attribute, but the element is actually silenced by
              // its property; without it, autoplay is blocked.
              if (element) element.muted = true;
              videoRef.current = element;
            }}
            onError={() => setFailed(true)}
          >
            <source src={sources.webm} type="video/webm" />
            <source src={sources.mp4} type="video/mp4" onError={() => setFailed(true)} />
          </video>
          <button
            aria-label={
              pausedByUser
                ? tr(`Reproduzir vídeo de ${title}`, `Play the ${title} video`)
                : tr(`Pausar vídeo de ${title}`, `Pause the ${title} video`)
            }
            className="gameplay-video-control"
            type="button"
            onClick={togglePlayback}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {pausedByUser ? <path d="M8 5.5v13l11-6.5Z" /> : <path d="M8 5.5h3v13H8Zm5 0h3v13h-3Z" />}
            </svg>
            <span>{pausedByUser ? tr('Reproduzir', 'Play') : tr('Pausar', 'Pause')}</span>
          </button>
        </>
      )}
    </div>
  );
}
