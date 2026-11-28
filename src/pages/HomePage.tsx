import { useEffect, useState } from 'react';
import { historicDrawings } from '../data/historic-drawings';
import GamesShowcase from '../components/GamesShowcase';
import MiiCreator from '../components/MiiCreator';
import { useLang } from '../i18n';

// Time each card stays highlighted (as on hover) before advancing to the next one.
const HIGHLIGHT_MS = 7000;

const PENDING_SUFFIX = ' · pedido';

export default function HomePage() {
  const { tr } = useLang();
  // Patent dates such as "1903 · filed" are rearranged for the English label; other dates stay as written.
  const yearLabel = (year: string) =>
    year.endsWith(PENDING_SUFFIX)
      ? tr(year, `filed ${year.slice(0, -PENDING_SUFFIX.length)}`)
      : year;
  const [active, setActive] = useState(-1);
  useEffect(() => {
    // With reduced motion enabled, do not highlight cards automatically; only hover responds.
    // Track preference changes while the page is open.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    const sync = () => {
      window.clearInterval(timer);
      if (reduce.matches) {
        setActive(-1);
        return;
      }
      setActive(-1);
      // O destaque espera a abertura acabar e os quadros terminarem de aparecer.
      timer = window.setInterval(() => {
        if (document.body.classList.contains('intro-active')) return;
        setActive((current) => (current + 1) % historicDrawings.length);
      }, HIGHLIGHT_MS);
    };
    sync();
    reduce.addEventListener('change', sync);
    return () => {
      window.clearInterval(timer);
      reduce.removeEventListener('change', sync);
    };
  }, []);

  return (
    <main className="home-stage" id="page-content" aria-label={tr('Nevergear, início', 'Nevergear, home')}>
      <section className="archive-gallery" aria-label={tr('Marcos do corpo e do movimento como controle', 'Milestones of body and motion as input')}>
        {historicDrawings.map((drawing, index) => (
          <a
            className={`archive-card${index === active ? ' is-active' : ''}`}
            href={drawing.source}
            key={drawing.title.pt}
            target="_blank"
            rel="noreferrer"
            style={{ '--i': index } as React.CSSProperties}
            aria-label={tr(
              `${drawing.title.pt}, por ${drawing.artist.pt}, ${yearLabel(drawing.year)}. Abrir fonte.`,
              `${drawing.title.en}, by ${drawing.artist.en}, ${yearLabel(drawing.year)}. Open source.`,
            )}
          >
            <span className="archive-art-surface">
              <svg className="archive-trace" aria-hidden="true">
                <rect pathLength="1" />
              </svg>
              <img src={drawing.image} alt={tr(drawing.alt.pt, drawing.alt.en)} loading="lazy" />
            </span>
            <span className="archive-caption">
              <span className="archive-work">
                <span className="archive-title">{tr(drawing.title.pt, drawing.title.en)}</span>
                <span className="archive-credit">
                  {tr(drawing.artist.pt, drawing.artist.en)} · {yearLabel(drawing.year)}
                </span>
              </span>
              <span className="archive-source" aria-hidden="true">↗</span>
            </span>
          </a>
        ))}
      </section>
      <GamesShowcase />
      <MiiCreator />
    </main>
  );
}
