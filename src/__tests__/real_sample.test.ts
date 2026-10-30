import { describe, it, expect } from 'vitest';
import { runPipeline } from '../core/pipeline';
import { execSync } from 'child_process';
import { readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Real GPT Image ada_quill.png End-to-End', () => {
  it('processes ada_quill.png correctly', () => {
    if (!existsSync('ada_quill.png')) {
      console.warn('ada_quill.png not found, skipping');
      return;
    }
    const rawPath = join(tmpdir(), 'pixeltool_ada_raw.bin');
    execSync(`python -c "from PIL import Image; im=Image.open('ada_quill.png').convert('RGBA'); open(r'${rawPath}', 'wb').write(im.tobytes())"`);
    const rawBytes = readFileSync(rawPath);
    rmSync(rawPath, { force: true });
    const source = {
      w: 1254,
      h: 1254,
      data: new Uint8ClampedArray(rawBytes.buffer, rawBytes.byteOffset, rawBytes.length)
    };

    const res = runPipeline(source, {
      gridMode: 'auto',
      bgTolerance: 0.12,
      bgRemoveIslands: false,
      fixOutline: true,
      outlineMode: 'inside',
      outlineColor: 'auto',
      targetColors: 16,
      keepExtremes: true
    });

    console.log(`Detected Grid: ${res.grid.cols}x${res.grid.rows}, Pitch: ${res.grid.pitchX.toFixed(2)}x${res.grid.pitchY.toFixed(2)}`);
    console.log(`Original unique colors: ${res.originalColorCount}, Result palette size: ${res.palette.length}`);
    console.log(`Mixels ratio: ${res.mixelReport.mixelRatio.toFixed(1)}%`);

    expect(res.grid.cols).toBeGreaterThanOrEqual(60);
    expect(res.grid.cols).toBeLessThanOrEqual(68);
    expect(res.palette.length).toBeLessThanOrEqual(16);
    expect(res.originalColorCount).toBeGreaterThan(100);

    // Verify corners are transparent (background removed)
    const corners = [
      0, // top-left
      (res.quantized.w - 1) * 4, // top-right
      ((res.quantized.h - 1) * res.quantized.w) * 4, // bottom-left
      ((res.quantized.h - 1) * res.quantized.w + (res.quantized.w - 1)) * 4 // bottom-right
    ];
    for (const c of corners) {
      expect(res.quantized.data[c + 3]).toBe(0);
    }
  });
});
