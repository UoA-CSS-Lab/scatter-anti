import type { Label, LabelFilterLambda, Point, PointHoverCallback, HoverOutlineOptions } from '../types.js';
import type { DataLayer } from './data-layer.js';

export interface LabelLayerOptions {
  canvas: HTMLCanvasElement;
  maxLabels?: number;
  minLabelDistance?: number;
  filterLambda?: LabelFilterLambda;
  onLabelClick?: (label: Label) => void;
  onPointHover?: PointHoverCallback;
  hoverOutlineOptions?: HoverOutlineOptions;
  hoverScaleFactor?: number;
  dataLayer?: DataLayer;
}

/**
 * LabelLayer handles 2D canvas overlay for label rendering
 * Responsibilities:
 * - Manage 2D canvas overlay
 * - Render text labels with collision detection
 * - Transform label coordinates using view matrix
 * - Filter labels by density and viewport visibility
 */
export class LabelLayer {
  private canvas: HTMLCanvasElement; // WebGPU canvas (for positioning)
  private labelCanvas: HTMLCanvasElement | null = null;
  private labelContext: CanvasRenderingContext2D | null = null;
  private labels: Label[] = [];
  private maxLabels: number = 50;
  private minLabelDistance: number = 40; // Minimum distance between labels in pixels
  private filterLambda?: LabelFilterLambda;

  // View transformation state (read from GPU layer)
  private zoom: number = 1.0;
  private panX: number = 0.0;
  private panY: number = 0.0;

  // Hover and interaction state
  private onLabelClick?: (label: Label) => void;
  private renderedLabelBounds: Array<{label: Label, x: number, y: number, width: number, height: number}> = [];
  private hoveredLabel: Label | null = null;
  private readonly normalScale = 1.0;
  private readonly hoverScale = 1.3;
  private readonly hitPadding = 10; // Padding around text for hit detection

  // Point hover state
  private onPointHover?: PointHoverCallback;
  private hoveredPoint: Point | null = null;
  private hoveredPointIndex: number | null = null;
  private hoverOutlineOptions: HoverOutlineOptions;
  private pointHoverScaleFactor: number;
  private dataLayer: DataLayer | null = null;

  constructor(options: LabelLayerOptions) {
    this.canvas = options.canvas;
    this.maxLabels = options.maxLabels ?? this.maxLabels;
    this.minLabelDistance = options.minLabelDistance ?? this.minLabelDistance;
    this.labels = [];
    this.filterLambda = options.filterLambda;
    this.onLabelClick = options.onLabelClick;
    this.onPointHover = options.onPointHover;
    this.dataLayer = options.dataLayer ?? null;
    this.pointHoverScaleFactor = options.hoverScaleFactor ?? 1.3;
    this.hoverOutlineOptions = {
      enabled: options.hoverOutlineOptions?.enabled ?? true,
      color: options.hoverOutlineOptions?.color ?? 'white',
      width: options.hoverOutlineOptions?.width ?? 2
    };
  }

  /**
   * Initialize the label canvas overlay
   */
  initialize(): void {
    this.createLabelCanvas();
  }

  /**
   * Create the 2D canvas overlay for labels
   */
  private createLabelCanvas(): void {
    // Create label canvas
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = this.canvas.width;
    this.labelCanvas.height = this.canvas.height;
    this.labelCanvas.style.position = 'absolute';
    this.labelCanvas.style.pointerEvents = 'none'; // Start with pass-through, enable only on labels
    this.labelCanvas.style.top = '0';
    this.labelCanvas.style.left = '0';

    // Position it over the WebGPU canvas
    const parent = this.canvas.parentElement;
    if (parent) {
      // Ensure parent has position relative
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }

      // Get the WebGPU canvas position within parent
      this.labelCanvas.style.top = `${this.canvas.offsetTop}px`;
      this.labelCanvas.style.left = `${this.canvas.offsetLeft}px`;

      parent.appendChild(this.labelCanvas);
    }

