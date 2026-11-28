import { useEffect, useRef, useState, type CSSProperties } from 'react';
import CrystalAsciiField from '../components/CrystalAsciiField';
import { paperLines, papers, type Paper } from '../data/papers';
import { useLang } from '../i18n';
import { orbitRadii } from './papersOrbit';

const LINE_MS = 4800;

/** The research proposals orbit the title; clicking one opens its summary and figure. */
export default function PapersPage() {
  const { lang, tr } = useLang();
  // Article text in the current language (Portuguese in the base fields, English in p.en).
  const copyOf = (p: Paper) => ({ short: tr(p.short, p.en.short), title: tr(p.title, p.en.title), blurb: tr(p.blurb, p.en.blurb) });
  const ringRef = useRef<HTMLDivElement>(null);
  const rotateRef = useRef<((index: number, done: () => void) => void) | null>(null); // Rotate the ring until a card reaches the front.
  const busy = useRef(false); // Queue new clicks while the ring is moving.
  const openRef = useRef(false); // com um resumo aberto o carrossel desacelera ate parar, sem corte seco
  const focusRef = useRef(false); // idem enquanto o foco do teclado esta num cartao (o alvo nao pode fugir)
  const [open, setOpen] = useState<Paper | null>(null);
  const [shown, setShown] = useState<Paper | null>(null); // Keep the panel mounted while it collapses.
  useEffect(() => { if (open) setShown(open); }, [open]);
  const [line, setLine] = useState(0);
  const reduce = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => { openRef.current = open !== null; }, [open]);

  // Elliptical carousel: items in front grow sharper; items behind become smaller and fainter.
  // Each frame writes only transform/opacity and performs no layout reads. Cache measurements and
  // update them only in ResizeObserver; the pointer never pauses rotation, while opening or focusing a summary slows it.
  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    const cards = Array.from(ring.children) as HTMLElement[];
    const front = cards.map(() => false);
    const compact = window.matchMedia('(max-width: 480px)');
    let rx = 0;
    let ry = 0;
    const measure = () => {
      let maxWidth = 0;
      let maxHeight = 0;
      for (const card of cards) {
        maxWidth = Math.max(maxWidth, card.offsetWidth);
        maxHeight = Math.max(maxHeight, card.offsetHeight);
      }
      ({ x: rx, y: ry } = orbitRadii(ring.clientWidth, ring.clientHeight, maxWidth, maxHeight));
    };
    let angle = -Math.PI / 2;
    let speed = 0.09; // rad/s
    let last = performance.now();
    let raf = 0;
    let tween: { from: number; to: number; t0: number; dur: number; done: () => void } | null = null;
    const TAU = Math.PI * 2;
    // Rotate along the shortest path until card i reaches the front (bottom of the ellipse), then call done.
    const rotateTo = (i: number, done: () => void) => {
      if (compact.matches) { done(); return; }
      if (reduce.current) {
        angle = Math.PI / 2 - (i / cards.length) * TAU;
        place();
        done();
        return;
      }
      const base = Math.PI / 2 - (i / cards.length) * TAU;
      // Take the shorter clockwise or counterclockwise path to bring the card closer to the front.
      const delta = ((((base - angle) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
      if (Math.abs(delta) < 0.02) { done(); return; }
      tween = { from: angle, to: angle + delta, t0: performance.now(), dur: Math.min(2400, 900 + Math.abs(delta) * 350), done };
    };
    rotateRef.current = rotateTo;
    const place = () => {
      cards.forEach((el, i) => {
        if (compact.matches) {
          // Keep the title clear: two cards above, remaining rows below.
          if (i < 2) {
            const x = (i % 2 === 0 ? -1 : 1) * rx;
            const y = -ry;
            el.style.transform = `translate3d(calc(-50% + ${x.toFixed(2)}px), calc(-50% + ${y.toFixed(2)}px), 0)`;
          } else {
            const lowerCount = cards.length - 2;
            const row = Math.floor((i - 2) / 2);
            const totalLowerRows = Math.ceil(lowerCount / 2);
            const isLastOdd = lowerCount % 2 === 1 && i === cards.length - 1;
            const x = isLastOdd ? 0 : ((i - 2) % 2 === 0 ? -1 : 1) * rx;
            const t = totalLowerRows > 1 ? row / (totalLowerRows - 1) : 1;
            const y = ry * (0.28 + 0.72 * t);
            el.style.transform = `translate3d(calc(-50% + ${x.toFixed(2)}px), calc(-50% + ${y.toFixed(2)}px), 0)`;
          }
          el.style.opacity = '1';
          el.style.zIndex = '5';
          front[i] = false;
          return;
        }
        const a = angle + (i / cards.length) * Math.PI * 2;
        const depth = (Math.sin(a) + 1) / 2; // 1 = frente (parte de baixo da elipse)
        const scale = 0.84 + 0.16 * depth;
        el.style.transform = `translate3d(calc(-50% + ${(Math.cos(a) * rx).toFixed(2)}px), calc(-50% + ${(Math.sin(a) * ry).toFixed(2)}px), 0) scale(${scale.toFixed(4)})`;
        el.style.opacity = (0.88 + 0.12 * depth).toFixed(3);
        const f = depth > 0.62; // atras do titulo; na frente dele so quando passa por baixo
        if (f !== front[i]) { front[i] = f; el.style.zIndex = f ? '30' : '5'; }
      });
    };
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05); // Clamp the elapsed time after a background tab pause.
      last = now;
      if (tween) {
        const t = tween;
        const p = Math.min(1, (now - t.t0) / t.dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2; // ease in-out cubico
        angle = t.from + (t.to - t.from) * e;
        if (p >= 1) {
          tween = null;
          speed = 0;
          place();
          t.done();
          raf = requestAnimationFrame(tick);
          return;
        }
      } else {
        const target = openRef.current || focusRef.current ? 0 : 0.09;
        speed += (target - speed) * Math.min(1, dt * 4);
        angle += speed * dt;
      }
      place();
      raf = requestAnimationFrame(tick);
    };
    measure();
    place();
    const ro = new ResizeObserver(() => { measure(); place(); });
    const onCompactChange = () => { measure(); place(); };
    compact.addEventListener('change', onCompactChange);
    ro.observe(ring);
    for (const card of cards) ro.observe(card);
    if (!reduce.current) raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      compact.removeEventListener('change', onCompactChange);
      rotateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (reduce.current || open) return;
    const id = window.setInterval(() => setLine((l) => (l + 1) % paperLines.length), LINE_MS);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (ringRef.current?.contains(document.activeElement)) focusRef.current = true;
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // When another article is clicked, close the current one, rotate the ring to it, and then open it.
  const pick = (p: Paper) => {
    // Bring focus to the center, where the papers sit, even if the page has been scrolled down.
    ringRef.current?.scrollIntoView({ behavior: reduce.current ? 'auto' : 'smooth', block: 'center' });
    if (open?.n === p.n) { setOpen(null); return; }
    if (busy.current) return;
    busy.current = true;
    setOpen(null);
    const finish = () => { busy.current = false; setOpen(p); };
    if (rotateRef.current) rotateRef.current(papers.indexOf(p), finish);
    else finish();
  };

  return (
    <main className={`papers${open ? ' has-open' : ''}`} id="page-content">
      <CrystalAsciiField />
      {/* biome-ignore lint/a11y/useSemanticElements: The orbit cards are an interactive carousel, not form fields. */}
      <div
        className="papers-orbit product-emerge"
        style={{ '--emerge': 1500 } as CSSProperties}
        ref={ringRef}
        onFocus={(e) => { focusRef.current = e.target instanceof HTMLElement && e.target.matches(':focus-visible'); }}
        onPointerDown={() => { focusRef.current = false; }}
        onBlur={() => { focusRef.current = false; }}
        role="group"
        aria-label={tr('Artigos', 'Papers')}
      >
        {papers.map((p) => {
          const c = copyOf(p);
          return (
            <div className="papers-orbit-item" key={p.n}>
              <button
                type="button"
                className={`papers-card${open?.n === p.n ? ' is-open' : ''}`}
                aria-label={tr(`Artigo ${p.n}: ${c.short}`, `Paper ${p.n}: ${c.short}`)}
                aria-expanded={open?.n === p.n}
                onClick={() => pick(p)}
              >
                <span className="papers-card-n">{p.n}</span>
                <span className="papers-card-name">{c.short}</span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="papers-center">
        <h1 className="papers-title product-emerge" style={{ '--emerge': 300 } as CSSProperties}>papers</h1>
        <div className={`papers-swap${open ? ' is-open' : ''}`}>
          <div className="papers-swap-inner">
            {shown && (
              <article className="papers-detail" aria-live="polite" aria-hidden={!open}>
                <p className="papers-detail-kicker">
                  {tr(`referência ${shown.n} de ${papers.length} · artigo externo`, `reference ${shown.n} of ${papers.length} · external paper`)}
                </p>
                <h2 className="papers-detail-title">{copyOf(shown).title}</h2>
                <p className="papers-detail-blurb">{copyOf(shown).blurb}</p>
                <div className="papers-detail-actions">
                  <a className="papers-open" href={shown.externalUrl} target="_blank" rel="noopener noreferrer">{tr('abrir artigo', 'open article')}</a>
                  <button type="button" className="papers-close" onClick={() => setOpen(null)}>{tr('fechar', 'close')}</button>
                </div>
              </article>
            )}
          </div>
        </div>
        <div className={`papers-swap${open ? '' : ' is-open'}`}>
          <div className="papers-swap-inner">
            <div>
              <p className="papers-line" key={`${line}-${lang}`} aria-live="off">{tr(paperLines[line].pt, paperLines[line].en)}</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
