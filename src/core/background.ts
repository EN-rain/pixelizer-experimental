import { PixelBuffer } from './types';
import { rgbToOklab, oklabDistance } from './color';

/**
 * Removes background using flood-fill from border pixels based on OKLab color distance.
 * Preserves internal foreground areas even if they share similar colors to the background.
 */
export function removeBackground(
  buf: PixelBuffer,
  tolerance = 0.12, // OKLab distance threshold
  removeIslands = false
): PixelBuffer {
  const { w, h } = buf;
  const data = new Uint8ClampedArray(buf.data);

  // If already predominantly transparent, check if we even need flood fill
  let initialTransparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) initialTransparent++;
  }
  if (initialTransparent > (w * h) * 0.3) {
    return { w, h, data };
  }

  // Sample border colors to find predominant background color
  const borderColors: { r: number; g: number; b: number }[] = [];
  const addPixel = (x: number, y: number) => {
    const idx = (y * w + x) * 4;
    borderColors.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
  };

  for (let x = 0; x < w; x++) {
    addPixel(x, 0);
    addPixel(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    addPixel(0, y);
    addPixel(w - 1, y);
  }

  // Average border color in OKLab
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  for (const c of borderColors) {
    const lab = rgbToOklab(c);
    sumL += lab.L;
    sumA += lab.a;
    sumB += lab.b;
  }
  const bgLab = {
    L: sumL / borderColors.length,
    a: sumA / borderColors.length,
    b: sumB / borderColors.length
  };

  // Visited / transparent mask
  const isBg = new Uint8Array(w * h);
  const queue: number[] = [];

  const checkAndEnqueue = (x: number, y: number) => {
    const idx = y * w + x;
    if (isBg[idx]) return;

    const pIdx = idx * 4;
    const pLab = rgbToOklab({ r: data[pIdx], g: data[pIdx + 1], b: data[pIdx + 2] });
    const dist = oklabDistance(bgLab, pLab);

    if (dist <= tolerance) {
      isBg[idx] = 1;
      queue.push(idx);
    }
  };

  // Seed with borders
  for (let x = 0; x < w; x++) {
    checkAndEnqueue(x, 0);
    checkAndEnqueue(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    checkAndEnqueue(0, y);
    checkAndEnqueue(w - 1, y);
  }

  // BFS Flood Fill
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    const cx = curr % w;
    const cy = Math.floor(curr / w);

    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1]
    ];

    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        checkAndEnqueue(nx, ny);
      }
    }
  }

  // Apply transparency to background pixels
  for (let i = 0; i < w * h; i++) {
    if (isBg[i]) {
      const pIdx = i * 4;
      data[pIdx] = 0;
      data[pIdx + 1] = 0;
      data[pIdx + 2] = 0;
      data[pIdx + 3] = 0;
    }
  }

  // Optional: remove isolated enclosed background holes
  if (removeIslands) {
    // If user explicitly asks to remove islands/holes that match bgLab
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!isBg[idx]) {
          const pIdx = idx * 4;
          const pLab = rgbToOklab({ r: data[pIdx], g: data[pIdx + 1], b: data[pIdx + 2] });
          if (oklabDistance(bgLab, pLab) <= tolerance * 0.7) {
            data[pIdx + 3] = 0;
          }
        }
      }
    }
  }

  return { w, h, data };
}
