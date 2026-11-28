import * as THREE from 'three';
import {
  EYE_PALETTE,
  GLASSES_PALETTE,
  HAIR_PALETTE,
  LIP_PALETTE,
  SKIN_PALETTE,
  cssColor,
  normalizeMiiFaceSpec,
  type MiiFaceSpec,
} from './miiSpec';

const FACE_TOP = 100;
const DEG = Math.PI / 180;
let scratch: HTMLCanvasElement | undefined;

function rgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponível');
  return context;
}

function scratchCanvas(size: number): HTMLCanvasElement {
  scratch ??= document.createElement('canvas');
  if (scratch.width !== size) scratch.width = size;
  if (scratch.height !== size) scratch.height = size;
  return scratch;
}

const fy = (y: number) => FACE_TOP - y;

function ellipsePath(context: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  context.beginPath();
  context.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
}

function drawCheeks(context: CanvasRenderingContext2D, spec: MiiFaceSpec): void {
  context.fillStyle = rgba(0xd86f72, 0.16);
  const cheekY = fy(spec.eyeY - 9);
  for (const side of [-1, 1]) {
    ellipsePath(context, 50 + side * (spec.eyeSpacing + 8), cheekY, 5.5, 3.2);
    context.fill();
  }
}

function drawBeard(context: CanvasRenderingContext2D, spec: MiiFaceSpec): void {
  if (spec.beard === 0) return;
  const hair = cssColor(HAIR_PALETTE[spec.hairColor]);
  const mouthY = fy(spec.mouthY);
  context.fillStyle = hair;
  context.strokeStyle = hair;
  if (spec.beard === 1) {
    context.fillStyle = rgba(HAIR_PALETTE[spec.hairColor], 0.32);
    for (let index = 0; index < 34; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const spread = 5 + (index % 7) * 2.1;
      const x = 50 + side * spread * (0.55 + ((index * 13) % 10) / 18);
      const y = mouthY + 4 + ((index * 17) % 15);
      ellipsePath(context, x, y, 0.42, 0.42);
      context.fill();
    }
    return;
  }
  if (spec.beard === 2) {
    ellipsePath(context, 50, mouthY + 9, spec.mouthWidth * 0.28, 7);
    context.fill();
    return;
  }
  if (spec.beard === 3) {
    context.lineWidth = 3;
    context.lineCap = 'round';
    for (const side of [-1, 1]) {
      context.beginPath();
      context.moveTo(50, mouthY - 2.5);
      context.quadraticCurveTo(
        50 + side * spec.mouthWidth * 0.22,
        mouthY - 6,
        50 + side * spec.mouthWidth * 0.48,
        mouthY - 2,
      );
      context.stroke();
    }
    return;
  }
  if (spec.beard === 4) {
    context.fillStyle = rgba(HAIR_PALETTE[spec.hairColor], 0.88);
    context.beginPath();
    context.moveTo(50 - spec.mouthWidth * 0.62, mouthY - 2);
    context.bezierCurveTo(36, mouthY + 8, 39, mouthY + 22, 50, mouthY + 24);
    context.bezierCurveTo(61, mouthY + 22, 64, mouthY + 8, 50 + spec.mouthWidth * 0.62, mouthY - 2);
    context.quadraticCurveTo(50, mouthY + 7, 50 - spec.mouthWidth * 0.62, mouthY - 2);
    context.fill();
    return;
  }
  context.lineWidth = 2.4;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(50 - spec.mouthWidth * 0.68, mouthY - 2);
  context.bezierCurveTo(37, mouthY + 5, 39, mouthY + 18, 50, mouthY + 20);
  context.bezierCurveTo(61, mouthY + 18, 63, mouthY + 5, 50 + spec.mouthWidth * 0.68, mouthY - 2);
  context.stroke();
}

function eyeShape(context: CanvasRenderingContext2D, style: number, rx: number, ry: number): void {
  context.beginPath();
  if (style === 2 || style === 11) {
    context.moveTo(-rx, 0);
    context.quadraticCurveTo(0, -ry * 1.35, rx, 0);
    context.quadraticCurveTo(0, ry * 1.1, -rx, 0);
    return;
  }
  if (style === 6) {
    context.moveTo(-rx, ry * 0.1);
    context.lineTo(-rx * 0.35, -ry);
    context.lineTo(rx, -ry * 0.35);
    context.lineTo(rx * 0.55, ry * 0.75);
    context.lineTo(-rx * 0.7, ry * 0.7);
    context.closePath();
    return;
  }
  context.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
}

