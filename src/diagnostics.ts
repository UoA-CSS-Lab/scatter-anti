/**
 * WebGPU診断結果のインターフェース
 */
export interface WebGPUDiagnostics {
  /** WebGPU APIがサポートされているか */
  supported: boolean;
  /** WebGPUが利用可能か */
  available: boolean;
  /** GPUアダプター情報 */
  adapter: {
    /** アダプターが利用可能か */
    available: boolean;
    /** サポートされている機能の配列 */
    features?: string[];
    /** GPUの制限値 */
    limits?: Record<string, number>;
  };
  /** ブラウザ情報 */
  browser: string;
  /** エラーメッセージ（ある場合） */
  error?: string;
}

/**
 * WebGPUの利用可能性を診断する
 * @returns 診断結果のWebGPUDiagnosticsオブジェクト
 */
export async function diagnoseWebGPU(): Promise<WebGPUDiagnostics> {
  const result: WebGPUDiagnostics = {
    supported: false,
    available: false,
    adapter: {
      available: false,
    },
    browser: getBrowserInfo(),
  };

  if (!('gpu' in navigator)) {
    result.error = 'WebGPU API not found in navigator';
    return result;
  }

  result.supported = true;

  try {
    const adapter = await navigator.gpu.requestAdapter();

    if (!adapter) {
      result.error = 'GPU adapter is null - GPU may be blocklisted or WebGPU is disabled';
      return result;
    }

    result.adapter.available = true;
    result.adapter.features = Array.from(adapter.features);
    result.adapter.limits = {};

    const limitsToCheck = [
      'maxTextureDimension1D',
      'maxTextureDimension2D',
      'maxBufferSize',
      'maxVertexBuffers',
      'maxVertexAttributes',
    ];

    for (const limit of limitsToCheck) {
      if (limit in adapter.limits) {
        result.adapter.limits[limit] = (adapter.limits as any)[limit];
      }
    }

    result.available = true;
  } catch (e) {
    result.error = `Error requesting adapter: ${e}`;
    return result;
  }

  return result;
}

/**
 * ブラウザ情報を取得する
 * @returns ブラウザ名とバージョンの文字列
 */
function getBrowserInfo(): string {
  const ua = navigator.userAgent;

  if (ua.includes('Chrome') && !ua.includes('Edg')) {
    const match = ua.match(/Chrome\/(\d+)/);
    return match ? `Chrome ${match[1]}` : 'Chrome (unknown version)';
  }

  if (ua.includes('Edg')) {
    const match = ua.match(/Edg\/(\d+)/);
    return match ? `Edge ${match[1]}` : 'Edge (unknown version)';
  }

  if (ua.includes('Safari') && !ua.includes('Chrome')) {
    const match = ua.match(/Version\/(\d+)/);
    return match ? `Safari ${match[1]}` : 'Safari (unknown version)';
  }

  if (ua.includes('Firefox')) {
    const match = ua.match(/Firefox\/(\d+)/);
    return match ? `Firefox ${match[1]}` : 'Firefox (unknown version)';
  }

  return 'Unknown browser';
}
