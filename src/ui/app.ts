import { PixelViewer, ViewerStep, ExportBackdrop } from './viewer';
import { runPipeline, generateVariations, DEFAULT_OPTIONS } from '../core/pipeline';
import { PipelineOptions, PipelineResult, PixelBuffer, CandidateVariation } from '../core/types';
import { rgbToHex } from '../core/color';
import JSZip from 'jszip';

/** Preview modes shown as tabs over the canvas (no step-by-step wizard). */
const VIEWS: ViewerStep[] = ['mixels', 'grid', 'background', 'outline', 'export'];

export class PixelApp {
  private viewer: PixelViewer;
  private currentView: ViewerStep = 'export';
  private pipelineOptions: PipelineOptions = { ...DEFAULT_OPTIONS };
  private pipelineResult: PipelineResult | null = null;
  private candidateVariations: CandidateVariation[] = [];
  private selectedVariationId = 1;
  private sourceBuffer: PixelBuffer | null = null;
  private debounceTimer: number | null = null;

  constructor() {
    const canvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
    if (!canvas) throw new Error('Main canvas element not found');

    this.viewer = new PixelViewer({
      canvas,
      onZoomChange: (zoom) => {
        const text = document.getElementById('zoomLevelText');
        if (text) text.textContent = `${Math.round(zoom * 100)}%`;
      },
      onSplitChange: (ratio) => {
        const slider = document.getElementById('splitSlider') as HTMLInputElement;
        const valText = document.getElementById('splitSliderValue');
        if (slider) slider.value = Math.round(ratio * 100).toString();
        if (valText) valText.textContent = `${Math.round(ratio * 100)}%`;
      }
    });

    this.initUI();
    this.initEventListeners();
    // Start on the empty upload / drag area; the user brings their own image.
  }

  private initUI(): void {
    this.viewer.setStep(this.currentView);
    this.updateViewUI();
  }

