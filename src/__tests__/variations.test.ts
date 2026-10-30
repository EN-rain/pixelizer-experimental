import { describe, it, expect } from 'vitest';
import { generateVariations } from '../core/pipeline';
import { PixelBuffer } from '../core/types';

describe('Multi-Pass Variations Engine', () => {
  it('generates 10 distinct candidate variations', () => {
    const w = 32;
    const h = 32;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 40;
      data[i + 1] = 60;
      data[i + 2] = 120;
      data[i + 3] = 255;
    }
    const source: PixelBuffer = { w, h, data };

    const vars = generateVariations(source, {}, 10);
    expect(vars.length).toBe(10);
    expect(vars[0].name).toBe('Balanced');
    expect(vars[1].name).toBe('Sharp Linework');
    expect(vars[7].name).toBe('Vibrant 24 Colors');

    for (const v of vars) {
      expect(v.result.quantized.w).toBeGreaterThan(0);
      expect(v.result.quantized.h).toBeGreaterThan(0);
      expect(v.result.palette.length).toBeGreaterThan(0);
    }
  });
});
