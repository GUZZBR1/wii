import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import { disposeObjectTree } from '../games/core/GameLoop';
import { CPU_MIIS } from '../miis/miiCatalog';
import { createMiiLights, createMiiModel, type MiiModel } from '../miis/miiMesh';
import { registerMiiPicker } from '../miis/miiPick';
import { createWalkers, stepWalker, type Walker } from '../miis/miiSimulation';
import { getPlayerMii, setPlayerMii, usePlayerMii } from '../miis/miiStore';
import { type SiteMii, siteMiiFromProfile } from '../miis/siteMii';
import { useLang } from '../i18n';

/** Pixels por unidade do modelo: um Mii médio fica com cerca de 64 px. */
const SCALE = 32;
const CLICK_IGNORE = 'a, button, input, select, textarea, label, summary, canvas, [role="button"], [role="dialog"]';

interface Actor {
  mii: SiteMii;
  readonly walker: Walker;
  model: MiiModel;
  phase: number;
}

interface Selection {
  readonly mii: SiteMii;
  readonly x: number;
  readonly y: number;
}

/** Miis passeando pela página inteira. O canvas cobre a janela e nunca recebe o ponteiro. */
export default function SiteMiiPlaza() {
  const { tr } = useLang();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const player = usePlayerMii();
  const hostRef = useRef<HTMLDivElement>(null);
  const replacePlayerRef = useRef<(mii: SiteMii) => void>(() => {});
  const [selected, setSelected] = useState<Selection | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // sem WebGL o site segue normal, só sem a praça
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    host.append(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(...createMiiLights());
    // 1 unidade = 1 px CSS, com a origem no canto superior esquerdo da janela.
    const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -2000, 2000);
    const bounds = () => ({
      width: document.documentElement.clientWidth,
      height: Math.max(document.body.scrollHeight, window.innerHeight),
    });
    const spawn = (mii: SiteMii) => {
      const model = createMiiModel(mii);
      model.root.scale.multiplyScalar(SCALE);
      scene.add(model.root);
      return model;
    };
    const roster = [getPlayerMii(), ...CPU_MIIS.map(siteMiiFromProfile)];
    const walkers = createWalkers(roster.length, bounds());
    const actors: Actor[] = roster.map((mii, index) => ({
      mii,
      walker: walkers[index],
      model: spawn(mii),
      phase: index,
    }));
    // O jogador começa à vista.
    walkers[0].x = bounds().width * 0.5;
    walkers[0].y = window.scrollY + window.innerHeight * 0.75;

    replacePlayerRef.current = (mii) => {
      const actor = actors[0];
      if (actor.mii === mii) return;
      scene.remove(actor.model.root);
      disposeObjectTree(actor.model.root);
      actor.mii = mii;
      actor.model = spawn(mii);
    };

    let area = bounds();
    const resize = () => {
      const previousArea = area;
      area = bounds();
      // A página mudou de tamanho (rota, imagens, janela): mantém o elenco espalhado.
      for (const { walker } of actors) {
        walker.x *= area.width / previousArea.width;
        walker.y *= area.height / previousArea.height;
      }
      const width = area.width;
      const height = window.innerHeight;
      renderer.setSize(width, height, false);
      camera.right = width;
      camera.bottom = -height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(document.body);
    window.addEventListener('resize', resize);
    resize();

    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      const scrollY = window.scrollY;
      for (const actor of actors) {
        const { walker, model } = actor;
        if (!still.matches) stepWalker(walker, dt, area);
        const walking = walker.walking && !still.matches;
        const screenY = walker.y - scrollY;
        model.root.visible = screenY > -10 && screenY < window.innerHeight + 90;
        if (!model.root.visible) continue;
        if (walking) actor.phase += dt * 9;
        model.pose(actor.phase, walking ? 1 : 0);
        // Quem está mais baixo na tela fica na frente.
        model.root.position.set(walker.x, -screenY, screenY);
        // Andando, olha para onde vai; parado, olha para quem está lendo.
        const yaw = walking ? Math.atan2(Math.cos(walker.heading), Math.sin(walker.heading)) : 0;
        model.root.rotation.set(0.16, yaw, 0);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    // Mesmo pick para mouse e para a pinça da mão: as exclusões (controles, canvas, cartão)
    // valem pelas coordenadas e pelo elemento do topo, seja ele o target do clique ou o hit-test.
    const pickAt = (clientX: number, clientY: number, target: Element | null | undefined) => {
      if (target?.closest('[data-mii-inspector]')) return;
      let hit: Actor | null = null;
      if (!target?.closest(CLICK_IGNORE)) {
        const pageY = clientY + window.scrollY;
        for (const actor of actors) {
          const { x, y } = actor.walker;
          if (Math.abs(clientX - x) > 18 || pageY > y + 6 || pageY < y - 70) continue;
          if (!hit || y > hit.walker.y) hit = actor;
        }
      }
      setSelected(hit ? { mii: hit.mii, x: clientX, y: clientY } : null);
    };
    const pick = (event: MouseEvent) => pickAt(event.clientX, event.clientY, event.target as Element | null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    const close = () => setSelected(null);
    const unregisterMiiPicker = registerMiiPicker(pickAt);
    window.addEventListener('click', pick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unregisterMiiPicker();
      window.removeEventListener('resize', resize);
      window.removeEventListener('click', pick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close);
      replacePlayerRef.current = () => {};
      disposeObjectTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => replacePlayerRef.current(player), [player]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: o cartão fecha a cada troca de rota.
  useEffect(() => setSelected(null), [pathname]);

  const editPlayer = () => {
    setSelected(null);
    if (pathname !== '/') navigate('/');
    // Espera a rota montar antes de rolar até o criador.
    window.setTimeout(() => document.getElementById('mii-creator')?.scrollIntoView({ behavior: 'smooth' }), 80);
  };

  return (
    <>
      <div ref={hostRef} className="mii-plaza" aria-hidden="true" />
      {selected && (
        <div
          data-mii-inspector
          className="mii-card"
          role="dialog"
          aria-label={`Mii ${selected.mii.name}`}
          style={{
            left: Math.min(Math.max(selected.x, 110), window.innerWidth - 110),
            top: Math.max(selected.y - 12, 150),
          }}
        >
          <strong>{selected.mii.name}</strong>
          {selected.mii.isCpu ? (
            <>
              <span>CPU · {tr('habilidade', 'skill')} {Math.round(selected.mii.skill * 100)}</span>
              <button
                type="button"
                onClick={() => {
                  setPlayerMii({ ...selected.mii, name: player.name });
                  setSelected(null);
                }}
              >
                {tr('Usar este visual', 'Use this look')}
              </button>
            </>
          ) : (
            <>
              <span>{tr('Seu Mii', 'Your Mii')}</span>
              <button type="button" onClick={editPlayer}>{tr('Editar', 'Edit')}</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
