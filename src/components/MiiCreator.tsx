import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { cssColor, EYE_PALETTE, GLASSES_PALETTE, HAIR_PALETTE, LIP_PALETTE, type MiiFaceSpec, normalizeMiiFaceSpec, SKIN_PALETTE } from '../mii/miiSpec';
import { FACE_SLIDERS, FACE_STYLES } from '../miis/faceLabels';
import { setPlayerMii, usePlayerMii } from '../miis/miiStore';
import { MII_NAME_MAX_LENGTH, SHIRT_COLORS } from '../miis/miiTypes';
import { faceFromProfile, randomSiteMii, type SiteMii } from '../miis/siteMii';
import { type Bilingual, useLang } from '../i18n';

const MiiPreview = lazy(() => import('./MiiPreview'));

const FACE_COLORS = [
  ['skin', SKIN_PALETTE, { pt: 'Pele', en: 'Skin' }],
  ['hairColor', HAIR_PALETTE, { pt: 'Cor do cabelo', en: 'Hair color' }],
  ['eyeColor', EYE_PALETTE, { pt: 'Cor dos olhos', en: 'Eye color' }],
  ['lipColor', LIP_PALETTE, { pt: 'Lábios', en: 'Lips' }],
  ['glassesColor', GLASSES_PALETTE, { pt: 'Cor dos óculos', en: 'Glasses color' }],
] as const;

const SIZES = [
  ['height', { pt: 'Altura', en: 'Height' }],
  ['build', { pt: 'Porte', en: 'Build' }],
] as const;

