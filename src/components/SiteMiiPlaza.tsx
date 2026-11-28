import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { disposeObjectTree } from '../games/core/GameLoop';
import { CPU_MIIS } from '../miis/miiCatalog';
import { createMiiLights, createMiiModel, type MiiModel } from '../miis/miiMesh';
import { registerMiiPicker } from '../miis/miiPick';
import {
  BOTTOM_MARGIN,
  createWalkers,
  depthScale,
  enterFromEdge,
  GRUMP_SECONDS,
  grumpPose,
  SIDE_MARGIN,
  stepWalker,
  TOP_MARGIN,
  type Walker,
} from '../miis/miiSimulation';
import { getPlayerMii, usePlayerMii } from '../miis/miiStore';
import { type SiteMii, siteMiiFromProfile } from '../miis/siteMii';
import { useLang } from '../i18n';

/** Pixels por unidade do modelo: um Mii médio fica com cerca de 64 px. */
const SCALE = 32;
/** Parte do elenco que passeia: um quarto fica de fora para a página não lotar. */
const CROWD = 0.75;
/** Movimento do ponteiro, em px, a partir do qual o clique vira arrasto. */
const DRAG_SLOP = 6;
const CLICK_IGNORE =
  'a, button, input, select, textarea, label, summary, canvas, img, video, h1, h2, h3, p, [role="button"], [role="dialog"]';

interface Actor {
  mii: SiteMii;
  readonly walker: Walker;
  model: MiiModel;
  baseScale: THREE.Vector3;
  readonly shadow: THREE.Mesh;
  phase: number;
  /** Segundos desde o clique que o incomodou. */
  grumpFor: number;
}