function drawIris(context: CanvasRenderingContext2D, spec: MiiFaceSpec, rx: number, ry: number): void {
  const radius = Math.min(rx, ry) * 0.72;
  ellipsePath(context, 0, 0, radius * 0.72, radius);
  context.fillStyle = cssColor(EYE_PALETTE[spec.eyeColor]);
  context.fill();
  ellipsePath(context, 0, 0, radius * 0.34, radius * 0.48);
  context.fillStyle = '#111';
  context.fill();
  ellipsePath(context, -radius * 0.18, -radius * 0.28, radius * 0.16, radius * 0.2);
  context.fillStyle = '#ffffffe8';
  context.fill();
}

function drawOpenEye(context: CanvasRenderingContext2D, spec: MiiFaceSpec, side: number): void {
  const style = spec.eyes;
  const wide = style === 8 ? 1.14 : style === 9 ? 0.88 : 1;
  const tall = style === 1 || style === 8 ? 1.22 : style === 10 || style === 11 ? 0.55 : style === 4 ? 0.72 : 1;
  const rx = spec.eyeScale * 0.74 * wide;
  const ry = spec.eyeScale * 0.48 * tall;
  eyeShape(context, style, rx, ry);
  context.fillStyle = '#fff';
  context.fill();
  context.save();
  eyeShape(context, style, rx, ry);
  context.clip();
  drawIris(context, spec, rx, ry);
  if (style === 4) {
    context.fillStyle = cssColor(SKIN_PALETTE[spec.skin]);
    context.fillRect(-rx - 1, -ry - 1, rx * 2 + 2, ry * 0.9);
  }
  context.restore();
  eyeShape(context, style, rx, ry);
  context.strokeStyle = '#20242a';
  context.lineWidth = 0.85;
  context.stroke();
  if (style === 7) {
    context.lineWidth = 0.8;
    context.lineCap = 'round';
    for (const lash of [-0.55, 0, 0.55]) {
      context.beginPath();
      context.moveTo(lash * rx, -ry * 0.78);
      context.lineTo(lash * rx + side * 1.4, -ry * 1.34);
      context.stroke();
    }
  }
}

function drawEye(context: CanvasRenderingContext2D, spec: MiiFaceSpec, side: number): void {
  const cx = 50 + side * spec.eyeSpacing;
  const cy = fy(spec.eyeY);
  context.save();
  context.translate(cx, cy);
  context.rotate(side * spec.eyeTilt * DEG);
  if (spec.eyes === 3) {
    context.strokeStyle = '#20242a';
    context.lineWidth = 1.7;
    context.lineCap = 'round';
    context.beginPath();
    context.arc(0, -0.5, spec.eyeScale * 0.58, 0.15 * Math.PI, 0.85 * Math.PI);
    context.stroke();
  } else if (spec.eyes === 5) {
    ellipsePath(context, 0, 0, spec.eyeScale * 0.28, spec.eyeScale * 0.34);
    context.fillStyle = cssColor(EYE_PALETTE[spec.eyeColor]);
    context.fill();
  } else {
    drawOpenEye(context, spec, side);
  }
  context.restore();
}

