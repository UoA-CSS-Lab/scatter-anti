/**
 * WebGPU context manager
 */
export class WebGPUContext {
  public device: GPUDevice | null = null;
  public context: GPUCanvasContext | null = null;
  public format: GPUTextureFormat = 'bgra8unorm';

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU is not supported in this browser. ' +
        'Please use Chrome 113+, Edge 113+, or Safari 18+ with WebGPU enabled.'
      );
    }

    // Try to get GPU adapter with fallback options
    let adapter: GPUAdapter | null = null;

    // First attempt: high-performance adapter
    try {
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
    } catch (e) {
      console.warn('Failed to request high-performance adapter:', e);
    }

    // Second attempt: default adapter
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch (e) {
        console.error('Failed to request default adapter:', e);
      }
    }

    // Third attempt: low-power adapter
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: 'low-power',
        });
      } catch (e) {
        console.error('Failed to request low-power adapter:', e);
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

    // Log adapter info for debugging
    console.log('WebGPU adapter obtained:', {
      features: Array.from(adapter.features),
      limits: adapter.limits,
    });

    // Get GPU device
    try {
      this.device = await adapter.requestDevice();
    } catch (e) {
      throw new Error(`Failed to get GPU device: ${e}`);
    }

    if (!this.device) {
      throw new Error('Failed to get GPU device: Device is null');
    }

    // Configure canvas context
    this.context = canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }

    // Get preferred format
    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    console.log('WebGPU initialized successfully with format:', this.format);
  }

  destroy(): void {
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.context = null;
  }
}
