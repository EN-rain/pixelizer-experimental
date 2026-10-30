import { describe, it, expect } from 'vitest';
import { fixOutline } from '../core/outline';
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

describe('Outline Fixing & Blue Pixel Tracking', () => {
  it('removes stray orphan pixels (noise dust) and logs their coordinates', () => {
    const w = 16;
    const h = 16;
    const buf = createBuffer(w, h);

    // Main solid body
    fillRect(buf, 4, 4, 8, 8, 50, 150, 250, 255);

    // Stray orphan pixels with 0 neighbors
    setPixel(buf, 1, 1, 200, 200, 200, 255);
    setPixel(buf, 14, 14, 200, 200, 200, 255);

    const { buffer, changedPixels } = fixOutline(buf, 'clean_only');

    // Stray pixels must now be transparent
    expect(buffer.data[(1 * w + 1) * 4 + 3]).toBe(0);
    expect(buffer.data[(14 * w + 14) * 4 + 3]).toBe(0);

    // changedPixels should track the removed orphans
    expect(changedPixels).toContainEqual({ x: 1, y: 1 });
    expect(changedPixels).toContainEqual({ x: 14, y: 14 });

    // Main body remains intact
    expect(buffer.data[(8 * w + 8) * 4 + 3]).toBe(255);
  });

  it('fills pinholes inside solid bodies using neighbor colors', () => {
    const w = 12;
    const h = 12;
    const buf = createBuffer(w, h);

    // Solid red 5x5 block
    fillRect(buf, 3, 3, 5, 5, 220, 40, 40, 255);

    // Punch a single pinhole in the center at (5, 5)
    setPixel(buf, 5, 5, 0, 0, 0, 0);

    const { buffer, changedPixels } = fixOutline(buf, 'clean_only');

    // Pinhole should be filled with opaque red
    const pinholeIdx = (5 * w + 5) * 4;
    expect(buffer.data[pinholeIdx + 3]).toBe(255);
    expect(buffer.data[pinholeIdx]).toBe(220);
    expect(buffer.data[pinholeIdx + 1]).toBe(40);
    expect(buffer.data[pinholeIdx + 2]).toBe(40);

    // changedPixels must record the filled coordinate
    expect(changedPixels).toContainEqual({ x: 5, y: 5 });
  });

  it('tracks all changes accurately for blue-pixel highlighting', () => {
    const w = 10;
    const h = 10;
    const buf = createBuffer(w, h);

    // Solid body
    fillRect(buf, 3, 3, 4, 4, 60, 60, 60, 255);
    // Two orphans
    setPixel(buf, 0, 0, 100, 100, 100, 255);
    setPixel(buf, 9, 9, 100, 100, 100, 255);

    const { changedPixels } = fixOutline(buf, 'clean_only');

    expect(changedPixels.length).toBe(2);
    expect(changedPixels).toEqual(
      expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 9, y: 9 }
      ])
    );
  });

  it('adds an exterior outline in outside mode with specified or auto color', () => {
    const w = 10;
    const h = 10;
    const buf = createBuffer(w, h);

    // 2x2 square in center
    fillRect(buf, 4, 4, 2, 2, 200, 100, 50, 255);

    const customColor = '#123456';
    const { buffer, changedPixels } = fixOutline(buf, 'outside', customColor);

    // Adjacent pixel (4, 3) was transparent, should now be outline color
    const edgeIdx = (3 * w + 4) * 4;
    expect(buffer.data[edgeIdx + 3]).toBe(255);
    expect(buffer.data[edgeIdx]).toBe(0x12);
    expect(buffer.data[edgeIdx + 1]).toBe(0x34);
    expect(buffer.data[edgeIdx + 2]).toBe(0x56);

    expect(changedPixels).toContainEqual({ x: 4, y: 3 });
  });

  it('cleans weak edge pixels in inside mode', () => {
    const w = 10;
    const h = 10;
    const buf = createBuffer(w, h);

    // Dark body
    fillRect(buf, 3, 3, 4, 4, 30, 30, 30, 255);

    // Pale anti-aliased edge pixel on corner
    setPixel(buf, 3, 3, 220, 220, 220, 255);

    const { buffer, changedPixels } = fixOutline(buf, 'inside');

    // The corner pixel has direct neighbors <= 2 and brightness > 160, so it gets reinforced
    const cornerIdx = (3 * w + 3) * 4;
    expect(changedPixels).toContainEqual({ x: 3, y: 3 });
    // Color should have been replaced with dark outline color
    expect(buffer.data[cornerIdx]).toBeLessThan(60);
  });

  it('bridges horizontal broken outline gaps (e.g. chin boundary)', () => {
    const w = 16;
    const h = 16;
    const buf = createBuffer(w, h);

    // Face skin above line (y=4, 5)
    fillRect(buf, 2, 4, 12, 2, 250, 220, 200, 255);
    // Neck/collar below line (y=7, 8)
    fillRect(buf, 2, 7, 12, 2, 80, 100, 60, 255);

    // Line at y=6 with a 2-pixel gap at x=7, 8
    // Left segment: x=3, 4, 5, 6
    for (let x = 3; x <= 6; x++) setPixel(buf, x, 6, 20, 20, 20, 255);
    // Gap: x=7, 8 has skin color
    setPixel(buf, 7, 6, 250, 220, 200, 255);
    setPixel(buf, 8, 6, 250, 220, 200, 255);
    // Right segment: x=9, 10, 11
    for (let x = 9; x <= 11; x++) setPixel(buf, x, 6, 20, 20, 20, 255);

    const { buffer, changedPixels } = fixOutline(buf, 'clean_only', 'auto', false, undefined, true);

    expect(changedPixels).toContainEqual({ x: 7, y: 6 });
    expect(changedPixels).toContainEqual({ x: 8, y: 6 });

    // Both gap pixels should now be dark outline
    const idx7 = (6 * w + 7) * 4;
    const idx8 = (6 * w + 8) * 4;
    expect(buffer.data[idx7]).toBeLessThan(50);
    expect(buffer.data[idx8]).toBeLessThan(50);
  });

  it('prevents 2x2 doubling when bridging outlines', () => {
    const w = 16;
    const h = 16;
    const buf = createBuffer(w, h);

    // Dark 2-line structure
    fillRect(buf, 4, 4, 6, 1, 20, 20, 20, 255);
    // Row 5 has dark at 4, 5 and 8, 9 with gap at 6, 7
    setPixel(buf, 4, 5, 20, 20, 20, 255);
    setPixel(buf, 5, 5, 20, 20, 20, 255);
    setPixel(buf, 6, 5, 200, 200, 200, 255);
    setPixel(buf, 7, 5, 200, 200, 200, 255);
    setPixel(buf, 8, 5, 20, 20, 20, 255);
    setPixel(buf, 9, 5, 20, 20, 20, 255);

    const { changedPixels } = fixOutline(buf, 'clean_only', 'auto', false, undefined, true);

    // Filling row 5 at (6, 5) would make a 2x2 block with (5,4),(6,4),(5,5)
    // Thus it should be rejected
    expect(changedPixels).not.toContainEqual({ x: 6, y: 5 });
  });
});