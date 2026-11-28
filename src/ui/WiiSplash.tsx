import { useEffect } from 'react';

const SPLASH_MS = 2400;

/** Abertura: tela branca, o "NeverGear" vem do fundo e a tela se abre no meio. */
export function WiiSplash({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(onDone, reduce ? 0 : SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return <div className="wii-splash" aria-hidden="true">
    <div className="wii-half left"><img className="brand-logo" src="/images/nevergear-logo.png" alt="" width={1200} height={234} /></div>
    <div className="wii-half right"><img className="brand-logo" src="/images/nevergear-logo.png" alt="" width={1200} height={234} /></div>
  </div>;
}
