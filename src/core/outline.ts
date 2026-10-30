import { PixelBuffer } from './types';
import { hexToRgb } from './color';

export interface OutlineResult {
  buffer: PixelBuffer;
  changedPixels: Array<{ x: number; y: number }>;
}

/**
 * Outline fix algorithm as shown in the reference video:
 * 1. Removes stray orphan pixels (noise / floating pixel dust).
 * 2. Fills single-pixel pinholes inside solid bodies.
 * 3. Bridges broken line gaps and diagonal linework.
 * 4. Cleans / reinforces outlines.
 * Returns both the repaired buffer and a list of changed coordinates (to display in blue).
 */
export function fixOutline(
  buf: PixelBuffer,
  mode: 'inside' | 'outside' | 'clean_only' = 'inside',
  outlineColorOpt: 'auto' | string = 'auto',
  connectDiagonals = true,
  darkCoverage?: Float32Array,
  bridgeLineGaps = true
): OutlineResult {
  const { w, h } = buf;
  const data = new Uint8ClampedArray(buf.data);
  const changed: Array<{ x: number; y: number }> = [];

  const isOpaque = (x: number, y: number): boolean => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    return data[(y * w + x) * 4 + 3] > 64;
  };

  const countOpaqueNeighbors = (x: number, y: number, diagonal = true): number => {
    let count = 0;
    const deltas = diagonal
      ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
      : [[0, -1], [-1, 0], [1, 0], [0, 1]];
    for (const [dx, dy] of deltas) {
      if (isOpaque(x + dx, y + dy)) count++;
    }
    return count;
  };

  // Determine outline color
  let outlineR = 20;
  let outlineG = 20;
  let outlineB = 25;

  if (outlineColorOpt !== 'auto') {
    const rgb = hexToRgb(outlineColorOpt);
    outlineR = rgb.r;
    outlineG = rgb.g;
    outlineB = rgb.b;
  } else {
    // Find darkest edge color
    let minBrightness = 999;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isOpaque(x, y)) {
          const directNeighbors = countOpaqueNeighbors(x, y, false);
          if (directNeighbors < 4) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            if (brightness < minBrightness) {
              minBrightness = brightness;
              outlineR = r;
              outlineG = g;
              outlineB = b;
            }
          }
        }
      }
    }
  }

  // Step 1: Remove stray / orphan pixels (less than or equal to 1 neighbor)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isOpaque(x, y)) {
        const neighbors = countOpaqueNeighbors(x, y, true);
        if (neighbors <= 1) {
          const idx = (y * w + x) * 4;
          data[idx + 3] = 0; // make transparent
          changed.push({ x, y });
        }
      }
    }
  }

  // Step 2: Fill single-pixel pinholes (transparent pixel with >= 6 opaque neighbors)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!isOpaque(x, y)) {
        const direct = countOpaqueNeighbors(x, y, false);
        const all = countOpaqueNeighbors(x, y, true);
        if (direct >= 3 || all >= 6) {
          // Fill pinhole using average color of adjacent opaque neighbors
          let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
          const directDeltas = [[0, -1], [-1, 0], [1, 0], [0, 1]];
          for (const [dx, dy] of directDeltas) {
            const nx = x + dx;
            const ny = y + dy;
            if (isOpaque(nx, ny)) {
              const nIdx = (ny * w + nx) * 4;
              sumR += data[nIdx];
              sumG += data[nIdx + 1];
              sumB += data[nIdx + 2];
              cnt++;
            }
          }
          if (cnt > 0) {
            const idx = (y * w + x) * 4;
            data[idx] = Math.round(sumR / cnt);
            data[idx + 1] = Math.round(sumG / cnt);
            data[idx + 2] = Math.round(sumB / cnt);
            data[idx + 3] = 255;
            changed.push({ x, y });
          }
        }
      }
    }
  }

  // Step 2.5: Bridge disconnected diagonal linework corners (e.g. glasses frames, facial linework)
  // Only bridge a diagonal gap when the source image actually has dark ink in the gap cell.
  // Plain 1-px diagonal lines are valid pixel art and must NOT be thickened.
  const MIN_INK_COVERAGE = 0.2;
  if (connectDiagonals && darkCoverage) {
    const hasInk = (x: number, y: number): boolean => darkCoverage[y * w + x] >= MIN_INK_COVERAGE;
    const isDarkLinework = (x: number, y: number): boolean => {
      if (!isOpaque(x, y)) return false;
      const idx = (y * w + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      return lum < 75; // dark linework pixel
    };

    // Find diagonal linework pairs that have no orthogonal connection between them
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        // Pattern 1: (x, y) dark and (x+1, y+1) dark, while (x+1, y) and (x, y+1) are non-dark
        if (isDarkLinework(x, y) && isDarkLinework(x + 1, y + 1)) {
          if (!isDarkLinework(x + 1, y) && !isDarkLinework(x, y + 1)) {
            const idx1 = (y * w + (x + 1)) * 4;
            const idx2 = ((y + 1) * w + x) * 4;
            const lum1 = 0.299 * data[idx1] + 0.587 * data[idx1 + 1] + 0.114 * data[idx1 + 2];
            const lum2 = 0.299 * data[idx2] + 0.587 * data[idx2 + 1] + 0.114 * data[idx2 + 2];
            const bridgeX = lum1 <= lum2 ? x + 1 : x;
            const bridgeY = lum1 <= lum2 ? y : y + 1;
            if (!hasInk(bridgeX, bridgeY)) continue;
            const bIdx = (bridgeY * w + bridgeX) * 4;
            data[bIdx] = outlineR;
            data[bIdx + 1] = outlineG;
            data[bIdx + 2] = outlineB;
            data[bIdx + 3] = 255;
            changed.push({ x: bridgeX, y: bridgeY });
          }
        }
        // Pattern 2: (x+1, y) dark and (x, y+1) dark, while (x, y) and (x+1, y+1) are non-dark
        if (isDarkLinework(x + 1, y) && isDarkLinework(x, y + 1)) {
          if (!isDarkLinework(x, y) && !isDarkLinework(x + 1, y + 1)) {
            const idx1 = (y * w + x) * 4;
            const idx2 = ((y + 1) * w + (x + 1)) * 4;
            const lum1 = 0.299 * data[idx1] + 0.587 * data[idx1 + 1] + 0.114 * data[idx1 + 2];
            const lum2 = 0.299 * data[idx2] + 0.587 * data[idx2 + 1] + 0.114 * data[idx2 + 2];
            const bridgeX = lum1 <= lum2 ? x : x + 1;
            const bridgeY = lum1 <= lum2 ? y : y + 1;
            if (!hasInk(bridgeX, bridgeY)) continue;
            const bIdx = (bridgeY * w + bridgeX) * 4;
            data[bIdx] = outlineR;
            data[bIdx + 1] = outlineG;
            data[bIdx + 2] = outlineB;
            data[bIdx + 3] = 255;
            changed.push({ x: bridgeX, y: bridgeY });
          }
        }
      }
    }
  }

  // Step 2.6: Bridge broken line gaps (e.g. missing chin contour line or boundary gap)
  if (bridgeLineGaps) {
    const isDark = (x: number, y: number): boolean => {
      if (!isOpaque(x, y)) return false;
      const idx = (y * w + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      return lum < 75;
    };

    const wouldCreate2x2 = (x: number, y: number): boolean => {
      if (isDark(x - 1, y - 1) && isDark(x, y - 1) && isDark(x - 1, y)) return true;
      if (isDark(x, y - 1) && isDark(x + 1, y - 1) && isDark(x + 1, y)) return true;
      if (isDark(x - 1, y) && isDark(x - 1, y + 1) && isDark(x, y + 1)) return true;
      if (isDark(x + 1, y) && isDark(x, y + 1) && isDark(x + 1, y + 1)) return true;
      return false;
    };

    // Bridge horizontal gaps (length 1 or 2)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 2; x++) {
        // Gap of 1
        if (isDark(x - 1, y) && !isDark(x, y) && isDark(x + 1, y)) {
          if (!wouldCreate2x2(x, y)) {
            const idx = (y * w + x) * 4;
            data[idx] = outlineR;
            data[idx + 1] = outlineG;
            data[idx + 2] = outlineB;
            data[idx + 3] = 255;
            changed.push({ x, y });
          }
        }
        // Gap of 2
        if (x < w - 3 && isDark(x - 1, y) && !isDark(x, y) && !isDark(x + 1, y) && isDark(x + 2, y)) {
          if (!wouldCreate2x2(x, y) && !wouldCreate2x2(x + 1, y)) {
            for (const gx of [x, x + 1]) {
              const idx = (y * w + gx) * 4;
              data[idx] = outlineR;
              data[idx + 1] = outlineG;
              data[idx + 2] = outlineB;
              data[idx + 3] = 255;
              changed.push({ x: gx, y });
            }
          }
        }
      }
    }

    // Bridge vertical gaps (length 1 or 2)
    for (let x = 1; x < w - 1; x++) {
      for (let y = 1; y < h - 2; y++) {
        // Gap of 1
        if (isDark(x, y - 1) && !isDark(x, y) && isDark(x, y + 1)) {
          if (!wouldCreate2x2(x, y)) {
            const idx = (y * w + x) * 4;
            data[idx] = outlineR;
            data[idx + 1] = outlineG;
            data[idx + 2] = outlineB;
            data[idx + 3] = 255;
            changed.push({ x, y });
          }
        }
        // Gap of 2
        if (y < h - 3 && isDark(x, y - 1) && !isDark(x, y) && !isDark(x, y + 1) && isDark(x, y + 2)) {
          if (!wouldCreate2x2(x, y) && !wouldCreate2x2(x, y + 1)) {
            for (const gy of [y, y + 1]) {
              const idx = (gy * w + x) * 4;
              data[idx] = outlineR;
              data[idx + 1] = outlineG;
              data[idx + 2] = outlineB;
              data[idx + 3] = 255;
              changed.push({ x, y: gy });
            }
          }
        }
      }
    }
  }

  // Step 3: Reinforce / clean outline if enabled
  if (mode === 'outside') {
    const outsidePixels: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isOpaque(x, y)) {
          if (countOpaqueNeighbors(x, y, false) > 0) {
            outsidePixels.push({ x, y });
          }
        }
      }
    }
    for (const p of outsidePixels) {
      const idx = (p.y * w + p.x) * 4;
      data[idx] = outlineR;
      data[idx + 1] = outlineG;
      data[idx + 2] = outlineB;
      data[idx + 3] = 255;
      changed.push(p);
    }
  } else if (mode === 'inside') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isOpaque(x, y)) {
          const direct = countOpaqueNeighbors(x, y, false);
          if (direct < 4) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            if (brightness > 160 && direct <= 2) {
              data[idx] = outlineR;
              data[idx + 1] = outlineG;
              data[idx + 2] = outlineB;
              changed.push({ x, y });
            }
          }
        }
      }
    }
  }

  return {
    buffer: { w, h, data },
    changedPixels: changed
  };
}