  private initEventListeners(): void {
    // 1. Preview mode tabs
    document.querySelectorAll('.view-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.setView(tab.getAttribute('data-view') as ViewerStep);
      });
    });

    // Keyboard shortcuts: 1-5 switch preview mode
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx >= 0 && idx < VIEWS.length) this.setView(VIEWS[idx]);
      }
    });

    // Big upload / drag area (empty state)
    const dropZone = document.getElementById('dropZone');
    const zoneFileInput = document.getElementById('fileInput') as HTMLInputElement;
    dropZone?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#btnDropSample')) return;
      zoneFileInput?.click();
    });
    dropZone?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        zoneFileInput?.click();
      }
    });
    document.getElementById('btnDropSample')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.loadInitialSample(true);
    });
    dropZone?.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
    dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone?.addEventListener('drop', () => dropZone.classList.remove('drag-over'));


    // 2. Viewport Controls
    document.getElementById('btnZoomIn')?.addEventListener('click', () => this.viewer.zoomIn());
    document.getElementById('btnZoomOut')?.addEventListener('click', () => this.viewer.zoomOut());
    document.getElementById('btnFitScreen')?.addEventListener('click', () => this.viewer.fitToScreen());
    document.getElementById('btnResetZoom')?.addEventListener('click', () => this.viewer.resetZoom());

    // 3. Upload & Sample Loaders
    const fileInput = document.getElementById('fileInput') as HTMLInputElement;
    document.getElementById('btnUpload')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => this.handleFileSelect(e));

    document.getElementById('btnLoadSample')?.addEventListener('click', () => {
      this.loadInitialSample(true);
    });

    // Drag & Drop
    const dropOverlay = document.getElementById('dropOverlay');
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dropOverlay?.classList.add('active');
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) {
        dropOverlay?.classList.remove('active');
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropOverlay?.classList.remove('active');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('image/')) {
          this.loadFile(file);
        } else {
          this.showToast('Please drop an image file (PNG, JPG, WebP)', 'error');
        }
      }
    });

    // Clipboard Paste (Ctrl+V)
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            this.loadFile(file);
            this.showToast('Image pasted from clipboard!', 'success');
            break;
          }
        }
      }
    });

    // 4. Mixels Controls
    const toggleHeatmap = document.getElementById('toggleHeatmap') as HTMLInputElement;
    toggleHeatmap?.addEventListener('change', (e) => {
      this.viewer.showHeatmap = (e.target as HTMLInputElement).checked;
      this.viewer.render();
    });

    const splitSlider = document.getElementById('splitSlider') as HTMLInputElement;
    splitSlider?.addEventListener('input', (e) => {
      const ratio = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      this.viewer.splitRatio = ratio;
      const text = document.getElementById('splitSliderValue');
      if (text) text.textContent = `${Math.round(ratio * 100)}%`;
      this.viewer.render();
    });

    // 5. Grid Controls
    const gridModeBtns = document.querySelectorAll('[data-grid-mode]');
    gridModeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        gridModeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.getAttribute('data-grid-mode');
        if (mode === '32') this.pipelineOptions.gridMode = 32;
        else if (mode === '64') this.pipelineOptions.gridMode = 64;
        else this.pipelineOptions.gridMode = 'auto';
        this.runPipelineAndRefresh();
      });
    });

    this.bindRangeInput('pitchNudgeSlider', 'pitchNudgeValue', '%', (val) => {
      this.pipelineOptions.pitchNudge = val;
      this.runPipelineDebounced();
    });

    this.bindRangeInput('offXNudgeSlider', 'offXNudgeValue', 'px', (val) => {
      this.pipelineOptions.offXNudge = val;
      this.runPipelineDebounced();
    });

    this.bindRangeInput('offYNudgeSlider', 'offYNudgeValue', 'px', (val) => {
      this.pipelineOptions.offYNudge = val;
      this.runPipelineDebounced();
    });

    document.getElementById('btnResetNudges')?.addEventListener('click', () => {
      this.pipelineOptions.pitchNudge = 0;
      this.pipelineOptions.offXNudge = 0;
      this.pipelineOptions.offYNudge = 0;
      (document.getElementById('pitchNudgeSlider') as HTMLInputElement).value = '0';
      (document.getElementById('offXNudgeSlider') as HTMLInputElement).value = '0';
      (document.getElementById('offYNudgeSlider') as HTMLInputElement).value = '0';
      (document.getElementById('pitchNudgeValue') as HTMLElement).textContent = '0%';
      (document.getElementById('offXNudgeValue') as HTMLElement).textContent = '0px';
      (document.getElementById('offYNudgeValue') as HTMLElement).textContent = '0px';
      this.runPipelineAndRefresh();
      this.showToast('Grid nudges reset', 'info');
    });

    const toggleGridOverlay = document.getElementById('toggleGridOverlay') as HTMLInputElement;
    toggleGridOverlay?.addEventListener('change', (e) => {
      this.viewer.showGridLines = (e.target as HTMLInputElement).checked;
      this.viewer.render();
    });

    // 6. Background Controls
    this.bindRangeInput('bgToleranceSlider', 'bgToleranceValue', '%', (val) => {
      this.pipelineOptions.bgTolerance = val / 100;
      this.runPipelineDebounced();
    });

    const toggleBgIslands = document.getElementById('toggleBgIslands') as HTMLInputElement;
    toggleBgIslands?.addEventListener('change', (e) => {
      this.pipelineOptions.bgRemoveIslands = (e.target as HTMLInputElement).checked;
      this.runPipelineDebounced();
    });

    // 7. Outline Controls
    const outlineModeBtns = document.querySelectorAll('[data-outline-mode]');
    outlineModeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        outlineModeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.pipelineOptions.outlineMode = btn.getAttribute('data-outline-mode') as 'inside' | 'outside' | 'clean_only';
        this.runPipelineAndRefresh();
      });
    });

    const toggleOutlineHighlights = document.getElementById('toggleOutlineHighlights') as HTMLInputElement;
    toggleOutlineHighlights?.addEventListener('change', (e) => {
      this.viewer.showOutlineHighlights = (e.target as HTMLInputElement).checked;
      this.viewer.render();
    });

    const toggleConnectDiagonals = document.getElementById('toggleConnectDiagonals') as HTMLInputElement;
    toggleConnectDiagonals?.addEventListener('change', (e) => {
      this.pipelineOptions.connectDiagonals = (e.target as HTMLInputElement).checked;
      this.runPipelineAndRefresh();
    });

    const toggleBridgeGaps = document.getElementById('toggleBridgeGaps') as HTMLInputElement;
    toggleBridgeGaps?.addEventListener('change', (e) => {
      this.pipelineOptions.bridgeGaps = (e.target as HTMLInputElement).checked;
      this.runPipelineAndRefresh();
    });

    const outlineColorBtns = document.querySelectorAll('[data-outline-color]');
    const outlineCustomColor = document.getElementById('outlineCustomColor') as HTMLInputElement;
    outlineColorBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        outlineColorBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.getAttribute('data-outline-color');
        if (mode === 'custom') {
          outlineCustomColor.style.display = 'block';
          this.pipelineOptions.outlineColor = outlineCustomColor.value;
        } else {
          outlineCustomColor.style.display = 'none';
          this.pipelineOptions.outlineColor = 'auto';
        }
        this.runPipelineAndRefresh();
      });
    });

    outlineCustomColor?.addEventListener('input', (e) => {
      this.pipelineOptions.outlineColor = (e.target as HTMLInputElement).value;
      this.runPipelineDebounced();
    });

    // 8. Colors Controls
    this.bindRangeInput('targetColorsSlider', 'targetColorsValue', '', (val) => {
      this.pipelineOptions.targetColors = val;
      this.updateColorPresetButtons(val);
      this.runPipelineDebounced();
    });

    const colorPresets = document.querySelectorAll('[data-color-preset]');
    colorPresets.forEach((btn) => {
      btn.addEventListener('click', () => {
        const count = parseInt(btn.getAttribute('data-color-preset') || '16', 10);
        this.pipelineOptions.targetColors = count;
        (document.getElementById('targetColorsSlider') as HTMLInputElement).value = count.toString();
        (document.getElementById('targetColorsValue') as HTMLElement).textContent = count.toString();
        this.updateColorPresetButtons(count);
        this.runPipelineAndRefresh();
      });
    });

    const toggleKeepExtremes = document.getElementById('toggleKeepExtremes') as HTMLInputElement;
    toggleKeepExtremes?.addEventListener('change', (e) => {
      this.pipelineOptions.keepExtremes = (e.target as HTMLInputElement).checked;
      this.runPipelineDebounced();
    });

    // 9. Export Controls
    document.getElementById('btnDownload1x')?.addEventListener('click', () => this.downloadPNG(1));
    document.getElementById('btnDownloadAll10')?.addEventListener('click', () => this.downloadAllVariationsZip());
    document.getElementById('btnDownload4x')?.addEventListener('click', () => this.downloadPNG(4));
    document.getElementById('btnDownload8x')?.addEventListener('click', () => this.downloadPNG(8));
    document.getElementById('btnDownload16x')?.addEventListener('click', () => this.downloadPNG(16));
    document.getElementById('btnDownload20x')?.addEventListener('click', () => this.downloadPNG(20));

    document.getElementById('btnDownloadHex')?.addEventListener('click', () => this.downloadHexPalette());
    document.getElementById('btnDownloadGpl')?.addEventListener('click', () => this.downloadGplPalette());

    const backdropBtns = document.querySelectorAll('[data-backdrop]');
    backdropBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        backdropBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.viewer.exportBackdrop = btn.getAttribute('data-backdrop') as ExportBackdrop;
        this.viewer.render();
      });
    });
  }

  private bindRangeInput(
    sliderId: string,
    valueId: string,
    unit: string,
    onChange: (val: number) => void
  ): void {
    const slider = document.getElementById(sliderId) as HTMLInputElement;
    const label = document.getElementById(valueId);
    if (!slider || !label) return;

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      label.textContent = `${val}${unit}`;
      onChange(val);
    });
  }

  private updateColorPresetButtons(count: number): void {
    document.querySelectorAll('[data-color-preset]').forEach((btn) => {
      if (btn.getAttribute('data-color-preset') === count.toString()) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  /** Switch the preview mode shown over the canvas. */
  public setView(view: ViewerStep): void {
    this.currentView = view;
    this.viewer.setStep(view);
    this.updateViewUI();
  }

  private updateViewUI(): void {
    const view = this.currentView;

    document.querySelectorAll('.view-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-view') === view);
    });

    // Vertical palette strip only on the final result view
    const canvasPaletteBar = document.getElementById('canvasPaletteBar');
    if (canvasPaletteBar) {
      canvasPaletteBar.style.display = view === 'export' ? 'flex' : 'none';
    }

    // Before/after labels only on the compare view
    const splitLabels = document.getElementById('splitLabels');
    if (splitLabels) {
      splitLabels.style.display = view === 'mixels' ? 'flex' : 'none';
    }
  }

  private handleFileSelect(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.loadFile(input.files[0]);
    }
  }

  private loadFile(file: File): void {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      this.loadImageFromUrl(dataUrl, file.name);
    };
    reader.readAsDataURL(file);
  }

  public async loadInitialSample(showToast = false): Promise<void> {
    try {
      // First try fetching public/ada_quill.png or ada_quill.png
      await this.loadImageFromUrl('ada_quill.png', 'ada_quill.png');
      if (showToast) {
        this.showToast('Sample image (ada_quill.png) loaded!', 'success');
      }
    } catch {
      // Fallback: generate a high-res synthetic pixel fox adventurer sprite buffer
      this.generateDemoImage();
      if (showToast) {
        this.showToast('Loaded demo sprite', 'info');
      }
    }
  }

  private markImageLoaded(name: string, w: number, h: number): void {
    document.getElementById('viewport')?.classList.add('has-image');
    const info = document.getElementById('imageInfo');
    if (info) info.textContent = `${name} - ${w}x${h}`;
  }

  private loadImageFromUrl(url: string, filename = ''): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        this.sourceBuffer = {
          w: canvas.width,
          h: canvas.height,
          data: imgData.data
        };

        this.markImageLoaded(filename || 'image', canvas.width, canvas.height);
        this.runPipelineAndRefresh(true);
        resolve();
      };
      img.onerror = (err) => reject(err);
      img.src = url;
    });
  }

  private generateDemoImage(): void {
    const w = 480;
    const h = 480;
    const data = new Uint8ClampedArray(w * h * 4);

    // Create a 16x16 pixel art scaled up by 30x with soft blurred edges (mixels)
    const scale = 30;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const cx = Math.floor(x / scale);
        const cy = Math.floor(y / scale);

        // Simple sprite silhouette (hooded character)
        if (cx >= 4 && cx <= 11 && cy >= 3 && cy <= 13) {
          data[idx] = 45;
          data[idx + 1] = 138;
          data[idx + 2] = 65;
          data[idx + 3] = 255;
        } else {
          // White background
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = 255;
        }
      }
    }

    this.sourceBuffer = { w, h, data };
    this.markImageLoaded('demo sprite', w, h);
    this.runPipelineAndRefresh(true);
  }

  private runPipelineDebounced(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.runPipelineAndRefresh();
    }, 70);
  }

  private runPipelineAndRefresh(isInitial = false): void {
    if (!this.sourceBuffer) return;

    const id = ++this.pipelineRequestId;
    if (isInitial) this.pendingFit = true;

    const worker = this.getWorker();
    if (!worker) {
      // Fallback: run synchronously on the main thread
      const res = runPipeline(this.sourceBuffer, this.pipelineOptions);
      const vars = generateVariations(this.sourceBuffer, this.pipelineOptions, 10);
      this.applyPipelineResult(res, vars);
      return;
    }
    worker.postMessage({
      id,
      source: this.sourceBuffer,
      options: this.pipelineOptions,
      computeVariations: true
    });
  }

  private pipelineRequestId = 0;
  private pendingFit = false;
  private worker: Worker | null | undefined;

  private getWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    try {
      this.worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.id !== this.pipelineRequestId) return; // stale result, newer request pending
        if (msg.type === 'done') this.applyPipelineResult(msg.result, msg.variations);
        else if (msg.type === 'error') this.showToast(`Processing failed: ${msg.error}`, 'error');
      };
      this.worker.onerror = () => {
        this.worker = null;
        this.runPipelineAndRefresh(this.pendingFit);
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private applyPipelineResult(result: PipelineResult, variations?: CandidateVariation[]): void {
    this.pipelineResult = result;
    if (variations && variations.length > 0) {
      this.candidateVariations = variations;
      // If selected variation was out of range or not set, default to 1
      if (!this.candidateVariations.some(v => v.id === this.selectedVariationId)) {
        this.selectedVariationId = 1;
      }
    } else if (this.sourceBuffer) {
      this.candidateVariations = generateVariations(this.sourceBuffer, this.pipelineOptions, 10);
    }

    this.viewer.setData({
      source: this.pipelineResult.source,
      grid: this.pipelineResult.grid,
      mixelReport: this.pipelineResult.mixelReport,
      snapped: this.pipelineResult.snapped,
      bgRemoved: this.pipelineResult.bgRemoved,
      outlineFixed: this.pipelineResult.outlineFixed,
      changedPixels: this.pipelineResult.changedPixels,
      quantized: this.pipelineResult.quantized,
      palette: this.pipelineResult.palette
    });

    this.updateStatsUI();
    this.updatePaletteUI();
    this.updateVariationsUI();

    if (this.pendingFit) {
      this.pendingFit = false;
      this.viewer.fitToScreen();
    }
  }

  private updateStatsUI(): void {
    if (!this.pipelineResult) return;
    const { grid, mixelReport, changedPixels, originalColorCount, palette } = this.pipelineResult;

    // Mixels Stats
    const mixelVal = document.getElementById('mixelStatValue');
    const mixelBadge = document.getElementById('mixelStatBadge');
    if (mixelVal) mixelVal.textContent = `${mixelReport.mixelRatio.toFixed(1)}%`;
    if (mixelBadge) {
      mixelBadge.textContent = mixelReport.mixelRatio > 10
        ? 'Mixed Resolution Snapped'
        : 'Crisp Pixel Alignment';
    }

    // Grid Stats
    const gridDim = document.getElementById('gridDimensionsText');
    const gridPitch = document.getElementById('gridPitchText');
    if (gridDim) gridDim.textContent = `${grid.cols} × ${grid.rows} px`;
    if (gridPitch) {
      gridPitch.textContent = `Pitch: ${grid.pitchX.toFixed(1)}px | Offset: (${grid.offX.toFixed(1)}, ${grid.offY.toFixed(1)})`;
    }

    // Outline Stats
    const outlineCount = document.getElementById('outlineRepairedCount');
    if (outlineCount) {
      outlineCount.textContent = `${changedPixels.length} Pixels Repaired`;
    }

    // Colors Stats
    const colorComp = document.getElementById('colorComparisonTitle');
    if (colorComp) {
      const origStr = originalColorCount.toLocaleString();
      colorComp.textContent = `${origStr} → ${palette.length} Colors`;
    }

    const paletteCountLabel = document.getElementById('paletteCountLabel');
    if (paletteCountLabel) {
      paletteCountLabel.textContent = `${palette.length} colors`;
    }

    // Export Stats
    const exportDim = document.getElementById('exportDimensionsText');
    if (exportDim) {
      exportDim.textContent = `${grid.cols} × ${grid.rows} px`;
    }

  }

  private updatePaletteUI(): void {
    if (!this.pipelineResult) return;
    const { palette } = this.pipelineResult;

    // 1. Sidebar Palette Swatches Grid
    const container = document.getElementById('paletteSwatchesContainer');
    if (container) {
      container.innerHTML = '';
      palette.forEach((c) => {
        const hex = rgbToHex(c);
        const swatch = document.createElement('div');
        swatch.className = 'palette-swatch';
        swatch.style.backgroundColor = hex;
        swatch.setAttribute('data-tooltip', hex);
        swatch.addEventListener('click', () => {
          navigator.clipboard.writeText(hex);
          this.showToast(`Copied ${hex} to clipboard!`, 'info');
        });
        container.appendChild(swatch);
      });
    }

    // 2. Vertical Palette Strip on Canvas Right (matching video!)
    const canvasBar = document.getElementById('canvasPaletteBar');
    if (canvasBar) {
      canvasBar.innerHTML = '';
      palette.forEach((c) => {
        const hex = rgbToHex(c);
        const swatch = document.createElement('div');
        swatch.className = 'canvas-swatch';
        swatch.style.backgroundColor = hex;
        swatch.setAttribute('data-tooltip', hex);
        swatch.addEventListener('click', () => {
          navigator.clipboard.writeText(hex);
          this.showToast(`Copied ${hex}`, 'info');
        });
        canvasBar.appendChild(swatch);
      });
    }
  }

  private selectVariation(id: number): void {
    const variation = this.candidateVariations.find(v => v.id === id);
    if (!variation) return;

    this.selectedVariationId = id;
    this.pipelineResult = variation.result;

    this.viewer.setData({
      source: this.pipelineResult.source,
      grid: this.pipelineResult.grid,
      mixelReport: this.pipelineResult.mixelReport,
      snapped: this.pipelineResult.snapped,
      bgRemoved: this.pipelineResult.bgRemoved,
      outlineFixed: this.pipelineResult.outlineFixed,
      changedPixels: this.pipelineResult.changedPixels,
      quantized: this.pipelineResult.quantized,
      palette: this.pipelineResult.palette
    });

    this.updateStatsUI();
    this.updatePaletteUI();
    this.updateVariationsUI();
    this.showToast(`Switched to Variation #${variation.id}: ${variation.name}`, 'info');
  }

  private updateVariationsUI(): void {
    const containers = [document.getElementById('variationThumbs')];

    const desc = document.getElementById('variationDesc');
    const exportBadge = document.getElementById('exportVariationBadge');

    const activeVar = this.candidateVariations.find(v => v.id === this.selectedVariationId) || this.candidateVariations[0];
    if (activeVar) {
      if (desc) desc.textContent = `${activeVar.name} (${activeVar.tag}): ${activeVar.description}`;
      if (exportBadge) exportBadge.textContent = `#${activeVar.id} ${activeVar.name}`;
    }

    containers.forEach((container) => {
      if (!container) return;
      container.innerHTML = '';

      this.candidateVariations.forEach((v) => {
        const card = document.createElement('div');
        card.className = `variation-thumb-card ${v.id === this.selectedVariationId ? 'active' : ''}`;
        card.setAttribute('data-tooltip', `#${v.id} ${v.name}: ${v.tag}`);

        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = v.result.quantized.w;
        thumbCanvas.height = v.result.quantized.h;
        const ctx = thumbCanvas.getContext('2d')!;
        const imgData = new ImageData(
          new Uint8ClampedArray(v.result.quantized.data),
          v.result.quantized.w,
          v.result.quantized.h
        );
        ctx.putImageData(imgData, 0, 0);

        const num = document.createElement('div');
        num.className = 'variation-thumb-num';
        num.textContent = `#${v.id}`;

        card.appendChild(thumbCanvas);
        card.appendChild(num);

        card.addEventListener('click', () => {
          this.selectVariation(v.id);
        });

        container.appendChild(card);
      });
    });
  }

  private async downloadAllVariationsZip(): Promise<void> {
    if (this.candidateVariations.length === 0) {
      this.showToast('No variations available to export', 'error');
      return;
    }

    this.showToast('Packaging all 10 variations into ZIP...', 'info');
    const zip = new JSZip();

    for (const v of this.candidateVariations) {
      const buf = v.result.quantized;
      const canvas = document.createElement('canvas');
      canvas.width = buf.w;
      canvas.height = buf.h;
      const ctx = canvas.getContext('2d')!;
      const imgData = new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h);
      ctx.putImageData(imgData, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) {
        const cleanName = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        zip.file(`${v.id.toString().padStart(2, '0')}_${cleanName}_${buf.w}x${buf.h}.png`, blob);
      }
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pixelcraft_all_10_variations.zip';
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Exported all 10 variations ZIP!', 'success');
  }

  private downloadPNG(scale: number): void {
    const buf = this.viewer.getQuantizedBuffer();
    if (!buf) {
      this.showToast('No processed sprite to export', 'error');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = buf.w * scale;
    canvas.height = buf.h * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // Draw sprite buffer into temporary canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = buf.w;
    tempCanvas.height = buf.h;
    const tempCtx = tempCanvas.getContext('2d')!;
    const imgData = new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h);
    tempCtx.putImageData(imgData, 0, 0);

    ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pixelcraft_${buf.w * scale}x${buf.h * scale}.png`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast(`Exported PNG at ${scale}x scale!`, 'success');
    }, 'image/png');
  }

  private downloadHexPalette(): void {
    if (!this.pipelineResult) return;
    const hexLines = this.pipelineResult.palette.map((c) => rgbToHex(c).replace('#', ''));
    const content = hexLines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'palette.hex';
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Downloaded .HEX palette', 'success');
  }

  private downloadGplPalette(): void {
    if (!this.pipelineResult) return;
    const lines = [
      'GIMP Palette',
      'Name: Pixelcraft Palette',
      'Columns: 8',
      '#'
    ];
    for (const c of this.pipelineResult.palette) {
      const r = c.r.toString().padStart(3, ' ');
      const g = c.g.toString().padStart(3, ' ');
      const b = c.b.toString().padStart(3, ' ');
      const hex = rgbToHex(c);
      lines.push(`${r} ${g} ${b}  ${hex}`);
    }
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'palette.gpl';
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Downloaded .GPL palette for Aseprite/GIMP', 'success');
  }

  public showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'success' ? 'toast-green' : type === 'info' ? 'toast-blue' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }
}
