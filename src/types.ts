import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

/**
 * duckscatterライブラリの型定義
 */
export type LabelFilterLambda = (properties: Record<string, any>) => boolean;
export type PointHoverCallback = (data: Record<string, any> | null) => void;

/** プログラムによるホバー制御用のラベル識別子 */
export interface LabelIdentifier {
  /** テキストでラベルを識別 */
  text?: string;
  /** クラスター番号でラベルを識別 */
  cluster?: number;
}

/** ラベルがホバーされた時に発火するコールバック */
export type LabelHoverCallback = (label: Label | null) => void;

export interface Color4f {
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

/** GPUフィルター条件 (range + optional soft-edge fade) */
export interface GpuWhereCondition {
  /** フィルター対象のカラム名 (gpuFilterColumnsで指定した名前) */
  column: string;
  /** 最小値 (指定しない場合は -Infinity) */
  min?: number;
  /** 最大値 (指定しない場合は +Infinity) */
  max?: number;
  /**
   * オプション: フィルタ範囲の端で alpha を連続的にランプする soft-edge フェード。
   * 範囲 [min,max] のハードカットはそのまま、その端から内側へ width 分だけ
   * フェードする。colorSql 再評価を伴わず GPU uniform 更新のみで毎フレーム安価
   * に変化させられる（このフィルタ自体と同じコスト構造）。per-point 値は
   * gpuFilterColumns 経由で既に GPU 常駐のため新規データアップロードは起きない。
   * 無限端（min/max 省略側）は自動的にフェード無効。
   */
  fade?: {
    /** 端のランプ幅（column と同じ単位, > 0）。0 以下でフェード無効 */
    width: number;
    /** どの端をフェードするか（既定 'both'） */
    edges?: 'both' | 'min' | 'max';
  };
}

/** フィルターされたポイントの表示モード */
export type FilteredPointDisplayMode = 'hidden' | 'grayed';

/** GPU 常駐 selection mask を brush 操作で更新するときの合成モード */
export type SelectionBrushMode = 'replace' | 'add' | 'subtract' | 'toggle';

/**
 * brush の対象集合。
 * - 'filtered-data'（既定）: 現在の whereConditions / gpuWhereConditions を通過した点のみ選択
 * - 'all-data': フィルタ状態に関係なく全点を選択対象にする
 */
export type SelectionBrushTarget = 'all-data' | 'filtered-data';

/** データ空間での矩形 brush 範囲（順序は任意で、内部で min/max に正規化される） */
export interface BrushBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** キャンバス画面座標（物理ピクセル）での矩形 brush 範囲（順序は任意） */
export interface ScreenBrushRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** brush 操作のオプション */
export interface BrushOptions {
  /** 合成モード（既定 'replace'） */
  mode?: SelectionBrushMode;
  /** 対象集合（既定 'filtered-data'） */
  target?: SelectionBrushTarget;
}

/** selection mask の描画スタイル */
export interface SelectionStyle {
  /** 選択済みポイントの色（未指定時は黄色系の強調色） */
  selectedColor?: Color4f;
  /** selection 有効時の非選択ポイント alpha 係数（0.0-1.0、既定 0.25） */
  unselectedAlpha?: number;
  /** 選択済みポイントのサイズ倍率（既定 1.35） */
  selectedSizeScale?: number;
  /**
   * 選択点を selectedColor で塗り替えるか（既定 true）。false にすると選択点は元の色を
   * 保持し、非選択点の減衰（unselectedAlpha）のみ行う＝クラスタ配色などを保ったまま
   * 「非選択を暗くする」dim-only 表示になる。
   */
  highlightSelected?: boolean;
}

/** update() が実際に通った処理経路 */
export type ScatterPlotUpdatePath =
  /** sizeSql/colorSql の変更により DuckDB で x/y/size/color を再 materialize した */
  | 'duckdb-all-points'
  /** whereConditions の変更、または全点再読込に伴い DuckDB で visibility bitmap を更新した */
  | 'duckdb-visibility-flags'
  /** gpuFilterColumns の変更により GPU filter column buffer を再アップロードした */
  | 'gpu-filter-columns-buffer'
  /** gpuWhereConditions/filteredPointDisplayMode の変更により GPU filter uniforms を更新した */
  | 'gpu-filter-uniforms'
  /** GPU 描画オプションまたは visiblePointLimit の変更により render/compute uniforms を更新した */
  | 'gpu-render-uniforms'
  /** ラベルレイヤーの設定またはデータを更新した */
  | 'label-layer'
  /** interaction callback を更新した */
  | 'interaction-callbacks';

/** update() の直近実行で使われた CPU/DuckDB/GPU 更新経路 */
export interface ScatterPlotUpdatePlan {
  /** 実行された処理経路。重複なし、概ねコストが高い順。 */
  paths: ScatterPlotUpdatePath[];
  /** DuckDB query により x/y/size/color の GPU 用 point buffer を再構築した */
  duckdbAllPointsReload: boolean;
  /** DuckDB query により whereConditions 用 visibility bitmap を更新した */
  duckdbVisibilityReload: boolean;
  /** GPU filter column buffer を再アップロードした */
  gpuFilterColumnUpload: boolean;
  /** GPU filter 条件または filtered point 表示モードの uniform を更新した */
  gpuFilterUniformUpdate: boolean;
  /** background/alpha/size scale/LOD などの GPU uniform を更新した */
  gpuRenderUniformUpdate: boolean;
  /** ラベルレイヤーを更新した */
  labelLayerUpdate: boolean;
  /** interaction callback を更新した */
  interactionUpdate: boolean;
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
  /**
   * GPUでフィルタリングするカラム名 (最大4つ)。超過分は無視され CONFIG_WARNING が発火する。
   * 初期設定での警告は `initialize()` 時に発火するため、observe するには `initialize()` より前に
   * `on('error', ...)` を登録すること（構築後の `update()` での警告は即時発火）。
   */
  gpuFilterColumns?: string[];
  /** GPU側で実行するフィルター条件 */
  gpuWhereConditions?: GpuWhereCondition[];
  /** フィルターされたポイントの表示モード（デフォルト: 'hidden'） */
  filteredPointDisplayMode?: FilteredPointDisplayMode;
}

export interface GpuOptions {
  /** 背景色（デフォルト: 透明な黒） */
  backgroundColor?: Color4f;
  /** グローバル透明度 (0.0-1.0, デフォルト: 1.0) */
  pointAlpha?: number;
  /** グローバルサイズスケール (デフォルト: 1.0) */
  pointSizeScale?: number;
  /** selection mask の描画スタイル */
  selection?: SelectionStyle;
}

export interface LabelOptions {
  /** ラベルGeoJSONデータを取得するURL（初期化時に自動ロード） */
  url?: string;
  /** ローカルのGeoJSONファイル（FileまたはArrayBuffer） */
  file?: File | ArrayBuffer;
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
  dataUrl?: string;
  /** ローカルのParquetファイル（FileまたはArrayBuffer） */
  dataFile?: File | ArrayBuffer;
  /** データレイヤーオプション */
  data: DataOptions;
  /** GPUレンダリングオプション */
  gpu?: GpuOptions;
  /** ラベルレイヤーオプション */
  labels?: LabelOptions;
  /** インタラクションコールバック */
  interaction?: InteractionOptions;
  /** DB接続・データロード後に呼ばれるコールバック（ALTER TABLE等のSQL操作用） */
  onDatabaseReady?: (conn: AsyncDuckDBConnection) => Promise<void>;
}

/**
 * エラーハンドリング型
 */

/** エラー重大度レベル */
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

/** エラーカテゴリ */
export type ErrorCategory = 'webgpu' | 'data' | 'label' | 'query';

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
  | 'CONFIG_WARNING';

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
