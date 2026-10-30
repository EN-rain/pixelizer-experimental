import { PixelBuffer, Grid, MixelReport, ColorRGBA } from '../core/types';

export type ViewerStep = 'mixels' | 'grid' | 'background' | 'outline' | 'colors' | 'export';
export type ExportBackdrop = 'checkerboard' | 'dark' | 'light' | 'scene';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  onZoomChange?: (zoom: number) => void;
  onSplitChange?: (splitRatio: number) => void;
}

export class PixelViewer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private options: ViewerOptions;

  // Viewport transform
  public zoom = 1.0;
  public panX = 0;
  public panY = 0;

  // Active step
  public currentStep: ViewerStep = 'mixels';

  // Overlays & Toggles
  public splitRatio = 0.5; // 0.0 to 1.0
  public showHeatmap = true;
  public showOutlineHighlights = true;
  public showGridLines = true;
  public exportBackdrop: ExportBackdrop = 'checkerboard';

  // Data
  private sourceBuf: PixelBuffer | null = null;
  private snappedBuf: PixelBuffer | null = null;
  private bgRemovedBuf: PixelBuffer | null = null;
  private outlineFixedBuf: PixelBuffer | null = null;
  private quantizedBuf: PixelBuffer | null = null;
  private grid: Grid | null = null;
  private mixelReport: MixelReport | null = null;
  private changedPixels: Array<{ x: number; y: number }> = [];
  public palette: ColorRGBA[] = [];

  // Cached canvas textures
  private sourceCanvas: HTMLCanvasElement | null = null;
  private snappedCanvas: HTMLCanvasElement | null = null;
  private bgRemovedCanvas: HTMLCanvasElement | null = null;
  private outlineFixedCanvas: HTMLCanvasElement | null = null;
  private quantizedCanvas: HTMLCanvasElement | null = null;
  private heatmapCanvas: HTMLCanvasElement | null = null;
  private highlightsCanvas: HTMLCanvasElement | null = null;

  // Mouse / Pointer Interaction
  private isPanning = false;
  private isDraggingSplit = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startPanX = 0;
  private startPanY = 0;
  private isHoveringSplit = false;

  // Resize handling
  private resizeObserver: ResizeObserver;
  private dpr = window.devicePixelRatio || 1;

  constructor(options: ViewerOptions) {
    this.options = options;
    this.canvas = options.canvas;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not get 2D canvas context');
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.canvas.parentElement || document.body);

    this.bindEvents();
    this.handleResize();
  }

  public setStep(step: ViewerStep): void {
    const wasHighRes = this.currentStep === 'mixels' || this.currentStep === 'grid';
    const isHighRes = step === 'mixels' || step === 'grid';
    this.currentStep = step;
    if (wasHighRes !== isHighRes) {
      this.fitToScreen();
    } else {
      this.render();
    }
  }

  public setData(data: {
    source: PixelBuffer;
    grid: Grid;
    mixelReport: MixelReport;
    snapped: PixelBuffer;
    bgRemoved: PixelBuffer;
    outlineFixed: PixelBuffer;
    changedPixels: Array<{ x: number; y: number }>;
    quantized: PixelBuffer;
    palette: ColorRGBA[];
  }): void {
    this.sourceBuf = data.source;
    this.grid = data.grid;
    this.mixelReport = data.mixelReport;
    this.snappedBuf = data.snapped;
    this.bgRemovedBuf = data.bgRemoved;
    this.outlineFixedBuf = data.outlineFixed;
    this.changedPixels = data.changedPixels;
    this.quantizedBuf = data.quantized;
    this.palette = data.palette;

    // Build cached canvases
    this.sourceCanvas = this.createCanvasFromBuffer(data.source);
    this.snappedCanvas = this.createCanvasFromBuffer(data.snapped);
    this.bgRemovedCanvas = this.createCanvasFromBuffer(data.bgRemoved);
    this.outlineFixedCanvas = this.createCanvasFromBuffer(data.outlineFixed);
    this.quantizedCanvas = this.createCanvasFromBuffer(data.quantized);

    // Build Heatmap texture
    this.buildHeatmapTexture();

    // Build Outline highlights texture
    this.buildHighlightsTexture();

    this.render();
  }

  private createCanvasFromBuffer(buf: PixelBuffer): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = buf.w;
    c.height = buf.h;
    const ctx = c.getContext('2d')!;
    const imgData = new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h);
    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  private buildHeatmapTexture(): void {
    if (!this.grid || !this.mixelReport) return;
    const { cols, rows } = this.grid;
    const c = document.createElement('canvas');
    c.width = cols;
    c.height = rows;
    const ctx = c.getContext('2d')!;
    const imgData = ctx.createImageData(cols, rows);

    for (let i = 0; i < cols * rows; i++) {
      const idx = i * 4;
      if (this.mixelReport.mixelMask[i] === 1) {
        // Red glowing heatmap
        imgData.data[idx] = 255;
        imgData.data[idx + 1] = 40;
        imgData.data[idx + 2] = 40;
        imgData.data[idx + 3] = 160;
      } else {
        imgData.data[idx + 3] = 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    this.heatmapCanvas = c;
  }

  private buildHighlightsTexture(): void {
    if (!this.outlineFixedBuf) return;
    const { w, h } = this.outlineFixedBuf;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const imgData = ctx.createImageData(w, h);

    for (const p of this.changedPixels) {
      if (p.x >= 0 && p.x < w && p.y >= 0 && p.y < h) {
        const idx = (p.y * w + p.x) * 4;
        // Electric blue highlight matching video (#00d2ff)
        imgData.data[idx] = 0;
        imgData.data[idx + 1] = 210;
        imgData.data[idx + 2] = 255;
        imgData.data[idx + 3] = 240;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    this.highlightsCanvas = c;
  }

  public fitToScreen(): void {
    if (!this.sourceBuf && !this.snappedBuf) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    const baseW = this.currentStep === 'mixels' || this.currentStep === 'grid'
      ? (this.sourceBuf?.w || 300)
      : (this.snappedBuf?.w || 32);

    const baseH = this.currentStep === 'mixels' || this.currentStep === 'grid'
      ? (this.sourceBuf?.h || 300)
      : (this.snappedBuf?.h || 32);

    // Leave 15% margin
    const scaleX = (w * 0.75) / baseW;
    const scaleY = (h * 0.75) / baseH;
    let targetZoom = Math.min(scaleX, scaleY);

    if (this.currentStep !== 'mixels' && this.currentStep !== 'grid') {
      // For low-res sprites, snap zoom to integer multiple if >= 1
      if (targetZoom >= 2) targetZoom = Math.floor(targetZoom);
    }

    this.zoom = Math.max(0.1, Math.min(targetZoom, 40));
    this.panX = (w - baseW * this.zoom) / 2;
    this.panY = (h - baseH * this.zoom) / 2;

    this.options.onZoomChange?.(this.zoom);
    this.render();
  }

  public resetZoom(): void {
    this.zoom = 1.0;
    const rect = this.canvas.getBoundingClientRect();
    const baseW = this.sourceBuf?.w || 300;
    const baseH = this.sourceBuf?.h || 300;
    this.panX = (rect.width - baseW * this.zoom) / 2;
    this.panY = (rect.height - baseH * this.zoom) / 2;
    this.options.onZoomChange?.(this.zoom);
    this.render();
  }

  public zoomIn(): void {
    this.applyZoom(this.zoom * 1.25, this.canvas.width / (2 * this.dpr), this.canvas.height / (2 * this.dpr));
  }

  public zoomOut(): void {
    this.applyZoom(this.zoom / 1.25, this.canvas.width / (2 * this.dpr), this.canvas.height / (2 * this.dpr));
  }

  private handleResize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * this.dpr);
    this.canvas.height = Math.floor(rect.height * this.dpr);
    this.render();
  }

  private bindEvents(): void {
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
    window.addEventListener('pointercancel', () => this.onPointerUp());
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    const nextZoom = Math.max(0.1, Math.min(this.zoom * factor, 64));
    this.applyZoom(nextZoom, mouseX, mouseY);
  }

  private applyZoom(nextZoom: number, anchorX: number, anchorY: number): void {
    const ratio = nextZoom / this.zoom;
    this.panX = anchorX - (anchorX - this.panX) * ratio;
    this.panY = anchorY - (anchorY - this.panY) * ratio;
    this.zoom = nextZoom;

    this.options.onZoomChange?.(this.zoom);
    this.render();
  }

  private onPointerDown(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    if (this.currentStep === 'mixels' && this.sourceBuf) {
      const splitScreenX = this.panX + this.sourceBuf.w * this.zoom * this.splitRatio;
      if (Math.abs(clientX - splitScreenX) < 14) {
        this.isDraggingSplit = true;
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    this.isPanning = true;
    this.startPointerX = clientX;
    this.startPointerY = clientY;
    this.startPanX = this.panX;
    this.startPanY = this.panY;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    if (this.isDraggingSplit && this.sourceBuf) {
      const imgW = this.sourceBuf.w * this.zoom;
      const relX = clientX - this.panX;
      this.splitRatio = Math.max(0.02, Math.min(0.98, relX / imgW));
      this.options.onSplitChange?.(this.splitRatio);
      this.render();
      return;
    }

    if (this.isPanning) {
      this.panX = this.startPanX + (clientX - this.startPointerX);
      this.panY = this.startPanY + (clientY - this.startPointerY);
      this.render();
      return;
    }

    // Check hover state for split slider
    if (this.currentStep === 'mixels' && this.sourceBuf) {
      const splitScreenX = this.panX + this.sourceBuf.w * this.zoom * this.splitRatio;
      const isNear = Math.abs(clientX - splitScreenX) < 14;
      if (isNear !== this.isHoveringSplit) {
        this.isHoveringSplit = isNear;
        if (isNear) {
          this.canvas.parentElement?.classList.add('slider-hover');
        } else {
          this.canvas.parentElement?.classList.remove('slider-hover');
        }
      }
    } else if (this.isHoveringSplit) {
      this.isHoveringSplit = false;
      this.canvas.parentElement?.classList.remove('slider-hover');
    }
  }

  private onPointerUp(): void {
    this.isPanning = false;
    this.isDraggingSplit = false;
  }

  /**
   * Main Render Loop
   */
  public render(): void {
    const { ctx, canvas, dpr } = this;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Draw Background
    this.drawBackground(width, height);

    // 2. Setup Viewport Transform
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Enforce sharp nearest-neighbor rendering for pixel art
    ctx.imageSmoothingEnabled = false;

    // 3. Render Step
    switch (this.currentStep) {
      case 'mixels':
        this.renderMixelsStep();
        break;
      case 'grid':
        this.renderGridStep();
        break;
      case 'background':
        this.renderBackgroundStep();
        break;
      case 'outline':
        this.renderOutlineStep();
        break;
      case 'colors':
        this.renderColorsStep();
        break;
      case 'export':
        this.renderExportStep();
        break;
    }

    ctx.restore();

    // 4. Draw screen-space overlays (like the split slider line)
    if (this.currentStep === 'mixels') {
      this.renderSplitSliderOverlay(height);
    }

    ctx.restore();
  }

  private drawBackground(w: number, h: number): void {
    const { ctx } = this;

    if (this.currentStep === 'export' && this.exportBackdrop === 'dark') {
      ctx.fillStyle = '#11131a';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    if (this.currentStep === 'export' && this.exportBackdrop === 'light') {
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    if (this.currentStep === 'export' && this.exportBackdrop === 'scene') {
      // Draw scenic sunset gradient matching the video scene!
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#2b3a4a');
      grad.addColorStop(0.4, '#8a5d52');
      grad.addColorStop(0.7, '#d68962');
      grad.addColorStop(1, '#2c3325');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Distant mountain silhouette
      ctx.fillStyle = 'rgba(65, 45, 55, 0.4)';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.7);
      ctx.lineTo(w * 0.35, h * 0.52);
      ctx.lineTo(w * 0.7, h * 0.68);
      ctx.lineTo(w, h * 0.58);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.fill();
      return;
    }

    // Default: dark studio workspace background
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, w, h);

    // Subtle grid pattern for workspace depth
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.lineWidth = 1;
    const spacing = 32;
    for (let x = 0; x < w; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += spacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  private drawCheckerboard(x: number, y: number, w: number, h: number, tileSize = 12): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const color1 = '#1a1f2c';
    const color2 = '#232a3b';

    for (let cy = y; cy < y + h; cy += tileSize) {
      for (let cx = x; cx < x + w; cx += tileSize) {
        const isEven = (Math.floor(cx / tileSize) + Math.floor(cy / tileSize)) % 2 === 0;
        ctx.fillStyle = isEven ? color1 : color2;
        ctx.fillRect(cx, cy, tileSize, tileSize);
      }
    }
    ctx.restore();
  }

  /**
   * Step 0: Mixels View
   * Split view between blurry AI input and clean snapped pixel art
   */
  private renderMixelsStep(): void {
    if (!this.sourceBuf || !this.sourceCanvas) return;
    const { ctx } = this;
    const { w, h } = this.sourceBuf;

    // Draw checkerboard behind
    this.drawCheckerboard(0, 0, w, h);

    // 1. Draw Left: Original AI image (clipped to splitRatio)
    const splitX = w * this.splitRatio;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, splitX, h);
    ctx.clip();
    // Use smoothed rendering for AI image to showcase original blurriness/mixels
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.sourceCanvas, 0, 0, w, h);
    ctx.restore();

    // 2. Draw Right: Snapped clean pixel art (scaled up from grid)
    if (this.snappedCanvas && this.grid) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, w - splitX, h);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      // Draw snapped low-res buffer scaled to fit source dimensions
      ctx.drawImage(this.snappedCanvas, 0, 0, w, h);
      ctx.restore();
    }

    // 3. Heatmap Overlay if enabled
    if (this.showHeatmap && this.heatmapCanvas) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, h); // Draw heatmap on the AI side
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.heatmapCanvas, 0, 0, w, h);
      ctx.restore();
    }

    // Draw boundary box
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeRect(0, 0, w, h);
  }

  /**
   * Screen-space Split Slider Divider
   */
  private renderSplitSliderOverlay(screenHeight: number): void {
    if (!this.sourceBuf) return;
    const { ctx } = this;
    const splitScreenX = this.panX + this.sourceBuf.w * this.zoom * this.splitRatio;

    // Divider line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(splitScreenX, 0);
    ctx.lineTo(splitScreenX, screenHeight);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center circular grip
    const centerY = screenHeight / 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(splitScreenX, centerY, 16, 0, Math.PI * 2);
    ctx.fill();

    // Inner knob icon ◀ ▶
    ctx.fillStyle = '#141824';
    ctx.beginPath();
    // Left arrow
    ctx.moveTo(splitScreenX - 8, centerY);
    ctx.lineTo(splitScreenX - 3, centerY - 5);
    ctx.lineTo(splitScreenX - 3, centerY + 5);
    // Right arrow
    ctx.moveTo(splitScreenX + 8, centerY);
    ctx.lineTo(splitScreenX + 3, centerY - 5);
    ctx.lineTo(splitScreenX + 3, centerY + 5);
    ctx.fill();
  }

  /**
   * Step 1: Pixel Grid View
   * High-res source or snapped image with aligned pixel grid lines
   */
  private renderGridStep(): void {
    if (!this.sourceBuf || !this.sourceCanvas || !this.grid) return;
    const { ctx } = this;
    const { w, h } = this.sourceBuf;
    const { pitchX, pitchY, offX, offY, cols, rows } = this.grid;

    this.drawCheckerboard(0, 0, w, h);

    // Draw Source Image
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.sourceCanvas, 0, 0, w, h);

    // Draw Grid Lines overlay
    if (this.showGridLines) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1 / this.zoom;

      const { xLines, yLines } = this.grid;

      // Vertical lines
      if (xLines && xLines.length === cols + 1) {
        const topY = yLines && yLines[0] !== undefined ? yLines[0] : offY;
        const botY = yLines && yLines[rows] !== undefined ? yLines[rows] : offY + rows * pitchY;
        for (let c = 0; c <= cols; c++) {
          const x = xLines[c];
          ctx.beginPath();
          ctx.moveTo(x, topY);
          ctx.lineTo(x, botY);
          ctx.stroke();
        }
      } else {
        for (let c = 0; c <= cols; c++) {
          const x = offX + c * pitchX;
          ctx.beginPath();
          ctx.moveTo(x, offY);
          ctx.lineTo(x, offY + rows * pitchY);
          ctx.stroke();
        }
      }

      // Horizontal lines
      if (yLines && yLines.length === rows + 1) {
        const leftX = xLines && xLines[0] !== undefined ? xLines[0] : offX;
        const rightX = xLines && xLines[cols] !== undefined ? xLines[cols] : offX + cols * pitchX;
        for (let r = 0; r <= rows; r++) {
          const y = yLines[r];
          ctx.beginPath();
          ctx.moveTo(leftX, y);
          ctx.lineTo(rightX, y);
          ctx.stroke();
        }
      } else {
        for (let r = 0; r <= rows; r++) {
          const y = offY + r * pitchY;
          ctx.beginPath();
          ctx.moveTo(offX, y);
          ctx.lineTo(offX + cols * pitchX, y);
          ctx.stroke();
        }
      }

      // Grid boundary in warm amber
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.8)';
      ctx.lineWidth = 2 / this.zoom;
      ctx.strokeRect(offX, offY, cols * pitchX, rows * pitchY);
    }
  }

  /**
   * Step 2: Background Removal View
   * Transparent checkerboard with background-removed sprite
   */
  private renderBackgroundStep(): void {
    if (!this.bgRemovedBuf || !this.bgRemovedCanvas) return;
    const { ctx } = this;
    const { w, h } = this.bgRemovedBuf;

    this.drawCheckerboard(0, 0, w, h, 2);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.bgRemovedCanvas, 0, 0, w, h);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeRect(0, 0, w, h);
  }

  /**
   * Step 3: Fix Outline View
   * Repaired sprite with bright electric blue highlights on modified pixels
   */
  private renderOutlineStep(): void {
    if (!this.outlineFixedBuf || !this.outlineFixedCanvas) return;
    const { ctx } = this;
    const { w, h } = this.outlineFixedBuf;

    this.drawCheckerboard(0, 0, w, h, 2);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.outlineFixedCanvas, 0, 0, w, h);

    // Draw bright blue highlights matching the video!
    if (this.showOutlineHighlights && this.highlightsCanvas) {
      ctx.drawImage(this.highlightsCanvas, 0, 0, w, h);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeRect(0, 0, w, h);
  }

  /**
   * Step 4: Colors View
   * Quantized sprite with color count comparison
   */
  private renderColorsStep(): void {
    if (!this.quantizedBuf || !this.quantizedCanvas) return;
    const { ctx } = this;
    const { w, h } = this.quantizedBuf;

    this.drawCheckerboard(0, 0, w, h, 2);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.quantizedCanvas, 0, 0, w, h);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeRect(0, 0, w, h);
  }

  /**
   * Step 5: Export View
   * Final production pixel art sprite showcase
   */
  private renderExportStep(): void {
    if (!this.quantizedBuf || !this.quantizedCanvas) return;
    const { ctx } = this;
    const { w, h } = this.quantizedBuf;

    if (this.exportBackdrop === 'checkerboard') {
      this.drawCheckerboard(0, 0, w, h, 2);
    }

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.quantizedCanvas, 0, 0, w, h);

    // Subtle sprite frame
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.5)';
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeRect(0, 0, w, h);
  }

  public getQuantizedBuffer(): PixelBuffer | null {
    return this.quantizedBuf;
  }
}