function drawBrow(context: CanvasRenderingContext2D, spec: MiiFaceSpec, side: number): void {
  if (spec.brows === 0) return;
  const length = spec.eyeScale + 7;
  const cx = 50 + side * spec.eyeSpacing;
  const cy = fy(spec.browY);
  const color = cssColor(HAIR_PALETTE[spec.hairColor]);
  context.save();
  context.translate(cx, cy);
  context.rotate(-side * spec.browTilt * DEG);
  context.strokeStyle = color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const style = spec.brows;
  const thickness = style === 4 ? 3.4 : style === 5 ? 1.2 : 2.2;
  context.lineWidth = thickness;
  context.beginPath();
  if (style === 1) {
    context.moveTo(-length / 2, 0);
    context.lineTo(length / 2, 0);
  } else if (style === 2) {
    context.moveTo(-length / 2, 1.2);
    context.lineTo(length / 2, -1.2);
  } else if (style === 3) {
    context.moveTo(-length / 2, 0.8);
    context.quadraticCurveTo(0, -2.4, length / 2, 0.8);
  } else if (style === 4 || style === 5) {
    context.moveTo(-length / 2, 0.4);
    context.quadraticCurveTo(0, -1.2, length / 2, 0.4);
  } else if (style === 6) {
    context.moveTo(-length / 2, -1);
    context.quadraticCurveTo(0, 2.2, length / 2, -1);
  } else {
    context.moveTo(-length * 0.32, 0);
    context.lineTo(length * 0.32, 0);
  }
  context.stroke();
  if (style === 4) {
    context.lineWidth = 1.1;
    for (const offset of [-2.2, 0, 2.2]) {
      context.beginPath();
      context.moveTo(offset - 1.5, -1.2);
      context.lineTo(offset + 1.5, 1.1);
      context.stroke();
    }
  }
  context.restore();
}

function drawMouth(context: CanvasRenderingContext2D, spec: MiiFaceSpec): void {
  const lip = cssColor(LIP_PALETTE[spec.lipColor]);
  const width = spec.mouthWidth;
  const cx = 50;
  const cy = fy(spec.mouthY);
  const curve = spec.mouthCurve;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = lip;
  context.fillStyle = lip;
  context.lineWidth = 1.9;

  if (spec.mouth === 2 || spec.mouth === 8) {
    context.beginPath();
    context.moveTo(cx - width / 2, cy - curve * 0.16);
    context.quadraticCurveTo(cx, cy + curve + 5, cx + width / 2, cy - curve * 0.16);
    context.quadraticCurveTo(cx, cy + curve * 0.35 + 2, cx - width / 2, cy - curve * 0.16);
    context.fillStyle = '#682b31';
    context.fill();
    context.save();
    context.clip();
    context.fillStyle = '#fff';
    context.fillRect(cx - width * 0.38, cy - 1.4, width * 0.76, 3.2);
    context.fillStyle = '#d84c5c';
    ellipsePath(context, cx, cy + curve * 0.35 + 3.2, width * 0.22, 2.8);
    context.fill();
    context.restore();
    context.strokeStyle = lip;
    context.stroke();
    return;
  }
  if (spec.mouth === 4) {
    context.beginPath();
    context.moveTo(cx - width * 0.48, cy);
    context.bezierCurveTo(cx - width * 0.22, cy - 4, cx - width * 0.1, cy - 1, cx, cy - 1.5);
    context.bezierCurveTo(cx + width * 0.1, cy - 1, cx + width * 0.22, cy - 4, cx + width * 0.48, cy);
    context.bezierCurveTo(cx + width * 0.2, cy + 4.5, cx - width * 0.2, cy + 4.5, cx - width * 0.48, cy);
    context.fill();
    return;
  }
  if (spec.mouth === 5) {
    context.fillStyle = '#fff';
    context.beginPath();
    context.roundRect(cx - width / 2, cy - 2.2, width, 4.8, 2);
    context.fill();
    context.strokeStyle = lip;
    context.stroke();
    context.beginPath();
    context.moveTo(cx - width / 2, cy);
    context.lineTo(cx + width / 2, cy);
    context.stroke();
    return;
  }
  if (spec.mouth === 7) {
    ellipsePath(context, cx, cy, width * 0.2, width * 0.24);
    context.fillStyle = '#682b31';
    context.fill();
    context.strokeStyle = lip;
    context.stroke();
    return;
  }
  context.beginPath();
  if (spec.mouth === 1 || spec.mouth === 11) {
    context.moveTo(cx - width / 2, cy);
    context.lineTo(cx + width / 2, cy);
  } else if (spec.mouth === 3) {
    context.moveTo(cx - width / 2, cy + 1.5);
    context.quadraticCurveTo(cx, cy - Math.max(2, curve + 4), cx + width / 2, cy + 1.5);
  } else if (spec.mouth === 6) {
    context.moveTo(cx - width / 2, cy);
    context.bezierCurveTo(cx - width * 0.25, cy - 3, cx - width * 0.1, cy + 3, cx, cy);
    context.bezierCurveTo(cx + width * 0.1, cy - 3, cx + width * 0.25, cy + 3, cx + width / 2, cy);
  } else if (spec.mouth === 9) {
    context.moveTo(cx - width / 2, cy + 1.5);
    context.quadraticCurveTo(cx + width * 0.05, cy + curve, cx + width / 2, cy - 2.2);
  } else if (spec.mouth === 10) {
    for (const side of [-1, 1]) {
      context.moveTo(cx, cy);
      context.quadraticCurveTo(cx + side * width * 0.24, cy + curve + 2, cx + side * width * 0.48, cy - 0.5);
    }
  } else {
    context.moveTo(cx - width / 2, cy - curve * 0.15);
    context.quadraticCurveTo(cx, cy + curve, cx + width / 2, cy - curve * 0.15);
  }
  context.stroke();
}

