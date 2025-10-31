/**
 * scatter-anti - A TypeScript library for plotting scatter charts using WebGPU
 */

export { ScatterPlot } from './scatter-plot.js';
export type {
  Point,
  ColorRGBA,
  ScatterPlotOptions,
  Label,
} from './types.js';

export { diagnoseWebGPU, printDiagnostics } from './diagnostics.js';
export type { WebGPUDiagnostics } from './diagnostics.js';

/**
 * Check if WebGPU is supported in the current environment
 */
export function isWebGPUSupported(): boolean {
  return 'gpu' in navigator;
}
