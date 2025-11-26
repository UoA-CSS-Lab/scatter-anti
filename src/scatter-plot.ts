import type { Label, ScatterPlotOptions } from './types.js';
import { DataLayer } from './layers/data-layer.js';
import { GpuLayer } from './layers/gpu-layer.js';
import { LabelLayer } from './layers/label-layer.js';
import type { ProcessedData } from './layers/data-layer.js';
import type { ParquetData } from './repository.js';

/**
 * Main ScatterPlot class for rendering scatter plots using WebGPU
 *
 * This class acts as a facade/coordinator for three distinct layers:
 * - DataLayer: Handles data acquisition and query management
 * - GpuLayer: Manages WebGPU rendering and transformations
 * - LabelLayer: Handles 2D canvas overlay for labels
 */
export class ScatterPlot {
  // Three distinct layers
  private readonly dataLayer: DataLayer;
  private gpuLayer: GpuLayer;
  private labelLayer: LabelLayer;

  // Configuration
  private readonly dataUrl: string;
  private readonly labelUrl?: string;

  constructor(options: ScatterPlotOptions) {
    // Initialize the three layers
    this.dataLayer = new DataLayer({
      visiblePointLimit: options.data.visiblePointLimit,
      pointSizeLambda: options.data.pointSizeLambda,
      pointColorLambda: options.data.pointColorLambda,
      whereConditions: options.data.whereConditions,
      idColumn: options.data.idColumn,
    });

    this.gpuLayer = new GpuLayer({
      canvas: options.canvas,
      backgroundColor: options.gpu?.backgroundColor,
    });

    this.labelLayer = new LabelLayer({
      canvas: options.canvas,
      labelFontSize: options.labels?.fontSize,
      filterLambda: options.labels?.filterLambda,
      onLabelClick: options.labels?.onClick,
      onPointHover: (data) => this.handlePointHover(data, options.interaction?.onPointHover),
      hoverOutlineOptions: options.labels?.hoverOutlineOptions,
      dataLayer: this.dataLayer,
    });

    // Store URLs for auto-fetch during initialization
    this.dataUrl = options.dataUrl;
    this.labelUrl = options.labels?.url;
  }

  /**
   * Initialize WebGPU and create rendering resources
   */
  async initialize(): Promise<void> {
    // Get the actual canvas aspect ratio for initial data load
    const aspectRatio = this.gpuLayer.getAspectRatio();
    const initialData = await this.dataLayer.initialize(this.dataUrl, aspectRatio);

    // 2. Initialize GPU layer with initial data
    await this.gpuLayer.initialize(initialData);

    // 3. Initialize label layer (creates canvas overlay)
    this.labelLayer.initialize();

    // 4. Auto-fetch labels if labelUrl is provided
    if (this.labelUrl) {
      try {
        const response = await fetch(this.labelUrl);
        if (response.ok) {
          const labelData = await response.json();
          this.loadLabels(labelData);
        }
      } catch {
        // Silently ignore label loading errors in legacy API
      }
    }
  }

  /**
   * Render the scatter plot (both GPU and labels)
   */
  render(): void {
    // Render GPU layer first
    this.gpuLayer.render();

    // Render labels on top
    this.labelLayer.render();
  }

  /**
   * Load labels from GeoJSON data
   * @param geojsonData GeoJSON FeatureCollection with label points
   */
  loadLabels(geojsonData: any): void {
    this.labelLayer.loadLabels(geojsonData);

    // Re-render to show new labels
    this.render();
  }

  /**
   * Update plot data and re-render
   */
  async update(options: Partial<ScatterPlotOptions>): Promise<void> {
    // Update data layer
    if (options.data !== undefined) {
      this.dataLayer.updateOptions({
        pointSizeLambda: options.data.pointSizeLambda,
        pointColorLambda: options.data.pointColorLambda,
        visiblePointLimit: options.data.visiblePointLimit,
        whereConditions: options.data.whereConditions,
      });
    }

    // Update GPU layer
    if (options.gpu !== undefined) {
      this.gpuLayer.updateOptions({
        backgroundColor: options.gpu.backgroundColor,
      });
    }

    // Update label layer
    if (options.labels !== undefined) {
      this.labelLayer.updateOptions({
        labelFontSize: options.labels.fontSize,
        filterLambda: options.labels.filterLambda,
        onLabelClick: options.labels.onClick,
        hoverOutlineOptions: options.labels.hoverOutlineOptions,
      });

      // Load labels if URL is provided
      if (options.labels.url !== undefined) {
        try {
          const response = await fetch(options.labels.url);
          if (response.ok) {
            const labelData = await response.json();
            this.loadLabels(labelData);
          }
        } catch {
          // Silently ignore label loading errors
        }
      }
    }

    // Update interaction callbacks
    if (options.interaction !== undefined) {
      this.labelLayer.updateOptions({
        onPointHover: (data) => this.handlePointHover(data, options.interaction?.onPointHover),
      });
    }

    this.scheduleDataUpdate();
  }

