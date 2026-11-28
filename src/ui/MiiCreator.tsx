import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { FACE_STYLE_NAMES } from '../miis/faceLabels';
import { createMiiFaceTexture } from '../mii/faceRenderer';
import {
  createMiiFacePatch,
  createMiiHairGeometry,
  createMiiHeadGeometry,
  createMiiNoseGeometry,
  type MiiFaceMount,
} from '../mii/miiHead';
import {
  EYE_PALETTE,
  GLASSES_PALETTE,
  HAIR_PALETTE,
  LIP_PALETTE,
  SKIN_PALETTE,
  cssColor,
  generateMiiFromSeed,
  loadPlayerMii,
  normalizeMiiFaceSpec,
  savePlayerMii,
  type MiiFaceSpec,
} from '../mii/miiSpec';
import { disposeObjectTree } from '../games/core/GameLoop';
import { createMiiStage } from '../miis/miiStage';

type Tab = 'face' | 'hair' | 'eyes' | 'brows' | 'nose' | 'mouth' | 'glasses';

const TABS: { id: Tab; label: string }[] = [
  { id: 'face', label: 'Rosto' },
  { id: 'hair', label: 'Cabelo' },
  { id: 'eyes', label: 'Olhos' },
  { id: 'brows', label: 'Sobrancelhas' },
  { id: 'nose', label: 'Nariz' },
  { id: 'mouth', label: 'Boca' },
  { id: 'glasses', label: 'Óculos' },
];
interface PreviewModel {
  group: THREE.Group;
  mount: MiiFaceMount;
  texture: THREE.CanvasTexture;
}

function buildPreviewModel(spec: MiiFaceSpec): PreviewModel {
  const group = new THREE.Group();
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: SKIN_PALETTE[spec.skin],
    roughness: 0.66,
    metalness: 0,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    color: HAIR_PALETTE[spec.hairColor],
    roughness: 0.74,
    metalness: 0,
  });
  group.add(new THREE.Mesh(createMiiHeadGeometry(spec), skinMaterial));
  const hair = createMiiHairGeometry(spec);
  if (hair) group.add(new THREE.Mesh(hair, hairMaterial));
  group.add(new THREE.Mesh(createMiiNoseGeometry(spec), skinMaterial));
  const mount = createMiiFacePatch(spec);
  mount.object.position.y = 0;
  const texture = createMiiFaceTexture(spec, 256);
  mount.setTexture(texture);
  group.add(mount.object);
  return { group, mount, texture };
}

function disposePreviewModel(model: PreviewModel): void {
  model.mount.setTexture(undefined);
  model.texture.dispose();
  disposeObjectTree(model.group);
}

function MiiPreview({ spec }: { spec: MiiFaceSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [webglError, setWebglError] = useState(false);
  const specRef = useRef<(next: MiiFaceSpec) => void>(() => {});
  const latestRef = useRef(spec);
  latestRef.current = spec;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The editor shows a head built at the origin and facing -Z, with its own softer lights.
    const stage = createMiiStage(host, { drag: true, animate: false, lights: false, maxPixelRatio: 2, camera: { position: [0, 0.03, -1.55], lookAt: [0, 0, 0], fov: 34, near: 0.05, far: 10 } });
    if (!stage) {
      setWebglError(true);
      return;
    }
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-1.5, 2, -2.5);
    stage.scene.add(new THREE.HemisphereLight(0xffffff, 0x91a7bb, 2.3), key);
    stage.content.rotation.y = 0.08;
    let model: PreviewModel | undefined;
    const show = (next: MiiFaceSpec) => {
      if (model) {
        stage.content.remove(model.group);
        disposePreviewModel(model);
      }
      model = buildPreviewModel(next);
      stage.content.add(model.group);
      stage.render();
    };
    show(latestRef.current);
    specRef.current = show;
    return () => {
      specRef.current = () => {};
      if (model) {
        stage.content.remove(model.group);
        disposePreviewModel(model);
      }
      stage.dispose();
    };
  }, []);

  // A new draft rebuilds only the head; the stage, lights and renderer stay.
  useEffect(() => {
    specRef.current(spec);
  }, [spec]);

  return (
    <>
      <div ref={hostRef} className="mii-preview" role="img" aria-label="Prévia 3D do Mii" hidden={webglError} />
      {webglError && (
        <p role="alert" style={{ maxWidth: 320, padding: '0 16px', textAlign: 'center' }}>
          Prévia 3D indisponível: o navegador não conseguiu iniciar o WebGL. Você ainda pode editar e salvar o Mii
          normalmente.
        </p>
      )}
    </>
  );
}

