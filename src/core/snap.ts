import { PixelBuffer, Grid, MixelReport } from './types';

export interface SnapResult {
  snapped: PixelBuffer;
  mixelReport: MixelReport;
  /** Fraction (0..1) of each cell's source pixels that are dark linework. Same layout as `snapped`. */
  darkCoverage: Float32Array;
}

/**
 * Snaps the high-resolution AI image into a crisp low-resolution (cols x rows) PixelBuffer.
 * Uses exact elastic grid cell boundaries (xLines, yLines) if available, or uniform grid otherwise.
 * Applies center-weighted sampling and dark linework boost to prevent thin outlines or glasses
 * bridges from being eroded by blurred light pixel borders.
 */
export function snapToGrid(source: PixelBuffer, grid: Grid, lineworkBoost = 1.35): SnapResult {
  const { cols, rows, pitchX, pitchY, offX, offY, xLines, yLines } = grid;
  const snappedData = new Uint8ClampedArray(cols * rows * 4);
  const mixelMask = new Uint8Array(cols * rows);
  const darkCoverage = new Float32Array(cols * rows);
  let totalMixels = 0;

  // Pre-generate grid line coordinates if not provided
  const getX0 = (c: number) => (xLines && xLines[c] !== undefined ? xLines[c] : Math.max(0, Math.floor(offX + c * pitchX)));
  const getX1 = (c: number) => (xLines && xLines[c + 1] !== undefined ? xLines[c + 1] : Math.min(source.w, Math.ceil(offX + (c + 1) * pitchX)));
  const getY0 = (r: number) => (yLines && yLines[r] !== undefined ? yLines[r] : Math.max(0, Math.floor(offY + r * pitchY)));
  const getY1 = (r: number) => (yLines && yLines[r + 1] !== undefined ? yLines[r + 1] : Math.min(source.h, Math.ceil(offY + (r + 1) * pitchY)));

  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.max(0, getY0(cy));
    const y1 = Math.min(source.h, getY1(cy));
    const cellH = Math.max(1, y1 - y0);
    const midY = (y0 + y1 - 1) * 0.5;

    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.max(0, getX0(cx));
      const x1 = Math.min(source.w, getX1(cx));
      const cellW = Math.max(1, x1 - x0);
      const midX = (x0 + x1 - 1) * 0.5;

      const binWeights = new Map<number, { count: number; weight: number; sumR: number; sumG: number; sumB: number; sumA: number }>();
      let totalSamples = 0;
      let opaqueCount = 0;
      let totalWeight = 0;

      // Dark ink coverage over the WHOLE cell (not just the center), used to detect
      // thin linework that center-weighted sampling may have dropped.
      let darkPixels = 0;
      let cellPixels = 0;
      for (let y = y0; y < y1; y++) {
        const ro = y * source.w * 4;
        for (let x = x0; x < x1; x++) {
          const i = ro + x * 4;
          cellPixels++;
          if (source.data[i + 3] >= 128 &&
              0.299 * source.data[i] + 0.587 * source.data[i + 1] + 0.114 * source.data[i + 2] < 65) {
            darkPixels++;
          }
        }
      }
      darkCoverage[cy * cols + cx] = cellPixels > 0 ? darkPixels / cellPixels : 0;

      for (let y = y0; y < y1; y++) {
        const rowOffset = y * source.w * 4;
        const ny = (y - midY) / (cellH * 0.5);
        if (Math.abs(ny) > 0.88) continue; // skip outer edge blur

        for (let x = x0; x < x1; x++) {
          const nx = (x - midX) / (cellW * 0.5);
          if (Math.abs(nx) > 0.88) continue;

          const idx = rowOffset + x * 4;
          const r = source.data[idx];
          const g = source.data[idx + 1];
          const b = source.data[idx + 2];
          const a = source.data[idx + 3];

          totalSamples++;
          if (a >= 128) opaqueCount++;

          // Gaussian radial center weight
          const r2 = nx * nx + ny * ny;
          let w = Math.exp(-1.5 * r2);

          // Boost dark linework (outline, glasses frames, pupils) so blurred light borders don't overpower thin lines
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum < 65 && a >= 128) {
            w *= lineworkBoost;
          }

          totalWeight += w;

          // 5-bit color binning
          const binKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          let entry = binWeights.get(binKey);
          if (!entry) {
            entry = { count: 0, weight: 0, sumR: 0, sumG: 0, sumB: 0, sumA: 0 };
            binWeights.set(binKey, entry);
          }
          entry.count++;
          entry.weight += w;
          entry.sumR += r * w;
          entry.sumG += g * w;
          entry.sumB += b * w;
          entry.sumA += a * w;
        }
      }

      const cellIdx = (cy * cols + cx) * 4;

      if (totalSamples === 0) {
        snappedData[cellIdx + 3] = 0;
        continue;
      }

      // If less than 40% opaque, consider transparent cell
      if (opaqueCount / totalSamples < 0.4) {
        snappedData[cellIdx] = 0;
        snappedData[cellIdx + 1] = 0;
        snappedData[cellIdx + 2] = 0;
        snappedData[cellIdx + 3] = 0;
        continue;
      }

      // Find dominant bin by weighted score
      let maxW = 0;
      let dominant = { count: 0, weight: 0, sumR: 0, sumG: 0, sumB: 0, sumA: 0 };
      for (const entry of binWeights.values()) {
        if (entry.weight > maxW) {
          maxW = entry.weight;
          dominant = entry;
        }
      }

      const meanR = Math.round(dominant.sumR / (dominant.weight || 1));
      const meanG = Math.round(dominant.sumG / (dominant.weight || 1));
      const meanB = Math.round(dominant.sumB / (dominant.weight || 1));
      const meanA = 255;

      snappedData[cellIdx] = meanR;
      snappedData[cellIdx + 1] = meanG;
      snappedData[cellIdx + 2] = meanB;
      snappedData[cellIdx + 3] = meanA;

      // Detect mixels: check variance across full cell compared to dominant color
      let sampleDiffSum = 0;
      let fullCount = 0;
      for (let y = y0; y < y1; y++) {
        const rowOffset = y * source.w * 4;
        for (let x = x0; x < x1; x++) {
          const idx = rowOffset + x * 4;
          const dr = Math.abs(source.data[idx] - meanR);
          const dg = Math.abs(source.data[idx + 1] - meanG);
          const db = Math.abs(source.data[idx + 2] - meanB);
          sampleDiffSum += (dr + dg + db) / 3;
          fullCount++;
        }
      }

      const avgDeviation = fullCount > 0 ? sampleDiffSum / fullCount : 0;
      if (avgDeviation > 18) {
        mixelMask[cy * cols + cx] = 1;
        totalMixels++;
      }
    }
  }

  const mixelRatio = (totalMixels / (cols * rows)) * 100;

  return {
    snapped: {
      w: cols,
      h: rows,
      data: snappedData
    },
    mixelReport: {
      mixelRatio,
      mixelMask
    },
    darkCoverage
  };
}
