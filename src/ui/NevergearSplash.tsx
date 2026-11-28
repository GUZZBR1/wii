import { useEffect } from 'react';

const SPLASH_MS = 2400;

/** Abertura: tela branca, o "Nevergear" vem do fundo e a tela se abre no meio. */
export function NevergearSplash({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(onDone, reduce ? 0 : SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return <div className="nevergear-splash" aria-hidden="true">
    <div className="nevergear-half left"><span>Nevergear</span></div>
    <div className="nevergear-half right"><span>Nevergear</span></div>
  </div>;
}
