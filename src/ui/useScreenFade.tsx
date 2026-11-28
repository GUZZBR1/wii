import { useCallback, useState } from 'react';

/** Passagem entre telas, como no Wii: clareia até o branco, troca, e o branco se dissolve. */
export function useScreenFade<S>(show: (screen: S) => void) {
  const [fade, setFade] = useState<{ phase: 'out'; to: S } | { phase: 'in' }>();

  // Sem animação não há `animationend`: quem pede menos movimento troca direto.
  const go = useCallback((to: S) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) show(to);
    else setFade({ phase: 'out', to });
  }, [show]);

  const veil = fade && <div
    key={fade.phase} className={`screen-fade ${fade.phase}`} aria-hidden="true"
    onAnimationEnd={() => {
      if (fade.phase === 'in') { setFade(undefined); return; }
      show(fade.to);
      setFade({ phase: 'in' });
    }}
  />;

  return { go, veil };
}
