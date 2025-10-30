/**
 * Type definitions for scatter-anti library
 */
export interface Point {
  x: number;
  y: number;
  color: ColorRGBA;
  size?: number; // Optional point size in pixels (falls back to global pointSize if not specified)
}

export type PointSizeLambda = (point: any[]) => number;
export type PointColorLambda = (point: any[]) => ColorRGBA;
export type LabelFilterLambda = (properties: Record<string, any>) => boolean;
export type PointHoverCallback = (point: Point | null, index: number | null) => void;

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

export interface ScatterPlotOptions {
  /** Canvas element to render to */
  canvas: HTMLCanvasElement;

  /** URL to fetch Parquet data from */
  dataUrl: string;

  /** Background color (default: transparent black) */
  backgroundColor?: ColorRGBA;

  visiblePointLimit?: number;

  pointSizeLambda?: PointSizeLambda;

  pointColorLambda?: PointColorLambda;

  preferPointColumn?: string;

  /** Labels to display on the scatter plot */
  labels?: Label[];

  /** URL to fetch label GeoJSON data from (auto-loads during initialization) */
  labelUrl?: string;

  /** Maximum number of labels to display (shows top N by cluster count) */
  maxLabels?: number;

  /** Filter function to control label visibility based on properties */
  labelFilterLambda?: LabelFilterLambda;

  /** Callback fired when a label is clicked */
  onLabelClick?: (label: Label) => void;

  /** Callback fired when a point is hovered */
  onPointHover?: PointHoverCallback;

  /** Options for point hover outline appearance */
  hoverOutlineOptions?: HoverOutlineOptions;

  /** Scale factor for hovered points (default: 1.3) */
  hoverScaleFactor?: number;
}

export interface ScatterPlotUpdateOptions {

  /** New background color */
  backgroundColor?: ColorRGBA;

    visiblePointLimit?: number;

    pointSizeLambda?: PointSizeLambda;

    pointColorLambda?: PointColorLambda;

    /** Filter function to control label visibility based on properties */
    labelFilterLambda?: LabelFilterLambda;
  preferPointColumn?: string;
}
