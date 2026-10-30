import { PixelBuffer, Grid, GridMode } from './types';

interface AxisDetection {
  pitch: number;
  offset: number;
  confidence: number;
}

// Compute differential profile along an axis
function computeProfile(buf: PixelBuffer, axis: 'x' | 'y'): Float64Array {
  const { w, h, data } = buf;
  const length = axis === 'x' ? w - 1 : h - 1;
  const profile = new Float64Array(length);

  if (axis === 'x') {
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w * 4;
      for (let x = 0; x < w - 1; x++) {
        const i1 = rowOffset + x * 4;
        const i2 = i1 + 4;
        if (data[i1 + 3] < 16 && data[i2 + 3] < 16) continue;
        const dr = Math.abs(data[i1] - data[i2]);
        const dg = Math.abs(data[i1 + 1] - data[i2 + 1]);
        const db = Math.abs(data[i1 + 2] - data[i2 + 2]);
        profile[x] += dr + dg + db;
      }
    }
  } else {
    for (let y = 0; y < h - 1; y++) {
      const row1 = y * w * 4;
      const row2 = (y + 1) * w * 4;
      for (let x = 0; x < w; x++) {
        const i1 = row1 + x * 4;
        const i2 = row2 + x * 4;
        if (data[i1 + 3] < 16 && data[i2 + 3] < 16) continue;
        const dr = Math.abs(data[i1] - data[i2]);
        const dg = Math.abs(data[i1 + 1] - data[i2 + 1]);
        const db = Math.abs(data[i1 + 2] - data[i2 + 2]);
        profile[y] += dr + dg + db;
      }
    }
  }

  return profile;
}

// Autocorrelation to estimate candidate periods
function findCandidatePitches(profile: Float64Array, minPitch = 6, maxPitch = 80): number[] {
  const n = profile.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;

  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) centered[i] = profile[i] - mean;

  const ac = new Float64Array(maxPitch + 1);
  for (let lag = minPitch; lag <= maxPitch; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += centered[i] * centered[i + lag];
    }
    ac[lag] = sum / (n - lag);
  }

  const peaks: { pitch: number; score: number }[] = [];
  for (let lag = minPitch + 1; lag < maxPitch; lag++) {
    if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > 0) {
      peaks.push({ pitch: lag, score: ac[lag] });
    }
  }

  peaks.sort((a, b) => b.score - a.score);
  return peaks.map(p => p.pitch);
}

// Evaluate grid quality given pitch and offset
function evaluateGrid(profile: Float64Array, pitch: number, offset: number): number {
  const n = profile.length;
  let edgeEnergy = 0;
  let edgeCount = 0;
  let centerEnergy = 0;
  let centerCount = 0;

  for (let pos = offset; pos < n; pos += pitch) {
    const idx = Math.round(pos);
    if (idx >= 0 && idx < n) {
      const w0 = Math.max(0, idx - 1);
      const w1 = Math.min(n - 1, idx + 1);
      let localMax = 0;
      for (let k = w0; k <= w1; k++) {
        if (profile[k] > localMax) localMax = profile[k];
      }
      edgeEnergy += localMax;
      edgeCount++;
    }

    const centerIdx = Math.round(pos + pitch * 0.5);
    if (centerIdx >= 0 && centerIdx < n) {
      centerEnergy += profile[centerIdx];
      centerCount++;
    }
  }

  if (edgeCount === 0 || centerCount === 0) return 0;
  const avgEdge = edgeEnergy / edgeCount;
  const avgCenter = centerEnergy / centerCount;
  return avgEdge / (avgCenter + 1e-4);
}

