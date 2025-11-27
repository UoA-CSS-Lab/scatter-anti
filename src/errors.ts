import type { ScatterPlotError, ErrorCode, ErrorCategory, ErrorSeverity } from './types.js';

/**
 * Mapping from error codes to their categories
 */
const categoryMap: Record<ErrorCode, ErrorCategory> = {
  // WebGPU errors
  WEBGPU_NOT_SUPPORTED: 'webgpu',
  GPU_ADAPTER_NOT_AVAILABLE: 'webgpu',
  GPU_DEVICE_FAILED: 'webgpu',
  WEBGPU_CONTEXT_FAILED: 'webgpu',
  // Data errors
  DATA_LAYER_NOT_INITIALIZED: 'data',
  PARQUET_LOAD_FAILED: 'data',
  QUERY_FAILED: 'query',
  // Label errors
  LABEL_FETCH_FAILED: 'label',
  LABEL_PARSE_FAILED: 'label',
  // Network errors
  NETWORK_ERROR: 'network',
};

/**
 * Mapping from error codes to their severity levels
 */
const severityMap: Record<ErrorCode, ErrorSeverity> = {
  // Fatal errors - application cannot continue
  WEBGPU_NOT_SUPPORTED: 'fatal',
  GPU_ADAPTER_NOT_AVAILABLE: 'fatal',
  GPU_DEVICE_FAILED: 'fatal',
  WEBGPU_CONTEXT_FAILED: 'fatal',
  DATA_LAYER_NOT_INITIALIZED: 'fatal',
  PARQUET_LOAD_FAILED: 'fatal',
  // Regular errors - operation failed but app can continue
  QUERY_FAILED: 'error',
  NETWORK_ERROR: 'error',
  // Warnings - non-critical issues
  LABEL_FETCH_FAILED: 'warning',
  LABEL_PARSE_FAILED: 'warning',
};

/**
 * Create a ScatterPlotError object with the given code and message.
 *
 * @param code - The error code
 * @param message - Human-readable error message
 * @param options - Additional options
 * @returns A ScatterPlotError object
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
  return {
    code,
    category: categoryMap[code],
    severity: severityMap[code],
    message,
    cause: options?.cause,
    context: options?.context,
    timestamp: Date.now(),
  };
}
