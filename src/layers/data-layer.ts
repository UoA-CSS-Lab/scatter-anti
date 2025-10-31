import { createParquetReader, ParquetData, ParquetReader } from '../repository.js';
import type { ColorRGBA, PointSizeLambda, PointColorLambda, Point, WhereCondition } from '../types.js';
import * as sql from 'sql-bricks';

export interface DataLayerOptions {
  visiblePointLimit?: number;
  pointSizeLambda?: PointSizeLambda;
  pointColorLambda?: PointColorLambda;
  preferPointColumn?: string;
  whereConditions?: WhereCondition[];
}

export interface VisibleBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ProcessedData {
  instanceData: Float32Array;
  rowCount: number;
  visiblePointLimit: number;
}

/**
 * DataLayer handles data acquisition and query management
 * Responsibilities:
 * - Load and manage Parquet data via ParquetReader
 * - Calculate visible viewport bounds
 * - Query and filter data based on viewport
 * - Throttle queries to optimize performance
 * - Convert data to GPU-ready format
 */
export class DataLayer {
  private repository: ParquetReader | null = null;
  private visiblePointLimit: number = 100000;
  private pointSizeLambda: PointSizeLambda = ((p, columns) => 3);
  private pointColorLambda: PointColorLambda = ((p, columns) => ({ r: 0.3, g: 0.3, b: 0.8, a: 0.3 }));
  private preferPointColumn: string | null = null;
  private whereConditions: WhereCondition[] = [];

  // Spatial query optimization
  private readonly VIEWPORT_MARGIN = 0.5; // 50% extra on each side

  // Query cancellation and state tracking
  private currentQueryId: number = 0; // Increments with each new query
  private latestRequestedViewport: { zoom: number; panX: number; panY: number; queryId: number } | null = null;

  // Query throttling
  private readonly queryThrottleInterval: number = 300; // ms between queries
  private lastQueryTime: number = 0;
  private throttleTimer: number | null = null;

  // Current visible data for hover detection
  private currentVisibleData: ProcessedData | null = null;

  constructor(options: DataLayerOptions = {}) {
    this.visiblePointLimit = options.visiblePointLimit ?? this.visiblePointLimit;
    this.pointSizeLambda = options.pointSizeLambda ?? this.pointSizeLambda;
    this.pointColorLambda = options.pointColorLambda ?? this.pointColorLambda;
    this.preferPointColumn = options.preferPointColumn ?? null;
    this.whereConditions = options.whereConditions ?? [];
  }

  /**
   * Initialize the data layer and load data
   */
  async initialize(dataUrl: string, aspectRatio: number = 1.0): Promise<ProcessedData> {
    this.repository = await createParquetReader();
    await this.repository.loadParquetFromUrl(dataUrl);

    // Load initial data
    return await this.loadInitialData(aspectRatio);
  }