// Refine pitch and find best offset
function optimizeAxis(
  profile: Float64Array,
  initialPitch: number,
  pitchSearchRadius = 1.5,
  pitchStep = 0.02
): AxisDetection {
  let bestScore = -1;
  let bestPitch = initialPitch;
  let bestOffset = 0;

  const minP = Math.max(4, initialPitch - pitchSearchRadius);
  const maxP = initialPitch + pitchSearchRadius;

  for (let p = minP; p <= maxP; p += pitchStep) {
    const offsetStep = Math.max(0.25, p / 40);
    for (let off = 0; off < p; off += offsetStep) {
      const score = evaluateGrid(profile, p, off);
      if (score > bestScore) {
        bestScore = score;
        bestPitch = p;
        bestOffset = off;
      }
    }
  }

  return {
    pitch: bestPitch,
    offset: bestOffset,
    confidence: bestScore
  };
}

// Helper to find fundamental pitch by identifying candidate with harmonics
function findBestFundamentalPitch(cand: number[]): number {
  if (cand.length === 0) return 20;
  const sorted = [...cand].sort((a, b) => a - b);
  for (const c of sorted) {
    const hasHarmonic = cand.some(other =>
      (Math.abs(other - 2 * c) <= 2) ||
      (Math.abs(other - 3 * c) <= 2) ||
      (Math.abs(other - 4 * c) <= 2)
    );
    if (hasHarmonic) {
      return c;
    }
  }
  return cand[0];
}

/**
 * Fits elastic grid lines via Dynamic Programming so that each cell boundary
 * snaps to the local edge peak while maintaining near-uniform spacing around `pitch`.
 * This corrects the non-uniform 18..21px block drift in AI-generated pixel art.
 */
function fitElasticLines(
  profile: Float64Array,
  pitch: number,
  offset: number,
  cellCount: number,
  maxCoord: number
): number[] {
  const K = cellCount + 1;
  if (K <= 1 || pitch < 5) {
    const fallback: number[] = [];
    for (let k = 0; k < K; k++) {
      fallback.push(Math.max(0, Math.min(maxCoord, Math.round(offset + k * pitch))));
    }
    return fallback;
  }

  const n = profile.length;
  let sumPos = 0;
  let cntPos = 0;
  for (let i = 0; i < n; i++) {
    if (profile[i] > 0) {
      sumPos += profile[i];
      cntPos++;
    }
  }
  const meanE = cntPos > 0 ? sumPos / cntPos : 1;
  if (cntPos === 0 || meanE < 1e-3) {
    const uniform: number[] = [];
    for (let k = 0; k < K; k++) {
      uniform.push(Math.max(0, Math.min(maxCoord, Math.round(offset + k * pitch))));
    }
    return uniform;
  }

  const normP = new Float64Array(n);
  for (let i = 0; i < n; i++) normP[i] = profile[i] / meanE;

  // Search radius around nominal position: allow cumulative drift up to 65% of pitch (max 14px)
  const R = Math.min(14, Math.max(2, Math.round(pitch * 0.65)));
  const numStates = 2 * R + 1;

  const cands: number[][] = new Array(K);
  for (let k = 0; k < K; k++) {
    const nom = Math.round(offset + k * pitch);
    const row: number[] = new Array(numStates);
    for (let s = 0; s < numStates; s++) {
      const d = s - R;
      row[s] = Math.max(0, Math.min(maxCoord, nom + d));
    }
    cands[k] = row;
  }

  const dp = new Float64Array(K * numStates);
  dp.fill(-1e18);
  const parent = new Int32Array(K * numStates);

  for (let s = 0; s < numStates; s++) {
    const x = cands[0][s];
    const edge = x < n ? normP[x] : 0;
    const dist = x - offset;
    dp[s] = edge - 0.08 * dist * dist;
  }

  const minStep = Math.max(2, Math.floor(pitch * 0.72));
  const maxStep = Math.ceil(pitch * 1.28);

  for (let k = 1; k < K; k++) {
    const curCands = cands[k];
    const prevCands = cands[k - 1];
    const rowOff = k * numStates;
    const prevOff = (k - 1) * numStates;

    for (let i = 0; i < numStates; i++) {
      const x = curCands[i];
      let edgeScore = 0;
      if (x >= 0 && x < n) {
        const w0 = Math.max(0, x - 1);
        const w1 = Math.min(n - 1, x + 1);
        edgeScore = Math.max(normP[x], 0.85 * normP[w0], 0.85 * normP[w1]);
      }

      let bestVal = -1e18;
      let bestJ = 0;
      for (let j = 0; j < numStates; j++) {
        const prevX = prevCands[j];
        const step = x - prevX;
        if (step < minStep || step > maxStep) continue;
        const diff = step - pitch;
        const spring = -0.35 * diff * diff;
        const val = dp[prevOff + j] + edgeScore + spring;
        if (val > bestVal) {
          bestVal = val;
          bestJ = j;
        }
      }
      dp[rowOff + i] = bestVal;
      parent[rowOff + i] = bestJ;
    }
  }

  let bestLast = 0;
  let bestLastVal = -1e18;
  const lastOff = (K - 1) * numStates;
  for (let i = 0; i < numStates; i++) {
    if (dp[lastOff + i] > bestLastVal) {
      bestLastVal = dp[lastOff + i];
      bestLast = i;
    }
  }

  const lines = new Array<number>(K);
  let cur = bestLast;
  for (let k = K - 1; k >= 0; k--) {
    lines[k] = cands[k][cur];
    cur = parent[k * numStates + cur];
  }

  // Ensure strictly monotonic boundaries
  for (let k = 1; k < K; k++) {
    if (lines[k] <= lines[k - 1]) {
      lines[k] = Math.min(maxCoord, lines[k - 1] + 1);
    }
  }

  return lines;
}

