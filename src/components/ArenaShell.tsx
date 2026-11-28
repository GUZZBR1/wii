import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLang } from '../i18n';

const ArenaApp = lazy(() => import('../App'));

/** `/app` frame for the sports arena and its exit transition. */
export default function ArenaShell() {
  const { lang, setLang, tr } = useLang();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useEffect(() => {
    const siteTitle = document.title;
    document.title = 'Nevergear Sports — Arena';
    return () => { document.title = siteTitle; };
  }, []);

  // Leaving reverses arrival: the arena flashes white while the site returns from far away to its normal size.
  const leave = (event: React.MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (leaving) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate('/product');
      return;
    }
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      document.body.classList.add('is-arriving');
      navigate('/product');
      window.setTimeout(() => document.body.classList.remove('is-arriving'), 1500);
    }, 1100);
  };

  const exitLink = (
    <Link className="arena-exit" style={{ zIndex: 30 }} to="/product" onClick={leave}>{tr('sair ↗', 'exit ↗')}</Link>
  );

  return (
    <main className={`arena-page${leaving ? ' is-leaving' : ''}`} id="page-content" lang={lang === 'pt' ? 'pt-BR' : 'en'}>
      <div className="arena-flash" aria-hidden="true" />
      {leaving && <div className="arena-leave" aria-hidden="true" />}
      <fieldset className="arena-language">
        <legend className="sr-only">{tr('Idioma do jogo', 'Game language')}</legend>
        <button type="button" aria-pressed={lang === 'pt'} onClick={() => setLang('pt')}>PT</button>
        <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
      </fieldset>
      <div className="arena">
        <Suspense fallback={null}><ArenaApp exit={exitLink} /></Suspense>
      </div>
    </main>
  );
}