function drawGlasses(context: CanvasRenderingContext2D, spec: MiiFaceSpec): void {
  if (spec.glasses === 0) return;
  const color = cssColor(GLASSES_PALETTE[spec.glassesColor]);
  const eyeY = fy(spec.eyeY);
  const rx = spec.eyeScale * (spec.glasses === 3 ? 1.04 : 0.96) + 2.4;
  const ry = spec.eyeScale * (spec.glasses === 3 ? 0.58 : 0.78) + 2.2;
  context.strokeStyle = color;
  context.lineWidth = spec.glasses === 5 ? 2.3 : 1.45;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const side of [-1, 1]) {
    const cx = 50 + side * spec.eyeSpacing;
    context.beginPath();
    if (spec.glasses === 1 || spec.glasses === 5) context.ellipse(cx, eyeY, rx, ry, 0, 0, Math.PI * 2);
    else if (spec.glasses === 2) context.roundRect(cx - rx, eyeY - ry, rx * 2, ry * 2, 2.5);
    else if (spec.glasses === 3) {
      context.moveTo(cx - rx, eyeY - ry * 0.5);
      context.lineTo(cx + rx, eyeY - ry * 0.7);
      context.lineTo(cx + rx * 0.82, eyeY + ry * 0.6);
      context.lineTo(cx - rx * 0.82, eyeY + ry * 0.7);
      context.closePath();
    } else if (spec.glasses === 4) context.roundRect(cx - rx, eyeY - ry * 0.62, rx * 2, ry * 1.24, 4);
    else context.ellipse(cx, eyeY, rx * 0.92, ry * 0.72, 0, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(cx + side * rx, eyeY - 0.5);
    context.lineTo(50 + side * 36, eyeY - 2.5);
    context.stroke();
  }
  context.beginPath();
  context.moveTo(50 - spec.eyeSpacing + rx * 0.85, eyeY - 1);
  context.quadraticCurveTo(50, eyeY - 3.2, 50 + spec.eyeSpacing - rx * 0.85, eyeY - 1);
  context.stroke();
}

function drawFace(context: CanvasRenderingContext2D, sourceSpec: MiiFaceSpec): void {
  const spec = normalizeMiiFaceSpec(sourceSpec);
  context.clearRect(0, 0, FACE_TOP, FACE_TOP);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  drawBeard(context, spec);
  drawCheeks(context, spec);
  for (const side of [-1, 1]) drawEye(context, spec, side);
  for (const side of [-1, 1]) drawBrow(context, spec, side);
  drawMouth(context, spec);
  drawGlasses(context, spec);
}

/**
 * Renders into the module scratch canvas, then copies the result to the texture-owned canvas.
 * The scratch is reused by every build; only the small final canvas is retained by a texture.
 */
export function renderMiiFace(spec: MiiFaceSpec, size = 128, target?: HTMLCanvasElement): HTMLCanvasElement {
  const source = scratchCanvas(size);
  const sourceContext = context2d(source);
  sourceContext.save();
  sourceContext.scale(size / FACE_TOP, size / FACE_TOP);
  drawFace(sourceContext, spec);
  sourceContext.restore();

  const canvas = target ?? document.createElement('canvas');
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const context = context2d(canvas);
  context.clearRect(0, 0, size, size);
  context.drawImage(source, 0, 0);
  return canvas;
}

export function createMiiFaceTexture(spec: MiiFaceSpec, size = 128): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(renderMiiFace(spec, size));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
