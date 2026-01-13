/**
 * WebGPUコンテキストを管理するクラス
 */
export class WebGPUContext {
  /** GPUデバイスインスタンス */
  public device: GPUDevice | null = null;
  /** キャンバスのWebGPUコンテキスト */
  public context: GPUCanvasContext | null = null;
  /** テクスチャフォーマット */
  public format: GPUTextureFormat = 'bgra8unorm';

  /**
   * WebGPUを初期化する
   * @param canvas 描画対象のHTMLCanvasElement
   */
  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU is not supported in this browser. ' +
          'Please use Chrome 113+, Edge 113+, or Safari 18+ with WebGPU enabled.'
      );
    }

    let adapter: GPUAdapter | null = null;

    try {
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
    } catch {
      // empty
    }

    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch {
        // empty
      }
    }

    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: 'low-power',
        });
      } catch {
        // empty
      }
    }

    if (!adapter) {
      throw new Error(
        'Failed to get GPU adapter. Possible reasons:\n' +
          '1. WebGPU is disabled in browser flags\n' +
          '2. Your GPU is blocklisted\n' +
          '3. GPU drivers need updating\n' +
          '4. Running in a virtual machine without GPU access\n\n' +
          'For Chrome/Edge: Visit chrome://gpu to check WebGPU status\n' +
          'For Safari: Ensure macOS Sonoma 14.4+ with Safari 18+'
      );
    }

    try {
      this.device = await adapter.requestDevice();
    } catch (e) {
      throw new Error(`Failed to get GPU device: ${e}`);
    }

    if (!this.device) {
      throw new Error('Failed to get GPU device: Device is null');
    }

    this.context = canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }

    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
  }

  /**
   * WebGPUリソースを破棄する
   */
  destroy(): void {
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.context = null;
  }
}