  /**
   * Build WHERE clause from a single condition
   */
  private buildWhereClause(condition: WhereCondition): string {
    if (condition.type === 'numeric') {
      const column = condition.column;
      const value = condition.value;

      switch (condition.operator) {
        case '>=':
          return `${column} >= ${value}`;
        case '>':
          return `${column} > ${value}`;
        case '<=':
          return `${column} <= ${value}`;
        case '<':
          return `${column} < ${value}`;
      }
    } else {
      // String filter
      const column = condition.column;
      // Escape single quotes in the value
      const escapedValue = condition.value.replace(/'/g, "''");

      switch (condition.operator) {
        case 'equals':
          return `${column} = '${escapedValue}'`;
        case 'contains':
          return `${column} LIKE '%${escapedValue}%'`;
        case 'startsWith':
          return `${column} LIKE '${escapedValue}%'`;
        case 'endsWith':
          return `${column} LIKE '%${escapedValue}'`;
      }
    }
  }

  private async runQuery(bounds: VisibleBounds): Promise<ParquetData | undefined> {
    // processing in lambda expression is maybe faster
    const data = await this.repository?.query({
      toString: () => {
        let query = sql
          .select('*')
          .from('parquet_data')
          .where(
            sql.between('x', bounds.minX, bounds.maxX),
            sql.between('y', bounds.minY, bounds.maxY)
          );

        // Apply custom WHERE conditions (all combined with AND)
        for (const condition of this.whereConditions) {
          const whereClause = this.buildWhereClause(condition);
          query = query.where(whereClause);
        }

        if (this.preferPointColumn != null) {
          // Use raw SQL for DuckDB-specific hash function and ORDER BY
          query = query.orderBy(`${this.preferPointColumn} DESC`, 'hash(tid)');
        } else {
          query = query.orderBy('hash(tid)');
        }
        return `${query.toString()} LIMIT ${this.visiblePointLimit}`;
      }
    });
    return data;
  }

  /**
   * Load initial data for the default viewport
   */
  private async loadInitialData(aspectRatio: number = 1.0): Promise<ProcessedData> {
    const startTime = performance.now();

    const bounds = this.calculateVisibleBounds(1.0, 0.0, 0.0, aspectRatio);
    const data = await this.runQuery(bounds);

    if (!data) {
      return { instanceData: new Float32Array(0), rowCount: 0, visiblePointLimit: this.visiblePointLimit };
    }

    console.log(`Initial load: ${data.rowCount} points in ${(performance.now() - startTime).toFixed(1)}ms`);

    const processedData = this.processDataToGpuFormat(data);
    this.currentVisibleData = processedData;
    return processedData;
  }

  /**
   * Calculate visible bounds in world coordinates with margin
   */
  calculateVisibleBounds(zoom: number, panX: number, panY: number, aspectRatio: number): VisibleBounds {
    // Clip space bounds with margin
    const clipMin = -1 - this.VIEWPORT_MARGIN;
    const clipMax = 1 + this.VIEWPORT_MARGIN;

    // Convert clip space to world coordinates, accounting for aspect ratio correction
    // The view matrix scales X by zoom/aspectRatio and Y by zoom, so we need to invert that:
    // worldX = (clipX - panX) * aspectRatio / zoom
    // worldY = (clipY - panY) / zoom
    const minX = (clipMin - panX) * aspectRatio / zoom;
    const maxX = (clipMax - panX) * aspectRatio / zoom;
    const minY = (clipMin - panY) / zoom;
    const maxY = (clipMax - panY) / zoom;

    return { minX, maxX, minY, maxY };
  }

  /**
   * Schedule a visible points update with throttling
   */
  scheduleVisiblePointsUpdate(zoom: number, panX: number, panY: number, aspectRatio: number, callback: (data: ProcessedData) => void): void {
    // Increment query ID and store latest viewport request
    this.currentQueryId++;
    const queryId = this.currentQueryId;
    this.latestRequestedViewport = { zoom, panX, panY, queryId };

    // Clear any existing scheduled query
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const now = performance.now();
    const timeSinceLastQuery = now - this.lastQueryTime;

    // If enough time has passed, run query immediately
    if (timeSinceLastQuery >= this.queryThrottleInterval) {
      this.updateVisiblePoints(zoom, panX, panY, aspectRatio, queryId, callback);
    } else {
      // Otherwise, schedule query to run after throttle period
      const delay = this.queryThrottleInterval - timeSinceLastQuery;
      this.throttleTimer = window.setTimeout(() => {
        this.throttleTimer = null;
        // Check if this is still the latest request before executing
        if (this.latestRequestedViewport && this.latestRequestedViewport.queryId === queryId) {
          this.updateVisiblePoints(zoom, panX, panY, aspectRatio, queryId, callback);
        }
      }, delay);
    }
  }

  /**
   * Update visible points using spatial query (non-blocking with cancellation)
   */
  private async updateVisiblePoints(
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    queryId: number,
    callback: (data: ProcessedData) => void
  ): Promise<void> {
    if (!this.repository) {
      return;
    }

    // Update last query time
    this.lastQueryTime = performance.now();

    try {
      let startTime = performance.now();
      const bounds = this.calculateVisibleBounds(zoom, panX, panY, aspectRatio);
      const data = await this.runQuery(bounds);

      // Check if this query is still relevant (hasn't been superseded)
      if (queryId !== this.currentQueryId) {
        console.log(`Query ${queryId} cancelled (current: ${this.currentQueryId})`);
        return;
      }

      console.log("query time: ", performance.now() - startTime);

      if (!data || data.rowCount === 0) {
        console.warn('No points in visible bounds');
        return;
      }

      const processedData = this.processDataToGpuFormat(data);

      // Final check before applying results
      if (queryId === this.currentQueryId) {
        this.currentVisibleData = processedData;
        callback(processedData);
      } else {
        console.log(`Query ${queryId} results discarded (current: ${this.currentQueryId})`);
      }

    } catch (error) {
      console.error('Error updating visible points:', error);
    }
  }

  /**
   * Convert columnar data to GPU-ready instance data format
   * Format: [x, y, r, g, b, a, size] per point
   */
  private processDataToGpuFormat(data: ParquetData): ProcessedData {
    const startTime = performance.now();

    // Get x and y columns directly from columnar data (Arrow vectors)
    const xColumn = data.columnData.get('x');
    const yColumn = data.columnData.get('y');

    if (!xColumn || !yColumn) {
      return { instanceData: new Float32Array(0), rowCount: 0, visiblePointLimit: this.visiblePointLimit };
    }

    const instanceData = new Float32Array(data.rowCount * 7);

    // Pre-cache all columns for row construction (needed for lambda functions)
    const allColumns = data.columns.map(name => data.columnData.get(name));

    for (let i = 0; i < data.rowCount; i++) {
      // Construct row array for lambda functions
      const point: any[] = new Array(data.columns.length);
      for (let j = 0; j < data.columns.length; j++) {
        point[j] = allColumns[j]?.get(i);
      }

      const color = this.pointColorLambda(point, data.columns);

      // Direct columnar access for x/y coordinates
      instanceData[i * 7 + 0] = xColumn.get(i); // x
      instanceData[i * 7 + 1] = yColumn.get(i); // y
      instanceData[i * 7 + 2] = color.r;
      instanceData[i * 7 + 3] = color.g;
      instanceData[i * 7 + 4] = color.b;
      instanceData[i * 7 + 5] = color.a;
      instanceData[i * 7 + 6] = this.pointSizeLambda(point, data.columns);
    }

    console.log("process time: ", performance.now() - startTime, "ms, row count: ", data.rowCount)
    return { instanceData, rowCount: data.rowCount, visiblePointLimit: this.visiblePointLimit };
  }

  /**
   * Update configuration options
   */
  updateOptions(options: Partial<DataLayerOptions>): void {
    if (options.visiblePointLimit !== undefined) {
      this.visiblePointLimit = options.visiblePointLimit;
    }
    if (options.pointSizeLambda !== undefined) {
      this.pointSizeLambda = options.pointSizeLambda;
    }
    if (options.pointColorLambda !== undefined) {
      this.pointColorLambda = options.pointColorLambda;
    }
    if (options.preferPointColumn !== undefined) {
      this.preferPointColumn = options.preferPointColumn;
    }
    if (options.whereConditions !== undefined) {
      this.whereConditions = options.whereConditions;
    }
  }

  /**
   * Find the nearest point to screen coordinates
   * @param screenX Mouse X in screen coordinates
   * @param screenY Mouse Y in screen coordinates
   * @param canvasWidth Canvas width in pixels
   * @param canvasHeight Canvas height in pixels
   * @param zoom Current zoom level
   * @param panX Current pan X
   * @param panY Current pan Y
   * @param aspectRatio Canvas aspect ratio
   * @param thresholdPixels Maximum distance in pixels to consider a hit (default: 10)
   * @returns Point data and index if found, null otherwise
   */
  findNearestPoint(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    thresholdPixels: number = 10
  ): { point: Point; index: number } | null {
    if (!this.currentVisibleData || this.currentVisibleData.rowCount === 0) {
      return null;
    }

    // Convert screen coordinates to clip space (-1 to 1)
    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1); // Flip Y axis

    // Convert clip space to world coordinates
    // Inverse of: clipPos = worldPos * vec2(zoom / aspectRatio, zoom) + vec2(panX, panY)
    const worldX = (clipX - panX) * aspectRatio / zoom;
    const worldY = (clipY - panY) / zoom;

    // Calculate threshold in world space
    // Convert pixel threshold to clip space, then to world space
    const thresholdClip = (thresholdPixels / canvasWidth) * 2;
    const thresholdWorld = thresholdClip * aspectRatio / zoom;

    let nearestIndex = -1;
    let nearestDistance = Infinity;

    // Search through all visible points
    const instanceData = this.currentVisibleData.instanceData;
    for (let i = 0; i < this.currentVisibleData.rowCount; i++) {
      const pointX = instanceData[i * 7 + 0];
      const pointY = instanceData[i * 7 + 1];

      // Calculate distance in world space
      const dx = pointX - worldX;
      const dy = pointY - worldY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < nearestDistance && distance <= thresholdWorld) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    if (nearestIndex === -1) {
      return null;
    }

    // Reconstruct Point object from instance data
    const i = nearestIndex;
    const point: Point = {
      x: instanceData[i * 7 + 0],
      y: instanceData[i * 7 + 1],
      color: {
        r: instanceData[i * 7 + 2],
        g: instanceData[i * 7 + 3],
        b: instanceData[i * 7 + 4],
        a: instanceData[i * 7 + 5]
      },
      size: instanceData[i * 7 + 6]
    };

    return { point, index: nearestIndex };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    // Clear any pending throttled queries
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // Note: repository cleanup is handled externally
  }
}
