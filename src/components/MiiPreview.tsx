import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { disposeObjectTree } from '../games/core/GameLoop';
import { createMiiLights, createMiiModel, type MiiModel } from '../miis/miiMesh';
import type { SiteMii } from '../miis/siteMii';
import { useLang } from '../i18n';

/** Prévia 3D do rascunho; arraste para girar. Um renderer por montagem. */
export default function MiiPreview({ mii }: { mii: SiteMii }) {
  const { tr } = useLang();
  const hostRef = useRef<HTMLDivElement>(null);
  const miiRef = useRef(mii);
  const rebuildRef = useRef<() => void>(() => {});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    host.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(...createMiiLights());
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.set(0, 1.5, 5.2);
    camera.lookAt(0, 1.02, 0);
    let model: MiiModel | null = null;
    let yaw = 0;
    const render = () => renderer.render(scene, camera);
    const rebuild = () => {
      if (model) {
        scene.remove(model.root);
        disposeObjectTree(model.root);
      }
      model = createMiiModel(miiRef.current, 256);
      model.root.rotation.y = yaw;
      scene.add(model.root);
      render();
    };
    rebuildRef.current = rebuild;
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = host;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const drag = (event: PointerEvent) => {
      if (!event.buttons || !model) return;
      yaw += event.movementX * 0.012;
      model.root.rotation.y = yaw;
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    host.addEventListener('pointermove', drag);
    renderer.domElement.addEventListener('webglcontextrestored', render);
    rebuild();
    resize();
    return () => {
      rebuildRef.current = () => {};
      observer.disconnect();
      host.removeEventListener('pointermove', drag);
      renderer.domElement.removeEventListener('webglcontextrestored', render);
      disposeObjectTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    miiRef.current = mii;
    rebuildRef.current();
  }, [mii]);

  return (
    <div
      ref={hostRef}
      className="mii-preview"
      role="img"
      aria-label={tr(`Prévia 3D do Mii ${mii.name}`, `3D preview of Mii ${mii.name}`)}
    >
      {failed && <p>{tr('Prévia 3D indisponível sem WebGL.', '3D preview needs WebGL.')}</p>}
    </div>
  );
}
