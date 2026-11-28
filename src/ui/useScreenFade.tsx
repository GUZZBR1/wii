import { useCallback, useState } from 'react';

/** Nevergear-style screen transition: fade to white, switch screens, then dissolve the overlay. */
export function useScreenFade<S>(show: (screen: S) => void) {
  const [fade, setFade] = useState<{ phase: 'out'; to: S } | { phase: 'in' }>();

  // Reduced-motion mode has no `animationend`; switch immediately instead.
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
