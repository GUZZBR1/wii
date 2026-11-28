import { useEffect, useMemo, useState } from 'react';
import type { CarouselStepResult } from './carouselController';
import type { HandInputStore } from './handInputStore';
import { useLang } from '../i18n';

interface Props {
  store: HandInputStore;
  carouselRef: { current: CarouselStepResult | undefined };
}

function vectorText(vector: { x: number; y: number; z: number } | undefined): string {
  if (!vector) return '—';
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}

function velocityText(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(0)}°/s`;
}

function millisecondsText(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(1)} ms`;
}

function fpsText(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(1)} fps`;
}

/** Live hand and carousel diagnostics, available with ?handDebug=1. */
export function HandDebugOverlay({ store, carouselRef }: Props) {
  const { tr } = useLang();
  const enabled = useMemo(() => new URLSearchParams(window.location.search).get('handDebug') === '1', []);
  const [, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [enabled]);
  if (!enabled) return null;

  const input = store.current;
  const carousel = carouselRef.current;
  const dtMs = input.rotationDtMs;
  const fps = dtMs && dtMs > 0 ? 1000 / dtMs : undefined;
  const carouselDtMs = carousel?.dtMs;
  const carouselFps = carouselDtMs && carouselDtMs > 0 ? 1000 / carouselDtMs : undefined;
  return <aside className="hand-debug" aria-label={tr('Diagnóstico do gesto rotacional', 'Rotational gesture diagnostics')}>
    <strong>hand debug</strong>
    <dl>
      <dt>{tr('fase', 'phase')}</dt><dd>{input.rotationPhase}</dd>
      <dt>{tr('pinça', 'pinch')}</dt><dd>{input.pinchState}{input.freezeReason ? ` · ${tr('congelado por', 'frozen by')} ${input.freezeReason}` : ''}</dd>
      <dt>swipe</dt><dd>{input.swipeMoving ? tr('movendo', 'moving') : tr('parado', 'still')} · {tr('direção', 'direction')} {input.swipeDirection}</dd>
      <dt>{tr('latência da mão', 'hand latency')}</dt><dd>{millisecondsText(input.handInferenceMs)}</dd>
      <dt>{tr('FPS do worker', 'worker FPS')}</dt><dd>{fpsText(input.workerFps)}</dd>
      <dt>{tr('forma', 'shape')}</dt><dd>{input.rotationHandShape ?? '—'} · {tr('curvatura', 'curvature')} {input.rotationCurvature?.toFixed(2) ?? '—'}</dd>
      <dt>{tr('normal da palma', 'palm normal')}</dt><dd>{vectorText(input.rotationOrientation?.zAxis)}</dd>
      <dt>{tr('eixo punho→médio', 'wrist-to-middle axis')}</dt><dd>{vectorText(input.rotationOrientation?.yAxis)}</dd>
      <dt>{tr('ω bruta', 'raw ω')}</dt><dd>{velocityText(input.rotationRawAngularVelocity)}</dd>
      <dt>{tr('ω filtrada', 'filtered ω')}</dt><dd>{velocityText(input.rotationFilteredAngularVelocity)}</dd>
      <dt>{tr('ω de controle', 'control ω')}</dt><dd>{velocityText(input.rotationAngularVelocity)}</dd>
      <dt>{tr('direção', 'direction')}</dt><dd>{input.rotationDirection}</dd>
      <dt>{tr('dt da mão', 'hand dt')}</dt><dd>{dtMs === undefined ? '—' : `${dtMs.toFixed(1)} ms`}{fps ? ` · ${fps.toFixed(1)} fps` : ''}</dd>
      <dt>{tr('motivo da rejeição', 'rejection reason')}</dt><dd>{input.rotationRejectReason ?? '—'}</dd>
      <dt>{tr('carrossel', 'carousel')}</dt><dd>{carousel ? `${carousel.mode} · ${velocityText(carousel.velocityDegPerSec)} · ${tr('canal', 'channel')} ${carousel.front}` : tr('fora da roda', 'off the wheel')}</dd>
      <dt>turn / {tr('dt da roda', 'wheel dt')}</dt><dd>{carousel ? `${carousel.turn.toFixed(3)} · ${carouselDtMs?.toFixed(1) ?? '—'} ms${carouselFps ? ` · ${carouselFps.toFixed(1)} fps` : ''}` : '—'}</dd>
    </dl>
  </aside>;
}
