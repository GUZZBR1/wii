import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useLang, type Bilingual } from '../i18n';
import GameplayVideo from './GameplayVideo';

type ShowcaseGame = {
  id: 'athletics' | 'tennis' | 'boxing';
  name: Bilingual;
  description: Bilingual;
};

const GAMES: ShowcaseGame[] = [
  {
    id: 'athletics',
    name: { pt: 'Atletismo', en: 'Athletics' },
    description: {
      pt: 'A manhã está clara no estádio e a raia espera por você. Corra no lugar e veja seu corredor ganhar ritmo a cada passo, curva após curva. Escolha entre 100, 200 e 400 metros e descubra quanto fôlego ainda resta na reta final.',
      en: 'It is a clear morning at the stadium and your lane is waiting. Run in place and watch your runner build pace with every step, bend after bend. Choose 100, 200 or 400 metres and find out how much breath you have left for the home straight.',
    },
  },
  {
    id: 'tennis',
    name: { pt: 'Tênis', en: 'Tennis' },
    description: {
      pt: 'A quadra fica em silêncio, a bola sobe e todos os olhos estão no seu saque. Balance o braço para sacar e rebater, como se a raquete estivesse na sua mão. O momento da raquetada define a direção da bola, e cada troca pede um pouco mais de calma.',
      en: 'The court goes quiet, the ball rises and every eye is on your serve. Swing your arm to serve and return, as if the racket were in your hand. The timing of your swing sets the direction of the ball, and every rally asks for a little more composure.',
    },
  },
  {
    id: 'boxing',
    name: { pt: 'Boxe', en: 'Boxing' },
    description: {
      pt: 'As luzes se acendem, a torcida se ajeita e o adversário já ergueu a guarda. Soque para a frente quando surgir a brecha e incline o corpo para esquivar do que vier. Antes da primeira luta, um aquecimento rápido ensina a defender, socar e esquivar.',
      en: 'The lights come up, the crowd settles in and your opponent already has their guard up. Punch forward when an opening appears and lean away from whatever comes back. Before your first fight, a quick warm-up teaches you to guard, punch and dodge.',
    },
  },
];

export default function GamesShowcase() {
  const { tr } = useLang();
  const listRef = useRef<HTMLUListElement>(null);

  // Each game appears as it enters the viewport and disappears when it leaves in either direction. Without is-reveal, all cards stay visible.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // Between 0% and 20%, keep the current state to avoid flickering at the edge.
        if (entry.intersectionRatio >= 0.2) entry.target.classList.add('is-visible');
        else if (!entry.isIntersecting) entry.target.classList.remove('is-visible');
      }
    }, { threshold: [0, 0.2] });
    list.classList.add('is-reveal');
    for (const item of list.children) observer.observe(item);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="games-showcase" aria-labelledby="games-showcase-title">
      <h2 id="games-showcase-title">{tr('Os jogos', 'The games')}</h2>
      <ul ref={listRef}>
        {GAMES.map((game) => (
          <li key={game.id}>
            <GameplayVideo sport={game.id} name={game.name} />
            <div>
              <h3>{tr(game.name.pt, game.name.en)}</h3>
              <p>{tr(game.description.pt, game.description.en)}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="games-showcase-iron">
        {tr(
          'E quando um só não bastar, o Iron Man junta os três em um único desafio.',
          'And when one is not enough, Iron Man strings all three into a single challenge.',
        )}
      </p>
      <Link className="vision-cta" to="/app">
        {tr('Jogar agora', 'Play now')} <span aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}
