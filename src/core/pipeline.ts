import { PixelBuffer, PipelineOptions, PipelineResult, Grid, CandidateVariation } from './types';
import { detectGrid } from './grid';
import { snapToGrid } from './snap';
import { removeBackground } from './background';
import { fixOutline } from './outline';
import { quantizeColors } from './quantize';

export const DEFAULT_OPTIONS: PipelineOptions = {
  gridMode: 'auto',
  pitchNudge: 0,
  offXNudge: 0,
  offYNudge: 0,
  bgTolerance: 0.12,
  bgRemoveIslands: false,
  fixOutline: true,
  outlineMode: 'inside',
  outlineColor: 'auto',
  targetColors: 16,
  keepExtremes: true,
  lineworkBoost: 1.35,
  connectDiagonals: true,
  bridgeGaps: true
};

export type ProgressCallback = (stage: string, progress: number) => void;

/**
 * Coordinates all pixel art conversion stages:
 * 1. detectGrid: finds pixel dimensions and grid alignment
 * 2. snapToGrid: samples cells with center-weighting & linework boost
 * 3. removeBackground: flood fills background from outer borders
 * 4. fixOutline: cleans orphan dust, fills pinholes, reinforces & bridges outlines
 * 5. quantizeColors: clusters colors into optimal palette in OKLab space
 */
export function runPipeline(
  source: PixelBuffer,
  options: Partial<PipelineOptions> = {},
  onProgress?: ProgressCallback
): PipelineResult {
  const opts: PipelineOptions = { ...DEFAULT_OPTIONS, ...options };

  // 1. Grid detection
  onProgress?.('detect_grid', 15);
  const detectedGrid = detectGrid(source, opts.gridMode, {
    pitchNudge: opts.pitchNudge,
    offXNudge: opts.offXNudge,
    offYNudge: opts.offYNudge
  });

  const grid: Grid = {
    ...detectedGrid,
    cols: opts.manualCols ?? detectedGrid.cols,
    rows: opts.manualRows ?? detectedGrid.rows
  };

  // 2. Snap & Mixel detection
  onProgress?.('snap_to_grid', 35);
  const snapResult = snapToGrid(source, grid, opts.lineworkBoost ?? 1.35);
  const snapped = snapResult.snapped;
  const mixelReport = snapResult.mixelReport;

  // 3. Background removal
  onProgress?.('remove_background', 55);
  let bgRemoved: PixelBuffer;
  if (opts.bgTolerance > 0) {
    bgRemoved = removeBackground(snapped, opts.bgTolerance, opts.bgRemoveIslands);
  } else {
    bgRemoved = { w: snapped.w, h: snapped.h, data: new Uint8ClampedArray(snapped.data) };
  }

  // 4. Outline fix & Linework gap bridging
  onProgress?.('fix_outline', 75);
  let outlineFixed: PixelBuffer;
  let changedPixels: Array<{ x: number; y: number }> = [];

  if (opts.fixOutline) {
    const outlineRes = fixOutline(bgRemoved, opts.outlineMode, opts.outlineColor, opts.connectDiagonals ?? true, snapResult.darkCoverage, opts.bridgeGaps ?? true);
    outlineFixed = outlineRes.buffer;
    changedPixels = outlineRes.changedPixels;
  } else {
    outlineFixed = { w: bgRemoved.w, h: bgRemoved.h, data: new Uint8ClampedArray(bgRemoved.data) };
  }

  // 5. Color quantization
  onProgress?.('quantize', 90);
  const quantRes = quantizeColors(outlineFixed, {
    targetColors: opts.targetColors,
    keepExtremes: opts.keepExtremes
  });

  onProgress?.('done', 100);

  return {
    source,
    grid,
    mixelReport,
    snapped,
    bgRemoved,
    outlineFixed,
    changedPixels,
    quantized: quantRes.quantized,
    originalColorCount: quantRes.originalColorCount,
    palette: quantRes.palette
  };
}

/**
 * Generates up to 10 automated tuning variations through the full pipeline.
 * Each variation exercises different sub-pixel alignments, linework weights,
 * diagonal connectivity, and palette sizes so users can pick the cleanest output.
 */
export function generateVariations(
  source: PixelBuffer,
  baseOptions: Partial<PipelineOptions> = {},
  maxCount = 10
): CandidateVariation[] {
  const base: PipelineOptions = { ...DEFAULT_OPTIONS, ...baseOptions };

  const presets: Array<{ name: string; tag: string; description: string; delta: Partial<PipelineOptions> }> = [
    {
      name: 'Balanced',
      tag: 'Default',
      description: 'Auto elastic grid with balanced linework and 16-color OKLab palette.',
      delta: {}
    },
    {
      name: 'Sharp Linework',
      tag: 'Glasses & Eyes',
      description: 'Boosted linework weight (1.7x) + diagonal bridging for thin frames.',
      delta: { lineworkBoost: 1.7, connectDiagonals: true }
    },
    {
      name: 'Shift Fine +X',
      tag: 'Right Alignment',
      description: 'Sub-pixel +0.25 pitch horizontal shift to catch left-shifted contours.',
      delta: { offXNudge: (base.offXNudge || 0) + 1.2 }
    },
    {
      name: 'Shift Fine -X',
      tag: 'Left Alignment',
      description: 'Sub-pixel -0.25 pitch horizontal shift to catch right-shifted contours.',
      delta: { offXNudge: (base.offXNudge || 0) - 1.2 }
    },
    {
      name: 'Shift Fine +Y',
      tag: 'Down Alignment',
      description: 'Sub-pixel +0.25 pitch vertical shift for horizontal line alignment.',
      delta: { offYNudge: (base.offYNudge || 0) + 1.2 }
    },
    {
      name: 'Shift Fine -Y',
      tag: 'Up Alignment',
      description: 'Sub-pixel -0.25 pitch vertical shift for eyebrow/glasses horizontal bars.',
      delta: { offYNudge: (base.offYNudge || 0) - 1.2 }
    },
    {
      name: 'High Contrast',
      tag: 'Bold Silhouettes',
      description: 'Strong outline reinforcement with maximum extreme colors preservation.',
      delta: { lineworkBoost: 1.85, outlineMode: 'inside', keepExtremes: true }
    },
    {
      name: 'Vibrant 24 Colors',
      tag: 'Rich Shading',
      description: '24-color palette preserving delicate eye, blush, and hair gradations.',
      delta: { targetColors: 24, lineworkBoost: 1.4 }
    },
    {
      name: 'High-Fidelity 32 Colors',
      tag: 'Full Spectrum',
      description: '32-color palette maintaining maximum original generator color fidelity.',
      delta: { targetColors: 32 }
    },
    {
      name: 'Retro 12 Colors',
      tag: 'Strict Minimal',
      description: 'Compact 12-color palette for classic GameBoy / Genesis aesthetic.',
      delta: { targetColors: 12, lineworkBoost: 1.5 }
    }
  ];

  const count = Math.min(maxCount, presets.length);
  const variations: CandidateVariation[] = [];

  for (let i = 0; i < count; i++) {
    const p = presets[i];
    const opts: PipelineOptions = { ...base, ...p.delta };
    const res = runPipeline(source, opts);
    variations.push({
      id: i + 1,
      name: p.name,
      tag: p.tag,
      description: p.description,
      options: opts,
      result: res
    });
  }

  return variations;
}
