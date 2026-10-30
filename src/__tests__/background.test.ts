import { describe, it, expect } from 'vitest';
import { removeBackground } from '../core/background';
import { PixelBuffer } from '../core/types';

function createBuffer(w: number, h: number): PixelBuffer {
  return {
    w,
    h,
    data: new Uint8ClampedArray(w * h * 4)
  };
}

function setPixel(
  buf: PixelBuffer,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255
) {
  const idx = (y * buf.w + x) * 4;
  buf.data[idx] = r;
  buf.data[idx + 1] = g;
  buf.data[idx + 2] = b;
  buf.data[idx + 3] = a;
}

function fillRect(
  buf: PixelBuffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255
) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPixel(buf, x, y, r, g, b, a);
    }
  }
}

describe('Background Removal Algorithm', () => {
  it('flood-fills background from borders and turns them transparent', () => {
    const w = 20;
    const h = 20;
    const buf = createBuffer(w, h);

    // Fill entire image with white background
    fillRect(buf, 0, 0, w, h, 255, 255, 255, 255);

    // Place a colored foreground character in the middle
    fillRect(buf, 6, 6, 8, 8, 40, 120, 200, 255);

    const result = removeBackground(buf, 0.12);

    // Borders should be fully transparent
    expect(result.data[0 + 3]).toBe(0); // (0, 0)
    expect(result.data[((h - 1) * w + (w - 1)) * 4 + 3]).toBe(0); // (w-1, h-1)
    expect(result.data[(5 * w + 5) * 4 + 3]).toBe(0);

    // Foreground character should remain intact and opaque
    const centerIdx = (10 * w + 10) * 4;
    expect(result.data[centerIdx]).toBe(40);
    expect(result.data[centerIdx + 1]).toBe(120);
    expect(result.data[centerIdx + 2]).toBe(200);
    expect(result.data[centerIdx + 3]).toBe(255);
  });

  it('retains enclosed foreground pixels that match background color', () => {
    const w = 24;
    const h = 24;
    const buf = createBuffer(w, h);

    // 1. White background across entire image
    fillRect(buf, 0, 0, w, h, 255, 255, 255, 255);

    // 2. Dark enclosed boundary (like character's black armor/outline)
    fillRect(buf, 5, 5, 14, 14, 20, 20, 20, 255);

    // 3. Colored character interior
    fillRect(buf, 7, 7, 10, 10, 200, 80, 50, 255);

    // 4. Enclosed "white eye/specular" inside the character that shares the exact background color
    fillRect(buf, 10, 10, 3, 3, 255, 255, 255, 255);

    // Run background removal without removing islands
    const result = removeBackground(buf, 0.12, false);

    // External background must be transparent
    expect(result.data[(0 * w + 0) * 4 + 3]).toBe(0);
    expect(result.data[(2 * w + 2) * 4 + 3]).toBe(0);

    // Dark outline remains opaque
    expect(result.data[(5 * w + 5) * 4 + 3]).toBe(255);

    // Character body remains opaque
    expect(result.data[(8 * w + 8) * 4 + 3]).toBe(255);

    // CRITICAL: The enclosed eye with background color REMAINS OPAQUE because flood fill didn't reach it
    const eyeIdx = (11 * w + 11) * 4;
    expect(result.data[eyeIdx]).toBe(255);
    expect(result.data[eyeIdx + 1]).toBe(255);
    expect(result.data[eyeIdx + 2]).toBe(255);
    expect(result.data[eyeIdx + 3]).toBe(255);
  });

  it('removes enclosed islands when removeIslands is enabled', () => {
    const w = 20;
    const h = 20;
    const buf = createBuffer(w, h);

    fillRect(buf, 0, 0, w, h, 250, 250, 250, 255);
    // Dark donut
    fillRect(buf, 4, 4, 12, 12, 10, 10, 10, 255);
    // Enclosed hole matching background
    fillRect(buf, 8, 8, 4, 4, 250, 250, 250, 255);

    const result = removeBackground(buf, 0.15, true);

    // Exterior background is transparent
    expect(result.data[0 + 3]).toBe(0);
    // Dark ring remains opaque
    expect(result.data[(5 * w + 5) * 4 + 3]).toBe(255);
    // Enclosed hole is also removed when removeIslands = true
    const holeIdx = (9 * w + 9) * 4;
    expect(result.data[holeIdx + 3]).toBe(0);
  });

  it('preserves images that are already predominantly transparent', () => {
    const w = 10;
    const h = 10;
    const buf = createBuffer(w, h);

    // Leave 50% transparent
    fillRect(buf, 0, 0, 10, 5, 0, 0, 0, 0);
    fillRect(buf, 0, 5, 10, 5, 100, 150, 200, 255);

    const result = removeBackground(buf, 0.12);
    // Should not mutate transparent or opaque halves
    expect(result.data[3]).toBe(0);
    expect(result.data[(6 * w + 5) * 4 + 3]).toBe(255);
  });
});
