/**
 * scatter-anti - WebGPUを使用して散布図を描画するTypeScriptライブラリ
 */

export { ScatterPlot } from './scatter-plot.js';
export type {
  ColorRGBA,
  ScatterPlotOptions,
  Label,
  WhereCondition,
  NumericFilter,
  StringFilter,
  RawSqlFilter,
  NumericOperator,
  StringOperator,
  // GPU filter types
  GpuWhereCondition,
  // Error handling types
  ErrorSeverity,
  ErrorCategory,
  ErrorCode,
  ScatterPlotError,
  ScatterPlotEventMap,
  // Hover control types
  PointId,
  LabelIdentifier,
  LabelHoverCallback,
} from './types.js';

export { diagnoseWebGPU } from './diagnostics.js';
export type { WebGPUDiagnostics } from './diagnostics.js';

/**
 * 現在の環境でWebGPUがサポートされているかを確認する
 * @returns WebGPUがサポートされている場合はtrue、そうでない場合はfalse
 */
export function isWebGPUSupported(): boolean {
  // navigatorオブジェクトにgpuプロパティが存在するかをチェック
  return 'gpu' in navigator;
}
