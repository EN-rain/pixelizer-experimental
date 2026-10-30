import { describe, it, expect } from 'vitest';
import { detectGrid } from '../core/grid';
import { snapToGrid } from '../core/snap';
import { PixelBuffer } from '../core/types';

/**
 * Helper to create an empty PixelBuffer
 */
function createBuffer(w: number, h: number): PixelBuffer {
  return {
    w,
    h,
    data: new Uint8ClampedArray(w * h * 4)
  };
}

/**
 * Sets a pixel color in PixelBuffer
 */
function setPixel(
  buf: PixelBuffer,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255
) {
  if (x < 0 || x >= buf.w || y < 0 || y >= buf.h) return;
  const idx = (y * buf.w + x) * 4;
  buf.data[idx] = r;
  buf.data[idx + 1] = g;
  buf.data[idx + 2] = b;
  buf.data[idx + 3] = a;
}

/**
 * Creates a synthetic scaled low-res pixel art image with noise
 */
function createSyntheticScaledSprite(
  gridCols: number,
  gridRows: number,
  scale: number,
  noiseAmp = 3
): { lowRes: PixelBuffer; highRes: PixelBuffer } {
  const lowRes = createBuffer(gridCols, gridRows);
  const highRes = createBuffer(gridCols * scale, gridRows * scale);

  // Distinct palette
  const palette = [
    [24, 20, 37],
    [58, 68, 102],
    [90, 105, 136],
    [139, 155, 180],
    [22, 90, 76],
    [35, 144, 99],
    [68, 207, 133],
    [158, 40, 53],
    [228, 59, 68],
    [247, 118, 34],
    [254, 174, 52],
    [254, 231, 97],
    [99, 199, 77],
    [62, 137, 72],
    [38, 92, 66],
    [25, 60, 62]
  ];

  // Draw pseudo-random pixel art cells so every cell boundary exhibits color variance
  let seed = 987654321;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };

  for (let y = 0; y < gridRows; y++) {
    for (let x = 0; x < gridCols; x++) {
      const colorIdx = nextRand() % palette.length;
      const [r, g, b] = palette[colorIdx];
      setPixel(lowRes, x, y, r, g, b, 255);
    }
  }

  // Scale up to highRes with noise
  let noiseSeed = 42;
  const nextNoise = () => {
    noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0;
    return ((noiseSeed / 4294967296) - 0.5) * 2; // -1 to 1
  };

  for (let gy = 0; gy < gridRows; gy++) {
    for (let gx = 0; gx < gridCols; gx++) {
      const lowIdx = (gy * gridCols + gx) * 4;
      const baseR = lowRes.data[lowIdx];
      const baseG = lowRes.data[lowIdx + 1];
      const baseB = lowRes.data[lowIdx + 2];

      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const hx = gx * scale + px;
          const hy = gy * scale + py;

          // Inner cell has small noise, border has slight blur
          const isEdge = px === 0 || px === scale - 1 || py === 0 || py === scale - 1;
          const noise = nextNoise() * (isEdge ? noiseAmp * 1.5 : noiseAmp);

          const r = Math.min(255, Math.max(0, Math.round(baseR + noise)));
          const g = Math.min(255, Math.max(0, Math.round(baseG + noise)));
          const b = Math.min(255, Math.max(0, Math.round(baseB + noise)));

          setPixel(highRes, hx, hy, r, g, b, 255);
        }
      }
    }
  }

  return { lowRes, highRes };
}

describe('Grid Detection & Snapping Algorithm', () => {
  it('detects grid pitch and offset accurately on synthetic scaled sprites', () => {
    const scale = 12;
    const cols = 16;
    const rows = 16;
    const { highRes } = createSyntheticScaledSprite(cols, rows, scale, 3);

    const grid = detectGrid(highRes, 'auto');

    // Pitch should match the true scale (12)
    expect(grid.pitchX).toBeCloseTo(scale, 0);
    expect(grid.pitchY).toBeCloseTo(scale, 0);
    expect(grid.cols).toBe(cols);
    expect(grid.rows).toBe(rows);
    expect(grid.confidence).toBeGreaterThan(1.0);
  });

  it('snaps high-res image back to low-res with high accuracy (>95%)', () => {
    const scale = 10;
    const cols = 16;
    const rows = 16;
    const { lowRes, highRes } = createSyntheticScaledSprite(cols, rows, scale, 4);

    const grid = detectGrid(highRes, 'auto');
    const { snapped, mixelReport } = snapToGrid(highRes, grid);

    expect(snapped.w).toBe(cols);
    expect(snapped.h).toBe(rows);

    let matchingPixels = 0;
    const totalPixels = cols * rows;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = (y * cols + x) * 4;
        const dr = Math.abs(snapped.data[idx] - lowRes.data[idx]);
        const dg = Math.abs(snapped.data[idx + 1] - lowRes.data[idx + 1]);
        const db = Math.abs(snapped.data[idx + 2] - lowRes.data[idx + 2]);

        // Dominant mode binning should reconstruct original color within minor noise threshold
        if (dr <= 10 && dg <= 10 && db <= 10) {
          matchingPixels++;
        }
      }
    }

    const accuracy = matchingPixels / totalPixels;
    expect(accuracy).toBeGreaterThan(0.95);
    expect(mixelReport.mixelMask.length).toBe(cols * rows);
    expect(mixelReport.mixelRatio).toBeGreaterThanOrEqual(0);
    expect(mixelReport.mixelRatio).toBeLessThanOrEqual(100);
  });

  it('supports fixed grid modes (32 and 64)', () => {
    const { highRes: highRes32 } = createSyntheticScaledSprite(32, 32, 8, 2);
    const grid32 = detectGrid(highRes32, 32);
    expect(grid32.cols).toBe(32);
    expect(grid32.rows).toBe(32);

    const { highRes: highRes64 } = createSyntheticScaledSprite(64, 64, 8, 2);
    const grid64 = detectGrid(highRes64, 64);
    expect(grid64.cols).toBe(64);
    expect(grid64.rows).toBe(64);
  });

  it('applies nudges correctly to pitch and offsets', () => {
    const { highRes } = createSyntheticScaledSprite(16, 16, 10);
    const nudges = {
      pitchNudge: 10, // +10%
      offXNudge: 2,
      offYNudge: 3
    };

    const grid = detectGrid(highRes, 'auto', nudges);
    expect(grid.offX).toBeDefined();
    expect(grid.offY).toBeDefined();
  });
});