export function detectGrid(
  buf: PixelBuffer,
  mode: GridMode = 'auto',
  nudges?: { pitchNudge?: number; offXNudge?: number; offYNudge?: number }
): Grid {
  const profileX = computeProfile(buf, 'x');
  const profileY = computeProfile(buf, 'y');

  let optX: AxisDetection;
  let optY: AxisDetection;

  if (mode === 'auto') {
    const candX = findCandidatePitches(profileX);
    const candY = findCandidatePitches(profileY);

    const bestX = findBestFundamentalPitch(candX);
    const bestY = findBestFundamentalPitch(candY);

    const avgCandidate = (bestX + bestY) / 2;
    optX = optimizeAxis(profileX, avgCandidate, 2.0, 0.02);
    optY = optimizeAxis(profileY, avgCandidate, 2.0, 0.02);
  } else {
    const maxDim = Math.max(buf.w, buf.h);
    const targetPitch = maxDim / mode;
    optX = optimizeAxis(profileX, targetPitch, 0.5, 0.02);
    optY = optimizeAxis(profileY, targetPitch, 0.5, 0.02);
  }

  let pitchX = optX.pitch;
  let pitchY = optY.pitch;
  if (nudges?.pitchNudge) {
    const factor = 1 + nudges.pitchNudge / 100;
    pitchX *= factor;
    pitchY *= factor;
  }

  let offX = optX.offset + (nudges?.offXNudge || 0);
  let offY = optY.offset + (nudges?.offYNudge || 0);

  offX = ((offX % pitchX) + pitchX) % pitchX;
  if (offX > pitchX * 0.75) offX -= pitchX;

  offY = ((offY % pitchY) + pitchY) % pitchY;
  if (offY > pitchY * 0.75) offY -= pitchY;

  const cols = typeof mode === 'number'
    ? (buf.w >= buf.h ? mode : Math.max(1, Math.round((buf.w - offX) / pitchX)))
    : Math.max(1, Math.round((buf.w - offX) / pitchX));
  const rows = typeof mode === 'number'
    ? (buf.h >= buf.w ? mode : Math.max(1, Math.round((buf.h - offY) / pitchY)))
    : Math.max(1, Math.round((buf.h - offY) / pitchY));

  const xLines = fitElasticLines(profileX, pitchX, offX, cols, buf.w);
  const yLines = fitElasticLines(profileY, pitchY, offY, rows, buf.h);

  return {
    pitchX,
    pitchY,
    offX,
    offY,
    cols,
    rows,
    confidence: (optX.confidence + optY.confidence) / 2,
    xLines,
    yLines
  };
}