export default function MiiCreator() {
  const { tr } = useLang();
  const label = (text: Bilingual) => tr(text.pt, text.en);
  const player = usePlayerMii();
  const [draft, setDraft] = useState<SiteMii>(player);
  const [status, setStatus] = useState('');
  // Choosing a look from the plaza also updates the draft.
  useEffect(() => setDraft(player), [player]);
  const change = (patch: Partial<SiteMii>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus('');
  };
  const changeFace = (patch: Partial<MiiFaceSpec>) => {
    setDraft((current) => ({ ...current, face: normalizeMiiFaceSpec({ ...current.face, ...patch }) }));
    setStatus('');
  };

  // Load Three.js for the preview only when the creator approaches the viewport.
  const sectionRef = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '200px' },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  // Photo/webcam suggestion. `attempt` invalidates responses that arrive after cancellation or exit.
  const attempt = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => {
    attempt.current++;
  }, []);
  useEffect(() => {
    if (!stream) return;
    if (videoRef.current) videoRef.current.srcObject = stream;
    return () => {
      for (const track of stream.getTracks()) track.stop();
    };
  }, [stream]);

  const suggest = async (read: () => Promise<ImageBitmap | HTMLVideoElement>) => {
    const token = ++attempt.current;
    setBusy(true);
    setStatus(tr('Analisando o rosto neste aparelho…', 'Reading the face on this device…'));
    try {
      const [source, { suggestMiiFromImage }] = await Promise.all([read(), import('../miis/faceSuggestClient')]);
      const result = await suggestMiiFromImage(source);
      if (token !== attempt.current) return;
      const { shirtColor, height, build } = result.draft;
      change({ face: faceFromProfile(result.draft), shirtColor, height, build });
      setStream(null);
      setStatus(tr('Sugestão aplicada. Ajuste o que quiser e salve.', 'Suggestion applied. Adjust anything, then save.'));
    } catch (error) {
      if (token !== attempt.current) return;
      console.warn('Mii photo suggestion failed', error);
      setStatus(tr(
        'Não deu para ler um rosto. Tente outra foto ou monte o Mii à mão.',
        'Could not read a face. Try another photo or build the Mii by hand.',
      ));
    } finally {
      if (token === attempt.current) setBusy(false);
    }
  };

  const openCamera = async () => {
    const token = ++attempt.current;
    setBusy(true);
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      if (token !== attempt.current) {
        for (const track of next.getTracks()) track.stop();
        return;
      }
      setStream(next);
      setStatus('');
    } catch {
      if (token === attempt.current) setStatus(tr('Câmera indisponível.', 'Camera unavailable.'));
    } finally {
      if (token === attempt.current) setBusy(false);
    }
  };

  const closeCamera = () => {
    attempt.current++;
    setStream(null);
    setBusy(false);
    setStatus('');
  };

  return (
    <section ref={sectionRef} id="mii-creator" className="mii-creator" aria-label={tr('Criador de Mii', 'Mii creator')}>
      <div className="mii-stage">
        {near && (
          <Suspense fallback={<div className="mii-preview" />}>
            <MiiPreview mii={draft} />
          </Suspense>
        )}
        {stream && <video ref={videoRef} className="mii-camera" autoPlay muted playsInline />}
        <div className="mii-actions">
          {stream ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => suggest(async () => videoRef.current as HTMLVideoElement)}
              >
                {tr('Capturar', 'Capture')}
              </button>
              <button type="button" onClick={closeCamera}>{tr('Cancelar', 'Cancel')}</button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={openCamera}>{tr('Usar webcam', 'Use webcam')}</button>
              <label className="mii-file">
                {tr('Enviar foto', 'Upload photo')}
                <input
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) suggest(() => createImageBitmap(file));
                  }}
                />
              </label>
            </>
          )}
        </div>
      </div>

      <div className="mii-form">
        <h2>{tr('Crie seu Mii', 'Make your Mii')}</h2>
        <label className="mii-field">
          {tr('Nome', 'Name')}
          <input
            value={draft.name}
            maxLength={MII_NAME_MAX_LENGTH}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <div className="mii-grid">
          {FACE_STYLES.map(([key, title, options]) => (
            <label className="mii-field" key={key}>
              {label(title)}
              <select value={draft.face[key]} onChange={(event) => changeFace({ [key]: Number(event.target.value) })}>
                {options.map((option, index) => (
                  <option key={option.en} value={index}>{label(option)}</option>
                ))}
              </select>
            </label>
          ))}
          {SIZES.map(([key, title]) => (
            <label className="mii-field" key={key}>
              {label(title)}
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft[key]}
                onChange={(event) => change({ [key]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>
        <details className="mii-fine">
          <summary>{tr('Ajuste fino', 'Fine-tune')}</summary>
          <div className="mii-grid">
            {FACE_SLIDERS.map(([key, title, min, max]) => (
              <label className="mii-field" key={key}>
                {label(title)}
                <input
                  type="range"
                  min={min}
                  max={max}
                  value={draft.face[key]}
                  onChange={(event) => changeFace({ [key]: Number(event.target.value) })}
                />
              </label>
            ))}
          </div>
        </details>
        {FACE_COLORS.map(([key, palette, title]) => (
          <fieldset className="mii-swatches" key={key}>
            <legend>{label(title)}</legend>
            {palette.map((color, index) => (
              <button
                key={color}
                type="button"
                style={{ backgroundColor: cssColor(color) }}
                aria-label={`${label(title)} ${index + 1}`}
                aria-pressed={draft.face[key] === index}
                onClick={() => changeFace({ [key]: index })}
              />
            ))}
          </fieldset>
        ))}
        <fieldset className="mii-swatches">
          <legend>{tr('Roupa', 'Shirt')}</legend>
          {SHIRT_COLORS.map((color, index) => (
            <button
              key={color}
              type="button"
              style={{ backgroundColor: color }}
              aria-label={`${tr('Roupa', 'Shirt')} ${index + 1}`}
              aria-pressed={draft.shirtColor === color}
              onClick={() => change({ shirtColor: color })}
            />
          ))}
        </fieldset>
        <div className="mii-actions">
          <button type="button" onClick={() => change(randomSiteMii(draft))}>{tr('Sortear', 'Randomize')}</button>
          <button
            type="button"
            className="mii-save"
            onClick={() => {
              setPlayerMii(draft);
              setStatus(tr('Mii salvo neste navegador.', 'Mii saved in this browser.'));
            }}
          >
            {tr('Salvar', 'Save')}
          </button>
        </div>
        <p className="mii-status" role="status">{status}</p>
      </div>
    </section>
  );
}
