/**
 * Type definitions for scatter-anti library
 */
export type LabelFilterLambda = (properties: Record<string, any>) => boolean;
export type PointHoverCallback = (data: { row: any[]; columns: string[] } | null) => void;

export interface ColorRGBA {
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
  a: number; // 0-1
}

export interface HoverOutlineOptions {
  /** Enable hover outline (default: true) */
  enabled?: boolean;
  /** Outline stroke color (default: white) */
  color?: string;
  /** Outline stroke width in pixels (default: 2) */
  width?: number;
  minimumHoverSize?: number;
  outlinedPointAddition?: number;
}

export interface Label {
  /** Label text to display */
  text: string;
  /** X coordinate in data space */
  x: number;
  /** Y coordinate in data space */
  y: number;
  /** Optional label properties */
  cluster?: number;
  count?: number;
  /** Original GeoJSON feature properties */
  properties?: Record<string, any>;
}

/**
 * WHERE condition filters for data queries
 */

/** Numeric comparison operators */
export type NumericOperator = '>=' | '>' | '<=' | '<';

/** String comparison operators */
export type StringOperator = 'contains' | 'equals' | 'startsWith' | 'endsWith';

/** Numeric filter condition */
export interface NumericFilter {
  type: 'numeric';
  column: string;
  operator: NumericOperator;
  value: number;
}

/** String filter condition */
export interface StringFilter {
  type: 'string';
  column: string;
  operator: StringOperator;
  value: string;
}

/** Raw SQL filter condition */
export interface RawSqlFilter {
  type: 'raw';
  sql: string;
}

/** Union type for all WHERE conditions */
export type WhereCondition = NumericFilter | StringFilter | RawSqlFilter;

export interface DataOptions {
  /** Maximum number of visible points to render */
  visiblePointLimit?: number;

  /** SQL expression for point size (e.g., "LOG(favorite_count + 1) * 2 + 2") */
  sizeSql?: string;

  /** SQL expression for point color as ARGB 32-bit integer (e.g., "0xFF0000FF") */
  colorSql?: string;

  /** WHERE conditions to filter data (AND only) */
  whereConditions?: WhereCondition[];

  /** Column name to identify points */
  idColumn: string;
}

export interface GpuOptions {
  /** Background color (default: transparent black) */
  backgroundColor?: ColorRGBA;
}

export interface LabelOptions {
  /** URL to fetch label GeoJSON data from (auto-loads during initialization) */
  url?: string;

  /** Font size for labels in pixels (default: 12) */
  fontSize?: number;

  /** Filter function to control label visibility based on properties */
  filterLambda?: LabelFilterLambda;

  /** Callback fired when a label is clicked */
  onClick?: (label: Label) => void;

  /** Options for point hover outline appearance */
  hoverOutlineOptions?: HoverOutlineOptions;
}

export interface InteractionOptions {
  /** Callback fired when a point is hovered */
  onPointHover?: PointHoverCallback;
}

export interface ScatterPlotOptions {
  /** Canvas element to render to */
  canvas: HTMLCanvasElement;

  /** URL to fetch Parquet data from */
  dataUrl: string;

  /** Data layer options */
  data: DataOptions;

  /** GPU rendering options */
  gpu?: GpuOptions;

  /** Label layer options */
  labels?: LabelOptions;

  /** Interaction callbacks */
  interaction?: InteractionOptions;
}

/**
 * Error handling types
 */

/** Error severity level */
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

/** Error category */
export type ErrorCategory = 'webgpu' | 'data' | 'label' | 'query' | 'network';

/** Error codes for all possible errors */
export type ErrorCode =
  // WebGPU errors
  | 'WEBGPU_NOT_SUPPORTED'
  | 'GPU_ADAPTER_NOT_AVAILABLE'
  | 'GPU_DEVICE_FAILED'
  | 'WEBGPU_CONTEXT_FAILED'
  // Data errors
  | 'DATA_LAYER_NOT_INITIALIZED'
  | 'PARQUET_LOAD_FAILED'
  | 'QUERY_FAILED'
  // Label errors
  | 'LABEL_FETCH_FAILED'
  | 'LABEL_PARSE_FAILED'
  // Network errors
  | 'NETWORK_ERROR';

/** Error event payload */
export interface ScatterPlotError {
  /** Error code for programmatic handling */
  code: ErrorCode;
  /** Error category */
  category: ErrorCategory;
  /** Error severity */
  severity: ErrorSeverity;
  /** Human-readable error message */
  message: string;
  /** Original error object if available */
  cause?: Error;
  /** Additional context information */
  context?: Record<string, unknown>;
  /** Timestamp when error occurred */
  timestamp: number;
}

/** Event map for ScatterPlot EventEmitter */
export interface ScatterPlotEventMap {
  error: ScatterPlotError;
}
