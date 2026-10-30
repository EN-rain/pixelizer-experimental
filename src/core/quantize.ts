import { PixelBuffer, ColorRGBA, ColorLab } from './types';
import { rgbToOklab, oklabToRgb, oklabDistance } from './color';

export interface QuantizeOptions {
  targetColors: number;
  keepExtremes?: boolean;
  seed?: number;
  maxIterations?: number;
}

export interface QuantizeResult {
  quantized: PixelBuffer;
  buffer: PixelBuffer; // alias for quantized for backward compatibility
  originalColorCount: number;
  palette: ColorRGBA[];
}

interface WeightedColor {
  r: number;
  g: number;
  b: number;
  lab: ColorLab;
  weight: number;
  key: number;
}

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 */
function createRng(seed: number): () => number {
  let s = Math.floor(seed) >>> 0;
  return function next(): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sorts palette by perceptual luminance (OKLab L), and by hue angle for similar luminance.
 */
function sortPalette(palette: ColorRGBA[]): ColorRGBA[] {
  return [...palette].sort((c1, c2) => {
    const lab1 = rgbToOklab(c1);
    const lab2 = rgbToOklab(c2);
    const diffL = lab1.L - lab2.L;
    if (Math.abs(diffL) > 0.04) {
      return diffL;
    }
    const h1 = (Math.atan2(lab1.b, lab1.a) + 2 * Math.PI) % (2 * Math.PI);
    const h2 = (Math.atan2(lab2.b, lab2.a) + 2 * Math.PI) % (2 * Math.PI);
    return h1 - h2;
  });
}

/**
 * Quantize colors using weighted k-Means in OKLab space with k-means++ initialization.
 */
export function quantizeColors(
  buf: PixelBuffer,
  optionsOrTarget: number | QuantizeOptions = 16,
  keepExtremesParam = false,
  seedParam = 42
): QuantizeResult {
  let targetColors: number;
  let keepExtremes = keepExtremesParam;
  let seed = seedParam;
  let maxIterations = 25;

  if (typeof optionsOrTarget === 'number') {
    targetColors = optionsOrTarget;
  } else {
    targetColors = optionsOrTarget.targetColors ?? 16;
    if (optionsOrTarget.keepExtremes !== undefined) keepExtremes = optionsOrTarget.keepExtremes;
    if (optionsOrTarget.seed !== undefined) seed = optionsOrTarget.seed;
    if (optionsOrTarget.maxIterations !== undefined) maxIterations = optionsOrTarget.maxIterations;
  }

  // 1. Collect unique colors and their weights (pixel counts)
  const colorMap = new Map<number, WeightedColor>();
  const totalPixels = buf.w * buf.h;

  for (let i = 0; i < buf.data.length; i += 4) {
    const a = buf.data[i + 3];
    if (a < 128) continue; // Skip transparent pixels

    const r = buf.data[i];
    const g = buf.data[i + 1];
    const b = buf.data[i + 2];
    const key = (r << 16) | (g << 8) | b;

    let entry = colorMap.get(key);
    if (!entry) {
      entry = {
        r,
        g,
        b,
        lab: rgbToOklab({ r, g, b }),
        weight: 0,
        key
      };
      colorMap.set(key, entry);
    }
    entry.weight++;
  }

  const uniqueColors = Array.from(colorMap.values());
  const originalColorCount = uniqueColors.length;

  // Damp pixel-count weights (sqrt) so large flat areas (e.g. hair) don't swallow
  // small but important accent colors (eyes, mouth, buttons) during clustering.
  for (const c of uniqueColors) c.weight = Math.sqrt(c.weight);

  // Handle edge case: empty or fully transparent image
  if (originalColorCount === 0) {
    const emptyBuf: PixelBuffer = {
      w: buf.w,
      h: buf.h,
      data: new Uint8ClampedArray(buf.data)
    };
    return {
      quantized: emptyBuf,
      buffer: emptyBuf,
      originalColorCount: 0,
      palette: [{ r: 0, g: 0, b: 0, a: 0 }]
    };
  }

  // Handle case where targetColors >= original unique colors
  if (originalColorCount <= targetColors) {
    const palette = sortPalette(
      uniqueColors.map(c => ({ r: c.r, g: c.g, b: c.b, a: 255 }))
    );

    const outData = new Uint8ClampedArray(buf.data.length);
    for (let i = 0; i < buf.data.length; i += 4) {
      if (buf.data[i + 3] < 128) {
        outData[i] = 0;
        outData[i + 1] = 0;
        outData[i + 2] = 0;
        outData[i + 3] = 0;
      } else {
        outData[i] = buf.data[i];
        outData[i + 1] = buf.data[i + 1];
        outData[i + 2] = buf.data[i + 2];
        outData[i + 3] = 255;
      }
    }

    const resBuf: PixelBuffer = {
      w: buf.w,
      h: buf.h,
      data: outData
    };

    return {
      quantized: resBuf,
      buffer: resBuf,
      originalColorCount,
      palette
    };
  }

  // 2. Identify extremes (darkest and brightest colors in OKLab L)
  let darkest = uniqueColors[0];
  let brightest = uniqueColors[0];
  for (const c of uniqueColors) {
    if (c.lab.L < darkest.lab.L) darkest = c;
    if (c.lab.L > brightest.lab.L) brightest = c;
  }

  const k = Math.min(targetColors, originalColorCount);
  const rng = createRng(seed);

  // 3. Initialize Centroids (k-means++)
  const centroids: ColorLab[] = [];
  const fixedCentroidMask: boolean[] = [];

  if (keepExtremes && k >= 2) {
    // Preserve darkest (outline) and brightest
    centroids.push({ ...darkest.lab });
    fixedCentroidMask.push(true);

    if (darkest.key !== brightest.key) {
      centroids.push({ ...brightest.lab });
      fixedCentroidMask.push(true);
    }
  }

  // Helper to compute min distance to already chosen centroids
  const minDistToCentroids = (lab: ColorLab): number => {
    let minD = Infinity;
    for (const c of centroids) {
      const d = oklabDistance(lab, c);
      if (d < minD) minD = d;
    }
    return minD;
  };

  // If no centroids yet, pick first centroid with probability proportional to weight
  if (centroids.length === 0) {
    let totalWeight = 0;
    for (const c of uniqueColors) totalWeight += c.weight;
    const threshold = rng() * totalWeight;
    let acc = 0;
    let chosen = uniqueColors[0];
    for (const c of uniqueColors) {
      acc += c.weight;
      if (acc >= threshold) {
        chosen = c;
        break;
      }
    }
    centroids.push({ ...chosen.lab });
    fixedCentroidMask.push(false);
  }

  // Pick remaining centroids with deterministic weighted farthest-point seeding:
  // choose the color maximizing sqrt(weight) * D(x). This reliably seeds distinct
  // hues (blue eyes, red mouth) that random k-means++ often misses.
  while (centroids.length < k) {
    const distSq = new Float64Array(uniqueColors.length);
    let totalDistSq = 0;
    let bestScore = -1;
    let bestIdx = -1;

    for (let i = 0; i < uniqueColors.length; i++) {
      const d = minDistToCentroids(uniqueColors[i].lab);
      const val = uniqueColors[i].weight * (d * d);
      distSq[i] = val;
      totalDistSq += val;
      const score = Math.sqrt(uniqueColors[i].weight) * d;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore > 1e-9) {
      centroids.push({ ...uniqueColors[bestIdx].lab });
      fixedCentroidMask.push(false);
      continue;
    }

    if (totalDistSq <= 1e-12) {
      // All remaining points are identical to existing centroids
      const remaining = uniqueColors.find(c => !centroids.some(cnt => oklabDistance(cnt, c.lab) < 1e-6));
      if (remaining) {
        centroids.push({ ...remaining.lab });
        fixedCentroidMask.push(false);
      } else {
        break;
      }
    } else {
      const threshold = rng() * totalDistSq;
      let acc = 0;
      let chosenIdx = 0;
      for (let i = 0; i < uniqueColors.length; i++) {
        acc += distSq[i];
        if (acc >= threshold) {
          chosenIdx = i;
          break;
        }
      }
      centroids.push({ ...uniqueColors[chosenIdx].lab });
      fixedCentroidMask.push(false);
    }
  }

  // 4. Weighted k-Means Lloyd's Iterations
  const numCentroids = centroids.length;
  const assignments = new Int32Array(uniqueColors.length);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assignment step
    for (let i = 0; i < uniqueColors.length; i++) {
      const pLab = uniqueColors[i].lab;
      let bestIdx = 0;
      let bestDist = oklabDistance(pLab, centroids[0]);

      for (let j = 1; j < numCentroids; j++) {
        const d = oklabDistance(pLab, centroids[j]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = j;
        }
      }
      assignments[i] = bestIdx;
    }

    // Update step
    const sumL = new Float64Array(numCentroids);
    const sumA = new Float64Array(numCentroids);
    const sumB = new Float64Array(numCentroids);
    const sumW = new Float64Array(numCentroids);

    for (let i = 0; i < uniqueColors.length; i++) {
      const aIdx = assignments[i];
      const w = uniqueColors[i].weight;
      sumL[aIdx] += uniqueColors[i].lab.L * w;
      sumA[aIdx] += uniqueColors[i].lab.a * w;
      sumB[aIdx] += uniqueColors[i].lab.b * w;
      sumW[aIdx] += w;
    }

    let maxShift = 0;
    for (let j = 0; j < numCentroids; j++) {
      if (fixedCentroidMask[j]) {
        // Keep extreme colors fixed
        continue;
      }

      if (sumW[j] > 0) {
        const newLab: ColorLab = {
          L: sumL[j] / sumW[j],
          a: sumA[j] / sumW[j],
          b: sumB[j] / sumW[j]
        };
        const shift = oklabDistance(centroids[j], newLab);
        if (shift > maxShift) maxShift = shift;
        centroids[j] = newLab;
      } else {
        // Empty cluster: reseed with the farthest point
        let maxD = -1;
        let farthestIdx = 0;
        for (let i = 0; i < uniqueColors.length; i++) {
          const d = minDistToCentroids(uniqueColors[i].lab);
          if (d > maxD) {
            maxD = d;
            farthestIdx = i;
          }
        }
        centroids[j] = { ...uniqueColors[farthestIdx].lab };
      }
    }

    if (maxShift < 1e-4) {
      break;
    }
  }

  // 5. Construct Resulting Palette
  const paletteColors: ColorRGBA[] = [];
  const paletteKeys = new Set<number>();

  for (let j = 0; j < numCentroids; j++) {
    let rgba: ColorRGBA;
    if (fixedCentroidMask[j] && j === 0) {
      rgba = { r: darkest.r, g: darkest.g, b: darkest.b, a: 255 };
    } else if (fixedCentroidMask[j] && j === 1) {
      rgba = { r: brightest.r, g: brightest.g, b: brightest.b, a: 255 };
    } else {
      const rgb = oklabToRgb(centroids[j]);
      rgba = { r: rgb.r, g: rgb.g, b: rgb.b, a: 255 };
    }

    const key = (rgba.r << 16) | (rgba.g << 8) | rgba.b;
    if (!paletteKeys.has(key)) {
      paletteKeys.add(key);
      paletteColors.push(rgba);
    }
  }

  // Ensure darkest and brightest are strictly included if keepExtremes is set
  if (keepExtremes) {
    const darkKey = (darkest.r << 16) | (darkest.g << 8) | darkest.b;
    if (!paletteKeys.has(darkKey)) {
      paletteKeys.add(darkKey);
      paletteColors.push({ r: darkest.r, g: darkest.g, b: darkest.b, a: 255 });
    }
    const brightKey = (brightest.r << 16) | (brightest.g << 8) | brightest.b;
    if (!paletteKeys.has(brightKey)) {
      paletteKeys.add(brightKey);
      paletteColors.push({ r: brightest.r, g: brightest.g, b: brightest.b, a: 255 });
    }
  }

  const sortedPalette = sortPalette(paletteColors);

  // 6. Map unique colors to the nearest palette color in OKLab space
  const paletteLabs = sortedPalette.map(c => rgbToOklab(c));
  const mapping = new Map<number, ColorRGBA>();

  for (const c of uniqueColors) {
    let bestIdx = 0;
    let bestDist = oklabDistance(c.lab, paletteLabs[0]);

    for (let j = 1; j < sortedPalette.length; j++) {
      const d = oklabDistance(c.lab, paletteLabs[j]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    mapping.set(c.key, sortedPalette[bestIdx]);
  }

  // 7. Write quantized pixel data
  const outData = new Uint8ClampedArray(totalPixels * 4);
  for (let i = 0; i < buf.data.length; i += 4) {
    const a = buf.data[i + 3];
    if (a < 128) {
      outData[i] = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 0;
    } else {
      const r = buf.data[i];
      const g = buf.data[i + 1];
      const b = buf.data[i + 2];
      const key = (r << 16) | (g << 8) | b;
      const targetColor = mapping.get(key) || sortedPalette[0];

      outData[i] = targetColor.r;
      outData[i + 1] = targetColor.g;
      outData[i + 2] = targetColor.b;
      outData[i + 3] = 255;
    }
  }

  const resultBuf: PixelBuffer = {
    w: buf.w,
    h: buf.h,
    data: outData
  };

  return {
    quantized: resultBuf,
    buffer: resultBuf, // alias for backwards compatibility
    originalColorCount,
    palette: sortedPalette
  };
}

/**
 * Backward-compatible alias for quantizeColors
 */
export const quantizeBuffer = quantizeColors;