  /**
   * Resize canvas and re-render
   */
  resize(width: number, height: number): void {
    this.gpuLayer.resize(width, height);
    this.labelLayer.resize(width, height);
    this.render();
  }

  /**
   * Set zoom level
   * @param zoom Zoom level (1.0 = normal, >1.0 = zoom in, <1.0 = zoom out)
   */
  setZoom(zoom: number): void {
    this.gpuLayer.setZoom(zoom);

    // Update label layer with new view transform
    const pan = this.gpuLayer.getPan();
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), pan.x, pan.y);

    // Immediate render (lightweight)
    this.render();

    // Schedule query for new visible points (throttled)
    this.scheduleDataUpdate();
  }

  /**
   * Get current zoom level
   */
  getZoom(): number {
    return this.gpuLayer.getZoom();
  }

  /**
   * Zoom in by a factor
   * @param factor Zoom factor (default: 1.2)
   */
  zoomIn(factor: number = 1.2): void {
    this.setZoom(this.gpuLayer.getZoom() * factor);
  }

  /**
   * Zoom out by a factor
   * @param factor Zoom factor (default: 1.2)
   */
  zoomOut(factor: number = 1.2): void {
    this.setZoom(this.gpuLayer.getZoom() / factor);
  }

  /**
   * Zoom to a specific point (zoom centered on a screen coordinate)
   * @param newZoom New zoom level
   * @param screenX Screen X coordinate (in canvas pixels)
   * @param screenY Screen Y coordinate (in canvas pixels)
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    this.gpuLayer.zoomToPoint(newZoom, screenX, screenY);

    // Update label layer with new view transform
    const pan = this.gpuLayer.getPan();
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), pan.x, pan.y);

    // Immediate render (lightweight)
    this.render();

    // Schedule query for new visible points (throttled)
    this.scheduleDataUpdate();
  }

  /**
   * Reset zoom and pan to default
   */
  resetView(): void {
    this.gpuLayer.setZoom(1.0);
    this.gpuLayer.setPan(0.0, 0.0);

    // Update label layer with new view transform
    this.labelLayer.updateViewTransform(1.0, 0.0, 0.0);

    // Immediate render (lightweight)
    this.render();

    // Schedule query for new visible points (throttled)
    this.scheduleDataUpdate();
  }

  /**
   * Set pan offset
   * @param x Pan X offset in normalized coordinates (-1 to 1)
   * @param y Pan Y offset in normalized coordinates (-1 to 1)
   */
  setPan(x: number, y: number): void {
    this.gpuLayer.setPan(x, y);

    // Update label layer with new view transform
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), x, y);

    // Immediate render (lightweight)
    this.render();

    // Schedule query for new visible points (throttled)
    this.scheduleDataUpdate();
  }

  /**
   * Get current pan offset
   */
  getPan(): { x: number; y: number } {
    return this.gpuLayer.getPan();
  }

  /**
   * Pan by a delta amount
   * @param dx Delta X in normalized coordinates
   * @param dy Delta Y in normalized coordinates
   */
  pan(dx: number, dy: number): void {
    const currentPan = this.gpuLayer.getPan();
    this.setPan(currentPan.x + dx, currentPan.y + dy);
  }

  /**
   * Schedule a data update based on current view state
   * This is called when zoom/pan changes to load new visible points
   */
  private scheduleDataUpdate(): void {
    const zoom = this.gpuLayer.getZoom();
    const pan = this.gpuLayer.getPan();
    const aspectRatio = this.gpuLayer.getAspectRatio();

    this.dataLayer.scheduleVisiblePointsUpdate(
      zoom,
      pan.x,
      pan.y,
      aspectRatio,
      (data: ProcessedData) => {
        // Update GPU layer with new data
        this.gpuLayer.updateInstanceBuffer(data);

        // Re-render with new data
        this.render();
      }
    );
  }

  /**
   * Handle point hover events from label layer
   */
  private handlePointHover(
    data: { row: any[]; columns: string[] } | null,
    userCallback?: any
  ): void {
    // Call user's callback if provided
    if (userCallback) {
      userCallback(data);
    }
  }

  async runQuery(query: any): Promise<ParquetData | undefined> {
    return await this.dataLayer.runQuery(query);
  }

  getLabels(): Label[] {
    return this.labelLayer.getLabels();
  }

  /**
   * Destroy resources
   */
  destroy(): void {
    this.dataLayer.destroy();
    this.gpuLayer.destroy();
    this.labelLayer.destroy();
  }
}
