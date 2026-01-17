/**
 * duckscatterライブラリの型定義
 */
export type LabelFilterLambda = (properties: Record<string, any>) => boolean;
export type PointHoverCallback = (data: { row: any[]; columns: string[] } | null) => void;

/** ポイント識別子の型（idColumnの値） */
export type PointId = string | number;

/** プログラムによるホバー制御用のラベル識別子 */
export interface LabelIdentifier {
  /** テキストでラベルを識別 */
  text?: string;
  /** クラスター番号でラベルを識別 */
  cluster?: number;
}

/** ラベルがホバーされた時に発火するコールバック */
export type LabelHoverCallback = (label: Label | null) => void;

export interface ColorRGBA {
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
  a: number; // 0-1
}

export interface HoverOutlineOptions {
  /** ホバーアウトラインを有効化（デフォルト: true） */
  enabled?: boolean;
  /** アウトラインの線色（デフォルト: 白） */
  color?: string;
  /** アウトラインの線幅（ピクセル単位、デフォルト: 2） */
  width?: number;
  minimumHoverSize?: number;
  outlinedPointAddition?: number;
}

export interface Label {
  /** 表示するラベルテキスト */
  text: string;
  /** データ空間でのX座標 */
  x: number;
  /** データ空間でのY座標 */
  y: number;
  /** オプションのラベルプロパティ */
  cluster?: number;
  count?: number;
  /** 元のGeoJSONフィーチャーのプロパティ */
  properties?: Record<string, any>;
}

/**
 * データクエリ用のWHERE条件フィルター
 */

/** 数値比較演算子 */
export type NumericOperator = '>=' | '>' | '<=' | '<';

/** 文字列比較演算子 */
export type StringOperator = 'contains' | 'equals' | 'startsWith' | 'endsWith';

/** 数値フィルター条件 */
export interface NumericFilter {
  type: 'numeric';
  column: string;
  operator: NumericOperator;
  value: number;
}

/** 文字列フィルター条件 */
export interface StringFilter {
  type: 'string';
  column: string;
  operator: StringOperator;
  value: string;
}

/** 生SQLフィルター条件 */
export interface RawSqlFilter {
  type: 'raw';
  sql: string;
}

/** すべてのWHERE条件の共用体型 */
export type WhereCondition = NumericFilter | StringFilter | RawSqlFilter;

/** GPUフィルター条件 (range only) */
export interface GpuWhereCondition {
  /** フィルター対象のカラム名 (gpuFilterColumnsで指定した名前) */
  column: string;
  /** 最小値 (指定しない場合は -Infinity) */
  min?: number;
  /** 最大値 (指定しない場合は +Infinity) */
  max?: number;
}

export interface DataOptions {
  /** レンダリングする表示ポイントの最大数 */
  visiblePointLimit?: number;

  /** ポイントサイズ用のSQL式（例: "LOG(favorite_count + 1) * 2 + 2"） */
  sizeSql?: string;

  /** ポイントカラー用のSQL式（ARGB 32bit整数、例: "0xFF0000FF"） */
  colorSql?: string;

  /** データをフィルタリングするWHERE条件（ANDのみ） */
  whereConditions?: WhereCondition[];

  /** GPUでフィルタリングするカラム名 (最大4つ) */
  gpuFilterColumns?: string[];

  /** GPU側で実行するフィルター条件 */
  gpuWhereConditions?: GpuWhereCondition[];

  /** ポイントを識別するカラム名 */
  idColumn: string;
}

export interface GpuOptions {
  /** 背景色（デフォルト: 透明な黒） */
  backgroundColor?: ColorRGBA;
  /** グローバル透明度 (0.0-1.0, デフォルト: 1.0) */
  pointAlpha?: number;
  /** グローバルサイズスケール (デフォルト: 1.0) */
  pointSizeScale?: number;
}

export interface LabelOptions {
  /** ラベルGeoJSONデータを取得するURL（初期化時に自動ロード） */
  url?: string;

  /** ラベルのフォントサイズ（ピクセル単位、デフォルト: 12） */
  fontSize?: number;

  /** プロパティに基づいてラベルの表示を制御するフィルター関数 */
  filterLambda?: LabelFilterLambda;

  /** ラベルがクリックされた時に発火するコールバック */
  onClick?: (label: Label) => void;

  /** ポイントホバーアウトラインの外観オプション */
  hoverOutlineOptions?: HoverOutlineOptions;
}

export interface InteractionOptions {
  /** ポイントがホバーされた時に発火するコールバック */
  onPointHover?: PointHoverCallback;
  /** ラベルがホバーされた時に発火するコールバック */
  onLabelHover?: LabelHoverCallback;
}

export interface ScatterPlotOptions {
  /** レンダリング先のCanvas要素 */
  canvas: HTMLCanvasElement;

  /** Parquetデータを取得するURL */
  dataUrl: string;

  /** データレイヤーオプション */
  data: DataOptions;

  /** GPUレンダリングオプション */
  gpu?: GpuOptions;

  /** ラベルレイヤーオプション */
  labels?: LabelOptions;

  /** インタラクションコールバック */
  interaction?: InteractionOptions;
}

/**
 * エラーハンドリング型
 */

/** エラー重大度レベル */
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

/** エラーカテゴリ */
export type ErrorCategory = 'webgpu' | 'data' | 'label' | 'query' | 'network';

/** すべての可能なエラーのエラーコード */
export type ErrorCode =
  | 'WEBGPU_NOT_SUPPORTED'
  | 'GPU_ADAPTER_NOT_AVAILABLE'
  | 'GPU_DEVICE_FAILED'
  | 'WEBGPU_CONTEXT_FAILED'
  | 'DATA_LAYER_NOT_INITIALIZED'
  | 'PARQUET_LOAD_FAILED'
  | 'QUERY_FAILED'
  | 'LABEL_FETCH_FAILED'
  | 'LABEL_PARSE_FAILED'
  | 'NETWORK_ERROR';

/** エラーイベントペイロード */
export interface ScatterPlotError {
  /** プログラムによるハンドリング用のエラーコード */
  code: ErrorCode;
  /** エラーカテゴリ */
  category: ErrorCategory;
  /** エラー重大度 */
  severity: ErrorSeverity;
  /** 人が読めるエラーメッセージ */
  message: string;
  /** 利用可能な場合、元のエラーオブジェクト */
  cause?: Error;
  /** 追加のコンテキスト情報 */
  context?: Record<string, unknown>;
  /** エラーが発生したタイムスタンプ */
  timestamp: number;
}

/** ScatterPlot EventEmitter用のイベントマップ */
export interface ScatterPlotEventMap {
  error: ScatterPlotError;
}
