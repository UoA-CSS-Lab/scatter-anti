import type { ParquetData, ParquetReader } from '../repository.js';
import { createParquetReader } from '../repository.js';
import type { WhereCondition } from '../types.js';

export interface DataLayerOptions {
  visiblePointLimit?: number;
  sizeSql?: string;
  colorSql?: string;
  whereConditions?: WhereCondition[];
  idColumn: string;
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

interface VisibleData {
  id: string;
  x: number;
  y: number;
  size: number;
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
  private sizeSql: string = '3';
  private colorSql: string = '0x4D4D4DCC'; // ARGB: a=0.3, r=0.3, g=0.3, b=0.8
  private whereConditions: WhereCondition[] = [];

  private currentVisibleData: VisibleData[] = [];
  private idColumn: string = '';

  // Spatial query optimization
  private readonly VIEWPORT_MARGIN = 0.5; // 50% extra on each side

  // Query cancellation and state tracking
  private currentQueryId: number = 0; // Increments with each new query
  private latestRequestedViewport: {
    zoom: number;
    panX: number;
    panY: number;
    queryId: number;
  } | null = null;

  // Query throttling
  private readonly queryThrottleInterval: number = 300; // ms between queries
  private lastQueryTime: number = 0;
  private throttleTimer: number | null = null;

  constructor(options: DataLayerOptions) {
    this.visiblePointLimit = options.visiblePointLimit ?? this.visiblePointLimit;
    this.sizeSql = options.sizeSql ?? this.sizeSql;
    this.colorSql = options.colorSql ?? this.colorSql;
    this.whereConditions = options.whereConditions ?? [];
    this.idColumn = options.idColumn;
  }

  /**
   * Initialize the data layer and load data
   */
  async initialize(dataUrl: string, aspectRatio: number = 1.0): Promise<ProcessedData> {
    this.repository = await createParquetReader();
    await this.repository.loadParquetFromUrl(dataUrl, this.idColumn);

    // Load initial data
    return await this.loadInitialData(aspectRatio);
  }

  /**
   * Load GeoJSON label data into DuckDB table
   */
  async loadLabelData(geojson: any): Promise<void> {
    if (!this.repository) {
      throw new Error('DataLayer not initialized. Call initialize() first.');
    }
    await this.repository.loadGeoJson(geojson);
  }

  /**
   * Build WHERE clause string from a single condition
   */
  private buildWhereClauseString(condition: WhereCondition): string {
    if (condition.type === 'numeric') {
      return `${condition.column} ${condition.operator} ${condition.value}`;
    } else {
      // String filter - escape single quotes
      const escapedValue = condition.value.replace(/'/g, "''");

      switch (condition.operator) {
        case 'equals':
          return `${condition.column} = '${escapedValue}'`;
        case 'contains':
          return `${condition.column} LIKE '%${escapedValue}%'`;
        case 'startsWith':
          return `${condition.column} LIKE '${escapedValue}%'`;
        case 'endsWith':
          return `${condition.column} LIKE '%${escapedValue}'`;
      }
    }
  }

  async runQuery(bounds: VisibleBounds): Promise<ParquetData | undefined> {
    return this.repository?.query({
      toString: () => {
        const whereConditions: string[] = [
          `x BETWEEN ${bounds.minX} AND ${bounds.maxX}`,
          `y BETWEEN ${bounds.minY} AND ${bounds.maxY}`,
        ];

        // Apply custom WHERE conditions (all combined with AND)
        for (const condition of this.whereConditions) {
          whereConditions.push(this.buildWhereClauseString(condition));
        }

        const whereClause = whereConditions.join(' AND ');

        return `SELECT x, y, (${this.sizeSql}) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__, ${this.idColumn} FROM parquet_data WHERE ${whereClause} LIMIT ${this.visiblePointLimit}`;
      },
    });
  }

  /**
   * Load initial data for the default viewport
   */
  private async loadInitialData(aspectRatio: number = 1.0): Promise<ProcessedData> {
    const bounds = this.calculateVisibleBounds(1.0, 0.0, 0.0, aspectRatio);
    const data = await this.runQuery(bounds);

    if (!data) {
      return {
        instanceData: new Float32Array(0),
        rowCount: 0,
        visiblePointLimit: this.visiblePointLimit,
      };
    }

    return this.processDataToGpuFormat(data);
  }

  /**
   * Calculate visible bounds in world coordinates with margin
   */
  calculateVisibleBounds(
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number
  ): VisibleBounds {
    // Clip space bounds with margin
    const clipMin = -1 - this.VIEWPORT_MARGIN;
    const clipMax = 1 + this.VIEWPORT_MARGIN;

    // Convert clip space to world coordinates, accounting for aspect ratio correction
    // The view matrix scales X by zoom/aspectRatio and Y by zoom, so we need to invert that:
    // worldX = (clipX - panX) * aspectRatio / zoom
    // worldY = (clipY - panY) / zoom
    const minX = ((clipMin - panX) * aspectRatio) / zoom;
    const maxX = ((clipMax - panX) * aspectRatio) / zoom;
    const minY = (clipMin - panY) / zoom;
    const maxY = (clipMax - panY) / zoom;

    return { minX, maxX, minY, maxY };
  }

  /**
   * Schedule a visible points update with throttling
   */
  scheduleVisiblePointsUpdate(
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    callback: (data: ProcessedData) => void
  ): void {
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
      const bounds = this.calculateVisibleBounds(zoom, panX, panY, aspectRatio);
      const data = await this.runQuery(bounds);

      // Check if this query is still relevant (hasn't been superseded)
      if (queryId !== this.currentQueryId) {
        return;
      }

      if (!data || data.rowCount === 0) {
        return;
      }

      const processedData = this.processDataToGpuFormat(data);

      // Final check before applying results
      if (queryId === this.currentQueryId) {
        callback(processedData);
      }
    } catch {
      // Silently ignore errors as they're handled by the query system
    }
  }

