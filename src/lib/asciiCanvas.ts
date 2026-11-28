import { rankGlyphs, type RankedGlyph } from './ascii';

/**
 * The canvas plumbing both ASCII portraits need: an image sampled on a small offscreen buffer,
 * a glyph atlas sized to the element, and the fit between a glyph grid and an image aspect ratio.
 * Nothing here decides colors or animation — those belong to each portrait.
 */
export const MONO_FONT = '"DM Mono", monospace';

export interface SampleSource {
  /** Width of the source image in pixels; drives the grid aspect. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface GlyphGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly glyphs: RankedGlyph[];
}

/** The glyph grid that fills `width` CSS pixels at the given font size, keeping the image aspect. */
export function fitGlyphGrid(
  output: CanvasRenderingContext2D,
  width: number,
  source: SampleSource,
  fontSize: number,
): GlyphGrid {
  output.font = `${fontSize}px ${MONO_FONT}`;
  const cellW = output.measureText('M').width;
  const cellH = fontSize * 1.12;
  const cols = Math.max(1, Math.floor(width / cellW));
  const aspect = source.naturalWidth && source.naturalHeight ? source.naturalWidth / source.naturalHeight : 1;
  const rows = Math.max(1, Math.round((cols * cellW) / (aspect * cellH)));
  return { cols, rows, cellW, cellH, glyphs: rankGlyphs(output.font, cellW, cellH) };
}

/**
 * Sizes the canvas for the grid, including the device pixel ratio transform, and returns the CSS
 * height it now occupies. Callers keep drawing in CSS pixels afterwards.
 */
export function sizeCanvasToGrid(
  canvas: HTMLCanvasElement,
  output: CanvasRenderingContext2D,
  width: number,
  grid: GlyphGrid,
) {
  const height = grid.rows * grid.cellH;
  canvas.style.height = `${height}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  output.setTransform(dpr, 0, 0, dpr, 0, 0);
  output.font = `${output.font.match(/(\d+(?:\.\d+)?)px/)?.[0] ?? '7px'} ${MONO_FONT}`;
  output.textBaseline = 'top';
  return height;
}

/** Samples one image onto a buffer of `cols x rows` cells of `sampleSize` pixels each. */
export function sampleImage(
  source: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  cols: number,
  rows: number,
  sampleSize: number,
): Uint8ClampedArray {
  source.width = cols * sampleSize;
  source.height = rows * sampleSize;
  context.clearRect(0, 0, source.width, source.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, source.width, source.height);
  return context.getImageData(0, 0, source.width, source.height).data;
}

/** Alpha-weighted color and coverage of one cell of a sampled buffer. */
export function sampleCell(
  pixels: Uint8ClampedArray,
  sourceWidth: number,
  col: number,
  row: number,
  sampleSize: number,
  target: [number, number, number],
): number {
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  for (let sy = 0; sy < sampleSize; sy += 1) {
    let offset = ((row * sampleSize + sy) * sourceWidth + col * sampleSize) * 4;
    for (let sx = 0; sx < sampleSize; sx += 1) {
      const weight = pixels[offset + 3] / 255;
      red += pixels[offset] * weight;
      green += pixels[offset + 1] * weight;
      blue += pixels[offset + 2] * weight;
      alpha += weight;
      offset += 4;
    }
  }
  const samples = sampleSize * sampleSize;
  target[0] = alpha ? red / alpha : 0;
  target[1] = alpha ? green / alpha : 0;
  target[2] = alpha ? blue / alpha : 0;
  return alpha / samples;
}
