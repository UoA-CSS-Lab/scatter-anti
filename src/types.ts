/**
 * Type definitions for scatter-anti library
 */
export type PointSizeLambda = (point: any[], columns: string[]) => number;
export type PointColorLambda = (point: any[], columns: string[]) => ColorRGBA;
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

/** Union type for all WHERE conditions */
export type WhereCondition = NumericFilter | StringFilter;

export interface DataOptions {
  /** Maximum number of visible points to render */
  visiblePointLimit?: number;

  /** Function to determine point size from row data */
  pointSizeLambda?: PointSizeLambda;

  /** Function to determine point color from row data */
  pointColorLambda?: PointColorLambda;

  /** Preferred column name for point size (fallback if pointSizeLambda not provided) */
  preferPointColumn?: string;

  /** WHERE conditions to filter data (AND only) */
  whereConditions?: WhereCondition[];
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
  data?: DataOptions;

  /** GPU rendering options */
  gpu?: GpuOptions;

  /** Label layer options */
  labels?: LabelOptions;

  /** Interaction callbacks */
  interaction?: InteractionOptions;
}
