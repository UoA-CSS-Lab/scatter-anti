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
    // WebGPU APIの存在チェック
    if (!navigator.gpu) {
      throw new Error(
        'WebGPU is not supported in this browser. ' +
          'Please use Chrome 113+, Edge 113+, or Safari 18+ with WebGPU enabled.'
      );
    }

    // フォールバックオプション付きでGPUアダプターを取得
    let adapter: GPUAdapter | null = null;

    // 1回目の試行: 高パフォーマンスアダプターをリクエスト
    try {
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
    } catch {
      // 無視して次のアダプターを試す
    }

    // 2回目の試行: デフォルトアダプターをリクエスト
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch {
        // 無視して次のアダプターを試す
      }
    }

    // 3回目の試行: 低消費電力アダプターをリクエスト
    if (!adapter) {
      try {
        adapter = await navigator.gpu.requestAdapter({
          powerPreference: 'low-power',
        });
      } catch {
        // 無視して次のアダプターを試す
      }
    }

    // すべての試行が失敗した場合はエラーをスロー
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

    // GPUデバイスを取得
    try {
      this.device = await adapter.requestDevice();
    } catch (e) {
      throw new Error(`Failed to get GPU device: ${e}`);
    }

    // デバイスがnullの場合はエラー
    if (!this.device) {
      throw new Error('Failed to get GPU device: Device is null');
    }

    // キャンバスからWebGPUコンテキストを取得
    this.context = canvas.getContext('webgpu');
    if (!this.context) {
      throw new Error('Failed to get WebGPU context from canvas');
    }

    // 優先フォーマットを取得（ブラウザ/GPU依存）
    this.format = navigator.gpu.getPreferredCanvasFormat();

    // コンテキストを設定
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
    // GPUデバイスがある場合は破棄
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    // コンテキスト参照をクリア
    this.context = null;
  }
}
