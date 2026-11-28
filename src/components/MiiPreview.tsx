import { useEffect, useRef, useState } from 'react';
import { disposeObjectTree } from '../games/core/GameLoop';
import { createMiiModel, type MiiModel } from '../miis/miiMesh';
import { createMiiStage, type MiiStage } from '../miis/miiStage';
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
    // The preview only redraws when the drag or a new draft asks for it.
    const stage: MiiStage | undefined = createMiiStage(host, { drag: true, animate: false });
    if (!stage) {
      setFailed(true);
      return;
    }
    let model: MiiModel | null = null;
    const rebuild = () => {
      if (model) {
        stage.content.remove(model.root);
        disposeObjectTree(model.root);
      }
      model = createMiiModel(miiRef.current, 256);
      // The stage turns its content group; keep the model neutral inside it.
      stage.content.add(model.root);
      stage.render();
    };
    rebuildRef.current = rebuild;
    rebuild();
    return () => {
      rebuildRef.current = () => {};
      stage.dispose();
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
