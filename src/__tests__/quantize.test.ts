import { describe, it, expect } from 'vitest';
import { quantizeColors } from '../core/quantize';
import { PixelBuffer, ColorRGBA } from '../core/types';
import { rgbToOklab } from '../core/color';

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

describe('Color Quantization (OKLab Weighted k-Means)', () => {
  it('counts original unique colors correctly', () => {
    const buf = createBuffer(4, 4);

    // Place 5 distinct colors
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [0, 255, 255]
    ];

    for (let i = 0; i < 16; i++) {
      const c = colors[i % colors.length];
      const x = i % 4;
      const y = Math.floor(i / 4);
      setPixel(buf, x, y, c[0], c[1], c[2], 255);
    }

    const result = quantizeColors(buf, 16);
    expect(result.originalColorCount).toBe(5);
    expect(result.palette.length).toBe(5);
  });

  it('limits the palette size to targetColors and remaps all pixels', () => {
    const w = 16;
    const h = 16;
    const buf = createBuffer(w, h);

    // Create an image with 64 smoothly varying colors
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        setPixel(buf, x, y, x * 16, y * 16, ((x + y) * 8) % 256, 255);
      }
    }

    const targetColors = 8;
    const result = quantizeColors(buf, { targetColors, seed: 100 });

    expect(result.originalColorCount).toBeGreaterThan(targetColors);
    expect(result.palette.length).toBeLessThanOrEqual(targetColors);

    // Verify every opaque pixel in quantized image uses a color from result.palette
    const paletteKeySet = new Set(
      result.palette.map((c: ColorRGBA) => `${c.r},${c.g},${c.b}`)
    );

    for (let i = 0; i < result.quantized.data.length; i += 4) {
      if (result.quantized.data[i + 3] >= 128) {
        const key = `${result.quantized.data[i]},${result.quantized.data[i + 1]},${result.quantized.data[i + 2]}`;
        expect(paletteKeySet.has(key)).toBe(true);
      }
    }
  });

  it('produces deterministic output with seeded PRNG', () => {
    const w = 12;
    const h = 12;
    const buf = createBuffer(w, h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        setPixel(buf, x, y, (x * 21) % 255, (y * 37) % 255, ((x + y) * 17) % 255, 255);
      }
    }

    const run1 = quantizeColors(buf, { targetColors: 6, seed: 1337 });
    const run2 = quantizeColors(buf, { targetColors: 6, seed: 1337 });

    // Palette must be strictly identical
    expect(run1.palette).toEqual(run2.palette);

    // Pixel buffers must be byte-for-byte identical
    expect(run1.quantized.data).toEqual(run2.quantized.data);
  });

  it('preserves the darkest (outline) and brightest colors when keepExtremes is true', () => {
    const w = 10;
    const h = 10;
    const buf = createBuffer(w, h);

    // Outline color: pure dark
    const darkR = 12, darkG = 12, darkB = 18;
    // Bright specular color
    const brightR = 250, brightG = 245, brightB = 230;

    // Fill with intermediate colors
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        setPixel(buf, x, y, 100 + x * 5, 80 + y * 5, 120, 255);
      }
    }

    // Set one pixel to the dark outline and one to the bright specular
    setPixel(buf, 0, 0, darkR, darkG, darkB, 255);
    setPixel(buf, 9, 9, brightR, brightG, brightB, 255);

    const result = quantizeColors(buf, {
      targetColors: 4,
      keepExtremes: true,
      seed: 42
    });

    const hasDark = result.palette.some(
      c => c.r === darkR && c.g === darkG && c.b === darkB
    );
    const hasBright = result.palette.some(
      c => c.r === brightR && c.g === brightG && c.b === brightB
    );

    expect(hasDark).toBe(true);
    expect(hasBright).toBe(true);
  });

  it('sorts resulting palette by luminance (OKLab L)', () => {
    const buf = createBuffer(4, 4);

    setPixel(buf, 0, 0, 255, 255, 255, 255); // Lightest
    setPixel(buf, 1, 0, 0, 0, 0, 255);       // Darkest
    setPixel(buf, 2, 0, 128, 128, 128, 255); // Middle
    setPixel(buf, 3, 0, 40, 40, 40, 255);    // Dark-mid

    const result = quantizeColors(buf, 4);

    // Verify ascending luminance order
    for (let i = 0; i < result.palette.length - 1; i++) {
      const lab1 = rgbToOklab(result.palette[i]);
      const lab2 = rgbToOklab(result.palette[i + 1]);
      // First should have L <= second (or very close if ordered by hue)
      expect(lab1.L).toBeLessThanOrEqual(lab2.L + 0.05);
    }
  });

  it('handles completely transparent buffers gracefully', () => {
    const buf = createBuffer(8, 8);
    const result = quantizeColors(buf, 8);

    expect(result.originalColorCount).toBe(0);
    expect(result.palette.length).toBeGreaterThan(0);
    expect(result.quantized.w).toBe(8);
    expect(result.quantized.h).toBe(8);
  });
});