  /**
   * Convert columnar data to GPU-ready instance data format
   * Format: [x, y, r, g, b, a, size] per point
   */
  private processDataToGpuFormat(data: ParquetData): ProcessedData {
    const xColumn = data.columnData.get('x');
    const yColumn = data.columnData.get('y');
    const sizeColumn = data.columnData.get('__size__');
    const colorColumn = data.columnData.get('__color__');
    const idColumn = data.columnData.get(this.idColumn);

    if (!xColumn || !yColumn || !sizeColumn || !colorColumn || !idColumn) {
      return {
        instanceData: new Float32Array(0),
        rowCount: 0,
        visiblePointLimit: this.visiblePointLimit,
      };
    }

    const cachedData = new Array<VisibleData>(data.rowCount);
    const instanceData = new Float32Array(data.rowCount * 7);

    for (let i = 0; i < data.rowCount; i++) {
      const x = xColumn.get(i);
      const y = yColumn.get(i);
      const size = sizeColumn.get(i);
      const argbRaw = colorColumn.get(i);

      // Handle BigInt from DuckDB
      const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;

      // Unpack ARGB integer to RGBA floats (0-1 range)
      // ARGB format: 0xAARRGGBB
      const a = ((argb >>> 24) & 0xff) / 255;
      const r = ((argb >>> 16) & 0xff) / 255;
      const g = ((argb >>> 8) & 0xff) / 255;
      const b = (argb & 0xff) / 255;

      instanceData[i * 7 + 0] = x;
      instanceData[i * 7 + 1] = y;
      instanceData[i * 7 + 2] = r;
      instanceData[i * 7 + 3] = g;
      instanceData[i * 7 + 4] = b;
      instanceData[i * 7 + 5] = a;
      instanceData[i * 7 + 6] = size;

      cachedData[i] = {
        id: idColumn.get(i),
        x: x,
        y: y,
        size: size,
      };
    }

    this.currentVisibleData = cachedData;

    return { instanceData, rowCount: data.rowCount, visiblePointLimit: this.visiblePointLimit };
  }

  /**
   * Update configuration options
   */
  updateOptions(options: Partial<DataLayerOptions>): void {
    if (options.visiblePointLimit !== undefined) {
      this.visiblePointLimit = options.visiblePointLimit;
    }
    if (options.sizeSql !== undefined) {
      this.sizeSql = options.sizeSql;
    }
    if (options.colorSql !== undefined) {
      this.colorSql = options.colorSql;
    }
    if (options.whereConditions !== undefined) {
      this.whereConditions = options.whereConditions;
    }
    if (options.idColumn !== undefined) {
      this.idColumn = options.idColumn;
    }
  }

  /**
   * Get point color from row data (expects __color__ column from SQL)
   */
  getPointColor(row: any[], columns: string[]): { r: number; g: number; b: number; a: number } {
    const colorIdx = columns.indexOf('__color__');
    if (colorIdx === -1) {
      return { r: 0.3, g: 0.3, b: 0.8, a: 0.3 }; // fallback
    }
    const argbRaw = row[colorIdx];
    const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;
    return {
      a: ((argb >>> 24) & 0xff) / 255,
      r: ((argb >>> 16) & 0xff) / 255,
      g: ((argb >>> 8) & 0xff) / 255,
      b: (argb & 0xff) / 255,
    };
  }

  /**
   * Get point size from row data (expects __size__ column from SQL)
   */
  getPointSize(row: any[], columns: string[]): number {
    const sizeIdx = columns.indexOf('__size__');
    if (sizeIdx === -1) {
      return 3; // fallback
    }
    return row[sizeIdx];
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
  async findNearestPoint(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    thresholdPixels: number = 10
  ): Promise<{ row: any[]; columns: string[] } | null> {
    if (this.currentVisibleData.length == 0 || this.repository == null) {
      return null;
    }

    // Convert screen coordinates to clip space (-1 to 1)
    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1); // Flip Y axis

    // Convert clip space to world coordinates
    // Inverse of: clipPos = worldPos * vec2(zoom / aspectRatio, zoom) + vec2(panX, panY)
    const worldX = ((clipX - panX) * aspectRatio) / zoom;
    const worldY = (clipY - panY) / zoom;

    // Calculate threshold in world space
    // Convert pixel threshold to clip space, then to world space
    const thresholdClip = (thresholdPixels / canvasWidth) * 2;
    const thresholdWorld = (thresholdClip * aspectRatio) / zoom;

    let nearestId: string | null = null;
    let nearestDistance = Infinity;

    // Search through all visible points
    // TODO: 現在は全探索しているが、quad treeとか使ってもいいかもしれない
    for (let i = 0; i < this.currentVisibleData.length; i++) {
      const pointX = this.currentVisibleData[i].x;
      const pointY = this.currentVisibleData[i].y;

      // Calculate distance in world space
      const dx = pointX - worldX;
      const dy = pointY - worldY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < nearestDistance && distance <= thresholdWorld) {
        nearestDistance = distance;
        nearestId = this.currentVisibleData[i].id;
      }
    }

    if (nearestId == null) {
      return null;
    }

    const data = await this.repository.query({
      toString: () =>
        `SELECT *, (${this.sizeSql}) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE ${this.idColumn} = ${nearestId}`,
    });

    if (!data || data.rowCount === 0) {
      return null;
    }

    // Extract first row
    const row: any[] = new Array(data.columns.length);
    for (let j = 0; j < data.columns.length; j++) {
      const column = data.columnData.get(data.columns[j]);
      row[j] = column?.get(0);
    }

    return { row, columns: data.columns };
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
