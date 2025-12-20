import type { ScatterPlotError, ErrorCode, ErrorCategory, ErrorSeverity } from './types.js';

/**
 * エラーコードからカテゴリへのマッピング
 */
const categoryMap: Record<ErrorCode, ErrorCategory> = {
  // WebGPUエラー
  WEBGPU_NOT_SUPPORTED: 'webgpu',
  GPU_ADAPTER_NOT_AVAILABLE: 'webgpu',
  GPU_DEVICE_FAILED: 'webgpu',
  WEBGPU_CONTEXT_FAILED: 'webgpu',
  // データエラー
  DATA_LAYER_NOT_INITIALIZED: 'data',
  PARQUET_LOAD_FAILED: 'data',
  QUERY_FAILED: 'query',
  // ラベルエラー
  LABEL_FETCH_FAILED: 'label',
  LABEL_PARSE_FAILED: 'label',
  // ネットワークエラー
  NETWORK_ERROR: 'network',
};

/**
 * エラーコードから重大度レベルへのマッピング
 */
const severityMap: Record<ErrorCode, ErrorSeverity> = {
  // 致命的エラー - アプリケーションは続行不可
  WEBGPU_NOT_SUPPORTED: 'fatal',
  GPU_ADAPTER_NOT_AVAILABLE: 'fatal',
  GPU_DEVICE_FAILED: 'fatal',
  WEBGPU_CONTEXT_FAILED: 'fatal',
  DATA_LAYER_NOT_INITIALIZED: 'fatal',
  PARQUET_LOAD_FAILED: 'fatal',
  // 通常のエラー - 操作は失敗したがアプリは続行可能
  QUERY_FAILED: 'error',
  NETWORK_ERROR: 'error',
  // 警告 - 重要ではない問題
  LABEL_FETCH_FAILED: 'warning',
  LABEL_PARSE_FAILED: 'warning',
};

/**
 * 指定されたコードとメッセージでScatterPlotErrorオブジェクトを作成する
 *
 * @param code エラーコード
 * @param message 人間が読めるエラーメッセージ
 * @param options 追加オプション
 * @returns ScatterPlotErrorオブジェクト
 *
 * @example
 * ```typescript
 * const error = createError(
 *   'WEBGPU_NOT_SUPPORTED',
 *   'WebGPU is not supported in this browser',
 *   { context: { userAgent: navigator.userAgent } }
 * );
 * ```
 */
export function createError(
  code: ErrorCode,
  message: string,
  options?: {
    cause?: Error;
    context?: Record<string, unknown>;
  }
): ScatterPlotError {
  // エラーオブジェクトを構築して返す
  return {
    code,
    // マップからカテゴリを取得
    category: categoryMap[code],
    // マップから重大度を取得
    severity: severityMap[code],
    message,
    // 元の原因となったエラー
    cause: options?.cause,
    // 追加のコンテキスト情報
    context: options?.context,
    // エラー発生時のタイムスタンプ
    timestamp: Date.now(),
  };
}