    this.labelContext = this.labelCanvas.getContext('2d');

    // Add mouse event listeners for hover and click
    this.setupEventListeners();
  }

  /**
   * Update view transformation state (called by coordinator when zoom/pan changes)
   */
  updateViewTransform(zoom: number, panX: number, panY: number): void {
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
  }

  /**
   * Render labels on the 2D canvas overlay
   */
  render(): void {
    if (!this.labelContext || !this.labelCanvas) {
      console.log('renderLabels: No label context or canvas');
      return;
    }

    // Clear previous labels and bounds
    this.labelContext.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    this.renderedLabelBounds = [];

    if (this.labels.length === 0) {
      console.log('renderLabels: No labels to render');
      return;
    }

    // Configure text rendering
    const baseFontSize = 12;
    const fontSize = baseFontSize; // Fixed size, not affected by zoom
    this.labelContext.fillStyle = 'white';
    this.labelContext.strokeStyle = 'black';
    this.labelContext.lineWidth = 2;
    this.labelContext.textAlign = 'center';
    this.labelContext.textBaseline = 'middle';

    let renderedCount = 0;
    let skippedCount = 0;
    const renderedPositions: Array<{x: number, y: number}> = [];

    // Render each label with density-based filtering
    for (const label of this.labels) {
      // Apply filterLambda first (before viewport/collision checks)
      if (this.filterLambda && label.properties) {
        if (!this.filterLambda(label.properties)) {
          continue; // Skip this label if filterLambda returns false
        }
      }

      // Transform label position using view matrix
      const worldX = label.x;
      const worldY = label.y;

      // Calculate aspect ratio for coordinate transformation
      const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;

      // Apply zoom and pan transformations (with aspect ratio correction)
      const clipX = worldX * (this.zoom / aspectRatio) + this.panX;
      const clipY = worldY * this.zoom + this.panY;

      // Convert from clip space (-1 to 1) to screen space (0 to canvas size)
      const screenX = (clipX + 1) * 0.5 * this.labelCanvas.width;
      const screenY = (1 - clipY) * 0.5 * this.labelCanvas.height; // Flip Y axis

      // Only render if within visible bounds
      if (screenX >= 0 && screenX <= this.labelCanvas.width &&
          screenY >= 0 && screenY <= this.labelCanvas.height) {

        // Check if this label is too close to any already rendered label
        const tooClose = renderedPositions.some(pos => {
          const dx = pos.x - screenX;
          const dy = pos.y - screenY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          return distance < this.minLabelDistance;
        });

        if (!tooClose) {
          // Apply scale if this is the hovered label
          const isHovered = this.hoveredLabel === label;
          const scale = isHovered ? this.hoverScale : this.normalScale;
          const scaledFontSize = fontSize * scale;

          // Set font with scale
          this.labelContext.font = `${scaledFontSize}px sans-serif`;

          // Measure text for bounding box
          const textMetrics = this.labelContext.measureText(label.text);
          const textWidth = textMetrics.width;
          const textHeight = scaledFontSize; // Approximate height

          // Draw text with outline for better visibility
          this.labelContext.strokeText(label.text, screenX, screenY);
          this.labelContext.fillText(label.text, screenX, screenY);

          // Store bounding box for hit detection (centered text)
          this.renderedLabelBounds.push({
            label,
            x: screenX - textWidth / 2,
            y: screenY - textHeight / 2,
            width: textWidth,
            height: textHeight
          });

          renderedPositions.push({x: screenX, y: screenY});
          renderedCount++;
        } else {
          skippedCount++;
        }
      }
    }

    // Render point outline if a point is hovered
    this.renderPointOutline();
  }

  /**
   * Render outline around hovered point
   */
  private renderPointOutline(): void {
    if (!this.labelContext || !this.labelCanvas || !this.hoveredPoint) {
      return;
    }

    if (!this.hoverOutlineOptions.enabled) {
      return;
    }

    // Transform point position to screen coordinates
    const worldX = this.hoveredPoint.x;
    const worldY = this.hoveredPoint.y;

    const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;

    // Apply zoom and pan transformations (with aspect ratio correction)
    const clipX = worldX * (this.zoom / aspectRatio) + this.panX;
    const clipY = worldY * this.zoom + this.panY;

    // Convert from clip space (-1 to 1) to screen space (0 to canvas size)
    const screenX = (clipX + 1) * 0.5 * this.labelCanvas.width;
    const screenY = (1 - clipY) * 0.5 * this.labelCanvas.height; // Flip Y axis

    // Calculate the point radius in screen space
    // Points are scaled by zoom^0.3 in the shader
    const baseSize = this.hoveredPoint.size ?? 3;
    const zoomScaledSize = baseSize * Math.pow(this.zoom, 0.3) * this.pointHoverScaleFactor;

    // Convert to screen pixels (this is an approximation)
    const screenRadius = zoomScaledSize;

    // Draw circular outline
    this.labelContext.beginPath();
    this.labelContext.arc(screenX, screenY, screenRadius, 0, Math.PI * 2);
    this.labelContext.strokeStyle = this.hoverOutlineOptions.color ?? 'black';
    this.labelContext.lineWidth = this.hoverOutlineOptions.width ?? 2;
    this.labelContext.stroke();
  }

  /**
   * Load labels from GeoJSON data
   */
  loadLabels(geojsonData: any): void {
    if (!geojsonData || !geojsonData.features) {
      console.warn('Invalid GeoJSON data provided');
      return;
    }

    // Map all features to labels
    const allLabels = geojsonData.features.map((feature: any) => ({
      text: feature.properties?.cluster_label || '',
      x: feature.geometry?.coordinates?.[0] || 0,
      y: feature.geometry?.coordinates?.[1] || 0,
      cluster: feature.properties?.cluster,
      count: feature.properties?.count || 0,
      properties: feature.properties || {},
    }));

    // Sort by count (descending) and take top N
    this.labels = allLabels
      .sort((a: Label, b: Label) => (b.count || 0) - (a.count || 0))
      .slice(0, this.maxLabels);

    console.log(`Loaded ${this.labels.length} labels (from ${allLabels.length} total, maxLabels: ${this.maxLabels})`);
    console.log('First label:', this.labels[0]);
    console.log('Label canvas:', this.labelCanvas);
    console.log('Label context:', this.labelContext);
  }

  /**
   * Setup event listeners for hover and click interactions
   */
  private setupEventListeners(): void {
    if (!this.labelCanvas) return;

    const parent = this.labelCanvas.parentElement;
    if (!parent) return;

    // Mouse move for hover effect - listen on parent to catch all mouse movement
    parent.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.labelCanvas) return;

      const rect = this.labelCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const labelAtPosition = this.getLabelAtPosition(x, y);

      // Check for point hover only if no label is hovered
      let pointHit: { point: Point; index: number } | null = null;
      if (!labelAtPosition && this.dataLayer) {
        const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;
        pointHit = this.dataLayer.findNearestPoint(
          x, y,
          this.labelCanvas.width,
          this.labelCanvas.height,
          this.zoom,
          this.panX,
          this.panY,
          aspectRatio,
          10 // threshold in pixels
        );
      }

      // Dynamically enable/disable pointer events based on label hit only
      // Point hits should keep pointerEvents as 'none' to allow pan/zoom
      if (labelAtPosition) {
        this.labelCanvas.style.pointerEvents = 'auto';
        this.labelCanvas.style.cursor = 'pointer';
      } else {
        this.labelCanvas.style.pointerEvents = 'none';
        this.labelCanvas.style.cursor = pointHit ? 'pointer' : 'default';
      }

      // Update label hover state
      if (labelAtPosition !== this.hoveredLabel) {
        this.hoveredLabel = labelAtPosition;
        // Re-render immediately to show hover effect
        this.render();
      }

      // Update point hover state
      const newHoveredPoint = pointHit?.point ?? null;
      const newHoveredIndex = pointHit?.index ?? null;
      if (newHoveredPoint !== this.hoveredPoint || newHoveredIndex !== this.hoveredPointIndex) {
        this.hoveredPoint = newHoveredPoint;
        this.hoveredPointIndex = newHoveredIndex;

        // Fire callback
        if (this.onPointHover) {
          this.onPointHover(this.hoveredPoint, this.hoveredPointIndex);
        }

        // Re-render to show point outline
        this.render();
      }
    });

    // Click event on label canvas (only fires when pointerEvents is 'auto')
    this.labelCanvas.addEventListener('click', (e: MouseEvent) => {
      const rect = this.labelCanvas!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const labelAtPosition = this.getLabelAtPosition(x, y);

      if (labelAtPosition && this.onLabelClick) {
        this.onLabelClick(labelAtPosition);
        e.stopPropagation(); // Prevent event from bubbling to canvas below
      }
    });

    // Mouse leave parent - reset hover state
    parent.addEventListener('mouseleave', () => {
      this.hoveredLabel = null;
      this.hoveredPoint = null;
      this.hoveredPointIndex = null;

      // Fire callback for point unhover
      if (this.onPointHover) {
        this.onPointHover(null, null);
      }

      if (this.labelCanvas) {
        this.labelCanvas.style.pointerEvents = 'none';
        this.labelCanvas.style.cursor = 'default';
      }
      // Re-render to remove hover effect
      this.render();
    });
  }

  /**
   * Find label at the given canvas position
   */
  private getLabelAtPosition(x: number, y: number): Label | null {
    for (const bound of this.renderedLabelBounds) {
      if (x >= bound.x - this.hitPadding &&
          x <= bound.x + bound.width + this.hitPadding &&
          y >= bound.y - this.hitPadding &&
          y <= bound.y + bound.height + this.hitPadding) {
        return bound.label;
      }
    }
    return null;
  }

  /**
   * Resize the label canvas
   */
  resize(width: number, height: number): void {
    if (this.labelCanvas) {
      this.labelCanvas.width = width;
      this.labelCanvas.height = height;
    }
  }

  /**
   * Set the filter lambda for controlling label visibility
   */
  setFilterLambda(filterLambda?: LabelFilterLambda): void {
    this.filterLambda = filterLambda;
  }

  /**
   * Set maximum number of labels to display
   */
  setMaxLabels(maxLabels: number): void {
    this.maxLabels = maxLabels;
  }

  /**
   * Set label click callback
   */
  setOnLabelClick(callback?: (label: Label) => void): void {
    this.onLabelClick = callback;
  }

  /**
   * Set point hover callback
   */
  setOnPointHover(callback?: PointHoverCallback): void {
    this.onPointHover = callback;
  }

  /**
   * Set hover outline options
   */
  setHoverOutlineOptions(options: HoverOutlineOptions): void {
    this.hoverOutlineOptions = {
      enabled: options.enabled ?? this.hoverOutlineOptions.enabled,
      color: options.color ?? this.hoverOutlineOptions.color,
      width: options.width ?? this.hoverOutlineOptions.width
    };
  }

  /**
   * Set point hover scale factor
   */
  setHoverScaleFactor(factor: number): void {
    this.pointHoverScaleFactor = factor;
  }

  /**
   * Get the currently hovered point index (for GPU layer to scale)
   */
  getHoveredPointIndex(): number | null {
    return this.hoveredPointIndex;
  }

  /**
   * Get the point hover scale factor
   */
  getPointHoverScaleFactor(): number {
    return this.pointHoverScaleFactor;
  }

  /**
   * Destroy resources
   */
  destroy(): void {
    // Remove label canvas
    if (this.labelCanvas && this.labelCanvas.parentElement) {
      this.labelCanvas.parentElement.removeChild(this.labelCanvas);
    }
  }
}