/** Miis passeando atrás do conteúdo da página. O canvas nunca recebe o ponteiro: clique e arrasto são lidos na janela. */
export default function SiteMiiPlaza() {
  const { tr } = useLang();
  const player = usePlayerMii();
  const hostRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<HTMLCanvasElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const replacePlayerRef = useRef<(mii: SiteMii) => void>(() => {});

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
    const shadowGeometry = new THREE.CircleGeometry(1, 24);
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x102a3a,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const spawnShadow = () => {
      const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
      scene.add(shadow);
      return shadow;
    };
    const cast = [getPlayerMii(), ...CPU_MIIS.map(siteMiiFromProfile)];
    const roster = cast.slice(0, Math.round(cast.length * CROWD));
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const walkers = createWalkers(roster.length, bounds());
    const actors: Actor[] = roster.map((mii, index) => {
      const model = spawn(mii);
      const baseScale = model.root.scale.clone();
      return {
        mii,
        walker: walkers[index],
        model,
        baseScale,
        shadow: spawnShadow(),
        phase: index,
        grumpFor: GRUMP_SECONDS,
      };
    });
    // Chegam aos poucos pelas laterais e cantos, o jogador primeiro. Sem movimento, já começam no lugar.
    if (!still.matches) {
      walkers.forEach((walker, index) => {
        enterFromEdge(walker, index, bounds(), window.scrollY, window.innerHeight);
      });
    }

    replacePlayerRef.current = (mii) => {
      const actor = actors[0];
      if (actor.mii === mii) return;
      scene.remove(actor.model.root);
      disposeObjectTree(actor.model.root);
      actor.mii = mii;
      actor.model = spawn(mii);
      actor.baseScale = actor.model.root.scale.clone();
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

    let drag: {
      actor: Actor;
      id: number;
      startX: number;
      startY: number;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;
    let swallowClick = false;
    let grumpy: Actor | null = null;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      const scrollY = window.scrollY;
      for (const actor of actors) {
        const { walker, model } = actor;
        const held = drag?.moved === true && drag.actor === actor;
        actor.grumpFor = Math.min(GRUMP_SECONDS, actor.grumpFor + dt);
        const grumbling = actor.grumpFor < GRUMP_SECONDS && !still.matches;
        if (!still.matches && !held && !grumbling) stepWalker(walker, dt, area);
        const walking = walker.walking && !still.matches && !grumbling;
        const screenY = walker.y - scrollY;
        model.root.visible = (still.matches || walker.delay <= 0) && screenY > -10 && screenY < window.innerHeight + 90;
        actor.shadow.visible = model.root.visible;
        if (!model.root.visible) continue;
        // No colo ou incomodado, esperneia depressa.
        const kicking = held || grumbling;
        if (walking || kicking) actor.phase += dt * (kicking ? 18 : 9);
        model.pose(actor.phase, walking || kicking ? 1 : 0);
        // Quem está mais baixo na tela fica na frente.
        const grump = grumpPose(actor.grumpFor);
        const lift = held ? 14 : grumbling ? grump.hop : 0;
        model.root.position.set(walker.x, -screenY + lift, screenY);
        const depth = depthScale(screenY, window.innerHeight);
        model.root.scale.copy(actor.baseScale).multiplyScalar(depth);
        actor.shadow.position.set(walker.x, -screenY, screenY - SCALE);
        actor.shadow.scale.set(18 * depth, 5 * depth, 1);
        // Andando, olha para onde vai; parado, olha para quem está lendo.
        const yaw = walking ? Math.atan2(Math.cos(walker.heading), Math.sin(walker.heading)) : 0;
        model.root.rotation.set(
          0.16,
          grumbling ? grump.yaw : held ? 0 : yaw,
          grumbling ? grump.tilt : held ? Math.sin(now / 140) * 0.18 : 0,
        );
      }
      const bubble = bubbleRef.current;
      if (bubble) {
        const show = grumpy !== null && grumpy.grumpFor < GRUMP_SECONDS;
        bubble.hidden = !show;
        if (show && grumpy) {
          // Embaixo dos pés e sem sair pela lateral.
          const x = Math.min(Math.max(grumpy.walker.x - 34, 4), window.innerWidth - 80);
          bubble.style.translate = `${x}px ${grumpy.walker.y - scrollY + 6}px`;
        }
      }
      // Só o Mii no colo passa por cima do conteúdo: é desenhado sozinho e copiado para a tela da frente.
      const carried = drag?.moved ? drag.actor : null;
      const lift = liftRef.current;
      if (lift) lift.hidden = !carried;
      if (carried && lift) {
        const others = actors.filter((actor) => actor !== carried && actor.model.root.visible);
        const show = (list: Actor[], visible: boolean) => {
          for (const actor of list) actor.model.root.visible = actor.shadow.visible = visible;
        };
        show(others, false);
        renderer.render(scene, camera);
        lift.width = renderer.domElement.width;
        lift.height = renderer.domElement.height;
        lift.getContext('2d')?.drawImage(renderer.domElement, 0, 0);
        show(others, true);
        show([carried], false);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    /** O Mii sob o ponteiro, se não houver conteúdo da página na frente dele. */
    const actorAt = (target: EventTarget | null, clientX: number, clientY: number) => {
      if (!(target instanceof Element) || target.closest(CLICK_IGNORE)) return null;
      let hit: Actor | null = null;
      const pageY = clientY + window.scrollY;
      for (const actor of actors) {
        const { x, y, delay } = actor.walker;
        if (delay > 0 && !still.matches) continue;
        const depth = depthScale(y - window.scrollY, window.innerHeight);
        if (Math.abs(clientX - x) > 18 * depth || pageY > y + 6 || pageY < y - 70 * depth) continue;
        if (!hit || y > hit.walker.y) hit = actor;
      }
      return hit;
    };
    /** Incomoda o Mii sob o ponto. Serve ao clique do mouse e à pinça da mão (miiPick). */
    const pickAt = (clientX: number, clientY: number, target: Element | null | undefined) => {
      const hit = actorAt(target ?? null, clientX, clientY);
      if (hit) {
        hit.grumpFor = 0;
        grumpy = hit;
      }
    };
    const pick = (event: MouseEvent) => {
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      pickAt(event.clientX, event.clientY, event.target as Element | null);
    };
    const press = (event: PointerEvent) => {
      swallowClick = false;
      if (event.button !== 0 || drag) return;
      const actor = actorAt(event.target, event.clientX, event.clientY);
      if (!actor) return;
      // Guarda a distância entre o ponteiro e os pés, para o Mii não pular ao ser pego.
      drag = {
        actor,
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: actor.walker.x - event.clientX,
        y: actor.walker.y - event.clientY - window.scrollY,
        moved: false,
      };
      if (event.pointerType === 'mouse') event.preventDefault(); // não seleciona texto ao arrastar
    };
    const move = (event: PointerEvent) => {
      if (!drag) {
        if (event.pointerType === 'mouse')
          document.body.style.cursor = actorAt(event.target, event.clientX, event.clientY) ? 'grab' : '';
        return;
      }
      if (event.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_SLOP) return;
      if (!drag.moved) {
        drag.moved = true;
        document.body.style.cursor = 'grabbing';
      }
      const { walker } = drag.actor;
      walker.delay = 0;
      walker.entering = 0;
      walker.x = Math.min(Math.max(event.clientX + drag.x, SIDE_MARGIN), area.width - SIDE_MARGIN);
      walker.y = Math.min(Math.max(event.clientY + window.scrollY + drag.y, TOP_MARGIN), area.height - BOTTOM_MARGIN);
    };
    const release = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        swallowClick = event.type === 'pointerup';
        // Larga o Mii parado um instante antes de ele voltar a passear.
        drag.actor.walker.walking = false;
        drag.actor.walker.timer = 1.2;
        document.body.style.cursor = '';
      }
      drag = null;
    };
    // No toque, só impede a rolagem quando o dedo começou em cima de um Mii.
    const holdScroll = (event: TouchEvent) => {
      if (drag) event.preventDefault();
    };
    window.addEventListener('pointerdown', press);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('touchmove', holdScroll, { passive: false });
    const unregisterMiiPicker = registerMiiPicker(pickAt);
    window.addEventListener('click', pick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unregisterMiiPicker();
      window.removeEventListener('resize', resize);
      window.removeEventListener('click', pick);
      window.removeEventListener('pointerdown', press);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('touchmove', holdScroll);
      document.body.style.cursor = '';
      replacePlayerRef.current = () => {};
      disposeObjectTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => replacePlayerRef.current(player), [player]);
  return (
    <>
      <div ref={hostRef} className="mii-plaza" aria-hidden="true" />
      <canvas ref={liftRef} className="mii-lift" aria-hidden="true" tabIndex={-1} hidden />
      <span ref={bubbleRef} className="mii-grump" aria-hidden="true" hidden>
        {tr('Ei!', 'Hey!')} 💢
      </span>
    </>
  );
}
