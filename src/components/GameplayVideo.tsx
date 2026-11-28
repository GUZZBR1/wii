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

// Clipe de gameplay em loop dentro da moldura de um cartao da vitrine. Dono do
// proprio estado de reproducao: o observador escreve inView, a aba escreve
// pageVisible, o botao e a preferencia de movimento escrevem pausedByUser, e um
// unico efeito confirma play/pause no elemento. Os clipes tem emenda de loop
// frame-exata, entao o atributo loop basta — nao ha rotacao nem crossfade.
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
        // Autoplay bloqueado pelo navegador: o cartao acorda pausado e o
        // visitante assume o controle pelo botao.
        if (error instanceof DOMException && error.name === 'NotAllowedError') setPausedByUser(true);
      });
    } catch {
      setPausedByUser(true);
    }
  }, []);

  // A preferencia de reduzir movimento pausa o clipe ao aparecer; desligar a
  // preferencia nao retoma sozinho, pois a pausa ja virou escolha do usuario.
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
          if (entry.target === frame) setInView(entry.isIntersecting);
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;
    // preload="none" segura o download ate aqui: o play() que dispara na
    // primeira entrada na viewport e o que inicia o carregamento do clipe.
    if (inView && pageVisible && !pausedByUser) requestPlay(video);
    else video.pause();
  }, [failed, inView, pageVisible, pausedByUser, requestPlay]);

  // O botao so registra a escolha; o efeito acima e o unico ponto que confirma
  // play/pause no elemento, respeitando viewport e visibilidade da aba.
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
              // React escreve muted como atributo, mas o elemento so silencia de
              // verdade com a propriedade — sem isso o autoplay e bloqueado.
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
