# Pixelizer (Experimental)

A high-fidelity tool designed to convert messy, mixel-heavy, or AI-generated pixel art into clean, grid-aligned, authentic 1:1 pixel art.

![Pixelizer Preview](ada_quill.png)

## Features

- **Elastic Grid Fitting**: Uses autocorrelation and dynamic programming line-fitting to detect true grid boundaries, even with floating or non-uniform AI pixel sizes.
- **Center-Weighted Sub-pixel Snapping**: Eliminates mixels, color bleeds, and bilinear blur by intelligently sampling cell centers with dark ink edge prioritization.
- **OKLab Perceptual Quantization**: Reduces bloated gradients into cohesive pixel palettes with extreme color preservation and frequency dampening.
- **Automated Outline & Gap Healing**:
  - Orphan pixel pruning
  - Pinhole cavity filling
  - Boundary smoothing
  - Intelligent ink-validated gap bridging (heals broken chins, facial contours, and line gaps without over-thickening)
- **Background Removal**: Border-connected flood fill in perceptual color space for instant sprite transparency.
- **10-Candidate Variation Generator**: Automatically generates 10 tailored stylistic variations (strict outlines, anime cel-shading, retro game palettes, ultra-compact) in a single click.
- **Side-by-Side Interactive Viewer**: Zoom, pan, inspect split before/after slider, toggle grid overlay, and highlight corrected pixels.
- **Batch Export**: Export the selected candidate or package all 10 candidates into a single ZIP.

## Tech Stack

- **TypeScript** & **Vite**
- **Web Workers** for background non-blocking image processing
- **JSZip** for client-side archive generation
- **Vitest** for algorithmic test coverage

## Getting Started

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open your browser at `http://localhost:5173`.

### Testing

```bash
npm run test
```

### Production Build

```bash
npm run build
```

## License

MIT