function Swatches({
  label,
  palette,
  value,
  onPick,
}: {
  label: string;
  palette: readonly number[];
  value: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="mii-control">
      <span>{label}</span>
      <div className="mii-swatches">
        {palette.map((color, index) => (
          <button
            key={color}
            type="button"
            aria-label={`${label} ${index + 1}`}
            aria-pressed={index === value}
            style={{ background: cssColor(color) }}
            onClick={() => onPick(index)}
          />
        ))}
      </div>
    </div>
  );
}

function Styles({
  label,
  names,
  value,
  onPick,
}: {
  label: string;
  names: readonly string[];
  value: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="mii-control">
      <span>{label}</span>
      <div className="mii-styles">
        {names.map((name, index) => (
          <button key={name} type="button" aria-pressed={index === value} onClick={() => onPick(index)}>
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mii-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <b aria-hidden="true">{value}</b>
    </label>
  );
}

export function MiiCreator({ onClose }: { onClose: () => void }) {
  const [spec, setSpec] = useState(loadPlayerMii);
  const [tab, setTab] = useState<Tab>('face');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'session'>('idle');
  const update = (patch: Partial<MiiFaceSpec>) => {
    setSaveStatus('idle');
    setSpec((current) => normalizeMiiFaceSpec({ ...current, ...patch }));
  };

  return (
    <section className="menu mii-editor" aria-label="Editor de Mii">
      <header className="menu-header">
        <h1>Editor de Mii</h1>
        <button type="button" className="logo-btn" onClick={onClose} aria-label="Voltar ao menu de jogos">
          <span className="logo">
            <img className="brand-logo" src="/images/nevergear-logo.png" alt="Nevergear" width={1200} height={234} /> <i>Sports</i>
          </span>
        </button>
      </header>
      <div className="mii-workbench">
        <div className="mii-stage">
          <MiiPreview spec={spec} />
          <p>Arraste para girar</p>
        </div>
        <div className="mii-panel">
          <div className="mii-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="mii-options">
            {tab === 'face' && (
              <>
                <Swatches label="Pele" palette={SKIN_PALETTE} value={spec.skin} onPick={(skin) => update({ skin })} />
                <Styles label="Rosto" names={FACE_STYLE_NAMES.head} value={spec.head} onPick={(head) => update({ head })} />
                <Styles label="Barba" names={FACE_STYLE_NAMES.beard} value={spec.beard} onPick={(beard) => update({ beard })} />
              </>
            )}
            {tab === 'hair' && (
              <>
                <Swatches
                  label="Cor do cabelo"
                  palette={HAIR_PALETTE}
                  value={spec.hairColor}
                  onPick={(hairColor) => update({ hairColor })}
                />
                <Styles label="Cabelo" names={FACE_STYLE_NAMES.hair} value={spec.hair} onPick={(hair) => update({ hair })} />
              </>
            )}
            {tab === 'eyes' && (
              <>
                <Swatches
                  label="Cor dos olhos"
                  palette={EYE_PALETTE}
                  value={spec.eyeColor}
                  onPick={(eyeColor) => update({ eyeColor })}
                />
                <Styles label="Olhos" names={FACE_STYLE_NAMES.eyes} value={spec.eyes} onPick={(eyes) => update({ eyes })} />
                <Slider label="Altura" min={42} max={62} value={spec.eyeY} onChange={(eyeY) => update({ eyeY })} />
                <Slider
                  label="Espaçamento"
                  min={12}
                  max={26}
                  value={spec.eyeSpacing}
                  onChange={(eyeSpacing) => update({ eyeSpacing })}
                />
                <Slider
                  label="Tamanho"
                  min={7}
                  max={14}
                  value={spec.eyeScale}
                  onChange={(eyeScale) => update({ eyeScale })}
                />
                <Slider
                  label="Inclinação"
                  min={-14}
                  max={14}
                  value={spec.eyeTilt}
                  onChange={(eyeTilt) => update({ eyeTilt })}
                />
              </>
            )}
            {tab === 'brows' && (
              <>
                <Styles label="Sobrancelhas" names={FACE_STYLE_NAMES.brows} value={spec.brows} onPick={(brows) => update({ brows })} />
                <Slider label="Altura" min={54} max={78} value={spec.browY} onChange={(browY) => update({ browY })} />
                <Slider
                  label="Inclinação"
                  min={-16}
                  max={16}
                  value={spec.browTilt}
                  onChange={(browTilt) => update({ browTilt })}
                />
              </>
            )}
            {tab === 'nose' && (
              <>
                <Styles label="Nariz" names={FACE_STYLE_NAMES.nose} value={spec.nose} onPick={(nose) => update({ nose })} />
                <Slider label="Altura" min={30} max={50} value={spec.noseY} onChange={(noseY) => update({ noseY })} />
              </>
            )}
            {tab === 'mouth' && (
              <>
                <Swatches
                  label="Lábios"
                  palette={LIP_PALETTE}
                  value={spec.lipColor}
                  onPick={(lipColor) => update({ lipColor })}
                />
                <Styles label="Boca" names={FACE_STYLE_NAMES.mouth} value={spec.mouth} onPick={(mouth) => update({ mouth })} />
                <Slider
                  label="Altura"
                  min={18}
                  max={34}
                  value={spec.mouthY}
                  onChange={(mouthY) => update({ mouthY })}
                />
                <Slider
                  label="Largura"
                  min={16}
                  max={36}
                  value={spec.mouthWidth}
                  onChange={(mouthWidth) => update({ mouthWidth })}
                />
                <Slider
                  label="Curva"
                  min={-10}
                  max={10}
                  value={spec.mouthCurve}
                  onChange={(mouthCurve) => update({ mouthCurve })}
                />
              </>
            )}
            {tab === 'glasses' && (
              <>
                <Swatches
                  label="Cor dos óculos"
                  palette={GLASSES_PALETTE}
                  value={spec.glassesColor}
                  onPick={(glassesColor) => update({ glassesColor })}
                />
                <Styles
                  label="Óculos"
                  names={FACE_STYLE_NAMES.glasses}
                  value={spec.glasses}
                  onPick={(glasses) => update({ glasses })}
                />
              </>
            )}
          </div>
          <div className="mii-actions">
            <button
              type="button"
              className="nevergear-btn"
              onClick={() => {
                setSaveStatus('idle');
                setSpec(generateMiiFromSeed(`${Date.now()}-${Math.random()}`));
              }}
            >
              Aleatório
            </button>
            <button
              type="button"
              className="nevergear-btn mii-save"
              onClick={() => {
                setSaveStatus(savePlayerMii(spec) ? 'saved' : 'session');
              }}
            >
              Salvar
            </button>
            <button type="button" className="nevergear-btn" onClick={onClose}>
              Voltar
            </button>
            {saveStatus === 'saved' && <strong role="status">Salvo!</strong>}
            {saveStatus === 'session' && (
              <strong role="status" style={{ color: '#8a5a00' }}>
                Salvo apenas nesta sessão: o armazenamento persistente não está disponível.
              </strong>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
