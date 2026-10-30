import { describe, it, expect } from 'vitest';
import { runPipeline } from '../core/pipeline';
import { PipelineOptions, PixelBuffer } from '../core/types';

function createSyntheticSprite(w: number, h: number): PixelBuffer {
  const buf: PixelBuffer = {
    w,
    h,
    data: new Uint8ClampedArray(w * h * 4)
  };

  // Background is white
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = 255;
    buf.data[i + 1] = 255;
    buf.data[i + 2] = 255;
    buf.data[i + 3] = 255;
  }

  // Draw 10x10 colored box in center
  for (let y = 10; y < 20; y++) {
    for (let x = 10; x < 20; x++) {
      const idx = (y * w + x) * 4;
      // Dark outline
      if (x === 10 || x === 19 || y === 10 || y === 19) {
        buf.data[idx] = 10;
        buf.data[idx + 1] = 10;
        buf.data[idx + 2] = 10;
      } else {
        // Red fill
        buf.data[idx] = 220;
        buf.data[idx + 1] = 30;
        buf.data[idx + 2] = 30;
      }
    }
  }

  return buf;
}

describe('Full Pipeline Integration', () => {
  it('runs the end-to-end pipeline and emits progress', () => {
    const source = createSyntheticSprite(32, 32);
    const options: PipelineOptions = {
      gridMode: 32,
      bgTolerance: 0.15,
      bgRemoveIslands: false,
      fixOutline: true,
      outlineMode: 'inside',
      outlineColor: 'auto',
      targetColors: 4,
      keepExtremes: true
    };

    const progressReports: Array<{ stage: string; progress: number }> = [];
    const result = runPipeline(source, options, (stage, progress) => {
      progressReports.push({ stage, progress });
    });

    // Check all pipeline outputs
    expect(result.source).toBe(source);
    expect(result.grid).toBeDefined();
    expect(result.grid.cols).toBe(32);
    expect(result.grid.rows).toBe(32);
    expect(result.mixelReport).toBeDefined();
    expect(result.snapped).toBeDefined();
    expect(result.bgRemoved).toBeDefined();
    expect(result.outlineFixed).toBeDefined();
    expect(result.quantized).toBeDefined();
    expect(result.palette.length).toBeLessThanOrEqual(4);
    expect(result.originalColorCount).toBeGreaterThan(0);

    // Verify progress callbacks
    expect(progressReports.length).toBeGreaterThanOrEqual(5);
    expect(progressReports[progressReports.length - 1].stage).toBe('done');
    expect(progressReports[progressReports.length - 1].progress).toBe(100);
  });
});
