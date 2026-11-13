// Generates a synthetic HDR gain map from an SDR image ("inverse tone mapping").
// Bright regions get boosted by up to `maxStops`; shadows and midtones stay as-is.

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** "Spread into mids" 0..1 -> curve exponent. 0 = highlights only (steep), 1 = even (gentle). */
export function curveExponent(spread) {
  return 3 - 2.4 * spread;
}

/**
 * Boost curve: fraction (0..1) of the max boost applied at perceived brightness L (0..1, sRGB-encoded).
 * Starts at `start` with zero slope (for p > 1, so no visible kink) and rises smoothly to 1 at white.
 */
export function boostWeight(L, start, p) {
  const t = (L - start) / (1 - start);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(t, p);
}

/** Maps a display-oriented pixel grid back to the JPEG's stored orientation. */
function storedToDisplay(o, x, y, W, H) {
  // W,H are stored dimensions
  switch (o) {
    case 2: return [W - 1 - x, y];
    case 3: return [W - 1 - x, H - 1 - y];
    case 4: return [x, H - 1 - y];
    case 5: return [y, x];
    case 6: return [H - 1 - y, x];
    case 7: return [H - 1 - y, W - 1 - x];
    case 8: return [y, W - 1 - x];
    default: return [x, y];
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export async function canvasToJpeg(canvas, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * @param {CanvasImageSource} image  decoded image, display orientation, size dw x dh
 * @param {number} orientation       EXIF orientation of the source JPEG
 * @param {{maxStops:number, start:number, spread:number, scale?:number}} opts
 *        start: perceived (sRGB 0..1) brightness where boosting begins
 *        spread: 0..1, how far the boost reaches down into the midtones
 *        saturation: 0..1, extra chroma in the HDR rendition at full boost (0 = colour-neutral gain map)
 * @returns {Promise<{jpeg: Uint8Array, meta: object}>}
 */
export async function makeGainMap(image, dw, dh, orientation, opts) {
  const scale = opts.scale || 4;
  const gw = Math.max(1, Math.round(dw / scale));
  const gh = Math.max(1, Math.round(dh / scale));

  const src = makeCanvas(gw, gh);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(image, 0, 0, gw, gh);
  const px = sctx.getImageData(0, 0, gw, gh).data;

  // Boost weight per pixel (0..1 of maxStops), via a LUT over linear brightness.
  const N = 4096;
  const lut = new Float32Array(N + 1);
  const p = curveExponent(opts.spread);
  for (let k = 0; k <= N; k++) {
    lut[k] = boostWeight(linearToSrgb(k / N), opts.start, p);
  }

  // Gain range encoded in the map (stops). Without saturation this is exactly 0..maxStops.
  // With saturation, the dominant channel can get up to log2(1+sat) extra and weak channels less.
  const sat = opts.saturation || 0;
  const gMin = sat > 0 ? -2 : 0;
  const gMax = opts.maxStops + (sat > 0 ? Math.log2(1 + sat) : 0);
  const span = gMax - gMin;
  const enc = (stops) => {
    const v = (stops - gMin) / span;
    return Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
  };

  // Per-pixel gains, 3 channels (identical when sat = 0).
  const gains = new Uint8Array(gw * gh * 3);
  const lin = [0, 0, 0];
  for (let i = 0, q = 0; i < gw * gh; i++, q += 4) {
    const r = SRGB_TO_LINEAR[px[q]], g = SRGB_TO_LINEAR[px[q + 1]], b = SRGB_TO_LINEAR[px[q + 2]];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const m = Math.max(r, g, b);
    const v = 0.6 * y + 0.4 * m; // lets bright saturated areas (skies, neon) glow too
    const w = lut[Math.round(v * N)];
    const base = opts.maxStops * w;
    if (sat === 0 || w === 0) {
      gains[i * 3] = gains[i * 3 + 1] = gains[i * 3 + 2] = enc(base);
      continue;
    }
    // HDR target: brighten by 2^base and scale chroma around luminance by s.
    // Saturation grows with the boost, so shadows (no boost) are never touched.
    const s = 1 + sat * w;
    lin[0] = r; lin[1] = g; lin[2] = b;
    for (let c = 0; c < 3; c++) {
      const val = lin[c];
      let stops = base;
      if (val > 1e-4) {
        const target = Math.max(y + s * (val - y), 1e-4);
        stops = base + Math.log2(target / val);
      }
      gains[i * 3 + c] = enc(stops);
    }
  }

  // Write the map in the JPEG's stored orientation so viewers rotate it with the image.
  const swap = orientation >= 5;
  const W = swap ? gh : gw, H = swap ? gw : gh;
  const out = makeCanvas(W, H);
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H);
  const d = img.data;
  for (let y = 0, o = 0; y < H; y++) {
    for (let x = 0; x < W; x++, o += 4) {
      const [dx, dy] = storedToDisplay(orientation, x, y, W, H);
      const k = (dy * gw + dx) * 3;
      d[o] = gains[k]; d[o + 1] = gains[k + 1]; d[o + 2] = gains[k + 2];
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const jpeg = await canvasToJpeg(out, sat > 0 ? 0.95 : 0.9);

  const meta = {
    gainMapMin: gMin,
    gainMapMax: gMax,
    gamma: 1,
    offsetSdr: 0, // no offsets: pure per-pixel multiply keeps colours exactly as saturated
    offsetHdr: 0,
    hdrCapacityMin: 0,
    hdrCapacityMax: opts.maxStops,
  };
  return { jpeg, meta };
}
