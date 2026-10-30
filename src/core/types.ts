export interface PixelBuffer {
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA 0-255 length = w * h * 4
}

export interface Grid {
  pitchX: number;
  pitchY: number;
  offX: number;
  offY: number;
  cols: number;
  rows: number;
  confidence: number;
  xLines?: number[];
  yLines?: number[];
}

export type GridMode = 'auto' | 32 | 64;

export interface ColorRGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorRGBA extends ColorRGB {
  a: number;
}

export interface ColorLab {
  L: number;
  a: number;
  b: number;
}

export interface MixelReport {
  mixelRatio: number;
  mixelMask: Uint8Array;
  totalCells?: number;
  mixelCount?: number;
}

export interface PipelineOptions {
  gridMode: GridMode;
  manualCols?: number;
  manualRows?: number;
  pitchNudge?: number; // small scale adjust %
  offXNudge?: number;
  offYNudge?: number;
  
  bgTolerance: number; // 0.0 - 1.0 (OKLab distance)
  bgRemoveIslands: boolean;
  
  fixOutline: boolean;
  outlineMode: 'inside' | 'outside' | 'clean_only';
  outlineColor: 'auto' | string; // hex
  
  targetColors: number; // e.g. 16
  keepExtremes: boolean;
  
  lineworkBoost?: number; // e.g. 1.0 - 2.0 (boost dark feature detection)
  connectDiagonals?: boolean; // bridge near-adjacent disconnected linework / glasses
  bridgeGaps?: boolean; // bridge 1-2px broken contour line gaps (e.g. chin line)
}

export interface CandidateVariation {
  id: number;
  name: string;
  tag: string;
  description: string;
  options: PipelineOptions;
  result: PipelineResult;
}

export interface PipelineResult {
  source: PixelBuffer;
  grid: Grid;
  snapped: PixelBuffer;
  mixelReport: MixelReport;
  bgRemoved: PixelBuffer;
  outlineFixed: PixelBuffer;
  changedPixels: Array<{ x: number; y: number }>;
  quantized: PixelBuffer;
  palette: ColorRGBA[];
  originalColorCount: number;
  processingTimeMs?: number;
  variations?: CandidateVariation[];
}
